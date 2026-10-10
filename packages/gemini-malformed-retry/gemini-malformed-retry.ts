/**
 * gemini-malformed-retry.ts — 未知 finish reason 的自动延时重发
 *
 * 背景：Gemini 会返回未文档化的 finishReason（如 `MALFORMED_RESPONSE`），pi 的
 * mapStopReason() 对其做穷举 switch，落到 default 抛
 * "Unhandled stop reason: <REASON>"。这类错误不匹配 pi 的
 * RETRYABLE_PROVIDER_ERROR_PATTERN，因此 pi 不会自动重试，整轮直接失败；
 * 手动立刻重发又常撞免费档 RPM 限制（429）。
 *
 * 本扩展在 agent_before_settle（pi 放弃自动重试后的最后可续跑边界）拦截：
 *   1. 剔除出错的 assistant 消息（context_edit + replacement:null，否则 canContinue=false）
 *   2. 指数退避等待后 return continue:true，让 pi 用干净上下文重发
 *   3. 达到最大次数后放行，把错误如实暴露
 *
 * 命中规则（按顺序，先匹配先赢）：
 *   - malformed-response   : MALFORMED_RESPONSE（服务端随机，重发通常可解）→ 默认 3 次
 *   - unknown-finish-reason: 其它 "Unhandled stop reason: X"（SDK 枚举漂移）→ 默认 1 次
 *   - malformed-tool-call  : MALFORMED_FUNCTION_CALL / UNEXPECTED_TOOL_CALL → 默认 1 次
 *   安全类（SAFETY/RECITATION/PROHIBITED_CONTENT 等）不重发（确定性，重发无益）
 *
 * 安装：放在 ~/.pi/agent/extensions/ 下即自动加载，重启 pi 或 /reload 生效。
 * 命令：/malformed-retry on|off|status|delay <ms>|max <n>|unknown <n>
 */
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionContext,
	ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";

// ==================== 配置 ====================

/** 运行时可变配置（/malformed-retry 命令可改，重启后回到默认） */
const CONFIG = {
	enabled: true,
	/** MALFORMED_RESPONSE 最多自动重发次数 */
	maxAttempts: 3,
	/** 其它未知 finish reason / 工具调用畸形 的保守重发次数 */
	unknownMaxAttempts: 1,
	/** 是否对未知 finish reason 与工具调用畸形也重发 */
	retryUnknownFinishReasons: true,
	/** 首次重发前等待毫秒数（≈ 免费档最小重发间隔，避开 RPM 限制） */
	baseDelayMs: 15000,
	/** 退避等待上限毫秒数 */
	maxDelayMs: 120000,
};

// ==================== 规则 ====================

interface RetryRule {
	name: string;
	test: (errorMessage: string) => boolean;
	maxAttempts: () => number;
}

/** 顺序敏感：更具体的规则必须靠前（MALFORMED_RESPONSE 同时命中通用规则） */
const RULES: RetryRule[] = [
	{
		name: "malformed-response",
		test: (m) => /MALFORMED_RESPONSE/i.test(m),
		maxAttempts: () => CONFIG.maxAttempts,
	},
	{
		name: "unknown-finish-reason",
		test: (m) =>
			CONFIG.retryUnknownFinishReasons && /Unhandled stop reason:\s*[A-Z][A-Z0-9_]*/i.test(m),
		maxAttempts: () => CONFIG.unknownMaxAttempts,
	},
	{
		name: "malformed-tool-call",
		test: (m) =>
			CONFIG.retryUnknownFinishReasons &&
			/Provider stopped with:\s*(MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL)/i.test(m),
		maxAttempts: () => CONFIG.unknownMaxAttempts,
	},
];

// ==================== 运行状态 ====================

/** 各规则的连续失败次数；成功一轮 / 新一轮用户输入时清零 */
const attemptsByRule = new Map<string, number>();

interface MinimalMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}

const NOTIFY_MAX = 3;                 // 同类提示最多弹 3 次
const notifySeen = new Map<string, number>();
function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") {
	try {
		// 数字归一化：同类提示（只差数字）合并计数
		const key = msg.replace(/\d+/g, "#");
		const n = (notifySeen.get(key) ?? 0) + 1;
		notifySeen.set(key, n);
		if (n > NOTIFY_MAX) return;
		if (ctx.hasUI !== false) {
			ctx.ui.notify(n === NOTIFY_MAX ? `${msg}（同类提示已达上限，后续不再重复）` : msg, level);
		}
	} catch {
		/* 非 TUI 模式下无 UI，静默 */
	}
}

/** 返回命中的规则；不是可重试的 provider 错误则返回 undefined */
function matchRule(message: MinimalMessage | undefined): RetryRule | undefined {
	if (message?.role !== "assistant" || message.stopReason !== "error") return undefined;
	const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
	if (!text) return undefined;
	return RULES.find((rule) => rule.test(text));
}

/** 便捷布尔判断（测试用） */
function isTargetError(message: MinimalMessage | undefined): boolean {
	return matchRule(message) !== undefined;
}

function resetAttempts() {
	attemptsByRule.clear();
}

/** 找当前仍在模型上下文里的、最后一条目标错误消息所属的 session entry id */
function findErrorEntryId(entries: ProjectedSessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const pe = entries[i];
		if (pe.sourceEntry.type !== "message") continue;
		for (const raw of pe.messages) {
			if (isTargetError(raw as unknown as MinimalMessage)) return pe.sourceEntry.id;
		}
	}
	return undefined;
}

/** 可中断的 sleep；abort 时立即返回 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function backoffMs(attempt: number): number {
	const delay = CONFIG.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(Number.isSafeInteger(delay) ? delay : CONFIG.maxDelayMs, CONFIG.maxDelayMs);
}

// ==================== 扩展主体 ====================

export default function (pi: ExtensionAPI) {
	// 新一轮用户输入 → 计数归零
	pi.on("input", () => {
		resetAttempts();
	});

	// 成功的一轮 assistant 消息 → 计数归零
	pi.on("message_end", (event) => {
		const m = event.message as unknown as MinimalMessage;
		if (m?.role === "assistant" && m.stopReason !== "error") {
			resetAttempts();
		}
	});

	pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx) => {
		if (!CONFIG.enabled) return;

		const messages = event.context.contextMessages as unknown as MinimalMessage[];
		const last = messages[messages.length - 1];
		const rule = matchRule(last);
		if (!rule) {
			// 不是可重试错误：不干涉（如 429、context overflow、安全类交给 pi）
			return;
		}

		const errText = last?.errorMessage ?? "";
		const max = rule.maxAttempts();
		const used = attemptsByRule.get(rule.name) ?? 0;

		// 次数用尽（或规则配置为 0）→ 放行，让错误如实暴露
		if (max <= 0 || used >= max) {
			if (used > 0) {
				notify(
					ctx,
					`gemini-malformed-retry：${rule.name} 已自动重发 ${used} 次仍失败，放弃并暴露错误。\n${errText}`,
					"warning",
				);
			}
			attemptsByRule.delete(rule.name);
			return;
		}

		const targetId = findErrorEntryId(event.context.contextEntries);
		if (!targetId) {
			// 找不到可剔除的出错条目 → 不冒险续跑（否则 canContinue 可能为 false）
			notify(ctx, `gemini-malformed-retry：找不到出错的 assistant 条目，跳过自动重发。\n${errText}`, "warning");
			return;
		}

		const attempt = used + 1;
		attemptsByRule.set(rule.name, attempt);
		const delay = backoffMs(attempt);
		notify(
			ctx,
			`gemini-malformed-retry：命中 ${rule.name}，${Math.round(delay / 1000)}s 后自动重发（第 ${attempt}/${max} 次）`,
			"warning",
		);

		await sleep(delay, ctx.signal);
		if (ctx.signal?.aborted) return; // 用户中止，不再续跑

		// 剔除坏消息 + 请求一次续跑（保留其它 handler 已提议的 entries）
		return {
			entries: [...event.entries, { type: "context_edit" as const, targetId, replacement: null }],
			continue: true,
		};
	});

	pi.registerCommand("malformed-retry", {
		description: "未知 finish reason 自动重发：on/off/status/delay <ms>/max <n>/unknown <n>",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const [cmd, value] = sub.split(/\s+/);

			if (cmd === "on" || cmd === "off") {
				CONFIG.enabled = cmd === "on";
				notify(ctx, `gemini-malformed-retry 已${CONFIG.enabled ? "开启" : "关闭"}`);
				return;
			}
			if (cmd === "delay") {
				const ms = Number(value);
				if (!Number.isFinite(ms) || ms < 0) {
					notify(ctx, "用法：/malformed-retry delay <毫秒>（如 delay 20000）", "warning");
					return;
				}
				CONFIG.baseDelayMs = ms;
				notify(ctx, `gemini-malformed-retry 首次等待 = ${ms}ms`);
				return;
			}
			if (cmd === "max") {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 0) {
					notify(ctx, "用法：/malformed-retry max <次数>（如 max 3，作用于 MALFORMED_RESPONSE）", "warning");
					return;
				}
				CONFIG.maxAttempts = n;
				notify(ctx, `gemini-malformed-retry：MALFORMED_RESPONSE 最大重发次数 = ${n}`);
				return;
			}
			if (cmd === "unknown") {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 0) {
					notify(ctx, "用法：/malformed-retry unknown <次数>（作用于未知 finish reason / 工具调用畸形）", "warning");
					return;
				}
				CONFIG.unknownMaxAttempts = n;
				notify(ctx, `gemini-malformed-retry：未知 finish reason 最大重发次数 = ${n}`);
				return;
			}

			// status / 默认
			const ruleLines = RULES.map(
				(r) => `· ${r.name}: 上限 ${r.maxAttempts()}，连续 ${attemptsByRule.get(r.name) ?? 0} 次`,
			);
			notify(
				ctx,
				[
					`状态: ${CONFIG.enabled ? "开启" : "关闭"}`,
					`首次等待: ${CONFIG.baseDelayMs}ms | 退避上限: ${CONFIG.maxDelayMs}ms`,
					`未知/工具类规则: ${CONFIG.retryUnknownFinishReasons ? "启用" : "停用"}`,
					...ruleLines,
				].join("\n"),
			);
		},
	});
}

// 供离线单测复用（不依赖 pi 运行时）
export { backoffMs, isTargetError, matchRule, findErrorEntryId, RULES };
export const _testConfig = CONFIG;

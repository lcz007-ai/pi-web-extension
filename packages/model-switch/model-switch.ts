/**
 * model-switch.ts —— 授权 agent 自主切换会话模型
 *
 * 暴露工具 switch_model：
 *   - action="list"              列出当前模型、语义别名、可切换模型
 *   - action="switch"（默认）     按别名 / provider/id / 裸 id / 关键字切换模型
 *     model    必填，切换目标
 *     thinking 可选，切换后设置思考等级（不传则用别名预设）
 *     reason   可选，记录切换原因（仅用于提示与回显）
 *
 * 语义别名（供 AGENTS.md 的模型选择策略使用，按需改这里）：
 *   planning / plan / high  → <your-provider>/<your-high-end-model>        （规划、设计、复杂判断）
 *   execute / exec / fast   → <your-provider>/<your-fast-model>  （开发、编码、部署落地）
 *   fallback-flash                → <your-fallback-provider>/<your-fallback-model>
 *
 * 行为边界：
 *   - 等价于 /model：只改当前会话，不写 settings.json 的 defaultModel
 *   - 同 provider 切换：立即生效，本轮的后续调用由新模型执行
 *   - 跨 provider 切换：目标模型未标 reasoning:true 时排定到本轮结束后生效。pi 在跨模型时会剥离
 *     reasoning_content，而部分端点（实测按量 provider）强制要求回传，同一轮内切会直接 400；
 *     同 provider 端点宽容接受；目标标了 reasoning:true 时 pi 会以空占位回传（实测可通过），
 *     同样允许同轮生效。排定后若再切回当前模型，视为取消排定
 *   - 目标 provider 未配置凭据时拒绝切换，工具报错并保留原模型
 *   - 缓存重计费警告：从 prompt cache 仍热的模型切走时（手动 /model、Ctrl+P、本工具、排定落定均覆盖），
 *     若上下文 ≥20k tokens 或重计费 ≥$0.10，在状态栏提示下一条请求将在新模型上全量重计费，
 *     下一条请求发出后自动消失（实现思路移植自 pi-model-switch）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof THINKING_LEVELS)[number];

/** 语义别名：小写键名 → 目标模型（provider/id）与预设思考等级
 *
 * v3 路由（2026-10-06）：套餐内模型走订阅积分（边际≈0），
 * 按量付费模型仅作特例出口。难度调节优先 effort/thinking（零缓存代价），
 * 模型切换只在阶段边界发生（切换税 = 全上下文按 cache-miss 重算）。
 */
const ALIASES: Record<string, { target: string; thinking?: Level }> = {
	// 主路由（订阅套餐内）
	planning: { target: "<your-provider>/<your-high-end-model>", thinking: "high" },      // 复杂：规划/架构/疑难分析
	plan: { target: "<your-provider>/<your-high-end-model>", thinking: "high" },
	execute: { target: "<your-provider>/<your-fast-model>", thinking: "low" },  // 简单：编码/部署/批量/短问答
	exec: { target: "<your-provider>/<your-fast-model>", thinking: "low" },
	fast: { target: "<your-provider>/<your-fast-model>", thinking: "low" },
	simple: { target: "<your-provider>/<your-fast-model>", thinking: "low" },
	hard: { target: "<your-provider>/<your-fast-model>", thinking: "max" },     // 同模型内升难度（零缓存税）
	vision: { target: "<your-provider>/<your-fast-model>" },                    // 视觉模型（可选）
	// 特例出口（按量计费）
	"fallback-flash": { target: "<your-fallback-provider>/<your-fallback-model>", thinking: "off" },   // 点名/配额溢出/超长上下文
	"fallback-pro": { target: "<your-fallback-provider>/<your-reasoning-model>", thinking: "high" },   // <20k 上下文硬推理
};

type Pending = {
	model: Model<any>;
	level?: Level;
	from: string;
	via: string;
	reason?: string;
	/** 排定时的会话文件，用于防止模块级状态跨会话串台 */
	sessionFile?: string;
};

type Match =
	| { kind: "ok"; model: Model<any>; via: string; alias?: { target: string; thinking?: Level } }
	| { kind: "ambiguous"; label: string; options: Model<any>[] }
	| { kind: "miss" };

function label(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function display(model: Model<any>): string {
	return model.name && model.name !== model.id ? `${label(model)} (${model.name})` : label(model);
}

/** 候选池：会话 scoped 模型优先，其次全部可用模型；按 provider/id 去重 */
function collection(ctx: ExtensionContext): Model<any>[] {
	const out: Model<any>[] = [];
	const seen = new Set<string>();
	for (const entry of ctx.scopedModels ?? []) {
		const key = label(entry.model);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry.model);
	}
	for (const model of ctx.modelRegistry.getAvailable()) {
		const key = label(model);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(model);
	}
	return out;
}

function matchModel(ctx: ExtensionContext, query: string): Match {
	const raw = query.trim().replace(/^@/, "");
	const lower = raw.toLowerCase();
	if (!lower) return { kind: "miss" };

	const alias = ALIASES[lower];
	if (alias) {
		const resolved = matchModel(ctx, alias.target);
		if (resolved.kind === "ok") return { ...resolved, via: `alias:${lower}`, alias };
		return resolved;
	}

	const all = collection(ctx);
	const exact =
		all.find((m) => label(m).toLowerCase() === lower) ??
		all.find((m) => m.id.toLowerCase() === lower) ??
		all.find((m) => m.name.toLowerCase() === lower);
	if (exact) return { kind: "ok", model: exact, via: "exact" };

	const partial = all.filter(
		(m) =>
			m.id.toLowerCase().includes(lower) ||
			m.name.toLowerCase().includes(lower) ||
			label(m).toLowerCase().includes(lower),
	);
	if (partial.length === 1) return { kind: "ok", model: partial[0], via: "partial" };
	if (partial.length > 1) return { kind: "ambiguous", label: raw, options: partial };
	return { kind: "miss" };
}

function aliasText(): string {
	const lines = Object.entries(ALIASES).map(([name, alias]) => {
		const thinking = alias.thinking ? ` (thinking: ${alias.thinking})` : "";
		return `  ${name} → ${alias.target}${thinking}`;
	});
	return lines.join("\n");
}

function listText(ctx: ExtensionContext, level: string, pending?: Pending | null): string {
	const current = ctx.model;
	const currentLabel = current ? label(current) : "(未知)";
	const lines: string[] = [];

	lines.push(`当前模型：${currentLabel}（thinking: ${level}）`);
	if (pending) {
		lines.push(`已排定切换：${pending.from} → ${label(pending.model)}（本轮结束后生效）`);
	}
	lines.push("");
	lines.push("语义别名：");
	lines.push(aliasText());
	lines.push("");
	const all = collection(ctx);
	lines.push(`可切换模型（${all.length}）：`);
	for (const model of all) {
		const mark = current && label(model) === currentLabel ? "*" : " ";
		const extra = model.reasoning ? "" : " [非推理]";
		lines.push(`${mark} ${display(model)}${priceText(model)}${extra}`);
	}
	const { count, estUsd } = switchStats(ctx);
	if (count > 0) {
		lines.push("");
		lines.push(`本会话已切换 ${count} 次 · 估算全量重算累计 ~$${estUsd.toFixed(2)}（按固定单价，不分峰谷）`);
	}
	return lines.join("\n");
}

function reasonSuffix(reason: string | undefined): string {
	return reason && reason.trim() ? `，原因：${reason.trim()}` : "";
}

const CACHE_STATUS_KEY = "[REDACTED]";

/** 模型 promptCache 元数据的 TTL（秒，short/long 档），缺省 300s；PI_CACHE_RETENTION=long 时用长档
 *  部分 provider 缓存实际保留数小时（远长于 300s），
 *  故按 provider 覆盖。 */
const TTL_OVERRIDE_S: Record<string, number> = { "<your-fallback-provider>": 3 * 3600 };

function cacheTtlMs(model: Model<any>): number {
	if (TTL_OVERRIDE_S[model.provider]) return TTL_OVERRIDE_S[model.provider] * 1000;
	const retention: "short" | "long" = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	return (model.promptCache?.[retention] ?? 300) * 1000;
}

/**
 * 缓存重计费估算：从 prompt cache 仍热的 from 切到缓存已冷的 to 时，下一条请求会在 to 上
 * 全量重算整个上下文（按缓存写入价或输入价计费）。阈值与 pi 自带的
 * "Cache miss after model switch" 提示一致：≥20k tokens 或 ≥$0.10。
 */
function cacheSwitchWarning(ctx: ExtensionContext, from: Model<any>, to: Model<any>): string | undefined {
	// 各模型在当前分支上最后一次带缓存活动的请求时间
	const lastRequestAt = new Map<string, number>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// 压缩/分支摘要重建上下文，之前的缓存全部失效
			lastRequestAt.clear();
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// 从不报告缓存活动的 provider 没有可损失的缓存
			if (entry.message.usage.cacheRead + entry.message.usage.cacheWrite === 0) continue;
			lastRequestAt.set(`${entry.message.provider}/${entry.message.model}`, entry.message.timestamp);
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			// pi 的 cache warmer 主动刷新也会给缓存续命
			lastRequestAt.set(`${entry.provider}/${entry.model}`, Date.parse(entry.timestamp));
		}
	}

	const now = Date.now();
	const isWarm = (model: Model<any>) =>
		now - (lastRequestAt.get(`${model.provider}/${model.id}`) ?? -Infinity) < cacheTtlMs(model);
	// from 缓存已冷（无可损失）或 to 缓存仍热（已有缓存可廉价复用）时不算重计费
	if (!isWarm(from) || isWarm(to)) return undefined;

	const tokens = ctx.getContextUsage()?.tokens;
	if (!tokens) return undefined;

	const paidRate = to.cost.cacheWrite || to.cost.input;
	const cost = (tokens * Math.max(0, paidRate - to.cost.cacheRead)) / 1_000_000;
	if (tokens < 20_000 && cost < 0.1) return undefined;

	const costText = cost >= 0.01 ? `（约 $${cost.toFixed(2)}）` : "";
	return `下一条请求将在 ${label(to)} 上全量重计费 ~${Math.round(tokens / 1000)}k tokens${costText}`;
}

/** 套餐 provider：cost 仅为记账口径，实际走订阅积分（边际现金≈0） */
const PLAN_PROVIDERS = new Set(["<your-provider>"]);

function priceText(model: Model<any>): string {
	const plan = PLAN_PROVIDERS.has(model.provider) ? " · 套餐" : " · 按量";
	const c = model.cost;
	return c ? ` [miss $${c.input}/M · hit $${c.cacheRead}/M · out $${c.output}/M${plan}]` : `${plan} [无价格数据]`;
}

/** 会话切换统计：模型变化次数 + 切换后首条 miss 输入的重算成本（USD，按 registry 单价） */
function switchStats(ctx: ExtensionContext): { count: number; estUsd: number } {
	const prices = new Map<string, number>();
	for (const m of ctx.modelRegistry.getAvailable()) prices.set(`${m.provider}/${m.id}`, m.cost?.input ?? 0);
	let prev = "";
	let count = 0;
	let estUsd = 0;
	let billNext = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const key = `${entry.message.provider}/${entry.message.model}`;
		if (!key.includes("/")) continue;
		if (prev && key !== prev) {
			count++;
			billNext = true;
		}
		if (billNext) {
			estUsd += ((entry.message.usage?.input ?? 0) * (prices.get(key) ?? 0)) / 1_000_000;
			billNext = false;
		}
		prev = key;
	}
	return { count, estUsd };
}

function statsText(ctx: ExtensionContext): string {
	const { count, estUsd } = switchStats(ctx);
	return count > 0 ? `\n本会话已切换 ${count} 次 · 估算全量重算累计 ~$${estUsd.toFixed(2)}（按固定单价，不分峰谷）` : "";
}

/** 往返检测：目标模型是刚切离且驻留 <2 轮的上一个部落时提示（扫 branch，会话恢复/rewind 不失真） */
function roundTripWarning(ctx: ExtensionContext, targetLabel: string): string | undefined {
	const runs: { key: string; len: number }[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const key = `${entry.message.provider}/${entry.message.model}`;
		if (!key.includes("/")) continue;
		if (runs.length && runs[runs.length - 1].key === key) runs[runs.length - 1].len++;
		else runs.push({ key, len: 1 });
	}
	runs.pop(); // 最后一段是当前模型自己的驻留段
	const prevRun = runs[runs.length - 1];
	if (prevRun && prevRun.key === targetLabel && prevRun.len < 2) {
		return `刚从 ${targetLabel} 切离仅 ${prevRun.len} 轮，本次切回是该模型的第 2 次全量重算，请确认切换必要。`;
	}
	return undefined;
}

const STATUS_KEY = "model-switch";

export default function (pi: ExtensionAPI) {
	// 排定中的切换：跨 provider 切换不在同一轮内生效，避免推理内容协议不兼容。
	// 必须放在 init 闭包内（每会话 rebind 各自独立）：放模块顶层会成为进程级单例，
	// 多会话并发时 A 排定的切换会被最先 settle 的会话 B 消费（2026-09-15 实测串台）。
	let pending: Pending | null = null;

	/** 会话标识：模块缓存导致闭包被跨会话复用时的最后防线 */
	function sessionFile(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager?.getSessionFile?.();
		} catch {
			return undefined;
		}
	}

	async function applyPending(ctx: ExtensionContext, trigger: string): Promise<void> {
		const job = pending;
		if (!job) return;
		const here = sessionFile(ctx);
		if (job.sessionFile && here && job.sessionFile !== here) {
			// 该排定属于另一个会话（模块/闭包被复用的兜底）：不消费也不清空，留给属主会话的 settle 处理
			return;
		}

		const ok = await pi.setModel(job.model).catch(() => false);
		pending = null;
		ctx.ui.setStatus(STATUS_KEY, "");
		if (!ok) {
			ctx.ui.notify(
				`模型切换失败（${trigger}）：provider "${job.model.provider}" 无可用凭据或切换异常，保持 ${job.from}`,
				"error",
			);
			return;
		}
		try {
			if (job.level) pi.setThinkingLevel(job.level);
		} catch {
			// 思考等级设置失败不影响已完成的模型切换
		}
		ctx.ui.notify(
			`模型切换生效（${trigger}）：${job.from} → ${label(job.model)}${job.via}（thinking: ${pi.getThinkingLevel()}）`,
			"info",
		);
	}

	// 本轮真正结束（无重试/压缩/后续消息残留）时才应用排定的切换
	pi.on("agent_settled", async (_event, ctx) => {
		await applyPending(ctx, "本轮结束");
	});

	// 会话被替换/重开后，旧的排定切换不再有意义；顺带做别名健康自检（防止 provider 改名导致静默失效）
	pi.on("session_start", async (_event, ctx) => {
		pending = null;
		ctx.ui.setStatus(STATUS_KEY, "");
		ctx.ui.setStatus(CACHE_STATUS_KEY, "");
		try {
			const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			// 复刻 pi 的 getSupportedThinkingLevels：map 中非 null 键（xhigh/max 需显式映射）
			const ok = (m: Model<any>, l: Level): boolean => {
				if (!m.reasoning) return false;
				const v = m.thinkingLevelMap?.[l];
				return v !== null && (l === "xhigh" || l === "max" ? v !== undefined : true);
			};
			for (const [name, alias] of Object.entries(ALIASES)) {
				const resolved = matchModel(ctx, alias.target);
				if (resolved.kind !== "ok") {
					ctx.ui.notify(`model-switch：别名 "${name}" → ${alias.target} 无法解析（provider 改名或模型下线？）`, "error");
					continue;
				}
				// 档位预设校验（2026-10-06 方案A 补齐）：非法档位会被 pi 静默 clamp，路由意图静默走样
				if (alias.thinking && !ok(resolved.model, alias.thinking)) {
					const legal = LEVELS.filter((l) => ok(resolved.model, l as Level));
					ctx.ui.notify(`model-switch：别名 "${name}" 预设 thinking:${alias.thinking} 不在 ${label(resolved.model)} 合法档位 [${legal.join("/")}]，将被静默 clamp`, "error");
				}
			}
		} catch {
			// registry 未就绪时跳过自检，不影响会话启动
		}
	});

	// 模型切换生效（手动 /model、Ctrl+P、本工具、排定落定均走这里）：展示缓存重计费警告。
	// 会话恢复（source=restore）不算切换；previousModel 缺失或与目标同名时无从谈起
	pi.on("model_select", async (event, ctx) => {
		if (event.source !== "restore" && event.previousModel && label(event.previousModel) !== label(event.model)) {
			const warning = cacheSwitchWarning(ctx, event.previousModel, event.model);
			ctx.ui.setStatus(CACHE_STATUS_KEY, warning ? `⚠ ${warning}` : "");
		}

		// 用户手动 /model 切换后，排定不再有意义（含切到与排定相同目标的情况：目标已就位，无需再排定）
		if (!pending) return;
		const sameTarget = label(pending.model) === label(event.model);
		pending = null;
		ctx.ui.setStatus(STATUS_KEY, "");
		if (!sameTarget) ctx.ui.notify("检测到手动切换模型，已丢弃之前的排定切换", "info");
	});

	// 新请求已发出：重计费已成事实，警告随之消失
	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setStatus(CACHE_STATUS_KEY, "");
	});

	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"查看或切换当前会话模型与思考等级。路由原则：难度优先用 thinking/effort 调节（零缓存代价）；换模型只在阶段边界发生（切换 = 全上下文按 cache-miss 价重算）。套餐内模型走订阅，按量模型作为特例出口。",
		promptSnippet: "查看或切换当前会话模型（语义别名：planning / execute / hard / vision / fallback-flash / fallback-pro）",
		promptGuidelines: [
			"模型路由（阶段级，低频）：默认 execute（<your-fast-model>，套餐）；规划/架构/疑难分析用 planning（<your-high-end-model>，套餐）；视觉输入用 vision（<your-vision-model>，套餐）。只在阶段边界切换，阶段内不换模型；拿不准算复杂、拿不准留在当前模型；复杂度只在阶段开始判断一次，中途不降级。",
			"难度调节优先用 thinking/effort 而非换模型（effort 切换不损失缓存）：机械任务 low、常规任务默认、卡壳时临时升 high/max（别名 hard = 快速模型 + max）。同一模型连续 2 次尝试失败才考虑升级模型。",
			"按量付费模型为特例出口：仅当用户点名、套餐周配额余量 <20%（/glm-quota 查看）、或 <20k 上下文硬推理难题（fallback-pro）时使用。短上下文（<10k）切换代价可忽略，可灵活。",
			"Use switch_model with action=\"list\" to see the current model, aliases, per-model prices, and session switch stats.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				StringEnum(["list", "switch"] as const, {
					description: 'list=列出模型；switch=切换（默认，给了 model 参数即视为 switch）',
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'目标模型：语义别名（planning / execute / fast）、provider/id（如 vendor/model-x）、裸 id 或唯一关键字',
				}),
			),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "切换后的思考等级，缺省用别名的预设值" })),
			reason: Type.Optional(Type.String({ description: "切换原因，仅用于提示与回显" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action ?? (params.model ? "switch" : "list");

			if (action === "list") {
				return {
				content: [{ type: "text" as const, text: listText(ctx, pi.getThinkingLevel(), pending) }],
				details: {},
			};
			}

			const query = (params.model ?? "").trim();
			if (!query) {
				return {
					content: [
						{
							type: "text" as const,
							text: `缺少 model 参数。\n\n${listText(ctx, pi.getThinkingLevel(), pending)}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const matched = matchModel(ctx, query);
			if (matched.kind === "miss") {
				return {
					content: [
						{
							type: "text" as const,
							text: `找不到模型 "${query}"。\n\n${listText(ctx, pi.getThinkingLevel(), pending)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
			if (matched.kind === "ambiguous") {
				const options = matched.options.map((m) => `- ${display(m)}`).join("\n");
				return {
					content: [
						{
							type: "text" as const,
							text: `"${matched.label}" 匹配到多个模型，请用 provider/id 精确指定：\n${options}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const target = matched.model;
			const targetLabel = label(target);
			const current = ctx.model;
			// 思考等级优先级：显式参数 > scoped pin（如 --models "id:high"）> 别名预设 > 保持当前
			const scopedPin = (ctx.scopedModels ?? []).find((e) => label(e.model) === targetLabel)?.thinkingLevel as
				| Level
				| undefined;
			const level = (params.thinking as Level | undefined) ?? scopedPin ?? matched.alias?.thinking;
			const from = current ? label(current) : "(未知)";
			const via = matched.via.startsWith("alias:") ? `（别名 ${matched.via.slice(6)}）` : "";
			const rtWarn = roundTripWarning(ctx, targetLabel);
			const stats = statsText(ctx);

			if (current && label(current) === targetLabel) {
				// 切回当前模型 = 明确取消之前未生效的排定（否则本轮结束仍会切走，违背最后一次指令）
				const hadPending = Boolean(pending);
				if (hadPending) {
					pending = null;
					ctx.ui.setStatus(STATUS_KEY, "");
					ctx.ui.notify(`已在 ${targetLabel} 上，已取消之前的排定切换`, "info");
				}
				if (level) {
					pi.setThinkingLevel(level);
					const actual = pi.getThinkingLevel();
					ctx.ui.notify(`模型未变（${targetLabel}），thinking → ${actual}`, "info");
					return {
						content: [
							{
								type: "text" as const,
								text: `已经在 ${targetLabel} 上，仅更新思考等级为 ${actual}${hadPending ? "，且已取消之前的排定切换" : ""}${reasonSuffix(params.reason)}。`,
							},
						],
						details: { model: targetLabel, thinking: actual, ...(hadPending ? { pendingCancelled: true } : {}) },
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `已经在 ${targetLabel} 上，无需切换${hadPending ? "，且已取消之前的排定切换。" : "。"}`,
						},
					],
					details: { model: targetLabel },
				};
			}

			if (pending && label(pending.model) === targetLabel) {
				return {
					content: [
						{ type: "text" as const, text: `已排定切换到 ${targetLabel}，本轮结束后自动生效，无需重复调用。` },
					],
					details: { to: targetLabel, pending: true },
				};
			}

			if (!ctx.modelRegistry.hasConfiguredAuth(target)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `切换失败：provider "${target.provider}" 未配置可用凭据。已在 pi 中配置该 provider 的 API key 后再试。当前模型保持 ${from}。`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// 同 provider：协议一致，直接生效。跨 provider：端点可能强制校验 reasoning_content，
			// 但目标模型标了 reasoning:true 时 pi 会以空 reasoning_content 占位，实测可通过（实验 E），也允许同轮生效
			const crossProvider = Boolean(current && current.provider !== target.provider);
			const sameTurnSafe = !crossProvider || target.reasoning === true;
			if (!sameTurnSafe && !ctx.isIdle()) {
				const cacheWarning = current ? cacheSwitchWarning(ctx, current, target) : undefined;
				pending = {
					model: target,
					level,
					from,
					via,
					reason: params.reason,
					sessionFile: sessionFile(ctx),
				};
				ctx.ui.notify(`已排定切换：${from} → ${targetLabel}（跨 provider，本轮结束后生效）`, "info");
				ctx.ui.setStatus(STATUS_KEY, `⏳ ${targetLabel}（本轮末生效）`);
				return {
					content: [
						{
							type: "text" as const,
							text: `已排定切换（跨 provider）：${from} → ${targetLabel}${via}${reasonSuffix(params.reason)}。\n本轮（含剩余工具调用与收尾）仍由 ${from} 完成，本轮结束后自动生效，无需重复调用本工具。${cacheWarning ? `\n⚠ 排定落定后${cacheWarning}。` : ""}${rtWarn ? `\n⚠ ${rtWarn}` : ""}${stats}`,
						},
					],
					details: { from, to: targetLabel, thinking: level, via: matched.via, pending: true, crossProvider: true },
				};
			}

			// isIdle 兜底：agent 运行中调用本工具时恒为非 idle（走上面的排定分支）；
			// 若被其他扩展/命令在空闲期调用，跨 provider 也直接切换更符合直觉
			const cacheWarning = current ? cacheSwitchWarning(ctx, current, target) : undefined;
			const ok = await pi.setModel(target).catch(() => false);
			if (!ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `切换失败：provider "${target.provider}" 未配置可用凭据或切换异常。当前模型保持 ${from}。`,
						},
					],
					details: {},
					isError: true,
				};
			}

			if (level) pi.setThinkingLevel(level);
			const actualLevel = pi.getThinkingLevel();

			ctx.ui.notify(`模型：${from} → ${targetLabel}（thinking: ${actualLevel}）`, "info");

			return {
				content: [
					{
						type: "text" as const,
						text: `已切换模型：${from} → ${targetLabel}${via}，thinking: ${actualLevel}${reasonSuffix(params.reason)}。\n本轮的后续调用已由新模型执行。${cacheWarning ? `\n⚠ ${cacheWarning}。` : ""}${rtWarn ? `\n⚠ ${rtWarn}` : ""}${stats}`,
					},
				],
				details: { from, to: targetLabel, thinking: actualLevel, via: matched.via, pending: false, ...(cacheWarning ? { cacheWarning } : {}), ...(rtWarn ? { roundTrip: rtWarn } : {}) },
			};
		},
	});
}

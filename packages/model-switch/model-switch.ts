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
 *   planning / plan / high  → <your-high-end-model>  （规划、设计、复杂判断）
 *   execute / exec / fast   → <your-fast-model>      （开发、编码、部署落地）
 *
 * ⚠️ 占位符必须替换为你自己的 provider/id（如 "vendor/model-x"），
 *    未替换时按别名切换会报「找不到模型」，属预期行为。
 *
 * 行为边界：
 *   - 等价于 /model：只改当前会话，不写 settings.json 的 defaultModel
 *   - 同 provider 切换：立即生效，本轮的后续调用由新模型执行
 *   - 跨 provider 切换：目标模型未标 reasoning:true 时排定到本轮结束后生效。pi 在跨模型时会剥离
 *     reasoning_content，而部分端点（实测 DeepSeek）强制要求回传，同一轮内切会直接 400；
 *     同 provider 端点一般宽容接受；目标标了 reasoning:true 时 pi 会以空占位回传（实测可通过），
 *     同样允许同轮生效。排定后若再切回当前模型，视为取消排定
 *   - 目标 provider 未配置凭据时拒绝切换，工具报错并保留原模型
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof THINKING_LEVELS)[number];

/**
 * 语义别名：小写键名 → 目标模型（provider/id）与预设思考等级。
 *
 * ⚠️ 使用前必须把下面的占位符替换为你在 pi 中配置好的真实模型
 *    （provider/id 形式，如 "vendor/model-x"）。
 *    别名键名可自由增删改，供 AGENTS.md 的模型选择策略引用。
 */
const ALIASES: Record<string, { target: string; thinking?: Level }> = {
	planning: { target: "<your-high-end-model>", thinking: "high" },
	plan: { target: "<your-high-end-model>", thinking: "high" },
	high: { target: "<your-high-end-model>", thinking: "high" },
	execute: { target: "<your-fast-model>", thinking: "low" },
	exec: { target: "<your-fast-model>", thinking: "low" },
	fast: { target: "<your-fast-model>", thinking: "low" },
	flash: { target: "<your-fast-model>", thinking: "low" },
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
		lines.push(`${mark} ${display(model)}${extra}`);
	}
	return lines.join("\n");
}

function reasonSuffix(reason: string | undefined): string {
	return reason && reason.trim() ? `，原因：${reason.trim()}` : "";
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

	// 会话被替换/重开后，旧的排定切换不再有意义
	pi.on("session_start", async (_event, ctx) => {
		pending = null;
		ctx.ui.setStatus(STATUS_KEY, "");
	});

	// 用户手动 /model 切换后，排定不再有意义（含切到与排定相同目标的情况：目标已就位，无需再排定）
	pi.on("model_select", async (event, ctx) => {
		if (!pending) return;
		const sameTarget = label(pending.model) === label(event.model);
		pending = null;
		ctx.ui.setStatus(STATUS_KEY, "");
		if (!sameTarget) ctx.ui.notify("检测到手动切换模型，已丢弃之前的排定切换", "info");
	});

	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"查看或切换当前会话使用的模型。设计/规划类任务切到高阶模型，开发/部署类任务切到低阶快速模型，也可用 provider/id 或关键字精确指定。",
		promptSnippet: "查看或切换当前会话模型（支持 planning / execute 等语义别名）",
		promptGuidelines: [
			"Use switch_model before starting design, planning, architecture, or other complex judgment work: call it with model=\"planning\".",
			"Use switch_model before starting implementation, coding, or deployment work: call it with model=\"execute\".",
			"Use switch_model with action=\"list\" when you need to know the current model or which models are available.",
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
							text: `已排定切换（跨 provider）：${from} → ${targetLabel}${via}${reasonSuffix(params.reason)}。\n本轮（含剩余工具调用与收尾）仍由 ${from} 完成，本轮结束后自动生效，无需重复调用本工具。`,
						},
					],
					details: { from, to: targetLabel, thinking: level, via: matched.via, pending: true, crossProvider: true },
				};
			}

			// isIdle 兜底：agent 运行中调用本工具时恒为非 idle（走上面的排定分支）；
			// 若被其他扩展/命令在空闲期调用，跨 provider 也直接切换更符合直觉
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
						text: `已切换模型：${from} → ${targetLabel}${via}，thinking: ${actualLevel}${reasonSuffix(params.reason)}。\n本轮的后续调用已由新模型执行。`,
					},
				],
				details: { from, to: targetLabel, thinking: actualLevel, via: matched.via, pending: false },
			};
		},
	});
}

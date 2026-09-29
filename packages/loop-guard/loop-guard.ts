/**
 * Loop Guard v2 —— 死循环防护 + 优雅降级
 *
 * 状态机：normal → summarize → hard
 *
 * 四层防御：
 *   L1 连续错误熔断：连续 3 次"失败且中间无任何成功调用" → summarize
 *   L2 重复指纹（tail-run）：同指纹且上次失败，第 2 次软拦、第 3 次 summarize
 *      上次成功（观察型重试）→ 放宽到 5 次软拦
 *   L3 轮次兜底：超 MAX_TURNS → summarize
 *   L4 无进展检测（windowed，跨 edit 不清零）：同一 bash 命令 + 完全相同的
 *      失败输出，累计第 3 次起在 tool_result 追加提示，第 5 次 summarize。
 *      专抓"改代码→测试→同样失败→再改"的创造性死循环（edit 成功不清零计数）。
 *
 * 优雅降级：summarize 模式下不硬停——context 注入最终指令 + 软 block 所有
 * 工具调用；模型若执迷（2 次 block 后仍调工具）才 hard terminate。
 *
 * 软提示通道：tool_result 追加备注（不 block），模型看到"输出+备注"继续工作。
 *
 * 环境变量：LOOP_GUARD_MAX_TURNS / LOOP_GUARD_MAX_ERROR_RUN
 *           LOOP_GUARD_NOPROG_NOTE / LOOP_GUARD_NOPROG_STOP
 *
 * 已知边界：
 *   - 无进展检测只统计 bash（isError）。edit 振荡（改了又撤销）不检测——
 *     误伤风险高，交给 MAX_TURNS 兜底。
 *   - 并行模式下同批调用只有部分被拦时，agent 不会立即停，下一轮同批
 *     调用会再次被拦，通常多花一轮。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_TURNS = num("LOOP_GUARD_MAX_TURNS", 100);
const MAX_ERROR_RUN = num("LOOP_GUARD_MAX_ERROR_RUN", 3);
const DUP_ERROR_SOFT = 2;
const DUP_ERROR_STOP = 3; // 同指纹失败第 3 次（含被 block 的）→ summarize
const DUP_SUCCESS_LIMIT = 5;
const NOPROG_NOTE = num("LOOP_GUARD_NOPROG_NOTE", 3);
const NOPROG_STOP = num("LOOP_GUARD_NOPROG_STOP", 5);
const SUMMARIZE_BLOCKS_LIMIT = 2; // summarize 模式下最多容忍 2 次 block 后硬停

function num(env: string, dflt: number): number {
	const v = Number(process.env[env]);
	return Number.isFinite(v) && v > 0 ? v : dflt;
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const o = v as Record<string, unknown>;
	return `{${Object.keys(o)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
		.join(",")}}`;
}

function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** 从 tool_result 的 content 提取纯文本前 N 字符（用于输出指纹） */
function textPreview(content: unknown, max = 300): string {
	const parts: string[] = [];
	if (Array.isArray(content)) {
		for (const c of content) {
			const t = (c as { type?: string; text?: string })?.text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join("\n").replace(/\s+/g, " ").trim().slice(0, max);
}

export default function (pi: ExtensionAPI) {
	type Mode = "normal" | "summarize" | "hard";
	let mode: Mode = "normal";
	let summarizeReason = "";
	let summarizeBlocks = 0;

	// tail-run 记账（同指纹紧邻连续）
	let tails = new Map<string, { tail: number; isError: boolean }>();
	let lastFp: string | null = null;
	let errorRun = 0;
	let turnCount = 0;
	let fpById = new Map<string, string>();

	// windowed 无进展记账：bash + isError 才记，跨 edit 不清零
	let noProgress = new Map<string, number>();

	const reset = () => {
		mode = "normal";
		summarizeReason = "";
		summarizeBlocks = 0;
		tails = new Map();
		lastFp = null;
		errorRun = 0;
		turnCount = 0;
		fpById = new Map();
		noProgress = new Map();
	};

	type Ctx = { ui?: { notify?: (msg: string, kind?: string) => void } };
	const enterSummarize = (reason: string, ctx?: Ctx) => {
		if (mode === "normal") {
			mode = "summarize";
			summarizeReason = reason;
			summarizeBlocks = 0;
			ctx?.ui?.notify?.(`[loop-guard] ${reason}（已切换到总结模式）`, "warning");
		}
	};

	const finalInstruction = () => ({
		role: "user" as const,
		content: `[loop-guard] 已触发熔断：${summarizeReason}\n不要再调用任何工具，不要再重试。请立即基于已收集的信息输出最终答复：说明已完成的工作、当前卡点、失败原因与建议的下一步。`,
		timestamp: Date.now(),
	});

	pi.on("agent_start", reset);

	pi.on("turn_start", () => {
		turnCount++;
	});

	// ── 优雅降级通道 1：summarize 模式下，每次 LLM 调用前注入最终指令 ──
	pi.on("context", async (event) => {
		if (mode === "normal") return undefined;
		return { messages: [...event.messages, finalInstruction()] };
	});

	// ── 决策通道：tool_call（执行前，可 block）──
	pi.on("tool_call", async (event, ctx) => {
		const fp = hash(`${event.toolName}|${stableStringify(event.input).replace(/\\\\/g, "/")}`);
		fpById.set(event.toolCallId, fp);

		if (mode === "hard") {
			return {
				block: true,
				reason: `[loop-guard] 已强制停止（${summarizeReason}）。`,
				terminate: true,
			};
		}

		if (mode === "summarize") {
			summarizeBlocks++;
			if (summarizeBlocks > SUMMARIZE_BLOCKS_LIMIT) {
				mode = "hard";
				return {
					block: true,
					reason: `[loop-guard] 已强制停止（${summarizeReason}）。`,
					terminate: true,
				};
			}
			return { block: true, reason: `[loop-guard] ${summarizeReason} 请勿再调用工具，直接输出最终总结。` };
		}

		// L1 连续错误熔断
		if (errorRun >= MAX_ERROR_RUN) {
			enterSummarize(`已连续 ${errorRun} 次工具调用失败且无任何成功进展。`, ctx);
			return { block: true, reason: `[loop-guard] ${summarizeReason} 请勿再调用工具，直接输出最终总结。` };
		}

		// L3 轮次兜底
		if (turnCount > MAX_TURNS) {
			enterSummarize(`本次任务已执行 ${turnCount} 轮（上限 ${MAX_TURNS}）。`, ctx);
			return { block: true, reason: `[loop-guard] ${summarizeReason} 请勿再调用工具，直接输出最终总结。` };
		}

		// L2 重复指纹
		const rec = tails.get(fp);
		if (rec) {
			if (rec.isError) {
				if (rec.tail + 1 >= DUP_ERROR_STOP) {
					enterSummarize(`相同调用已连续失败 ${rec.tail} 次。`, ctx);
					return { block: true, reason: `[loop-guard] ${summarizeReason} 请勿再调用工具，直接输出最终总结。` };
				}
				if (rec.tail + 1 >= DUP_ERROR_SOFT) {
					// 被 block 的调用不产生 tool_execution_end，这里必须同步记账，
					// 否则“block 后仍原样重试”永远达不到 DUP_ERROR_STOP 阈值
					tails.set(fp, { tail: rec.tail + 1, isError: true });
					lastFp = fp;
					return {
						block: true,
						reason: "[loop-guard] 此调用上一次以相同参数失败。不要原样重试：先分析错误原因，更换参数/方法，或改用其他工具。",
					};
				}
			} else if (rec.tail + 1 >= DUP_SUCCESS_LIMIT) {
				return {
					block: true,
					reason: "[loop-guard] 此成功调用已原样重复多次。若在等待外部变化，请改用带等待的命令或向用户说明。",
				};
			}
		}

		return undefined;
	});

	// ── 软提示通道：tool_result 追加备注（不 block）──
	// 注：被 tool_call block 的调用不经过 afterToolCall（immediate 路径），
	// 故不会触发本事件——noProgress 只统计真正执行过的命令。
	pi.on("tool_result", async (event, ctx) => {
		if (mode !== "normal" || !event.isError || event.toolName !== "bash") return undefined;

		const cmd =
			typeof event.input?.command === "string" ? event.input.command.replace(/\s+/g, " ").trim() : "";
		if (!cmd) return undefined;
		const key = hash(`${cmd}|${textPreview(event.content)}`);
		const count = (noProgress.get(key) ?? 0) + 1;
		noProgress.set(key, count);

		if (count >= NOPROG_STOP) {
			enterSummarize(
				`验证命令的失败输出与之前完全相同，已第 ${count} 次——修改未改变测试结果。`,
				ctx,
			);
			// 这次调用已完成，注入的最终指令在下一轮 context 生效；
			// 若模型仍调工具，tool_call 会软 block。
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `[loop-guard] ⚠ 同样的失败输出已第 ${count} 次出现（命令：${cmd.slice(0, 80)}）。你的修改没有改变结果。请停止重复修改-验证循环：或重新分析根因，或直接总结当前状态与建议。`,
					},
				],
			};
		}
		if (count >= NOPROG_NOTE) {
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `[loop-guard] 备注：同样的失败输出已出现 ${count} 次。若刚做过修改，请确认修改是否真的生效/触及问题根源。`,
					},
				],
			};
		}
		return undefined;
	});

	// ── 记账通道：tool_execution_end ──
	pi.on("tool_execution_end", async (event) => {
		const fp = fpById.get(event.toolCallId);
		fpById.delete(event.toolCallId);
		if (!fp) return;

		const prev = tails.get(fp);
		const tail = lastFp === fp && prev ? prev.tail + 1 : 1;
		tails.set(fp, { tail, isError: event.isError });
		lastFp = fp;

		errorRun = event.isError ? errorRun + 1 : 0;
	});
}

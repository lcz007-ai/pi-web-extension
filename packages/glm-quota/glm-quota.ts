/**
 * GLM Coding Plan 余量显示（pi 扩展）
 *
 * 每次打开新对话时，在输入框（发送键）正上方显示一行 Coding Plan 余量：
 *   5 小时窗口 / 周窗口的剩余额度、已用百分比、重置倒计时。
 *
 * 数据接口：GET {host}/api/monitor/usage/quota/limit
 *   注意：智谱该接口要求 Authorization 头直接传 key（不带 "Bearer " 前缀）。
 *
 * 密钥零配置：优先复用 pi 已配置的智谱 provider（zai-cn 等），兜底读环境变量。
 * 刷新：session_start 立即查询；之后每 5 分钟自动刷新
 *   （环境变量 GLM_QUOTA_REFRESH_MS 可调，设为 0 关闭自动刷新）；
 *   /glm-quota 命令可手动刷新。
 *
 * 加载位置：~/.pi/agent/extensions/（全局），/reload 可热重载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = Number(process.env.GLM_QUOTA_REFRESH_MS ?? 5 * 60 * 1000);
const WIDGET_KEY = "glm-quota";

// truecolor ANSI 颜色（pi 的 Text 组件原生支持 ANSI 的宽度计算与换行）
const C = {
	green: "\x1b[38;2;52;199;89m",
	orange: "\x1b[38;2;255;159;10m",
	red: "\x1b[38;2;255;69;58m",
	dim: "\x1b[38;2;142;142;147m",
	reset: "\x1b[39m",
};

// ── 类型 ────────────────────────────────────────────────────────────

interface GlmLimitItem {
	type?: string;
	unit?: number; // 3 = 5 小时窗口，6 = 周窗口
	usage?: number; // 总额度（credits）
	currentValue?: number; // 已用
	remaining?: number; // 余量
	percentage?: number; // 已用百分比
	nextResetTime?: number; // 重置时间（毫秒时间戳）
}

interface GlmQuotaResponse {
	success?: boolean;
	msg?: string;
	data?: { level?: string; limits?: GlmLimitItem[] };
}

interface GlmTier {
	level?: string;
	remaining?: number;
	total?: number;
	usedPct?: number;
	resetMs?: number;
}

interface GlmUsage {
	level?: string;
	fiveHour?: GlmTier;
	weekly?: GlmTier;
	error?: string;
}

interface GlmCredential {
	key: string;
	host: string;
}

interface CtxLike {
	hasUI: boolean;
	modelRegistry?: {
		getProviderAuth?(id: string): Promise<unknown>;
		getProvider?(id: string): { baseUrl?: string } | undefined;
	};
	ui?: {
		setWidget?(key: string, lines: string[] | undefined): void;
	};
}

// ── 凭据解析 ────────────────────────────────────────────────────────

function hostOf(baseUrl?: string): string {
	const url = (baseUrl ?? "").toLowerCase();
	if (url.includes("bigmodel.cn")) return "https://open.bigmodel.cn";
	if (url.includes("z.ai")) return "https://api.z.ai";
	return "https://open.bigmodel.cn"; // 默认国内站
}

async function resolveCredential(ctx: CtxLike): Promise<GlmCredential | null> {
	// 1) 复用 pi 已配置的智谱 provider（zai-cn / zai 等）
	const reg = ctx.modelRegistry;
	if (reg?.getProviderAuth) {
		for (const id of ["zai-coding-cn", "zai-cn", "zai", "zhipu", "bigmodel"]) {
			try {
				const result = (await reg.getProviderAuth(id)) as
					| { auth?: { apiKey?: string }; apiKey?: string; baseUrl?: string }
					| undefined;
				const apiKey = result?.auth?.apiKey ?? result?.apiKey;
				if (!apiKey) continue;
				if (apiKey.startsWith("$")) continue; // "$ENV_VAR" 占位符未展开，跳过，勿当真实 key 外发
				const baseUrl =
					result?.baseUrl ?? reg.getProvider?.(id)?.baseUrl ?? undefined;
				return { key: apiKey, host: hostOf(baseUrl) };
			} catch {
				// 该 provider 未配置或解析失败，继续尝试下一个
			}
		}
	}
	// 2) 环境变量兜底
	const envKey =
		process.env.ZAI_CN_KEY ??
		process.env.ZAI_API_KEY ??
		process.env.ZHIPUAI_API_KEY;
	if (envKey) return { key: envKey, host: "https://open.bigmodel.cn" };
	return null;
}

// ── 配额查询与解析 ──────────────────────────────────────────────────

async function queryUsage(cred: GlmCredential): Promise<GlmUsage> {
	let resp: Response;
	try {
		resp = await fetch(`${cred.host}/api/monitor/usage/quota/limit`, {
			headers: {
				Authorization: cred.key, // 智谱特殊：不带 "Bearer " 前缀
				"Content-Type": "application/json",
				"Accept-Language": "en-US,en",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	if (resp.status === 401 || resp.status === 403)
		return { error: `认证失败 (HTTP ${resp.status})` };
	if (!resp.ok) return { error: `HTTP ${resp.status}` };

	let body: GlmQuotaResponse;
	try {
		body = (await resp.json()) as GlmQuotaResponse;
	} catch {
		return { error: "响应不是合法 JSON" };
	}
	if (body.success === false) return { error: body.msg ?? "业务错误" };

	const limits = body.data?.limits ?? [];
	const tier = (unit: number): GlmTier | undefined => {
		const it = limits.find((x) => Number(x.unit) === unit);
		if (!it) return undefined;
		return {
			remaining: it.remaining,
			total: it.usage,
			usedPct: it.percentage,
			resetMs: Number(it.nextResetTime) > 0 ? Number(it.nextResetTime) : undefined,
		};
	};
	return {
		level: body.data?.level,
		fiveHour: tier(3),
		weekly: tier(6),
	};
}

// ── 格式化 ──────────────────────────────────────────────────────────

function colorForPct(pct: number, text: string): string {
	if (pct >= 90) return `${C.red}${text}${C.reset}`;
	if (pct >= 70) return `${C.orange}${text}${C.reset}`;
	if (pct < 30) return `${C.green}${text}${C.reset}`;
	return text;
}

function fmtCountdown(resetMs?: number): string {
	if (!resetMs) return "";
	const diff = resetMs - Date.now();
	if (diff <= 0) return "重置中";
	const h = Math.floor(diff / 3_600_000);
	const m = Math.floor((diff % 3_600_000) / 60_000);
	if (h > 0) return `${h}h${m}m 后重置`;
	if (m > 0) return `${m}m 后重置`;
	return "即将重置";
}

const fmtNum = (n: number): string => n.toLocaleString("en-US");

function fmtTier(label: string, t: GlmTier | undefined): string {
	if (!t) return "";
	const parts: string[] = [];
	if (t.remaining !== undefined && t.total !== undefined && t.total > 0) {
		parts.push(`余 ${fmtNum(t.remaining)}/${fmtNum(t.total)}`);
	}
	if (t.usedPct !== undefined) parts.push(`已用 ${t.usedPct.toFixed(0)}%`);
	const countdown = fmtCountdown(t.resetMs);
	if (countdown) parts.push(countdown);
	if (parts.length === 0) return "";
	const body = colorForPct(t.usedPct ?? 0, `${label}: ${parts.join(" · ")}`);
	return body;
}

function fmtWidgetLine(u: GlmUsage): string {
	if (u.error) {
		return `${C.red}GLM Coding Plan 余量: 查询失败 · ${u.error}${C.reset}`;
	}
	const parts: string[] = [];
	if (u.level) parts.push(`${C.dim}[${u.level}]${C.reset}`);
	const fh = fmtTier("5h", u.fiveHour);
	if (fh) parts.push(fh);
	const wk = fmtTier("周", u.weekly);
	if (wk) parts.push(wk);
	if (parts.length === 0) return `${C.dim}GLM Coding Plan 余量: 暂无数据${C.reset}`;
	return `GLM Coding Plan ${parts.join(`  ${C.dim}│${C.reset}  `)}`;
}

// ── 扩展入口 ────────────────────────────────────────────────────────

export default function glmQuotaExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | null = null;
	let booted = false;
	let credential: GlmCredential | null = null;
	let lastCtx: CtxLike | null = null;

	const render = (ctx: CtxLike, line: string): void => {
		if (!ctx.hasUI) return;
		ctx.ui?.setWidget?.(WIDGET_KEY, [line]);
	};

	const refresh = async (ctx: CtxLike): Promise<void> => {
		render(ctx, `${C.dim}GLM Coding Plan 余量: 查询中…${C.reset}`);
		if (!credential) {
			credential = await resolveCredential(ctx);
			if (!credential) {
				render(ctx, `${C.dim}GLM Coding Plan 余量: 未找到智谱 API 密钥${C.reset}`);
				return;
			}
		}
		const usage = await queryUsage(credential);
		render(ctx, fmtWidgetLine(usage));
	};

	const bootstrap = (ctx: CtxLike): void => {
		lastCtx = ctx;
		if (booted) return;
		booted = true;
		void refresh(ctx);
		if (REFRESH_INTERVAL_MS > 0) {
			timer = setInterval(() => {
				if (lastCtx) void refresh(lastCtx);
			}, REFRESH_INTERVAL_MS);
		}
	};

	// 每次打开新对话（启动 / /new / /resume / /fork / /reload）都会触发
	pi.on("session_start", (_event, ctx) => bootstrap(ctx as unknown as CtxLike));
	// 兜底：热重载后首条消息点亮 widget（幂等，不会重复启动定时器）
	pi.on("agent_start", (_event, ctx) => bootstrap(ctx as unknown as CtxLike));

	// 手动刷新命令
	pi.registerCommand("glm-quota", {
		description: "刷新 GLM Coding Plan 余量显示",
		handler: async (_args, ctx) => {
			credential = null; // 强制重新解析密钥
			await refresh(ctx as unknown as CtxLike);
		},
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		booted = false;
		lastCtx = null;
	});
}

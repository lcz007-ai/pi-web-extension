/**
 * models-sync — pi 扩展版（替代常驻的 pi-models-sync.mjs）
 *
 * 随 pi 进程加载，不额外占用后台进程。做两件事（与原脚本一致）：
 *   1. 给 models.json 里的"裸条目"（只有一个 id 键）补元数据：
 *      先查内置表 ~/.pi/pi-models-builtin.json，再查 models.dev（本地缓存 24h）
 *   2. 维护 settings.json 的 enabledModels：新增模型自动加入，被删除的模型自动移除
 *
 * 白名单策略（关键）：
 *   - 只增：models.json 里“真新增”（不在上次 known 快照中）且未被覆盖的模型，追加 "provider/id"；
 *     用户在面板关闭的模型（models.json 未变、仅条目消失）不会被自动加回（2026-10-06 修复复活 bug）
 *   - 只减：enabledModels 里"精确条目（非 glob）"在 models.json 中已不存在时移除。
 *     判据只看 models.json，不看 pi 内置目录，所以删掉一个内置模型的自定义覆盖
 *     后它也会从列表消失（这正是原 .mjs 漏掉的情况）。
 *     为避免误删，仅当 ①本工具添加过（台账）或 ②该 provider 在 models.json 中有配置
 *     时才回收；未知 provider 的精确条目视为用户手写，保留。
 *   - glob（含 *）永不动，作为"我就要这些内置模型"的逃生口
 *   - 更保守（只回收台账内条目）：设 PI_MODELS_SYNC_KEEP_UNMANAGED=1
 *
 * 触发时机：
 *   - session_start / resources_discover：每次会话启动/重载同步一次
 *   - 会话存续期间 fs.watch 监视 models.json，面板保存后自动同步并刷新模型注册表
 *   - session_shutdown：引用计数归零时关闭 watch
 *   - /models-sync 命令：手动同步 + 刷新
 *
 * 加载位置：~/.pi/agent/extensions/（全局），/reload 可热重载。
 */

import {
	readFileSync,
	writeFileSync,
	existsSync,
	statSync,
	watch,
	renameSync,
	copyFileSync,
	unlinkSync,
	readdirSync,
	type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── 路径与常量 ──────────────────────────────────────────────────────

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HOME_DIR = dirname(AGENT_DIR); // 默认 ~/.pi
const MODELS_P = join(AGENT_DIR, "models.json");
const SETTINGS_P = join(AGENT_DIR, "settings.json");
const BUILTIN_P = join(HOME_DIR, "pi-models-builtin.json");
const DEVCACHE_P = join(HOME_DIR, "models-dev-cache.json");
const LOG_P = join(HOME_DIR, "pi-models-sync.log");
const MANAGED_P = join(HOME_DIR, "pi-models-sync-managed.json");

const DEVAPI = "https://models.dev/api.json";
const DEV_TTL = 24 * 3600_000; // 缓存有效期
const DEV_RETRY = 5 * 60_000; // 抓取失败退避
const DEV_TIMEOUT = 5_000; // 网络超时
const WATCH_DEBOUNCE = 400; // models.json 变更防抖
const SELF_WRITE_GUARD = 1_000; // 忽略自己写文件触发的事件
const SYNC_DEDUPE = 1_000; // 连续触发去重
const LOG_ROTATE = 200 * 1024;

/** 保守模式：只回收本工具添加过的白名单条目（不回收集合外的精确条目） */
const KEEP_UNMANAGED = process.env.PI_MODELS_SYNC_KEEP_UNMANAGED === "1";

// ── 类型 ────────────────────────────────────────────────────────────

type ModelEntry = Record<string, unknown> & { id: string };
type ModelsFile = { providers?: Record<string, { models?: ModelEntry[] }> };
type SettingsFile = { enabledModels?: string[]; [key: string]: unknown };
type BuiltinTable = Record<string, Record<string, Record<string, unknown>>>;
type DevCatalog = Record<string, { models?: Record<string, Record<string, unknown>> }>;

interface SyncState {
	refs: number;
	watcher: FSWatcher | null;
	timer: ReturnType<typeof setTimeout> | null;
	selfWriteAt: number;
	lastSyncAt: number;
	running: boolean;
	queued: boolean;
	lastErr: string;
	lastCtx: ExtensionContext | null;
	builtin: BuiltinTable | null;
	devCache: DevCatalog | null;
	devCacheAt: number;
	devAttemptAt: number;
	announced: boolean;
}

const G = globalThis as typeof globalThis & { __piModelsSync?: SyncState };
const state: SyncState = (G.__piModelsSync ??= {
	refs: 0,
	watcher: null,
	timer: null,
	selfWriteAt: 0,
	lastSyncAt: 0,
	running: false,
	queued: false,
	lastErr: "",
	lastCtx: null,
	builtin: null,
	devCache: null,
	devCacheAt: 0,
	devAttemptAt: 0,
	announced: false,
});

// ── 工具 ────────────────────────────────────────────────────────────

function log(msg: string): void {
	const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [ext] ${msg}`;
	console.log(line);
	try {
		if (existsSync(LOG_P) && statSync(LOG_P).size > LOG_ROTATE) {
			try {
				renameSync(LOG_P, LOG_P + ".old");
			} catch {
				/* ignore */
			}
		}
		writeFileSync(LOG_P, line + "\n", { flag: "a" });
	} catch {
		/* ignore */
	}
}

/** 原子写：临时文件 + rename（与 pi-web 自身写配置的方式一致） */
function atomicWrite(path: string, data: string): void {
	const tmp = join(dirname(path), `.${basename(path)}-${process.pid}-${Date.now()}.tmp`);
	try {
		writeFileSync(tmp, data, { encoding: "utf8", flag: "wx" });
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
	}
}

/** 配置写：每日首次备份 + 原子替换（沿用原 .mjs 的 safeWrite） */
function safeWrite(path: string, data: string): void {
	const bak = path + ".bak-" + new Date().toISOString().slice(0, 10);
	try {
		if (!existsSync(bak)) copyFileSync(path, bak);
	} catch {
		/* ignore */
	}
	atomicWrite(path, data);
	pruneBackups(path);
}

/** 备份保留上限：只留最近 3 份 .bak-YYYY-MM-DD（旧 .mjs 的 bak-YYYYMMDD 命名不匹配，不动） */
const BACKUP_KEEP = 3;
function pruneBackups(path: string): void {
	try {
		const dir = dirname(path);
		const prefix = basename(path) + ".bak-";
		const baks = readdirSync(dir)
			.filter((f) => f.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(f.slice(prefix.length)))
			.map((f) => join(dir, f))
			.sort();
		for (const old of baks.slice(0, -BACKUP_KEEP)) {
			try {
				unlinkSync(old);
			} catch {
				/* 单个清理失败不中断 */
			}
		}
	} catch {
		/* 清理失败不影响主流程 */
	}
}

const reCache = new Map<string, RegExp>();
function globToRe(p: string): RegExp {
	let re = reCache.get(p);
	if (!re) {
		re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*") + "$");
		reCache.set(p, re);
	}
	return re;
}

function covered(list: string[], provider: string, id: string): boolean {
	return list.some((pat) => {
		const re = globToRe(pat);
		return re.test(provider + "/" + id) || re.test(id);
	});
}

/** 去掉 enabledModels 条目上的思考等级后缀，如 "a/b:high" -> "a/b" */
function stripThinkingSuffix(entry: string): string {
	return entry.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
}

// ── managed 台账（记录本工具添加过的白名单条目） ──────────────────

// ── 台账：managed（本工具添加过的条目）+ known（上次见过的 models.json 模型全集）──
// known 用于区分“真新增”（自动加白名单）与“用户面板刚关闭”（尊重用户，不加回）；
// known=null 表示旧格式/首跑：只建基线，本轮不做任何追加。
interface Ledger {
	managed: string[];
	known: string[] | null;
}

function loadLedger(): Ledger {
	try {
		const a = JSON.parse(readFileSync(MANAGED_P, "utf8"));
		if (Array.isArray(a))
			return { managed: a.filter((x): x is string => typeof x === "string"), known: null };
		if (a && typeof a === "object" && Array.isArray(a.managed))
			return {
				managed: a.managed.filter((x): x is string => typeof x === "string"),
				known: Array.isArray(a.known)
					? a.known.filter((x): x is string => typeof x === "string")
					: null,
			};
		return { managed: [], known: null };
	} catch {
		return { managed: [], known: null };
	}
}

function saveLedger(l: Ledger): void {
	try {
		atomicWrite(MANAGED_P, JSON.stringify({ managed: l.managed, known: l.known ?? [] }, null, 2) + "\n");
	} catch (err) {
		log("warn: cannot save managed ledger: " + (err instanceof Error ? err.message : String(err)));
	}
}

// ── 元数据来源 ──────────────────────────────────────────────────────

function loadBuiltin(): BuiltinTable {
	if (state.builtin) return state.builtin;
	try {
		const tbl = JSON.parse(readFileSync(BUILTIN_P, "utf8")) as BuiltinTable & { _comment?: string };
		delete tbl._comment;
		state.builtin = tbl;
	} catch (err) {
		log("warn: builtin table unreadable: " + (err instanceof Error ? err.message : String(err)));
		state.builtin = {};
	}
	return state.builtin;
}

function readDiskCache(): DevCatalog | null {
	try {
		return existsSync(DEVCACHE_P) ? (JSON.parse(readFileSync(DEVCACHE_P, "utf8")) as DevCatalog) : null;
	} catch {
		return null;
	}
}

async function ensureDevCache(): Promise<DevCatalog | null> {
	if (state.devCache && Date.now() - state.devCacheAt < DEV_TTL) return state.devCache;
	let fresh = false;
	try {
		fresh = existsSync(DEVCACHE_P) && Date.now() - statSync(DEVCACHE_P).mtimeMs < DEV_TTL;
	} catch {
		/* ignore */
	}
	if (fresh) {
		state.devCache = readDiskCache();
		state.devCacheAt = Date.now();
		return state.devCache;
	}
	if (Date.now() - state.devAttemptAt < DEV_RETRY) return state.devCache || readDiskCache();
	state.devAttemptAt = Date.now();
	try {
		const res = await fetch(DEVAPI, { signal: AbortSignal.timeout(DEV_TIMEOUT) });
		const json = (await res.json()) as DevCatalog;
		atomicWrite(DEVCACHE_P, JSON.stringify(json));
		state.devCache = json;
		state.devCacheAt = Date.now();
		return json;
	} catch {
		return state.devCache || readDiskCache();
	}
}

function fromDev(dev: DevCatalog | null, provider: string, id: string): Record<string, unknown> | null {
	if (!dev) return null;
	const candidates = [provider, provider.replace(/-cn$/, "")];
	let entry: Record<string, unknown> | undefined;
	for (const p of candidates) {
		entry = (dev[p] || {}).models?.[id];
		if (entry) break;
	}
	if (!entry) return null;
	const meta: Record<string, unknown> = {};
	if (entry.name) meta.name = entry.name;
	const input = Array.isArray(entry.input)
		? entry.input
		: ((entry.input as { input?: unknown[] } | undefined)?.input ?? (entry.attachment ? ["text", "image"] : ["text"]));
	meta.input = (input as unknown[]).filter((x) => x === "text" || x === "image");
	if (entry.context_window) meta.contextWindow = entry.context_window;
	const limit = entry.limit as number | { output?: number; context?: number } | undefined;
	if (limit) {
		if (typeof limit === "number") meta.maxTokens = limit;
		else {
			if (limit.output) meta.maxTokens = limit.output;
			if (limit.context) meta.contextWindow = limit.context;
		}
	}
	const cost = entry.cost as
		| { input?: number; output?: number; cache_read?: number; cache_write?: number }
		| undefined;
	if (cost) {
		meta.cost = {
			input: cost.input ?? 0,
			output: cost.output ?? 0,
			cacheRead: cost.cache_read ?? 0,
			cacheWrite: cost.cache_write ?? 0,
		};
	}
	if (typeof entry.reasoning === "boolean") meta.reasoning = entry.reasoning;
	return Object.keys(meta).length ? meta : null;
}

// ── 同步 ────────────────────────────────────────────────────────────

async function refreshRegistry(ctx: ExtensionContext | null): Promise<void> {
	if (!ctx) return;
	try {
		// refresh 无 signal 时无界，这里加超时兜底
		await ctx.modelRegistry.refresh({ signal: AbortSignal.timeout(DEV_TIMEOUT + 3_000) } as never);
	} catch {
		/* 刷新失败不影响文件已同步 */
	}
}

async function syncOnce(ctx: ExtensionContext | null): Promise<boolean> {
	if (Date.now() - state.lastSyncAt < SYNC_DEDUPE) return true;
	if (state.running) {
		state.queued = true;
		return false;
	}
	state.running = true;
	try {
		let models: ModelsFile;
		let settings: SettingsFile;
		try {
			models = JSON.parse(readFileSync(MODELS_P, "utf8")) as ModelsFile;
			settings = JSON.parse(readFileSync(SETTINGS_P, "utf8")) as SettingsFile;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg !== state.lastErr) {
				log("skip (parse error): " + msg);
				state.lastErr = msg;
			}
			return false;
		}
		state.lastErr = "";
		state.lastSyncAt = Date.now();

		const builtin = loadBuiltin();
		const ledger = loadLedger();
		const managed = ledger.managed;
		const firstSeen = ledger.known === null; // 首跑/旧格式迁移：只建 known 基线，本轮不做任何追加
		const known = new Set(ledger.known ?? []);
		const enriched: string[] = [];
		const wlAdded: string[] = [];
		const bareUnknown: string[] = [];
		const bareForDev: Array<{ prov: string; id: string; m: ModelEntry }> = [];
		const modelKeys = new Set<string>(); // 仅 models.json 里存在的 provider/id
		const modelIds = new Set<string>();

		for (const [prov, cfg] of Object.entries(models.providers || {})) {
			const arr = cfg?.models;
			if (!Array.isArray(arr)) continue;
			for (const m of arr) {
				if (!m || typeof m.id !== "string") continue;
				modelKeys.add(prov + "/" + m.id);
				modelIds.add(m.id);
				if (Object.keys(m).length === 1) {
					const meta = builtin[prov]?.[m.id];
					if (meta) {
						Object.assign(m, structuredClone(meta));
						enriched.push(prov + "/" + m.id);
					} else {
						bareForDev.push({ prov, id: m.id, m });
					}
				}
				if (
					Array.isArray(settings.enabledModels) &&
					!firstSeen &&
					!covered(settings.enabledModels, prov, m.id) &&
					!known.has(prov + "/" + m.id) // 用户关闭的模型不复活；仅 models.json 真新增才入列
				) {
					settings.enabledModels.push(prov + "/" + m.id);
					wlAdded.push(prov + "/" + m.id);
				}
			}
		}

		if (bareForDev.length) {
			const dev = await ensureDevCache();
			for (const { prov, id, m } of bareForDev) {
				const meta = fromDev(dev, prov, id);
				if (meta) {
					Object.assign(m, meta);
					enriched.push(prov + "/" + id);
				} else {
					bareUnknown.push(prov + "/" + id);
				}
			}
		}

		// 回收失效白名单：精确条目（非 glob）在 models.json 中已不存在，
		// 且（本工具添加过 OR 该 provider 在 models.json 中有配置）。
		// 只看 models.json，不看内置目录 —— 否则删除内置模型的覆盖不会生效。
		// 未知 provider 的精确条目当作手写白名单，保留。
		const configuredProviders = new Set(Object.keys(models.providers || {}));
		const stale: string[] = [];
		if (Array.isArray(settings.enabledModels)) {
			settings.enabledModels = settings.enabledModels.filter((entry) => {
				if (entry.includes("*")) return true; // glob 始终保留
				const base = stripThinkingSuffix(entry);
				if (modelKeys.has(base) || modelIds.has(base)) return true;
				const tracked = managed.includes(entry) || managed.includes(base);
				const provider = base.includes("/") ? base.slice(0, base.indexOf("/")) : "";
				if (tracked || (!KEEP_UNMANAGED && configuredProviders.has(provider))) {
					stale.push(entry);
					return false;
				}
				return true;
			});
		}

		// 维护台账（provenance，仅在保守模式下参与判定）
		let managedDirty = false;
		for (const p of wlAdded) {
			if (!managed.includes(p)) {
				managed.push(p);
				managedDirty = true;
			}
		}
		for (const p of stale) {
			const i = managed.indexOf(p);
			if (i >= 0) {
				managed.splice(i, 1);
				managedDirty = true;
			}
		}

		// 内置目录模型用于判断 glob 是否仍然有意义（仅日志）
		const matchable = new Set(modelKeys);
		for (const [p, tbl] of Object.entries(builtin)) {
			for (const id of Object.keys(tbl)) matchable.add(p + "/" + id);
		}
		const orphans = Array.isArray(settings.enabledModels)
			? settings.enabledModels.filter(
					(p) =>
						![...matchable].some((k) => {
							const i = k.indexOf("/");
							return covered([p], i < 0 ? "" : k.slice(0, i), i < 0 ? k : k.slice(i + 1));
						}),
				)
			: [];

		if (enriched.length) safeWrite(MODELS_P, JSON.stringify(models, null, 2) + "\n");
		if (wlAdded.length || stale.length) {
			state.selfWriteAt = Date.now();
			safeWrite(SETTINGS_P, JSON.stringify(settings, null, 2) + "\n");
		}
		// known 快照刷新为本次 models.json 全集（新增入列、被删出列）；变更时与台账一并落盘
		const newKnown = [...modelKeys];
		if (managedDirty || JSON.stringify(ledger.known ?? []) !== JSON.stringify(newKnown)) {
			saveLedger({ managed, known: newKnown });
		}

		if (enriched.length || wlAdded.length || stale.length || bareUnknown.length) {
			log(
				`sync: enriched=[${enriched.join(", ")}] whitelist+=[${wlAdded.join(", ")}] whitelist-=[${stale.join(", ")}] no-metadata=[${bareUnknown.join(", ")}]`,
			);
		} else if (orphans.length) {
			log(`info: whitelist patterns matching no model (kept): [${orphans.join(", ")}]`);
		}
		if (!Array.isArray(settings.enabledModels)) {
			log("info: enabledModels not configured -> nothing to whitelist-sync (all models visible).");
		}

		if (enriched.length || wlAdded.length || stale.length) await refreshRegistry(ctx);
		return true;
	} finally {
		state.running = false;
		if (state.queued) {
			state.queued = false;
			void syncOnce(state.lastCtx);
		}
	}
}

// ── 文件监视（进程内，非独立进程） ─────────────────────────────────

function schedule(): void {
	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => {
		state.timer = null;
		void syncOnce(state.lastCtx);
	}, WATCH_DEBOUNCE);
}

function ensureWatcher(): void {
	state.refs++;
	if (state.watcher) return;
	try {
		// 监视目录而非单文件：原子 rename 替换 models.json 后仍能收到事件
		state.watcher = watch(AGENT_DIR, { persistent: false }, (_event, filename) => {
			if (!filename) return;
			if (basename(String(filename)) !== "models.json") return;
			if (Date.now() - state.selfWriteAt < SELF_WRITE_GUARD) return;
			schedule();
		});
	} catch (err) {
		log("warn: fs.watch failed: " + (err instanceof Error ? err.message : String(err)));
	}
}

function releaseWatcher(): void {
	state.refs = Math.max(0, state.refs - 1);
	if (state.refs > 0) return;
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
	if (state.watcher) {
		try {
			state.watcher.close();
		} catch {
			/* ignore */
		}
		state.watcher = null;
	}
}

// ── 扩展入口 ────────────────────────────────────────────────────────

export default function modelsSyncExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		state.lastCtx = ctx;
		if (!state.announced) {
			state.announced = true;
			log(`active (agentDir=${AGENT_DIR}, mode=${KEEP_UNMANAGED ? "conservative" : "standard"})`);
		}
		ensureWatcher();
		await syncOnce(ctx);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		state.lastCtx = ctx;
		await syncOnce(ctx);
	});

	pi.on("session_shutdown", () => {
		releaseWatcher();
	});

	pi.registerCommand("models-sync", {
		description: "立即同步 models.json（补元数据 + 白名单增删）并刷新模型列表",
		handler: async (_args, ctx) => {
			state.lastSyncAt = 0; // 强制跑一次
			state.lastCtx = ctx;
			const ok = await syncOnce(ctx);
			await refreshRegistry(ctx);
			if (ctx.hasUI) ctx.ui.notify(ok ? "models-sync: 已同步" : "models-sync: 同步被跳过（文件解析失败或已有任务在跑）", "info");
		},
	});
}

/**
 * egress-guard v4 —— 控制"什么内容进模型"的 pi 扩展
 *
 * 四层防护：
 *   L1 tool_call               执行前拦截 read/ls + bash/powershell 触达敏感路径
 *   L2 tool_result             执行后对结果文本脱敏（同时保护本地会话文件）
 *   L3 before_provider_request 出站前扫描整个 payload（兜住手贴密钥/上下文文件）
 *   L4 session_shutdown        对本次会话 jsonl 做一次事后脱敏（补 tool_call 入参盲区）
 *
 * 安装：~/.pi/agent/extensions/z-egress-guard.ts（全局）
 *       或 <项目>/.pi/extensions/z-egress-guard.ts（需项目信任），然后 /reload
 *
 * ---- 两档预设（v4 新增，2026-10-10）----
 *   /egress            查看当前档位与各开关
 *   /egress daily      日常宽松：L1 只告警不拦、出站与日志不动、最激进的裸串规则关掉
 *   /egress strict     安全收紧：拦截敏感读取、出站脱敏、会话结束时改写日志
 *   切换立即生效，并持久化到 ~/.pi/egress-guard.mode（下次启动沿用）。
 *   优先级：环境变量 PI_EGRESS_MODE > ~/.pi/egress-guard.mode > PRESET_DEFAULT
 *
 * ---- 提示策略（v4 新增）----
 *   L1 浮层（拦截/放行告警）：同类提示走 10 分钟时间窗，最多 3 次（数字归一化）。
 *       用时间窗而非"全程 3 次"，避免名额在会话开头几秒就用光、用户什么都没看到。
 *   L3/L4 计数型提示：不发浮层，改写状态栏 setStatus("egress", …) —— 原地覆盖、不堆叠。
 *       静置 15 秒无人更新后自动清除（有活动时一直可见，停手后自己消失）。
 *       可用 PI_EGRESS_STATUS_IDLE_MS 覆盖静置时长。切档与会话结束时同步清除。
 *   /egress 命令的提示不受任何上限约束（用户主动要看的每次都显示）。
 *
 * ---- v3 相对 v2 的变更（2026-10-10）----
 *   L1  bash 分支改为「先切 token，再用与 read 同一套 isBlockedPath() 判定」：
 *       修掉两份清单不对称（read 拦得住 web-push.json，bash 却放行），
 *       同时消除 `list(o.keys())` 这类子串误报。
 *   L2  补齐凭据形态：JSON/TOML 里的 p256dh / auth / privateKey / unlock_pin / enc_id …
 *       、HTTP 认证头、推送端点，以及"上下文感知的高熵裸串"。
 *   另：新增「本机已知凭据字面量」精确脱敏（读 KNOWN_SECRET_FILES，零误报）。
 *   L4  新增 session_shutdown 事后脱敏，补 tool_call 入参（命令行里的明文密钥）这个盲区。
 *
 * 边界（必读）：
 *   - L1 的 bash 拦截是启发式，模型可用任意语言内联脚本绕过路径匹配
 *   - 图片（截图含密钥）无法脱敏，只能靠 L1 拦截
 *   - L3 会把用户手贴的真实密钥也脱敏——想让模型看到真密钥时切 daily
 *   - L4 会在会话结束时【改写会话 jsonl】；daily 档默认关闭
 *   - 这不是安全边界；真隔离用容器（见 docs/security.md）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ======================= 档位预设 =======================

type Preset = "daily" | "strict";

interface PresetSpec {
  /** 中文名，仅用于提示 */
  label: string;
  /** L1 敏感路径处理强度 */
  l1: "off" | "warn" | "block";
  /** L2：前缀型密钥规则（sk-/AKIA/JWT/私钥块/KV 赋值，实践中几乎不误报） */
  baseRules: boolean;
  /** L2：JSON 自定义字段、TOML/INI 赋值、HTTP 认证头、推送端点（会碰到正常代码/配置） */
  extraRules: boolean;
  /** L2：本机凭据文件里的字面量精确脱敏（零误报） */
  knownSecrets: boolean;
  /** L2：裸高熵串兜底强度 */
  bareToken: "off" | "contextual" | "aggressive";
  /** L3：出站 payload 脱敏 */
  scanPayload: boolean;
  /** L4：会话结束时改写 jsonl */
  sweepJournal: boolean;
}

const PRESETS: Record<Preset, PresetSpec> = {
  daily: {
    label: "日常宽松",
    l1: "warn",            // 只在通知栏提醒，放行
    baseRules: true,
    extraRules: false,
    knownSecrets: true,
    bareToken: "off",
    scanPayload: false,
    sweepJournal: false,
  },
  strict: {
    label: "安全收紧",
    l1: "block",
    baseRules: true,
    extraRules: true,
    knownSecrets: true,
    bareToken: "contextual",
    scanPayload: true,
    sweepJournal: true,
  },
};

const PRESET_DEFAULT: Preset = "strict";
const MODE_ENV = "PI_EGRESS_MODE";

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? "";
}

function modeFilePath(): string {
  return path.join(homeDir(), ".pi", "egress-guard.mode");
}

function isPreset(v: string): v is Preset {
  return v === "daily" || v === "strict";
}

/** 优先级：环境变量 > 模式文件 > 默认 */
function resolvePreset(): Preset {
  const fromEnv = (process.env[MODE_ENV] ?? "").trim().toLowerCase();
  if (isPreset(fromEnv)) return fromEnv;
  try {
    const fromFile = fs.readFileSync(modeFilePath(), "utf8").trim().toLowerCase();
    if (isPreset(fromFile)) return fromFile;
  } catch {
    // 没有模式文件就用默认档
  }
  return PRESET_DEFAULT;
}

/** 当前档位（可变，/egress 可即时切换） */
const state: { preset: Preset } = { preset: resolvePreset() };
const cur = (): PresetSpec => PRESETS[state.preset];

// ======================= 配置 =======================

/** L1：文件名精确匹配（对 basename，大小写不敏感） */
const BLOCKED_BASENAMES = new Set([
  ".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "credentials", "creds.json", "auth.json", "trust.json",
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".gnupg",
  // v3：本机私有凭据文件（原来只靠内容规则兜，等于没拦）
  "pi-web-password.txt",
]);

/** L1：basename 通配（对 basename）—— .env.* 只列真实环境层，放行 example/sample 模板 */
const BLOCKED_BASENAME_GLOBS: RegExp[] = [
  /^\.env\.(local|dev|development|test|prod|production|staging|secret)s?$/i,
  /^id_[a-z0-9_]+$/i,   // id_* 私钥家族
  /\.(pem|key|p12|pfx)$/i,
  /^auth\.json(\.|$)/i, // pi 凭证及其 .bak 备份
  /^web-push\.json$/i,  // web 推送凭证
];

/** L1：路径片段匹配（对正斜杠归一化后的全路径，大小写不敏感）
 *  注意：不含 .pi/agent/ —— 那会误拦 models.json/settings.json 的读取，
 *  妨碍模型管理类工作流；pi 目录下只拦真正的凭证文件（见 globs） */
const BLOCKED_FRAGMENTS = [
  "/.ssh/", "/.aws/", "/.gnupg/", "/.docker/config.json",
  "secrets/", ".kube/config",
];

/** L1：write/edit 禁写路径（完整性防护，防止模型改 pi 凭证/git 元数据）
 *  注意：不含整个 .pi/ —— 那会挡住"让 pi 改 settings.json/models.json"的正常工作流 */
const PROTECTED_WRITE_FRAGMENTS = [
  "/.ssh/", "/.git/",
  ".pi/agent/auth.json", ".pi/agent/trust.json", ".pi/agent/web-push.json",
];

/** bash/powershell 中视为"读取类"的命令词。
 *  含解释器：`python -c "print(open('x').read())"` 这类内联读取绕不过文件名匹配 */
const READISH = /\b(cat|less|more|head|tail|bat|type|strings|xxd|od|base64|env|printenv|set|grep|rg|awk|sed|dd|Get-Content|gc|Select-String|openssl|python3?|node|deno|bun|ruby|perl|php|ipython|Rscript)\b/i;

/** bash 命令切 token 用的分隔符（shell 元字符 + 空白） */
const CMD_TOKEN_SPLIT = /[\s;|&()<>"'`$={}[\]*,!]+/;

/** L2：始终启用的高置信规则（baseRules） */
const REDACT_RULES_BASE: Array<[RegExp, string]> = [
  // 带前缀的 token
  [/\bsk-(ant-)?[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED_KEY]"],
  [/\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GH]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GH]"],
  [/\bglpat-[A-Za-z0-9_\-]{15,}\b/g, "[REDACTED_GITLAB]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS]"],
  [/\bAIza[0-9A-Za-z_\-]{30,}\b/g, "[REDACTED_GOOGLE]"],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, "[REDACTED_HF]"],
  [/\bsk-or-[A-Za-z0-9\-_]{20,}\b/g, "[REDACTED_OPENROUTER]"],
  // 智谱 GLM key：{32位hex}.{16位字母数字}；加 lookbehind/边界防误伤长哈希（如 git SHA）
  [/(?<![0-9a-fA-F])[0-9a-fA-F]{32}\.[A-Za-z0-9]{16}(?![A-Za-z0-9])/g, "[REDACTED_ZHIPU]"],
  // JWT
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*\b/g, "[REDACTED_JWT]"],
  // 私钥块
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_KEY]"],
  // KV 赋值：兼容 env 大写形态（MY_DB_PASSWORD=xxx），跳过"引用型"值
  // （process.env.X / config.getX() / dotted 路径 / ${VAR} / <placeholder>）
  [/\b([A-Za-z0-9_]*(?:(?:API_?)?KEY|SECRET|TOKEN|PASSW(?:OR)?D|PASSPHRASE)[A-Za-z0-9_]*)\b(\s*[:=]\s*)(?!process\.env|os\.environ|\$\{|env\.|<|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)(["']?)([A-Za-z0-9_\-\.\/+]{16,})\3/gi,
   "$1$2$3[REDACTED]$3"],
];

/** L2：strict 档才启用的补充规则（extraRules）——会命中正常代码/配置，故不默认开 */
const REDACT_RULES_EXTRA: Array<[RegExp, string]> = [
  // JSON 自定义字段（Web Push 订阅、各类 token）
  [/"((?:p256dh|auth|privateKey|publicKey|private_key|public_key|unlock_pin|enc_id|apiKey|api_key|clientSecret|client_secret|refreshToken|refresh_token|accessToken|access_token|idToken|id_token|sessionToken|session_token))"(\s*:\s*)"[^"]{12,}"/gi,
   '"$1"$2"[REDACTED]"'],
  // TOML / INI / YAML 赋值（值里可能含 = + / 等，原规则字符集覆盖不到）
  [/\b(unlock_pin|enc_id|private_key|privatekey|public_key|api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|id[_-]?token)\b(\s*[:=]\s*)(["'])([^\n"']{12,})\3/gi,
   "$1$2$3[REDACTED]$3"],
  // HTTP 认证头。前缀部分必须同时兼容“方案词”(Bearer/Basic/Token) 与“已脱敏占位”
  // ([REDACTED]/[REDACTED_KEY] …)——否则遇到 `Authorization: [REDACTED] <真token>` 时
  // \S{6,} 会只吃掉占位符，替换后字符串不变，真 token 就静默漏过去了。
  [/\b(Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|X-Access-Token|X-Auth-Key)\b(\s*[:=]\s*)(?:\[[A-Z_]+\]\s+|[A-Za-z]+\s+)?\S{6,}/gi,
   "$1$2[REDACTED]"],
  // 推送服务端点（精确到域名，避免误伤普通 API endpoint 配置）
  [/\bhttps?:\/\/[^\s"']*(?:fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|webpush)[^\s"']*/gi,
   "[REDACTED_PUSH_ENDPOINT]"],
];

/** 裸高熵串兜底用的正则 */
const BARE_TOKEN_RE = /(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{42,}(?![A-Za-z0-9_\-])/g;
const BARE_CONTEXT_RE = /(_?key|secret|token|password|passwd|passphrase|auth|credential|vapid|subscription|unlock|enc_id)/i;

/** v3：本机已知凭据文件——把其中的值当"字面量黑名单"用，精确匹配脱敏（零误报）。
 *  这是唯一能兜住"裸人记型口令"（如 16 位非随机密码）的手段，规则匹配对它无能为力。
 *  加载时机：扩展载入时一次；轮换凭据后需 /reload。文件缺失/不可读则静默跳过，
 *  值短于 MIN_KNOWN_SECRET_LEN 一律忽略，避免误伤通用词。 */
const KNOWN_SECRET_FILES = [
  "~/.pi/pi-web-password.txt",
  "~/.pi/tavily.key",
  "~/.pi/agent/web-push.json",
];
const MIN_KNOWN_SECRET_LEN = 12;

function loadKnownSecrets(): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim().length >= MIN_KNOWN_SECRET_LEN) out.push(v.trim());
  };
  for (const spec of KNOWN_SECRET_FILES) {
    try {
      const p = spec.startsWith("~") ? homeDir() + spec.slice(1) : spec;
      if (!p || !fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, "utf8");
      if (p.toLowerCase().endsWith(".json")) {
        const j = JSON.parse(text) as {
          vapidKeys?: { privateKey?: string; publicKey?: string };
          subscriptions?: Array<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>;
        };
        push(j.vapidKeys?.privateKey);
        push(j.vapidKeys?.publicKey);
        for (const s of j.subscriptions ?? []) {
          push(s?.endpoint);
          push(s?.keys?.p256dh);
          push(s?.keys?.auth);
        }
      } else {
        push(text.split("\n")[0]);
      }
    } catch {
      // 凭据文件读不了就不读，不影响其余防护
    }
  }
  return out;
}

const KNOWN_SECRETS: string[] = loadKnownSecrets();

const MAX_SWEEP_BYTES = 64 * 1024 * 1024; // 超过则跳过，避免会话结束时卡顿

// ======================= 实现 =======================

/** 裸高熵串兜底（上下文感知）。纯 hex（sha/md5）与全小写无符号串放行，减少误伤 */
function redactBareTokens(text: string, mode: PresetSpec["bareToken"]): string {
  if (mode === "off") return text;
  const perLine = mode === "contextual";
  return text
    .split("\n")
    .map((line) => {
      if (perLine && !BARE_CONTEXT_RE.test(line)) return line;
      return line.replace(BARE_TOKEN_RE, (m) => {
        if (/^[0-9a-f]+$/i.test(m)) return m;
        if (!/[A-Z]/.test(m) && !/[_-]/.test(m)) return m;
        return "[REDACTED_TOKEN]";
      });
    })
    .join("\n");
}

function redactText(text: string, spec: PresetSpec = cur()): string {
  let out = text;
  // ① 已知凭据字面量（精确，零误报）
  if (spec.knownSecrets) {
    for (const s of KNOWN_SECRETS) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  // ② 裸高熵串（上下文感知）
  out = redactBareTokens(out, spec.bareToken);
  // ③ 形态规则
  if (spec.baseRules) for (const [re, rep] of REDACT_RULES_BASE) out = out.replace(re, rep);
  if (spec.extraRules) for (const [re, rep] of REDACT_RULES_EXTRA) out = out.replace(re, rep);
  return out;
}

/** 路径归一化：反斜杠→正斜杠 + 小写（Windows 大小写不敏感） */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function basename(p: string): string {
  const n = normPath(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

function isBlockedPath(rawPath: string): string | undefined {
  const full = normPath(rawPath);
  const base = basename(rawPath);
  if (BLOCKED_BASENAMES.has(base)) return base;
  for (const re of BLOCKED_BASENAME_GLOBS) if (re.test(base)) return base;
  for (const frag of BLOCKED_FRAGMENTS) if (full.includes(frag)) return frag;
  return undefined;
}

/** L1：从 shell 命令里找出敏感目标。
 *  先按路径片段整体判断（/.ssh/ 这类会跨 token），再切 token 逐个用 isBlockedPath()
 *  —— 用 basename 判定而不是子串包含，避免 `.keys()` / `o.key` 这类误报。 */
function findSensitiveToken(cmd: string): string | undefined {
  const normalized = normPath(cmd);
  for (const frag of BLOCKED_FRAGMENTS) if (normalized.includes(frag)) return frag;
  for (const raw of cmd.split(CMD_TOKEN_SPLIT)) {
    if (!raw) continue;
    const tok = raw.replace(/^[-~]+/, "");       // 去掉 -- 前缀与 ~ 家目录符
    if (tok.length === 0) continue;
    const hit = isBlockedPath(tok);
    if (hit) return hit;
  }
  return undefined;
}

/** L3/L4：深度遍历 payload，替换所有字符串。返回替换的字符串个数 */
function deepRedact(node: unknown, spec: PresetSpec = cur()): number {
  if (typeof node === "string") return 0; // 字符串不可变，由父层处理
  if (Array.isArray(node)) {
    let n = 0;
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") {
        const r = redactText(v, spec);
        if (r !== v) { node[i] = r; n++; }
      } else n += deepRedact(v, spec);
    }
    return n;
  }
  if (node && typeof node === "object") {
    let n = 0;
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string") {
        const r = redactText(v, spec);
        if (r !== v) { obj[k] = r; n++; }
      } else n += deepRedact(v, spec);
    }
    return n;
  }
  return 0;
}

/** L4：对会话 jsonl 逐行做 JSON 感知脱敏。
 *  任一行解析失败就保留原样，全部成功且确有改动才落盘——避免把会话写坏。 */
function sweepJournal(filePath: string | undefined): number {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    const st = fs.statSync(filePath);
    if (st.size === 0 || st.size > MAX_SWEEP_BYTES) return 0;
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    let changed = 0;
    const out = lines.map((line) => {
      const body = line.trim();
      if (body.length === 0) return line;
      let obj: unknown;
      try { obj = JSON.parse(body); } catch { return line; }
      const n = deepRedact(obj);
      if (n === 0) return line;
      const next = JSON.stringify(obj);
      // 双保险：改写后仍须是合法 JSON
      try { JSON.parse(next); } catch { return line; }
      changed += n;
      return next;
    });
    if (changed === 0) return 0;
    fs.writeFileSync(filePath, out.join("\n"), "utf8");
    return changed;
  } catch {
    return 0; // 会话结束时绝不抛错
  }
}

/** 浮层提示限流：同一条消息（数字归一化后）10 分钟内最多 3 次。
 *  归一化是为了让 "脱敏 18 处" 与 "脱敏 21 处" 算同类。 */
const NOTIFY_WINDOW_MS = 10 * 60 * 1000;
const NOTIFY_MAX_PER_WINDOW = 3;
const notifyHits = new Map<string, number[]>();
function notifyWindowed(
  ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
  msg: string,
  level: "info" | "warning" | "error" = "info",
): void {
  const key = msg.replace(/\d+/g, "#");
  const now = Date.now();
  const hits = (notifyHits.get(key) ?? []).filter((t) => now - t < NOTIFY_WINDOW_MS);
  if (hits.length >= NOTIFY_MAX_PER_WINDOW) { notifyHits.set(key, hits); return; }
  hits.push(now);
  notifyHits.set(key, hits);
  try {
    ctx.ui.notify(hits.length === NOTIFY_MAX_PER_WINDOW ? `${msg}（10 分钟内同类提示已达上限）` : msg, level);
  } catch {
    // UI 不可用就静默
  }
}

/** 计数型提示（L3 出站脱敏 / L4 日志脱敏）走状态栏：原地覆盖、不堆叠、不打断。
 *  静置 STATUS_IDLE_MS 后自动清除——有活动时一直可见，停手后自己消失。 */
const STATUS_KEY = "egress";
const STATUS_IDLE_MS = (() => {
  const v = Number(process.env.PI_EGRESS_STATUS_IDLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 15_000;
})();
let statusTimer: ReturnType<typeof setTimeout> | undefined;

type StatusCtx = { ui: { setStatus?: (key: string, text?: string) => void } };

function setEgressStatus(ctx: StatusCtx, text: string): void {
  try { ctx.ui.setStatus?.(STATUS_KEY, text); } catch { return; }
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusTimer = undefined;
    try { ctx.ui.setStatus?.(STATUS_KEY, undefined); } catch { /* 忽略 */ }
  }, STATUS_IDLE_MS);
  const t = statusTimer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();   // 别拖着进程不退出
}

function clearEgressStatus(ctx: StatusCtx): void {
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = undefined; }
  try { ctx.ui.setStatus?.(STATUS_KEY, undefined); } catch { /* 忽略 */ }
}

/** /egress 状态文本 */
function describePreset(): string {
  const p = cur();
  const on = (b: boolean) => (b ? "开" : "关");
  return [
    `egress-guard 当前档位：${p.label}（${state.preset}）`,
    `  L1 敏感路径        ${p.l1 === "block" ? "拦截" : p.l1 === "warn" ? "仅告警" : "关闭"}`,
    `  L2 前缀型密钥规则   ${on(p.baseRules)}`,
    `  L2 补充形态规则     ${on(p.extraRules)}`,
    `  L2 本机凭据字面量   ${on(p.knownSecrets)}`,
    `  L2 裸高熵串兜底     ${p.bareToken}`,
    `  L3 出站 payload     ${on(p.scanPayload)}`,
    `  L4 会话日志改写     ${on(p.sweepJournal)}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  // 重复拦截记账：补 loop-guard 盲区——tool_call 链式处理中首个 block 短路返回，
 // 后来者（loop-guard）看不到被我拦的调用，其重复指纹防护对这类重试失明。
 // 所以这里自己升级：同目标第 3 次拦截强化提示，第 5 次 terminate。
  const blockCounts = new Map<string, number>();
  function escalate(key: string, baseReason: string): { block: true; reason: string; terminate?: boolean } {
    const n = (blockCounts.get(key) ?? 0) + 1;
    blockCounts.set(key, n);
    if (n >= 5) return { block: true, reason: `${baseReason}（已第 ${n} 次拦截同一目标，终止本轮）`, terminate: true };
    if (n >= 3) return { block: true, reason: `${baseReason}（已第 ${n} 次拦截：不要重试，直接向用户说明需要该内容的原因，或请用户手动提供脱敏后版本）` };
    return { block: true, reason: baseReason };
  }

  // ============ /egress：查看与切换档位 ============
  pi.registerCommand("egress", {
    description: "查看/切换 egress-guard 档位：daily（日常宽松）/ strict（安全收紧）/ status",
    getArgumentCompletions: (prefix: string) =>
      [
        { value: "status", label: "status", description: "查看当前档位与各开关" },
        { value: "daily", label: "daily", description: "日常宽松：仅告警、不改出站与日志" },
        { value: "strict", label: "strict", description: "安全收紧：拦截 + 脱敏 + 日志改写" },
      ].filter((i) => i.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg || arg === "status") {
        ctx.ui.notify(describePreset(), "info");
        return;
      }
      if (!isPreset(arg)) {
        ctx.ui.notify(`未知档位 "${arg}"，可选：daily / strict / status`, "warning");
        return;
      }
      if (arg === state.preset) {
        ctx.ui.notify(`已是 ${PRESETS[arg].label} 档，无需切换`, "info");
        return;
      }
      if (arg === "strict") {
        const ok = await ctx.ui.confirm(
          "切换到安全收紧？",
          "将拦截敏感文件读取、脱敏出站内容（含您手贴的密钥），并在会话结束时改写日志文件。",
        );
        if (!ok) { ctx.ui.notify("已取消，保持当前档位", "info"); return; }
      }
      state.preset = arg;
      clearEgressStatus(ctx);   // 旧档位的计数已无意义
      let persisted = false;
      try {
        fs.writeFileSync(modeFilePath(), arg + "\n", "utf8");
        persisted = true;
      } catch {
        // 写不进去也不影响本次会话即时生效
      }
      ctx.ui.notify(
        `egress-guard 已切到 ${PRESETS[arg].label}，立即生效${persisted ? `，并记入 ${modeFilePath()}` : "（模式文件写入失败，仅本次会话有效）"}`,
        "info",
      );
    },
  });

  // ============ L1：执行前拦截 ============
  pi.on("tool_call", async (event, ctx) => {
    const spec = cur();
    const input = event.input as Record<string, unknown>;

    // 文件类读取工具：只查 path 字段（grep/find 的 pattern/glob 是搜索式，不拦，
    // grep/find 本身遵守 .gitignore，内容泄露由 L2/L3 兜底）
    if (event.toolName === "read" || event.toolName === "ls") {
      const hit = isBlockedPath(String(input.path ?? ""));
      if (hit) {
        if (spec.l1 === "off") return undefined;
        notifyWindowed(ctx, `Sensitive path: ${hit}`, "warning");
        if (spec.l1 === "warn") return undefined;
        return escalate(`read:${hit}`, `"${hit}" 在敏感清单中，读取已阻止`);
      }
    }

    // shell 类（bash + powershell，Windows 下两个都存在）
    // v3：改用 token 抽取 + isBlockedPath()，与 read 分支同源，消除清单不对称与子串误报
    if (event.toolName === "bash" || event.toolName === "powershell") {
      const cmd = String(input.command ?? "");
      if (READISH.test(cmd)) {
        const hit = findSensitiveToken(cmd);
        if (hit) {
          if (spec.l1 === "off") return undefined;
          notifyWindowed(ctx, `Sensitive shell read: ${hit}`, "warning");
          if (spec.l1 === "warn") return undefined;
          return escalate(`shell:${hit}`, `shell 命令疑似读取敏感文件 (${hit})`);
        }
      }
    }

    // 写入类：防篡改（防止模型改 pi 凭证/git 元数据）——两档都拦，与"读"不同，
    // 写坏凭证/仓库的代价太高，且正常工作流不会碰这些路径
    if (event.toolName === "write" || event.toolName === "edit") {
      const p = normPath(String(input.path ?? ""));
      const hit = PROTECTED_WRITE_FRAGMENTS.find((f) => p.includes(f));
      if (hit) {
        notifyWindowed(ctx, `Blocked write to: ${p}`, "warning");
        return escalate(`write:${hit}`, `"${p}" 受写保护`);
      }
    }

    return undefined;
  });

  // ============ L2：执行后脱敏（落盘会话也被保护） ============
  pi.on("tool_result", async (event) => {
    const spec = cur();
    let changed = false;
    const newContent = event.content.map((part) => {
      if (part.type !== "text") return part;
      const r = redactText(part.text, spec);
      if (r !== part.text) changed = true;
      return { ...part, text: r };
    });
    return changed ? { content: newContent } : undefined;
  });

  // ============ L3：出站前扫描整个 payload ============
  // 与 secret-scan.ts 同 hook：那个扩展只告警不改，这个改。
  // 若本文件名字母序在 secret-scan 之前（默认 e < s），它会先看到脱敏后的
  // payload 而不再告警（其 isRedacted 认得 [REDACTED] 占位）。
  // 建议安装时改名为 z-egress-guard.ts：让 secret-scan 先扫（原始告警）
  // 本扩展后脱敏（防护），观测与防护双全；下面的 notify 兜底两种顺序都成立。
  pi.on("before_provider_request", async (event, ctx) => {
    const spec = cur();
    if (!spec.scanPayload) return event.payload;
    const n = deepRedact(event.payload, spec);
    if (n > 0) setEgressStatus(ctx, `egress-guard: 出站脱敏 ${n} 处`);
    return event.payload;
  });

  // ============ L4：会话结束时对 jsonl 做事后脱敏 ============
  // L2 只覆盖 tool_result，模型把密钥写进命令行（tool_call 的 input）这一路会明文落盘。
  // 这里在会话销毁时补一刀；逐行 JSON 校验通过且确有改动才写，失败即放弃。
  pi.on("session_shutdown", async (_event, ctx) => {
    clearEgressStatus(ctx);              // 清掉本会话的残留计数，避免带到下次
    if (!cur().sweepJournal) return;
    let filePath: string | undefined;
    try { filePath = ctx.sessionManager.getSessionFile(); } catch { return; }
    const n = sweepJournal(filePath);
    if (n > 0) setEgressStatus(ctx, `egress-guard: 日志脱敏 ${n} 处`);
  });
}

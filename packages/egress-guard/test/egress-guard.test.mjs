// egress-guard 自测：直接载入同包内的 z-egress-guard.ts，mock ExtensionAPI，逐个钩子跑真实分支。
// 运行（仓库根或本包目录均可）：node packages/egress-guard/test/egress-guard.test.mjs
// 只打印 PASS/FAIL，绝不回显任何真实凭据值。
// 约定：测试用假值一律 Dummy*；认证头前缀统一用下面的 AUTH_PREFIX。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.resolve(here, "..", "z-egress-guard.ts");

// 固定初始档位 strict；把状态栏静置时长压到 80ms 便于测淡出（都必须在 import 前设置）
process.env.PI_EGRESS_MODE = "strict";
process.env.PI_EGRESS_STATUS_IDLE_MS = "80";
const ext = (await import(pathToFileURL(extPath).href)).default;

const HOME = os.homedir().replace(/\\/g, "/");   // 跨平台路径（避免写死用户名）
const H = {};
let cmdEgress = null;
ext({
  on(name, fn) { (H[name] ??= []).push(fn); },
  registerCommand(name, opts) { if (name === "egress") cmdEgress = opts; },
});
const L1 = H.tool_call[0], L2 = H.tool_result[0], L3 = H.before_provider_request[0], L4 = H.session_shutdown[0];

// 假值（同形态，全是自造）
const AUTH_PREFIX = "Authorization: Bearer ";
const D_AUTH = "DummyBearerToken0123456789";
const D_PW = "SamplePassw0rd16";
const D_P256 = "DummyP256dhValue0123456789abcd";
const D_AUTH2 = "DummyPushAuthValue0123456789";
const D_HI = "Zq7" + "k".repeat(41);
const D_SK = "sk-" + "ant-" + "DummyKeyValue" + "0123456789";   // 拼接：不落可匹配字面量
const D_44 = "Zq7" + "k".repeat(41);

// ---- 模式文件保护：测试前后原样恢复 ----
const MODE_FILE = path.join(os.homedir(), ".pi", "egress-guard.mode");
const savedMode = fs.existsSync(MODE_FILE) ? fs.readFileSync(MODE_FILE, "utf8") : null;
const restoreMode = () => {
  try {
    if (savedMode === null) { if (fs.existsSync(MODE_FILE)) fs.unlinkSync(MODE_FILE); }
    else fs.writeFileSync(MODE_FILE, savedMode, "utf8");
  } catch { /* 忽略 */ }
};

let pass = 0, fail = 0;
const ok = (c, label, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${extra ? "   " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCtx(hasUI = false) {
  const notes = [], statuses = [];
  return {
    notes, statuses, hasUI,
    ui: {
      notify: (m) => notes.push(String(m)),
      setStatus: (k, t) => statuses.push([k, t]),
      confirm: async () => true,
    },
    sessionManager: { getSessionFile: () => undefined },
  };
}
const lastStatus = (ctx) => { const s = ctx.statuses.filter(([, t]) => t !== undefined).pop(); return s ? s[1] : undefined; };
const statusCleared = (ctx) => ctx.statuses.some(([, t]) => t === undefined);

const baseCtx = fakeCtx(true);
async function switchTo(p) { const c = fakeCtx(true); await cmdEgress.handler(p, c); return c; }
async function l1(toolName, input, ctx = baseCtx) { const r = await L1({ toolName, input }, ctx); return !!(r && r.block); }
async function l2(text) { const r = await L2({ content: [{ type: "text", text }] }, baseCtx); return r ? r.content[0].text : text; }
async function l3(payload, ctx = baseCtx) { const r = await L3({ payload }, ctx); return r ?? payload; }
const sweep = (file, ctx = baseCtx) => L4({ type: "session_shutdown", reason: "quit" }, { ...ctx, sessionManager: { getSessionFile: () => file } });

console.log("\n=== strict 档 ===");
await switchTo("strict");

console.log("--- L1 读取拦截 ---");
ok(await l1("read", { path: "" + HOME + "/.pi/agent/web-push.json" }), "拦 web-push.json");
ok(await l1("read", { path: "" + HOME + "/.pi/pi-web-password.txt" }), "拦 pi-web-password.txt");
ok(await l1("read", { path: "" + HOME + "/.pi/agent/auth.json" }), "拦 auth.json");
ok(!await l1("read", { path: "" + HOME + "/.pi/agent/models.json" }), "放行 models.json");
ok(await l1("bash", { command: "cat ~/.pi/agent/web-push.json" }), "拦 cat web-push.json");
ok(await l1("bash", { command: "python -c \"print(open('" + HOME + "/.pi/agent/web-push.json').read())\"" }), "拦解释器内联读取");
ok(!await l1("bash", { command: "list(o.keys())" }), "放行 list(o 的 keys())");
ok(!await l1("bash", { command: "git commit -m 'fix key handling'" }), "放行 git commit");
ok(await l1("write", { path: "" + HOME + "/.pi/agent/web-push.json" }), "写保护拦 web-push.json");

console.log("--- L2 脱敏 ---");
let r = await l2('{"p256dh":"' + D_P256 + '","auth":"' + D_AUTH2 + '"}');
ok(!r.includes(D_P256) && !r.includes(D_AUTH2), "脱敏 JSON p256dh / auth（补充规则）");
r = await l2(AUTH_PREFIX + D_AUTH);
ok(!r.includes(D_AUTH), "脱敏 Authorization 头（方案词 + token）");
r = await l2("Authorization: [REDACTED] " + D_AUTH);
ok(!r.includes(D_AUTH), "脱敏 Authorization 头（占位符 + token，回归）");
r = await l2("unlock_pin = '" + D_HI + "'");
ok(!r.includes(D_HI), "脱敏 TOML unlock_pin");
r = await l2("password = '" + D_PW + "'");
ok(!r.includes(D_PW), "脱敏 password 赋值（基础规则）");
r = await l2("OPENAI_API_KEY=" + D_SK);
ok(!r.includes(D_SK), "脱敏 sk- 前缀（基础规则）");
r = await l2("vapid private key " + D_44);
ok(!r.includes(D_44), "脱敏上下文中的裸高熵串");
r = await l2('"cacheKey":"' + "a".repeat(64) + '"');
ok(r.includes("a".repeat(64)), "放行 64 位纯 hex（防误伤 sha256）");
r = await l2("data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".repeat(4));
ok(r.includes("iVBORw0KGgo"), "放行 base64 图片数据");

console.log("--- L3 出站脱敏 ---");
let p = { a: "keep", b: AUTH_PREFIX + D_AUTH };
await l3(p);
ok(!p.b.includes(D_AUTH), "strict 档出站被脱敏");

console.log("--- L4 会话日志改写 ---");
const tmp1 = path.join(os.tmpdir(), "egress-strict-" + Date.now() + ".jsonl");
fs.writeFileSync(tmp1, JSON.stringify({ type: "message", message: { content: [{ type: "toolCall", input: { command: "curl -H '" + AUTH_PREFIX + D_AUTH + "'" } }] } }) + "\n", "utf8");
await sweep(tmp1);
ok(!fs.readFileSync(tmp1, "utf8").includes(D_AUTH), "strict 档日志被执行脱敏");
fs.unlinkSync(tmp1);

console.log("\n=== 提示策略（L1 时间窗 / L3 状态栏静置淡出） ===");
const nctx = fakeCtx(true);
for (let i = 0; i < 6; i++) await l1("read", { path: "" + HOME + "/.pi/agent/.env" }, nctx);
const pathNotes = nctx.notes.filter((m) => m.includes("Sensitive path"));
ok(pathNotes.length === 3, "L1 浮层同类告警上限 3 次", "(实得 " + pathNotes.length + ")");
ok(pathNotes[2].includes("已达上限"), "第 3 条带时间窗上限说明");

const sctx = fakeCtx(true);
await l3({ v: AUTH_PREFIX + D_AUTH }, sctx);
ok(sctx.notes.length === 0, "L3 不再发浮层（改走状态栏）");
ok(String(lastStatus(sctx)).includes("出站脱敏"), "L3 写入状态栏", "(实得 " + lastStatus(sctx) + ")");
await sleep(200);
ok(statusCleared(sctx), "静置后状态栏自动清除");
ok(sctx.statuses.at(-1)[1] === undefined, "清除后最后一次状态事件是空值");

const cctx = fakeCtx(true);
await l3({ v: AUTH_PREFIX + D_AUTH }, cctx);
await cmdEgress.handler("daily", cctx);
ok(statusCleared(cctx), "切换档位时清除状态栏");

const ectx = fakeCtx(true);
await l3({ v: AUTH_PREFIX + D_AUTH }, ectx);
await sweep(undefined, ectx);
ok(statusCleared(ectx), "会话结束时清除状态栏");

console.log("\n=== daily 档 ===");
await switchTo("daily");

console.log("--- L1 改为仅告警 ---");
const warnCtx = fakeCtx(true);
const blocked = await l1("read", { path: "" + HOME + "/.pi/agent/trust.json" }, warnCtx);
ok(!blocked, "daily 档不再拦截读取");
ok(warnCtx.notes.length > 0, "但仍发告警通知", "(实得 " + warnCtx.notes.length + ")");
ok(await l1("write", { path: "" + HOME + "/.pi/agent/web-push.json" }), "写保护在 daily 档仍然拦");

console.log("--- L2 只保留高置信规则 ---");
r = await l2(AUTH_PREFIX + D_AUTH);
ok(r.includes(D_AUTH), "daily 档不脱敏 Authorization 头（补充规则关闭）");
r = await l2("vapid private key " + D_44);
ok(r.includes(D_44), "daily 档不做裸高熵串脱敏");
r = await l2("OPENAI_API_KEY=" + D_SK);
ok(!r.includes(D_SK), "sk- 前缀仍然脱敏（基础规则常开）");
r = await l2("password = '" + D_PW + "'");
ok(!r.includes(D_PW), "password 赋值仍然脱敏（基础规则常开）");

console.log("--- L3 / L4 关闭 ---");
p = { a: "keep", b: AUTH_PREFIX + D_AUTH };
await l3(p);
ok(p.b.includes(D_AUTH), "daily 档出站原样放行");
const dctx = fakeCtx(true);
await l3({ v: AUTH_PREFIX + D_AUTH }, dctx);
ok(lastStatus(dctx) === undefined, "daily 档不写状态栏");
const tmp2 = path.join(os.tmpdir(), "egress-daily-" + Date.now() + ".jsonl");
const orig = JSON.stringify({ type: "message", message: { content: [{ type: "toolCall", input: { command: "curl -H '" + AUTH_PREFIX + D_AUTH + "'" } }] } }) + "\n";
fs.writeFileSync(tmp2, orig, "utf8");
await sweep(tmp2);
ok(fs.readFileSync(tmp2, "utf8") === orig, "daily 档日志文件未被改写");
fs.unlinkSync(tmp2);

console.log("\n=== /egress 命令 ===");
const st = await switchTo("status");
ok(st.notes.join(" ").includes("日常宽松"), "status 报告当前档位");
const c3 = fakeCtx(true); await cmdEgress.handler("strict", c3);
ok(c3.notes.join(" ").includes("安全收紧"), "可切回 strict");
const c4 = fakeCtx(true); await cmdEgress.handler("bogus", c4);
ok(c4.notes.join(" ").includes("未知档位"), "非法档位被拒绝");
const ac = await cmdEgress.getArgumentCompletions("d");
ok(Array.isArray(ac) && ac.some((i) => i.value === "daily"), "参数补全含 daily");
ok(fs.readFileSync(MODE_FILE, "utf8").trim() === "strict", "切换已持久化到模式文件");
const ccmd = fakeCtx(true);
for (let i = 0; i < 5; i++) await cmdEgress.handler("status", ccmd);
ok(ccmd.notes.filter((m) => m.includes("当前档位")).length === 5, "/egress 命令提示不受上限约束");

restoreMode();
console.log(`\n结果：${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

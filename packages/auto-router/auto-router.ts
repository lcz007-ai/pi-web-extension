/**
 * auto-router.ts — 按任务复杂度自动路由模型（缓存税感知版）
 *
 * 设计文档：model-routing-plan.md (v2)
 *
 * 核心：订阅积分制下，切换模型的缓存重建税方向不对称——
 * 降级(高端→快速)税约为升级(快速→高端)的 1/10。因此策略为：
 *   1. 组内调级（L0↔L1 或 L2↔L3）只调 thinking level —— 零缓存税
 *   2. 降级从宽（收尾/新话题积极降级），升级从严（税费闸门）
 *   3. 长上下文升级不切模型，改用嵌套委托（streamSimple/complete 短上下文调用）
 *   4. 免税窗口：会话开局 + compaction 之后（缓存反正要重建）
 *   5. 手动切换后锁定 15 分钟；模型不在路由表则静默跳过
 *
 * 安装：复制到 ~/.pi/agent/extensions/auto-router.ts，重启 pi 生效。
 * 命令：/router on|off|status
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ==================== 配置 ====================

const PROVIDER = "<your-provider>";

/** 官方积分抵扣系数（每万 token）。来源：你的 provider 套餐文档 */
const COST = {
  "<your-high-end-model>": { input: 6.9, cached: 1.7,  output: 24 } as const,
  "<your-fast-model>":     { input: 2.3, cached: 0.56, output: 8  } as const,
} as const;
type RouterModelId = keyof typeof COST;

/** 组：0=快速模型组(L0/L1) 1=高端模型组(L2/L3)。跨组切换才需要过税费闸门 */
const GROUP: Record<RouterModelId, 0 | 1> = { "<your-fast-model>": 0, "<your-high-end-model>": 1 };

/** 四档复杂度 → 模型 + thinking
 *  档位对齐端点真实能力（你的 provider 的 thinking 文档，2026-10-06 核对）：
 *  该端点强制开启思考（thinking disabled 会报错），effort 仅支持 low/high/max。
 *  旧设计 L0=off、L2=medium 会被 pi 静默 clamp（off→low、medium→high），导致四档退化两档。 */
const TIERS = [
  { model: "<your-fast-model>",     thinking: "low"  }, // L0 快问快答（端点最低档）
  { model: "<your-fast-model>",     thinking: "high" }, // L1 常规执行（快速模型组内升档，零切换税）
  { model: "<your-high-end-model>", thinking: "low"  }, // L2 复杂开发（跨组，轻度推理）
  { model: "<your-high-end-model>", thinking: "high" }, // L3 规划评审
] as const;

/** failover 兑底目标（真钱段），与决策表 L331 处保持一致 */
const FAILOVER_TARGET = { provider: "<your-fallback-provider>", model: "<your-fallback-model>", thinking: "off" } as const;

// ==================== 自检（一致性校验，2026-10-06 方案A）====================
// 目标：把“副本与事实源脱钩”从静默退化变成启动即报警。校验的是内部一致性
// （TIERS/COST/GROUP/failover vs 模型注册表），不是外部正确性（注册表 vs 端点真实能力，
// 后者靠官方文档/实测，见 2026-10-06 修复记录）。纯函数，便于离线单测。
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 复刻 pi 的 getSupportedThinkingLevels：thinkingLevelMap 中非 null 键（xhigh/max 需显式映射） */
function supportedLevels(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> | null }): string[] {
  if (!model.reasoning) return []; // 非推理模型无档位概念
  return LEVELS.filter((l) => {
    const v = model.thinkingLevelMap?.[l];
    if (v === null) return false;
    if (l === "xhigh" || l === "max") return v !== undefined;
    return true;
  });
}

export function checkConsistency(models: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> | null }>): string[] {
  const issues: string[] = [];
  const find = (p: string, id: string) => models.find((m) => m.provider === p && m.id === id);
  // 1. TIERS：模型必须存在于注册表，且档位必须在目标模型合法档位集（防 pi 静默 clamp 错位）
  TIERS.forEach((t, i) => {
    const m = find(PROVIDER, t.model);
    if (!m) { issues.push(`TIERS L${i}: ${PROVIDER}/${t.model} 不在模型注册表`); return; }
    if (!supportedLevels(m).includes(t.thinking)) {
      issues.push(`TIERS L${i}: 档位 ${t.thinking} 不在 ${t.model} 合法档位 [${supportedLevels(m).join("/")}]，会被 pi 静默 clamp`);
    }
  });
  // 2. COST/GROUP 键应一致且都存在于注册表
  const costIds = Object.keys(COST), groupIds = Object.keys(GROUP);
  if ([...costIds].sort().join() !== [...groupIds].sort().join()) issues.push(`COST/GROUP 键不一致: [${costIds}] vs [${groupIds}]`);
  for (const id of costIds) if (!find(PROVIDER, id)) issues.push(`COST: ${PROVIDER}/${id} 不在模型注册表`);
  for (const id of new Set(TIERS.map((t) => t.model))) if (!costIds.includes(id)) issues.push(`TIERS: ${id} 缺少 COST 积分系数`);
  // 3. failover 兑底目标必须存在且档位合法
  const ft = find(FAILOVER_TARGET.provider, FAILOVER_TARGET.model);
  if (!ft) issues.push(`failover: ${FAILOVER_TARGET.provider}/${FAILOVER_TARGET.model} 不在模型注册表，兑底会失败`);
  else if (!supportedLevels(ft).includes(FAILOVER_TARGET.thinking))
    issues.push(`failover: 档位 ${FAILOVER_TARGET.thinking} 不在 ${FAILOVER_TARGET.model} 合法档位 [${supportedLevels(ft).join("/")}]`);
  return issues;
}

/** session_start / /router status 共用：跑自检并缓存结果 */
let selfCheckIssues: string[] | null = null;
function runSelfCheck(ctx: { modelRegistry?: { getAvailable(): Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> | null }> } }) {
  selfCheckIssues = checkConsistency(ctx.modelRegistry?.getAvailable() ?? []);
  return selfCheckIssues;
}

/** 升级闸门：上下文超过此 token 数后，升级改走嵌套委托而非切换 */
const UPGRADE_CTX_LIMIT = 60_000;
/** 近似免税：开局阶段上下文很小，切换税趋近于零 */
const SMALL_CTX_FREE = 30_000;
/** 手动切换后的自动路由锁定时长 */
const MANUAL_LOCK_MS = 15 * 60_000;
/** 切换冷却：刚升级后 3 分钟内不自动降级（防振荡） */
const SWITCH_COOLDOWN_MS = 3 * 60_000;
/** 嵌套委托用的深度模型（固定 medium 思考，控制思考税） */
const DELEGATE_MODEL: RouterModelId = "<your-high-end-model>";

// ==================== 边界区复核（纠错器，不依赖判级结果）====================
// 双通道优先级链：配置了 TYPESAFE_API_KEY → Jev（$0.042/M、<300ms、原生置信度）；
// 否则/失败 → <your-fast-model> 嵌套调用（走订阅套餐，1~3s，约0.1积分/次）；
// 都不可用 → 纯启发式。
// 触发：除“明确 L0 问答”和“收尾确认”外都复核——复核条件绝不能依赖判级结果，
// 否则判低→不跨组→不复核→永远判低（自锁，已修复过一次）。
// 融合规则：Jev 高置信（≥0.7）允许覆盖（含降向）；flash 嵌套无真实置信度，一律保守取较高档（只升不降）。
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 1500;
const JEV_CONFIDENCE_MIN = 0.7;
const FLASH_REVIEW_TIMEOUT_MS = 6000;
const FLASH_REVIEW_SYSTEM = "你是任务复杂度分类器。只输出 JSON，不要输出任何其他文字。";
const FLASH_REVIEW_INSTRUCTIONS =
  "评估以下用户消息的任务复杂度，输出 JSON：{\"tier\": 0-3, \"closing\": true/false}\n" +
  "tier 档位：0=快问快答/闲聊/翻译；1=常规执行（单文件小改、跑命令）；2=复杂开发（多文件、调试、部署）；3=深度工作（架构、方案、重构）\n" +
  "closing=true 表示消息只是收尾寒暄（好的/谢谢/收到）而非提出新任务。\n\n用户消息：\n";
const jevConfigured = () => !!process.env.TYPESAFE_API_KEY;
let reviewLastResult: string | null = null; // 供 /router status 展示

// ==================== Failover（层级1+2，单向链不回切）====================
// 链：<your-high-end-model> → <your-fast-model> → <your-fallback-provider>/<your-fallback-model>（真钱，停止线）→ 停止并通知。
// 连续 FAILOVER_THRESHOLD 次 429/5xx（pi 内置同模型重试后仍失败）才切；
// 切换不走过税费闸门（可用性优先）；不自动切回；手动切换重置链状态。
// 注意：套餐内两模型共享积分池，双挂 → 疑似配额耗尽/整体故障 → 进入 <your-fallback-provider> 真钱段。
const FAILOVER_THRESHOLD = 3;
let failCount = 0;
let failoverCount = 0;
let failoverNotice = "无";

// ==================== 状态 ====================

let enabled = true;
let initialized = false;          // 是否已从 ctx.model 推导过当前模型
let lastModelId: RouterModelId | null = null;
let manualLockUntil = 0;
let selfSwitchUntil = 0;          // 自身 setModel 触发的 model_select 时间窗（不算手动切换）
let freeSwitchWindow = true;      // 开局即免税窗口
let lastSwitchAt = 0;
let lastSwitchDir: "up" | "down" | null = null;
let ctxTokens = 0;                // 由 message_end 的 usage 持续校准
let totalTax = 0;                 // 累计切换税（积分，估算）
let switchCount = 0;
const hitRates: number[] = [];    // 近 N 条缓存命中率

// ==================== 工具函数 ====================

const NOTIFY_MAX = 3;                 // 同类提示最多弹 3 次
const notifySeen = new Map<string, number>();
function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" = "info") {
  try {
    // 数字归一化："第 3 次" 与 "第 5 次" 算同类，避免变体绕过上限
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

/** 当前路由表内的模型 id；不在表内返回 null（自动路由跳过） */
function routerModelOf(ctx: ExtensionContext): RouterModelId | null {
  const id = ctx.model?.id;
  if (!id || !(id in COST)) return null;
  return id as RouterModelId;
}

/** 一次切换的前缀重建税（积分估算）：新模型全价 × 上下文 token / 10000 */
function switchTax(target: RouterModelId): number {
  return (ctxTokens * COST[target].input) / 10_000;
}

// ==================== 启发式打分卡 ====================

const RX = {
  plan: /设计|架构|方案|重构|权衡|评审|选型|规划|技术路线|对比.*(优劣|好坏)|为什么.*(好|优)/,
  multiFile: /整个项目|所有模块|批量|全部文件|全局|目录树/,
  debug: /报错|exception|堆栈|traceback|不工作|跑不起来|失败|修复|fix|bug|调试/,
  risky: /部署|deploy|删除|迁移|密钥|凭证|注册表|生产环境|数据库/,
  qa: /什么是|是什么|解释一下|翻译|总结一下|怎么用|什么意思|帮我看看/,
  closing: /^(好的?|行|嗯+|ok|okay|thanks|谢谢|辛苦了?|收到|明白)[!！。.~\s]*$/i,
};
/** 单文件名匹配（用于统计文件路径个数） */
const RX_FILE = /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|json|md|css|html|java|go|rs|sql|ya?ml|toml)\b/g;

/** Jev 复核：state + 2 个并行问题（tier Choice + closing Noul）→ 结构化答案。失败返回 null。 */
async function classifyWithJev(
  prompt: string,
): Promise<{ tier: number; closing: boolean; confidence: number } | null> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      signal: ac.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: prompt.slice(0, 4000),
        questions: {
          tier: {
            type: "choice",
            instructions: "评估这条用户消息需要的智能档位",
            criteria: {
              "0": "快问快答、闲聊、翻译、单点事实查询，无需工具或仅即时回答",
              "1": "常规执行：单个文件小改动、运行命令、格式化，步骤明确",
              "2": "复杂开发：多文件改动、调试报错、部署，需要推理和多步操作",
              "3": "深度工作：架构设计、方案权衡、大型重构、疑难分析",
            },
          },
          closing: {
            type: "noul",
            instructions: "这条消息只是收尾确认或寒暄（如好的/谢谢/收到），而非提出新任务",
          },
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      answers?: Record<string, { choice?: unknown; confidence?: number; noul?: number }>;
    };
    const a = data.answers;
    if (!a?.tier || !a?.closing) return null;
    const tier = Number(a.tier.choice);
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) return null;
    return {
      tier,
      closing: Number(a.closing.noul ?? 0) > 0.9,
      confidence: a.tier.confidence ?? 0,
    };
  } catch {
    return null; // 超时/网络错误：回退纯启发式
  } finally {
    clearTimeout(timer);
  }
}

/** flash 嵌套复核（套餐内，短上下文无缓存税）。无 AbortController 透传，超时后后台调用自然结束被弃用，浪费可忽略。 */
async function classifyWithFlash(
  ctx: ExtensionContext,
  prompt: string,
): Promise<{ tier: number; closing: boolean; confidence: number } | null> {
  const model = ctx.modelRegistry.find(PROVIDER, "<your-fast-model>");
  if (!model) return null;
  try {
    const msg = await Promise.race([
      ctx.modelRegistry.complete(model, {
        systemPrompt: FLASH_REVIEW_SYSTEM,
        messages: [
          { role: "user", content: FLASH_REVIEW_INSTRUCTIONS + prompt.slice(0, 4000), timestamp: Date.now() },
        ],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FLASH_REVIEW_TIMEOUT_MS)),
    ]);
    if (!msg) return null;
    const text = (msg.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as { tier?: unknown; closing?: unknown };
    const tier = Number(j.tier);
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) return null;
    // confidence 固定 0：无真实置信度 → 调用方一律走保守 max 融合（只升不降）
    return { tier, closing: j.closing === true, confidence: 0 };
  } catch {
    return null;
  }
}

/** 返回 [级别 0-3, 是否收尾信号] */
function scorePrompt(text: string): [number, boolean] {
  let s = 0;
  let closing = false;
  if (RX.plan.test(text)) s += 3;
  if (RX.multiFile.test(text)) s += 2;
  const files = new Set(text.match(RX_FILE) ?? []);
  if (files.size >= 2) s += 2;
  if (text.length > 500) s += 2;
  else if (/```/.test(text) && text.split("\n").length > 20) s += 2;
  if (RX.debug.test(text)) s += 1;
  if (RX.risky.test(text)) s += 1;
  if (RX.qa.test(text)) s -= 2;
  if (RX.closing.test(text.trim())) {
    s -= 1;
    closing = true;
  }
  if (text.length < 50 && !/```/.test(files.size ? "x" : text)) {
    // 短消息只有在命中寒暄/收尾词时才降分；否则保持中性 0 分——
    // 连续会话中的短消息（“选项3”“继续”“按这个改”）往往是重活的延续指令，
    // 交给复核通道判定，避免“判低→不跨组→不复核→永远判低”的自锁
    if (RX.closing.test(text.trim()) || RX.qa.test(text)) s -= 2;
  }
  const tier = s <= -1 ? 0 : s <= 1 ? 1 : s <= 3 ? 2 : 3;
  return [tier, closing];
}

// ==================== 嵌套委托（升级税规避） ====================

const DELEGATE_SYSTEM =
  "你是深度分析助手。请针对用户的问题做一次透彻的分析或设计，输出结构化、可直接执行的结论。" +
  "这是一次性的深度分析调用：主对话模型稍后会基于你的结论继续工作，请务必给出完整结论而非过程叙述。";

/** 用深度模型做一次性分析，不切换主模型（无前缀缓存税）。失败返回 null。 */
async function delegateDeep(ctx: ExtensionContext, prompt: string): Promise<string | null> {
  const model = ctx.modelRegistry.find(PROVIDER, DELEGATE_MODEL);
  if (!model) return null;
  try {
    const msg = await ctx.modelRegistry.complete(model, {
      systemPrompt: DELEGATE_SYSTEM,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    });
    const text = (msg.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return text || null;
  } catch {
    return null;
  }
}

// ==================== 扩展入口 ====================

export default function (pi: ExtensionAPI) {
  // 用户手动切换模型 → 锁定自动路由。
  // "restore" 是会话恢复，不算手动；本扩展自己的 setModel 也不算（selfSwitchUntil 时间窗内跳过）。
  // 兼容 model-switch.ts（switch_model 工具）：它排定的切换在 agent_settled 落地时同样触发
  // model_select("set")，会被这里视为手动优先并锁定 15 分钟——即 AI 主动排定的切换优先于自动路由。
  pi.on("model_select", (event) => {
    if (event.source === "set" && Date.now() > selfSwitchUntil) {
      manualLockUntil = Date.now() + MANUAL_LOCK_MS;
      failCount = 0; // 手动切换重置 failover 状态（用户接管，链重新归零）
    }
  });

  // compaction 后前缀必然重建 → 免税窗口重新打开
  pi.on("session_compact", () => {
    freeSwitchWindow = true;
  });

  // 会话开始/reload 重载扩展时立即初始化路由状态（不等第一条消息）；顺跑一致性自检
  pi.on("session_start", (_event, ctx) => {
    lastModelId = routerModelOf(ctx);
    initialized = true;
    const issues = runSelfCheck(ctx);
    if (issues.length > 0 && ctx.hasUI !== false) {
      notify(ctx, `⚠ auto-router 自检发现 ${issues.length} 处断链/错位：\n${issues.map((s) => `· ${s}`).join("\n")}\n详情见 /router status`, "warning");
    }
  });

  // usage 校准：ctxTokens 近似 = 未命中输入 + 缓存命中 + 缓存写入；滚动命中率
  pi.on("message_end", (event) => {
    const m = event.message as { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
    const u = m?.usage;
    if (m?.role !== "assistant" || !u) return;
    const input = u.input ?? 0;
    const read = u.cacheRead ?? 0;
    const total = input + read + (u.cacheWrite ?? 0);
    if (total > 0) {
      ctxTokens = total;
      hitRates.push(total > 0 ? read / total : 0);
      if (hitRates.length > 20) hitRates.shift();
    }
  });

  // Failover：连续 429/5xx → 沿链自动切（主会话请求才会走这里，嵌套复核/委托不触发）
  pi.on("after_provider_response", async (event, ctx) => {
    const bad = event.status === 429 || event.status >= 500;
    if (!bad) {
      failCount = 0;
      return;
    }
    failCount++;
    if (failCount < FAILOVER_THRESHOLD) return;
    failCount = 0;

    const curId = ctx.model ? ctx.model.id : "";
    const curProvider = ctx.model ? ctx.model.provider : "";
    // 决策表：套餐内非路由表模型→套餐备胎；快速模型→按量兑底；已在兜底 provider→链尽头
    let target: { provider: string; model: string; thinking: string; warn: boolean };
    if (curId === "<your-fast-model>") {
      target = { provider: FAILOVER_TARGET.provider, model: FAILOVER_TARGET.model, thinking: FAILOVER_TARGET.thinking, warn: true };
    } else if (curProvider === "<your-fallback-provider>") {
      failoverNotice = `链尽头：${curId} 连续异常，无更多兑底`;
      notify(ctx, `⚠ failover 链尽头：<your-fallback-provider> 也连续 ${FAILOVER_THRESHOLD} 次异常，全部兑底失败，请人工介入`, "warning");
      return;
    } else {
      // 套餐内其它模型 → 先落套餐备胎（快速模型），按量段留给套餐整体故障
      target = { provider: "<your-provider>", model: "<your-fast-model>", thinking: "low", warn: false };
    }

    const m = ctx.modelRegistry.find(target.provider, target.model);
    if (!m) {
      notify(ctx, `failover：找不到 ${target.provider}/${target.model}，保持当前模型`, "warning");
      return;
    }
    selfSwitchUntil = Date.now() + 5_000;
    const ok = await pi.setModel(m);
    if (!ok) {
      notify(ctx, `failover：切换到 ${target.model} 失败，保持当前模型`, "warning");
      return;
    }
    pi.setThinkingLevel(target.thinking as never);
    failoverCount += 1;
    // 冻结主路由 15 分钟（等效用户接管）：防止主路由在免税窗口下立刻把模型切回刚故障的目标，
    // 形成切换振荡；failover 自身不受此锁限制（flash 也挂时仍推进到层级2）
    manualLockUntil = Date.now() + MANUAL_LOCK_MS;
    // 进入非路由表模型（<your-fallback-provider>）后主路由自动让位（routerModelOf 返回 null）
    initialized = false;
    lastModelId = null;
    if (target.warn) {
      failoverNotice = `已切 ${target.model}（真钱！恢复后请手动 /model 切回）`;
      notify(ctx, `⚠ failover 层级2：套餐内两模型均不可用（疑似配额耗尽/整体故障），已自动切 ${target.provider}/${target.model}（按量计费！），恢复后请手动 /model 切回`, "warning");
    } else {
      failoverNotice = `已切 ${target.model}（套餐备胎）`;
      notify(ctx, `failover 层级1：${curId} 连续 ${FAILOVER_THRESHOLD} 次异常(HTTP ${event.status})，已切 ${target.model} 兑底（不自动切回）`);
    }
  });

  // 主路由：每个任务开始前评估一次
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;
    if (Date.now() < manualLockUntil) return;

    // 懒初始化：从当前会话模型推导路由状态（兼容会话恢复）
    if (!initialized) {
      initialized = true;
      lastModelId = routerModelOf(ctx);
      if (!lastModelId) return; // 当前模型不在路由表（其它 provider 的模型），静默跳过
    }
    const current = lastModelId;
    if (!current) return;

    let [tier, closing] = scorePrompt(event.prompt);

    // 边界区复核：除“明确 L0 问答”和“收尾确认”外都复核。
    // 复核是判级的纠错者，条件不能依赖判级结果（否则判低→不跨组→不复核→永远判低）；
    // 通道链：Jev（若配置）→ flash 嵌套（套餐内）→ 回退启发式
    if (!(tier === 0 && RX.qa.test(event.prompt)) && !closing) {
      let r = jevConfigured() ? await classifyWithJev(event.prompt) : null;
      let via = r ? "Jev" : null;
      if (!r) {
        r = await classifyWithFlash(ctx, event.prompt);
        via = r ? "flash" : null;
      }
      if (r) {
        // Jev 高置信允许覆盖（含降向）；其余（低置信/flash）一律取较高档，防降级误判
        tier = via === "Jev" && r.confidence >= JEV_CONFIDENCE_MIN ? r.tier : Math.max(tier, r.tier);
        closing = closing || r.closing;
        reviewLastResult = `${via}: L${r.tier}（置信 ${r.confidence.toFixed(2)}）`;
      } else {
        reviewLastResult = "复核不可用，回退启发式";
      }
    }

    const target = TIERS[tier].model as RouterModelId;
    const targetThinking = TIERS[tier].thinking;

    // 同模型：组内调级，只动 thinking（零缓存税）
    if (target === current) {
      pi.setThinkingLevel(targetThinking);
      return;
    }

    // 带图片的消息不降级（视觉上下文交给当前模型，避免任务被误降）
    if (event.images?.length && GROUP[target] < GROUP[current]) return;

    // 收尾信号且无强开发信号 → 直接视为降级请求
    const [, closingOnly] = [tier, closing && tier <= 1];

    // ---- 跨组：升级（快速 → 高端，重税方向）----
    if (GROUP[target] > GROUP[current]) {
      const taxFree = freeSwitchWindow || ctxTokens < SMALL_CTX_FREE;
      if (taxFree || ctxTokens < UPGRADE_CTX_LIMIT) {
        // 免税窗口或小上下文：直接切换
      } else {
        // 长上下文升级：改走嵌套委托，不切换
        const text = await delegateDeep(ctx, event.prompt);
        if (text) {
          notify(ctx, `auto-router：长上下文(${Math.round(ctxTokens / 1000)}k)升级税约 ${Math.round(switchTax(target))} 分 → 已改用 ${DELEGATE_MODEL} 嵌套分析（免税）`);
          return {
            message: {
              customType: "router-delegation",
              content: `[auto-router 深度分析 · ${DELEGATE_MODEL}，主模型保持 ${current}]\n\n${text}`,
              display: true,
            },
          };
        }
        notify(ctx, "auto-router：嵌套委托失败，保持当前模型", "warning");
        return;
      }
    }

    // ---- 跨组：降级（高端 → 快速，轻税方向）----
    if (GROUP[target] < GROUP[current]) {
      // 防振荡：刚升级不久且非明确收尾 → 不降
      if (Date.now() - lastSwitchAt < SWITCH_COOLDOWN_MS && lastSwitchDir === "up" && !closingOnly) return;
    }

    // ---- 执行切换 ----
    const model = ctx.modelRegistry.find(PROVIDER, target);
    if (!model) {
      notify(ctx, `auto-router：找不到 ${PROVIDER}/${target}，保持当前模型`, "warning");
      return;
    }
    selfSwitchUntil = Date.now() + 5_000; // 标记：接下来 model_select("set") 是自己切的，不锁定
    const ok = await pi.setModel(model);
    if (!ok) {
      notify(ctx, `auto-router：切换到 ${target} 失败（无凭证？），保持当前模型`, "warning");
      return;
    }
    pi.setThinkingLevel(targetThinking);

    totalTax += switchTax(target);
    switchCount += 1;
    lastSwitchAt = Date.now();
    lastSwitchDir = GROUP[target] > GROUP[current] ? "up" : "down";
    freeSwitchWindow = false; // 免税窗口用掉
    lastModelId = target;
    notify(ctx, `auto-router → L${tier} ${target} (${targetThinking})，税≈${switchTax(target).toFixed(1)} 分`);
  });

  // /router on|off|status
  pi.registerCommand("router", {
    description: "auto-router：on/off/status 查看或开关自动模型路由",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on" || sub === "off") {
        enabled = sub === "on";
        notify(ctx, `auto-router 已${enabled ? "开启" : "关闭"}`);
        return;
      }
      const avgHit = hitRates.length ? hitRates.reduce((a, b) => a + b, 0) / hitRates.length : 0;
      const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(未知)";
      const liveRoute = routerModelOf(ctx as unknown as ExtensionContext); // 即时推导，不依赖懒初始化
      const locked = Date.now() < manualLockUntil;
      const issues = selfCheckIssues ?? runSelfCheck(ctx);
      const selfLine = issues.length === 0 ? "自检: ✓ 无断链" : `自检: ⚠ ${issues.length} 处断链/错位\n${issues.map((s) => `· ${s}`).join("\n")}`;
      const lines = [
        `状态: ${enabled ? "开启" : "关闭"} | 当前模型: ${cur} | 边界复核: ${jevConfigured() ? `Jev→flash 链（最近: ${reviewLastResult ?? "无"}）` : `flash 嵌套（最近: ${reviewLastResult ?? "无"}）`}`,
        `路由模型: ${liveRoute ?? `${cur.split("/")[1] ?? "?"}（不在路由表，自动路由静默）`} | 上下文≈${Math.round(ctxTokens / 1000)}k tokens`,
        `缓存命中率(近${hitRates.length}条): ${(avgHit * 100).toFixed(0)}% | 免税窗口: ${freeSwitchWindow ? "开" : "关"}`,
        `切换次数: ${switchCount} | 累计切换税≈${totalTax.toFixed(1)} 积分${locked ? " | 手动锁定中" : ""} | failover: ${failoverCount} 次（${failoverNotice}）`,
        selfLine,
      ];
      notify(ctx, lines.join("\n"));
    },
  });
}

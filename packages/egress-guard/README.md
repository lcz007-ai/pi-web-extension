# pi-egress-guard

> 控制**什么内容进模型**的 [pi](https://github.com/earendil-works/pi) 扩展：敏感路径拦截 + 结果/出站/会话日志三层脱敏，两档预设可随时切换。

## ⚠️ 先说清楚它是什么

**这不是安全边界，是"减噪 + 减速带"。** 它做的是模式匹配层面的清理：

- 拦得住误操作（`cat .env`、整段环境变量 dump、带前缀的 API key）
- 拦不住刻意绕过（启发式规则，内联脚本/编码/分段都能绕）
- **完全不管网络出口**——名字里的 egress 指"出站到模型"，不是"数据出网"。`curl -d @file` 一条都不查
- 图片（截图里的密钥）无法脱敏

真隔离请用容器或独立用户。厂商级别的凭据保护靠轮换和最小权限，不靠这个。

## 安装

```bash
# 方式一：从 npm 安装（推荐，随本 monorepo 发布）
pi install npm:@lcz007-ai/egress-guard

# 方式二：本地路径（本包即 packages/egress-guard）
pi install /path/to/pi-web-extension/packages/egress-guard

# 方式三：手动（单文件即可用）
cp z-egress-guard.ts ~/.pi/agent/extensions/
# 然后 /reload
```

> 文件名保留 `z-` 前缀是**有意为之**：如果同时装了 `secret-scan`（只告警不改）之类的扩展，
> 字母序能让它先看到原始 payload 去告警，本扩展再脱敏——观测与防护双全。

## 两档预设

```
/egress            # 查看当前档位与各开关
/egress strict     # 安全收紧（默认）
/egress daily      # 日常宽松
```

切换**立即生效**，并持久化到 `~/.pi/egress-guard.mode`（该文件属本机状态，不入库）。
优先级：环境变量 `PI_EGRESS_MODE` > 模式文件 > 内置默认。

**内置默认是 `strict`**——安全优先：装上就先拦住，不需要你记得去开。被拦得烦了再 `/egress daily`。

| 开关 | daily | strict |
|---|---|---|
| L1 敏感路径（`.env` / `*.pem` / `id_*` / `.ssh/` / `.aws/` …） | 仅告警，放行 | 拦截（同目标 5 次终止本轮） |
| L2 前缀型密钥（`sk-` / `AKIA` / `JWT` / 私钥块 / `PASSWORD=`） | 开 | 开 |
| L2 本机凭据字面量（读 `KNOWN_SECRET_FILES`，零误报） | 开 | 开 |
| L2 补充形态（JSON 字段 / TOML 赋值 / `Authorization` 头 / 推送端点） | 关 | 开 |
| L2 裸高熵串兜底 | off | contextual |
| L3 出站 payload 脱敏 | 关 | 开 |
| L4 会话结束时改写日志 | 关 | 开 |
| `write` 写保护（凭证 / `.git`） | 拦 | 拦 |

设计取舍：**读**放宽（日常被打断的正是读配置），**写**不放宽（写坏凭证或 git 元数据的代价太高，
而正常工作流不会碰这些路径）。规则也按误报风险拆成两组——`sk-`/`AKIA` 这类几乎不可能误伤，常开；
`Authorization:` 头、`"auth":"…"` 这类会命中正常代码配置，只在 strict 开。

**daily 下贴真密钥给模型是能看到/能用的**（L3 关），这是"宽松"的核心含义。

> 也就是说：默认档位下读 `.env`、`web-push.json`、`id_rsa` 这类文件会被**直接拦下**，
> 贴真密钥给模型会被**脱敏成 `[REDACTED]`**，会话结束时日志会被改写。这三件事就是 strict 的全部代价。

## 四层防护

| 层 | 钩子 | 做什么 |
|---|---|---|
| L1 | `tool_call` | 执行前拦 `read`/`ls` 与 `bash`/`powershell` 触达敏感路径；拦截发生在**执行之前** |
| L2 | `tool_result` | 工具结果文本脱敏（落盘会话同步受保护） |
| L3 | `before_provider_request` | 出站 payload 全量扫描，兜住手贴密钥与上下文文件 |
| L4 | `session_shutdown` | 会话结束对 jsonl 逐行做 JSON 感知脱敏，补 `tool_call` 入参盲区 |

L4 的安全阀：逐行 `JSON.parse` → 脱敏 → 再 `JSON.parse` 校验，**全部通过且确有改动才落盘**；
任何异常静默放弃。文件超过 64MB 直接跳过。

## 提示策略

- **L1 告警**：浮层，10 分钟时间窗内同类最多 3 次（数字归一化，`第 3 次`/`第 5 次` 算同类）
- **L3/L4 计数**：不发浮层，写状态栏 `setStatus("egress", "出站脱敏 18 处")`——原地覆盖、不堆叠；
  静置 15 秒无人更新后自动清除，切档与会话结束时同步清除
- `/egress` 命令的提示不受任何限制

理由：一个每请求都变的数字用浮层播报必然刷屏；而"全程只弹 3 次"又会让名额在会话开头几秒用光、
用户一次都看不到。状态栏 + 静置淡出才是计数该有的形态。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_EGRESS_MODE` | —（回落到模式文件/内置默认） | `daily` / `strict` |
| `PI_EGRESS_STATUS_IDLE_MS` | `15000` | 状态栏静置多久后清除，`0` = 立即 |

其余在源码顶部配置区，改完 `/reload`：

- `PRESETS` —— 各档位的开关组合
- `BLOCKED_BASENAMES` / `BLOCKED_BASENAME_GLOBS` / `BLOCKED_FRAGMENTS` —— L1 清单
- `KNOWN_SECRET_FILES` —— 从本机凭据文件读取字面量做精确脱敏（唯一能兜住"裸人记型口令"的手段）
- `MAX_SWEEP_BYTES` —— L4 阈值

## 已知边界

- L1 的 shell 拦截是启发式；`READISH` 动词表之外的解释器/工具链可能绕过
- L2 只挂 `tool_result`：模型自己的回复与 thinking 块**只在 L4（会话结束）时才被清理**，
  即会话进行中日志里可能暂时存着明文
- 裸人记型口令若不在 `KNOWN_SECRET_FILES` 且不符合任何形态，匹配不到
- 图片不脱敏
- 网络出口不设防

## 开发

```bash
node packages/egress-guard/test/egress-guard.test.mjs   # 44 项，直载 .ts 走真实钩子
```

测试 mock `ExtensionAPI`、逐个钩子跑真实分支，覆盖两档差异、L1 清单、L2 各形态规则、
L3/L4、提示策略（窗口限流、状态栏淡出、切档/结束清除）与 `/egress` 命令。
测试会临时改写 `~/.pi/egress-guard.mode`，结束时还原。

## License

MIT

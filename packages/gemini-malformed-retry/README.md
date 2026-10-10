# gemini-malformed-retry

[pi agent](https://github.com/earendil-works/pi) 扩展：对 Gemini 返回的**未文档化 finish reason** 自动延时重发。

## 背景

Gemini 偶发返回未文档化的 `finishReason`（如 `MALFORMED_RESPONSE`）。pi 的 `mapStopReason()` 对其做穷举 switch，落到 default 抛 `Unhandled stop reason: <REASON>`；这类错误不匹配 pi 的 `RETRYABLE_PROVIDER_ERROR_PATTERN`，因此 pi **不会自动重试**，整轮直接失败。手动立刻重发又常撞免费档 RPM 限制（429）。

## 机制

在 `agent_before_settle`（pi 放弃自动重试后的最后可续跑边界）拦截：

1. 剔除出错的 assistant 消息（`context_edit` + `replacement:null`，否则 `canContinue=false`）
2. 指数退避等待后 `return continue:true`，让 pi 用干净上下文重发
3. 达到最大次数后放行，把错误如实暴露

## 命中规则（按顺序，先匹配先赢）

| 规则 | 匹配 | 默认重发次数 |
| --- | --- | --- |
| `malformed-response` | `MALFORMED_RESPONSE`（服务端随机，重发通常可解） | 3 |
| `unknown-finish-reason` | 其它 `Unhandled stop reason: X`（SDK 枚举漂移） | 1 |
| `malformed-tool-call` | `MALFORMED_FUNCTION_CALL` / `UNEXPECTED_TOOL_CALL` | 1 |

安全类（`SAFETY` / `RECITATION` / `PROHIBITED_CONTENT` 等）**不重发**（确定性，重发无益）。

## 命令

- `/malformed-retry on|off`：开关
- `/malformed-retry status`：查看当前配置
- `/malformed-retry delay <ms>` / `max <n>` / `unknown <n>`：调整退避与次数（重启后回到默认）

## 安装

将 `gemini-malformed-retry.ts` 放入 `~/.pi/agent/extensions/`（全局），`/reload` 热重载即可。

或从 npm（发布后）：

```bash
pi install npm:@lcz007-ai/gemini-malformed-retry
```

# auto-router

[pi agent](https://github.com/earendil-works/pi) 扩展：按任务复杂度自动路由模型（缓存税感知版）。

订阅积分制下，切换模型的缓存重建税方向不对称——降级（高端→快速）税约为升级（快速→高端）的 1/10。本扩展据此在「组内调 thinking（零缓存税）/ 降级从宽 / 升级从严 / 长上下文改嵌套委托」之间做权衡。

## 上下文缓存机制（路由依据）

缓存的是**前缀 token 序列的 KV**，不是「问题」也不是语义：命中只能从开头连续匹配，中间任一处不同则其后全部作废；且**按模型隔离**，跨模型不共享缓存。

| | 隐式（自动） | 显式（手动断点） |
|---|---|---|
| 触发 | provider 自动识别重复前缀 | 请求里标 `cache_control` |
| 写入计费 | 不计（仅命中打折） | 写缓存加价，`cacheWrite ≠ 0` |
| 例子 | [DeepSeek 上下文缓存](https://api-docs.deepseek.com/guides/kv_cache)、[智谱 GLM 上下文缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache) | Anthropic 系 |

易踩坑的行为：

- **以「前缀单元」为单位，不是任意切片**。DeepSeek 因 Sliding Window Attention，只在请求边界、公共前缀探测、固定 token 间隔三处持久化 cache prefix unit，后续请求必须**完整匹配某个单元**才命中：`A+B` → `A+B+C` 命中 `A+B`；`A+B` → `A+C` 不命中（但会持久化公共前缀 `A`）→ `A+D` 命中 `A`
- **best-effort**，不保证 100%；建缓存要几秒；不用后自动清理，**通常几小时到几天**（实测跨 14 小时空档后同一前缀仍近乎全命中）
- **前缀太短不触发**：智谱建议重复前缀 ≥500 token
- **缓存异步生效**：智谱明确「首次请求后稍等片刻再发起后续请求」——紧连两发可能白搭
- **可观测**：响应 `usage` 的 `cacheRead` / `cacheWrite` / `input`（供应商侧对应 `prompt_cache_hit_tokens`、`prompt_tokens_details.cached_tokens`）

命中与未命中的价差（[DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing)、智谱 Coding Plan 积分表口径）：

| 供应商 / 模型 | 命中 | 未命中 | 比值 |
|---|---|---|---|
| DeepSeek `deepseek-flash`（低峰） | $0.003 /1M | $0.15 /1M | **1/50** |
| 智谱 `glm-5.3` | 1.7 积分/万 | 6.9 积分/万 | ≈ 1/4 |
| 智谱 `glm-5.3-flash` | 0.56 积分/万 | 2.3 积分/万 | ≈ 1/4 |

**打掉缓存**（从变化点起全部重建）：换模型、系统提示变化、工具集或工具描述变化、在历史前部插入/重排、compact 摘要。
**零代价**（只动尾部）：追加消息、**同模型内调 thinking 档**、工具调用。

自查命中率：`/router status` 的滚动命中率（扩展在 `message_end` 按 `input + cacheRead + cacheWrite` 校准）；原始数据见会话日志 `~/.pi/agent/sessions/**/*.jsonl` 的 `usage`。

## 功能

- 四档复杂度 L0–L3 → 模型 + thinking 组合；同组内只调 thinking（零缓存税）
- **降级从宽**：收尾、新话题积极降级；**升级从严**：上下文超阈值不切模型，改走 `<your-high-end-model>` 嵌套委托（一次性短上下文分析）
- 免税窗口：会话开局 + compaction 之后（前缀反正要重建）
- 手动切换后锁定自动路由 15 分钟；模型不在路由表则静默跳过
- Failover：连续 429/5xx 沿链切换 `<your-high-end-model> → <your-fast-model> → <your-fallback-provider>/<your-fallback-model>`（真钱段，停止线），不自动切回
- 边界复核：可选 Jev（需 `TYPESAFE_API_KEY`）→ `<your-fast-model>` 嵌套复核 → 回退纯启发式
- 启动自检：TIERS/COST/GROUP/failover 与模型注册表的一致性校验，断链启动即告警

## 命令

- `/router on|off`：开关自动路由
- `/router status`：查看当前路由、缓存命中率、累计切换税、failover 状态与自检结果

## 安装

将 `auto-router.ts` 放入 `~/.pi/agent/extensions/`（全局），`/reload` 热重载即可。

或从 npm（发布后）：

```bash
pi install npm:@lcz007-ai/auto-router
```

## 说明

- 当前路由表：`<your-provider>/<your-high-end-model>`、`<your-provider>/<your-fast-model>`；其它模型不在表内时自动路由静默让位。
- 可选环境变量 `TYPESAFE_API_KEY`：配置后启用 Jev 边界复核通道（低延迟、原生置信度）。
- 目标端点能力（强制思考、effort 仅 low/high/max）需与 `TIERS` 对齐，否则会被 pi 静默 clamp；启动自检会提示错位。

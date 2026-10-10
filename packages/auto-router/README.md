# auto-router

[pi agent](https://github.com/earendil-works/pi) 扩展：按任务复杂度自动路由模型（缓存税感知版）。

智谱 Coding Plan 积分制下，切换模型的缓存重建税方向不对称——降级（5.3→flash）税约为升级（flash→5.3）的 1/10。本扩展据此在「组内调 thinking（零缓存税）/ 降级从宽 / 升级从严 / 长上下文改嵌套委托」之间做权衡。

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

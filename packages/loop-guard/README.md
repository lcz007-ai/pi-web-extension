# loop-guard

[pi agent](https://github.com/earendil-works/pi) 扩展：死循环防护 + 优雅降级。当 agent 陷入重复失败、原地打转时及时熔断，避免烧穿 token 与时间。

## 状态机

```
normal → summarize → hard
```

- **normal**：正常执行，各层计数器持续记账
- **summarize**：软熔断——不再执行任何工具，注入最终指令引导模型直接输出总结；若模型执迷（连续 2 次仍尝试调工具）进入 hard
- **hard**：强制终止本轮

## 四层防御

| 层 | 触发条件 | 动作 |
|---|---|---|
| L1 连续错误熔断 | 连续 3 次工具调用失败且中间无任何成功 | summarize |
| L2 重复指纹（tail-run） | 同指纹且上次失败：第 2 次软拦、第 3 次 summarize；上次成功（观察型重试）放宽到 5 次 | 软拦 / summarize |
| L3 轮次兜底 | 超过 `LOOP_GUARD_MAX_TURNS`（默认 100） | summarize |
| L4 无进展检测 | 同一 bash 命令 + 完全相同的失败输出：第 3 次起在结果后追加提示，第 5 次 summarize | 软提示 / summarize |

L4 专抓"改代码 → 测试 → 同样失败 → 再改"的**创造性死循环**：计数跨 edit 不清零（edit 成功不清零），只有 bash 的失败输出指纹参与统计。

## 优雅降级

summarize 模式下不硬停：通过 `context` 钩子注入最终指令（"不要再调工具，基于已收集的信息输出最终答复"），并软 block 所有工具调用。给模型一次自己收尾的机会，执迷才真正终止。

软提示通道：L4 在 `tool_result` 后追加备注（不 block），模型看到"输出+备注"继续工作。

## 安装

将 `loop-guard.ts` 放入 `~/.pi/agent/extensions/`（全局），`/reload` 热重载即可。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOOP_GUARD_MAX_TURNS` | 100 | L3 轮次上限 |
| `LOOP_GUARD_MAX_ERROR_RUN` | 3 | L1 连续失败熔断阈值 |
| `LOOP_GUARD_NOPROG_NOTE` | 3 | L4 开始追加提示的次数 |
| `LOOP_GUARD_NOPROG_STOP` | 5 | L4 熔断次数 |

## 已知边界

- 无进展检测只统计 bash 的失败输出；edit 振荡（改了又撤销）不检测——误伤风险高，交给 L3 轮次兜底
- 并行模式下同批调用只有部分被拦时，agent 不会立即停，下一轮同批调用会再次被拦，通常多花一轮
- 超长任务（大批量重构、长链路调研）建议调高 `LOOP_GUARD_MAX_TURNS`，避免过早熔断

## 说明

- 熔断仅作用于当前会话（`agent_start` 时全部计数器重置），不跨会话记忆
- 扩展内不含任何密钥，不上传任何数据

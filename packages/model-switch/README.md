# model-switch

[pi agent](https://github.com/earendil-works/pi) 扩展：授权 agent 自主切换当前会话的模型——设计/规划类任务切到高阶模型，开发/编码类任务切到低阶快速模型，按任务类型动态分配算力与费用。

## 功能

注册工具 `switch_model`：

- `action="list"` —— 列出当前模型、语义别名、全部可切换模型
- `action="switch"`（默认，给了 `model` 即视为 switch）—— 按 **语义别名 / provider/id / 裸 id / 唯一关键字** 切换，可选 `thinking` 指定思考等级、`reason` 记录切换原因

```
switch_model(model="planning")   # → 高阶模型（预设 thinking: high）
switch_model(model="execute")    # → 快速模型（预设 thinking: low）
switch_model(model="vendor/x", thinking="off")
```

## 安装与配置

```bash
cp model-switch.ts ~/.pi/agent/extensions/
# pi 中执行 /reload 热重载
```

**⚠️ 必须先改 `ALIASES`**：文件中的别名目标是占位符（`<your-high-end-model>` / `<your-fast-model>`），请替换为你自己在 pi 中配置好的真实模型（`provider/id` 形式）。别名键名可自由增删改，建议与 `AGENTS.md` 里的模型选择策略配套使用：

```
## 模型选择策略
- 设计、规划、方案权衡 → switch_model(model="planning")
- 开发、编码、部署落地 → switch_model(model="execute")
```

## 行为边界（重点）

- 等价于 `/model`：只改当前会话，**不写** `settings.json` 的 `defaultModel`
- **同 provider 切换**：立即生效，本轮的后续调用由新模型执行
- **跨 provider 切换**：目标模型未标 `reasoning: true` 时**排定到本轮结束后生效**。原因：pi 在跨模型时会剥离 `reasoning_content`，而部分端点强制要求回传，同一轮内切会直接 400；目标标了 `reasoning: true` 时 pi 会以空占位回传（实测可通过），允许同轮生效。排定后若再切回当前模型，视为取消排定
- 目标 provider 未配置凭据时拒绝切换，工具报错并保留原模型
- 思考等级优先级：显式参数 > scoped pin（如 `--models "id:high"`）> 别名预设 > 保持当前
- 用户手动 `/model` 切换后，未生效的排定自动丢弃

## 实现细节

- 排定切换的 `pending` 状态放在 `init` 闭包内（每会话 rebind 各自独立）——放模块顶层会成为进程级单例，多会话并发时 A 排定的切换会被最先 settle 的会话 B 消费（实测串台）
- 闭包被跨会话复用时，另有 `sessionFile` 比对作最后防线

## 说明

- 扩展内不含任何密钥、不写任何配置文件

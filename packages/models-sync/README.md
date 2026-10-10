# models-sync

[pi agent](https://github.com/earendil-works/pi) 扩展版模型清单同步（替代常驻的 `pi-models-sync.mjs`）。随 pi 进程加载，不额外占用后台进程。

## 做两件事

1. 给 `models.json` 里的**裸条目**（只有一个 `id` 键）补元数据：先查内置表 `~/.pi/pi-models-builtin.json`，再查 [models.dev](https://models.dev)（本地缓存 24h）。
2. 维护 `settings.json` 的 `enabledModels`：新增模型自动加入，被删除的模型自动移除。

## 白名单策略（关键）

- **只增**：`models.json` 里"真新增"（不在上次 known 快照中）且未被覆盖的模型，追加 `"provider/id"`；用户在面板关闭的模型不会被自动加回。
- **只减**：`enabledModels` 里"精确条目（非 glob）"在 `models.json` 中已不存在时移除。为避免误删，仅当 ①本工具添加过（台账）或 ②该 provider 在 `models.json` 中有配置时才回收；未知 provider 的精确条目视为用户手写，保留。
- **glob（含 `*`）永不动**，作为"我就要这些内置模型"的逃生口。
- 更保守（只回收台账内条目）：设 `PI_MODELS_SYNC_KEEP_UNMANAGED=1`。

## 触发时机

- `session_start` / `resources_discover`：每次会话启动/重载同步一次
- 会话存续期间 `fs.watch` 监视 `models.json`，面板保存后自动同步并刷新模型注册表
- `session_shutdown`：引用计数归零时关闭 watch
- `/models-sync` 命令：手动同步 + 刷新

## 安装

将 `models-sync.ts` 放入 `~/.pi/agent/extensions/`（全局），`/reload` 热重载即可。

或从 npm（发布后）：

```bash
pi install npm:@lcz007-ai/models-sync
```

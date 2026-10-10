# session-artifacts

[pi agent](https://github.com/earendil-works/pi) 扩展：为每个会话在 `<cwd>/pi-document` 下维护一个以**会话标题**命名的产物目录。

## 功能

- 会话开始 / 继续时自动创建会话产物子文件夹
- 会话标题变化时同步重命名子文件夹
- 通过系统提示引导模型把本会话的产物写入该目录
- 仅在 `<cwd>/pi-document` 目录存在时启用，避免影响其他项目

## 关键改进

- **防撞名**：无标题/无消息时的占位名改用完整 sessionId（UUIDv7 前 8 位是时间戳高位，截短会导致同一分钟内多个会话占位名相同、堆出 `(2)(3)` 后缀）。
- **惰性 GC**：pi 的会话文件在第一条 assistant 回复前不落盘，"session_start 触发过但从未聊起来"的会话会留下空壳目录；GC 定期把这类死会话目录移入 `<root>/.trash/`（不直接删除，可人工恢复）。
- **标题同步更可靠**：pi-web 改标题有两条路径（auto-name 事件、手动重命名离线写会话文件），后者不触发运行时事件；本扩展以**会话文件中的最新 `session_info` 为权威标题来源**，用 `fs.watch` 监视会话文件即时同步，并以低频轮询兜底，同时保留 `session_info_changed` / `turn_end` 事件路径。

## 安装

将 `session-artifacts.ts` 放入 `~/.pi/agent/extensions/`（全局），`/reload` 热重载即可。

或从 npm（发布后）：

```bash
pi install npm:@lcz007-ai/session-artifacts
```

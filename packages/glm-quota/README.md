# glm-quota

[pi agent](https://github.com/earendil-works/pi) 扩展：在输入框上方实时显示 GLM Coding Plan 余量。

## 功能
- 显示 5 小时窗口 / 周窗口的剩余额度、已用百分比、重置倒计时
- 百分比变色：<30% 绿色、≥70% 橙色、≥90% 红色
- 密钥零配置：自动复用 pi 已配置的智谱 provider（zai-cn 等），兜底读 `ZAI_CN_KEY` / `ZAI_API_KEY` / `ZHIPUAI_API_KEY`
- 自动刷新：默认每 5 分钟（`GLM_QUOTA_REFRESH_MS` 可调，设 0 关闭）
- `/glm-quota` 命令手动刷新

## 安装
将 `glm-quota.ts` 放入 `~/.pi/agent/extensions/`（全局），`/reload` 热重载即可。

## 说明
- 数据接口：`GET {host}/api/monitor/usage/quota/limit`（Authorization 直接传 key，不带 Bearer 前缀）
- 仅本地查询智谱 API，不上传任何数据；扩展内不含任何密钥

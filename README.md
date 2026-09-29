# 🧩 Pi Web Extensions for the Pi Coding Agent

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)

Independently installable [Pi Coding Agent](https://pi.dev) extensions for live GLM quota display, web
search, model switching, loop protection, egress secret guarding, and macOS developer-environment
diagnostics.

Install only what you need.

## 🚀 Quick start

Install this repository as one Pi package to enable every extension listed in the root manifest:

```bash
pi install git:github.com/lcz007-ai/pi-web-extension
```

Install a single extension directly from the repository:

```bash
pi install git:github.com/lcz007-ai/pi-web-extension#packages/glm-quota
```

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension before installing it from any third party.

## 📦 Choose an extension

| Package | Use it for | Install |
| --- | --- | --- |
| [`glm-quota`](./packages/glm-quota) | pi 扩展：实时显示 GLM Coding Plan 余量（5h/周窗口、百分比、重置倒计时） | `pi install git:github.com/lcz007-ai/pi-web-extension#packages/glm-quota` |
| [`web-search`](./packages/web-search) | pi 扩展：联网搜索，Firecrawl 主通道 + Tavily 自动兜底 | `pi install git:github.com/lcz007-ai/pi-web-extension#packages/web-search` |
| [`model-switch`](./packages/model-switch) | pi 扩展：agent 按任务类型自主切换会话模型（语义别名） | `pi install git:github.com/lcz007-ai/pi-web-extension#packages/model-switch` |
| [`loop-guard`](./packages/loop-guard) | pi 扩展：死循环防护，四层防御 + summarize 优雅降级 | `pi install git:github.com/lcz007-ai/pi-web-extension#packages/loop-guard` |
| [`egress-guard`](./packages/egress-guard) | pi 扩展：出站密钥防护，拦截敏感文件读取 + 结果/出站 payload 脱敏 | `pi install git:github.com/lcz007-ai/pi-web-extension#packages/egress-guard` |
| [`pi-macos-tools`](./packages/pi-macos-tools) | macOS 开发环境体检 doctor：系统/工具链/TCC 权限/Pi 扩展与技能巡检（只读） | `pi install git:github.com/lcz007-ai/pi-web-extension#packages/pi-macos-tools` |

## 🔧 Advanced installation

<details>
<summary>Install this repository directly from GitHub</summary>

Install the repository as one Pi package:

```bash
pi install git:github.com/lcz007-ai/pi-web-extension
```

The repository root Pi manifest explicitly lists every extension under `packages/`, so this enables all of them.

To load only selected extensions, replace the installed package entry in `~/.pi/agent/settings.json` with a resource filter:

```json
{
  "packages": [
    {
      "source": "git:github.com/lcz007-ai/pi-web-extension",
      "extensions": [
        "packages/glm-quota/glm-quota.ts",
        "packages/web-search/web-search.ts"
      ]
    }
  ]
}
```

Filters use resource paths relative to the repository root. A package directory such as `packages/glm-quota` is not enough; select its TypeScript entrypoint.

Restart Pi or run `/reload` after changing the filter. Update the checkout later with:

```bash
pi update --extensions
```

</details>

## 🗂️ Repository structure

```text
packages/                Extension packages, one directory per extension
```

Each package contains its own `package.json` (with a `pi` manifest declaring its entrypoint) and TypeScript source.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).

# pi-macos-tools

A read-only **macOS developer-environment doctor** for the [Pi](https://pi.dev) coding agent. It is the macOS-flavoured counterpart to `pi-windows-tools`: instead of shell/path plumbing (which macOS does not need — it is a Unix), it focuses on **answering "is this machine set up for development, and what is missing?"**

## Install

```bash
pi install npm:pi-macos-tools
# or from a local checkout:
pi install /absolute/path/to/pi-macos-tools
# or try without installing:
pi -e /absolute/path/to/pi-macos-tools
```

## Tools

| Tool | What it does |
|------|--------------|
| `mac_doctor` | Full report: OS/hardware, Xcode toolchain, Homebrew, ~55 developer tools on PATH, system security features, **macOS permissions (TCC)**, **Pi packages/extensions/skills**, and free disk space. `format:"json"` returns structured output. |
| `mac_permissions` | macOS TCC permission grants (Accessibility, Screen Recording, Full Disk Access, Input Monitoring, Automation, Developer Tools, …), which are held by this terminal, and whether this process has Full Disk Access. |
| `mac_pi_resources` | Installed Pi packages (from `settings.json`), extension files, and skills with name/description parsed from `SKILL.md` frontmatter. |
| `mac_tool_discover` | Is one specific command on PATH, and where does it resolve. |
| `mac_shell_detect` | Login shells from `/etc/shells` (plus common ones) and the current `$SHELL`. |

## Commands

- `/mac-doctor` — print the full doctor report to the terminal.
- `/mac-shell` — list available shells and the current one.

## What `mac_doctor` checks

**System** — `sw_vers` (product name / version / build), kernel, architecture, hardware model (`hw.model`), CPU brand, total memory, default shell, free disk on `/`.

**Xcode / toolchain** — Command Line Tools path, active developer dir (`xcode-select -p`), `xcodebuild` version, `clang`, `swift`, and whether the Xcode license has been accepted.

**Homebrew** — version and prefix (`/opt/homebrew` vs `/usr/local`).

**Tools on PATH** (grouped):

- *Languages & runtimes*: node, npm, pnpm, yarn, bun, deno, python3, pip3, uv, poetry, ruby, gem, bundle, go, rustc, cargo, rustup, java, javac, dotnet, php
- *Build & version control*: git, git-lfs, gh, make, cmake, ninja, pkg-config, bazel
- *Containers & cloud*: docker, docker compose, kubectl, helm, terraform, aws, gcloud, az
- *Package managers*: mas, port (MacPorts)
- *Apple / mobile*: xcodebuild, clang, swift, pod (CocoaPods), fastlane
- *CLI utilities*: jq, yq, rg, fd, fzf, bat, watchman, tmux, wget, curl, openssl, sqlite3, ffmpeg
- *Editors*: code, cursor, subl, nvim, vim

A probe that resolves but fails its `--version` call (e.g. the `/usr/bin/java` stub with no JDK, or `xcodebuild` without Xcode selected) is reported as `⚠` with the reason, not as present.

**System security & features** — System Integrity Protection (`csrutil status`), Gatekeeper (`spctl --status`), Developer Mode (`DevToolsSecurity -status`), FileVault (`fdesetup status`), Rosetta 2 presence.

**Permissions (TCC)** — reads the user privacy database (`~/Library/Application Support/com.apple.TCC/TCC.db`) with `sqlite3 -readonly` and reports which services have granted clients: Accessibility, Screen Recording, Full Disk Access, Input Monitoring, Automation, Developer Tools, and others. It identifies the terminal's own bundle id (via `TERM_PROGRAM` / the process's parent `.app` bundle) and marks grants that terminal holds. Because that database is only readable with Full Disk Access, a readable DB is also the signal that this process has FDA; an unreadable one is reported as "not granted".

**Pi resources** — installed packages (from `settings.json`), extension files (global `~/.pi/agent/extensions` and project `.pi/extensions`), and skills (global/project `skills/` directories plus `~/.pi/agents/skills`), with `name`/`description` parsed from each `SKILL.md` frontmatter. For npm packages it also reads the package's `pi` manifest to show how many extensions/skills it bundles.

  > **Trust gating:** when `ctx.isProjectTrusted()` is not `true`, project-scoped skills are listed **without** their frontmatter description (marked `description hidden: untrusted project`) — descriptions are attacker-controllable text in an untrusted checkout and must not reach model context. Global-scope skills are always shown (flattened and capped at 160 chars).

## Design

- **Read-only.** Only `--version` probes and status queries (`sysctl`, `sw_vers`, `csrutil`, `spctl`, `fdesetup`, `pkgutil`, `df`, `xcode-select`, `ps`, `plutil`) plus `sqlite3 -readonly` against the TCC database. Nothing is mutated; no network. The TCC database is opened read-only so no WAL is written.
- **Single exec choke point.** Every subprocess goes through one `execFile` wrapper with argument arrays (no shell string). All fixed probes use absolute system paths; the only model-controlled executable input is `mac_tool_discover`'s `name`, which is rejected if it starts with `-` or contains a NUL byte, and is then run only with the fixed argument `--version` (no additional capability beyond Pi's own `bash` tool).
- **Injection-safe output.** SQL column names come from a fixed set; regexes are built only from fixed keys; skill metadata from untrusted projects is suppressed (see trust gating above), and all metadata is control-char-flattened and length-capped before it can appear in any tool output path (`content`, `details`, or JSON).
- **No shell.** Every command is launched with `execFile` and an argument array, never a shell string. The only model-controlled input (`mac_tool_discover`'s `name`) is validated against a leading `-` and used as a bare executable name.
- **PATH-aware.** Executable lookup searches `$PATH` plus the common macOS install locations (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/.local/bin`, `~/.pyenv/shims`, …), so it works even when Pi's environment is thinner than your login shell.
- **Parallel probes.** All version probes run concurrently with short timeouts.

## Configuration

```text
PI_MACOS_TOOLS_ENABLED=false   # disable the extension entirely
```

## Requirements

- macOS (Apple Silicon or Intel). On other platforms the tools still load but report everything as missing.
- Pi with `@earendil-works/pi-coding-agent` and `@sinclair/typebox` available (both are peer deps).

## License

MIT

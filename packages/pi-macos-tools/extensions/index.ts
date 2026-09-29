/**
 * pi-macos-tools — a macOS developer-environment doctor for Pi.
 *
 * Tools:
 *   - mac_doctor          : system + toolchain + tools + security + permissions
 *                           + Pi extensions/packages/skills
 *   - mac_permissions     : macOS TCC permission grants (Accessibility, Screen
 *                           Recording, Full Disk Access, Input Monitoring, …)
 *   - mac_pi_resources    : installed Pi packages, extensions and skills
 *   - mac_tool_discover   : is a single tool on PATH, and where
 *   - mac_shell_detect    : available login shells and the current one
 *
 * Commands:
 *   - /mac-doctor         : print the full report to the terminal
 *
 * Everything is READ-ONLY: `--version` probes, `sysctl`, `sw_vers`,
 * `csrutil status`, `spctl --status`, `fdesetup status`, `df`, and read-only
 * `sqlite3` queries against the user TCC database. No config is mutated and no
 * network is used. Executables are invoked with execFile and argument arrays
 * (no shell interpolation).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import * as os from "node:os";
import { join, delimiter } from "node:path";

const execFileP = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 3000;

function tr(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

async function run(
  cmd: string,
  args: string[],
  timeout = DEFAULT_TIMEOUT_MS,
  maxBuffer = 2 * 1024 * 1024,
): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      encoding: "utf8",
      timeout,
      maxBuffer,
      windowsHide: true,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr), code: 0, timedOut: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: unknown; killed?: boolean; signal?: string };
    return {
      ok: false,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? e?.message ?? ""),
      code: typeof e?.code === "number" ? e.code : null,
      timedOut: Boolean(e?.killed || e?.signal === "SIGTERM"),
    };
  }
}

/** First non-empty line of stdout, then stderr (some tools print version to stderr). */
function versionFrom(out: CmdResult): string | undefined {
  const pick = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  return pick(out.stdout) ?? pick(out.stderr);
}

// ---------------------------------------------------------------------------
// Executable discovery (PATH + common macOS install locations)
// ---------------------------------------------------------------------------

const EXTRA_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  join(os.homedir(), ".local", "bin"),
  join(os.homedir(), ".cargo", "bin"),
  join(os.homedir(), "go", "bin"),
  join(os.homedir(), ".bun", "bin"),
  join(os.homedir(), ".deno", "bin"),
  join(os.homedir(), ".rbenv", "shims"),
  join(os.homedir(), ".pyenv", "shims"),
  join(os.homedir(), ".volta", "bin"),
  join(os.homedir(), "Library", "pnpm"),
];

function isExecutableFile(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function findExecutable(name: string): string | undefined {
  if (!name) return undefined;
  if (name.includes("/")) return isExecutableFile(name) ? name : undefined;
  const seen = new Set<string>();
  for (const dir of [...(process.env.PATH || "").split(delimiter), ...EXTRA_DIRS]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Doctor report
// ---------------------------------------------------------------------------

export interface ToolInfo {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  /** First line of stderr when the version probe failed (present but not usable). */
  error?: string;
  group: string;
}

export interface DoctorReport {
  platform: string;
  os: { productName: string; productVersion: string; build: string };
  kernel: string;
  architecture: string;
  model: string | null;
  cpu: string | null;
  memoryBytes: number;
  defaultShell: string;
  xcode: {
    commandLineToolsPath: string | null;
    developerDir: string | null;
    xcodebuild: string | null;
    clang: string | null;
    swift: string | null;
    licenseAccepted: boolean | null;
  };
  brew: { prefix: string | null; version: string | null } | null;
  tools: ToolInfo[];
  system: {
    sip: boolean | null;
    gatekeeper: boolean | null;
    developerMode: boolean | null;
    fileVault: boolean | null;
    rosetta: boolean | null;
  };
  permissions: PermissionsReport;
  pi: PiResources;
  disk: { mount: string; totalBytes: number | null; freeBytes: number | null } | null;
}

export interface PermissionsReport {
  terminal: {
    program: string | null;
    bundleId: string | null;
    process: string | null;
    appPath: string | null;
    pid: number;
  };
  /** Heuristic: true when the user TCC database was readable (implies Full Disk Access). */
  fullDiskAccess: boolean;
  tccReadable: boolean;
  tccError?: string;
  /** Services with at least one allowed client, from the user TCC database. */
  granted: { service: string; label: string; clients: string[] }[];
  /** Labels of granted services that this terminal itself holds. */
  currentTerminalGrants: string[];
  developerTools: boolean | null;
}

export interface PiResources {
  agentDir: string;
  settingsFiles: string[];
  packages: { spec: string; name?: string; extensions: number; skills: number }[];
  extensions: { source: string; path: string }[];
  skills: { source: string; name: string; path: string; description?: string; untrusted?: boolean }[];
}

interface Probe {
  name: string;
  exe: string;
  args: string[];
  timeoutMs?: number;
}

const TOOL_GROUPS: { group: string; probes: Probe[] }[] = [
  {
    group: "Languages & runtimes",
    probes: [
      { name: "node", exe: "node", args: ["-v"] },
      { name: "npm", exe: "npm", args: ["-v"] },
      { name: "pnpm", exe: "pnpm", args: ["-v"] },
      { name: "yarn", exe: "yarn", args: ["-v"] },
      { name: "bun", exe: "bun", args: ["-v"] },
      { name: "deno", exe: "deno", args: ["--version"] },
      { name: "python3", exe: "python3", args: ["--version"] },
      { name: "pip3", exe: "pip3", args: ["--version"] },
      { name: "uv", exe: "uv", args: ["--version"] },
      { name: "poetry", exe: "poetry", args: ["--version"] },
      { name: "ruby", exe: "ruby", args: ["-v"] },
      { name: "gem", exe: "gem", args: ["-v"] },
      { name: "bundle", exe: "bundle", args: ["-v"] },
      { name: "go", exe: "go", args: ["version"] },
      { name: "rustc", exe: "rustc", args: ["--version"] },
      { name: "cargo", exe: "cargo", args: ["--version"] },
      { name: "rustup", exe: "rustup", args: ["--version"] },
      { name: "java", exe: "java", args: ["-version"] },
      { name: "javac", exe: "javac", args: ["-version"] },
      { name: "dotnet", exe: "dotnet", args: ["--version"] },
      { name: "php", exe: "php", args: ["-v"] },
    ],
  },
  {
    group: "Build & version control",
    probes: [
      { name: "git", exe: "git", args: ["--version"] },
      { name: "git-lfs", exe: "git", args: ["lfs", "version"] },
      { name: "gh", exe: "gh", args: ["--version"] },
      { name: "make", exe: "make", args: ["-v"] },
      { name: "cmake", exe: "cmake", args: ["--version"] },
      { name: "ninja", exe: "ninja", args: ["--version"] },
      { name: "pkg-config", exe: "pkg-config", args: ["--version"] },
      { name: "bazel", exe: "bazel", args: ["--version"] },
    ],
  },
  {
    group: "Containers & cloud",
    probes: [
      { name: "docker", exe: "docker", args: ["--version"] },
      { name: "docker compose", exe: "docker", args: ["compose", "version"] },
      { name: "kubectl", exe: "kubectl", args: ["version", "--client"] },
      { name: "helm", exe: "helm", args: ["version", "--short"] },
      { name: "terraform", exe: "terraform", args: ["version"] },
      { name: "aws", exe: "aws", args: ["--version"] },
      { name: "gcloud", exe: "gcloud", args: ["--version"], timeoutMs: 6000 },
      { name: "az", exe: "az", args: ["version"], timeoutMs: 6000 },
    ],
  },
  {
    group: "Package managers",
    probes: [
      { name: "mas", exe: "mas", args: ["version"] },
      { name: "port (MacPorts)", exe: "port", args: ["version"] },
    ],
  },
  {
    group: "Apple / mobile",
    probes: [
      { name: "xcodebuild", exe: "xcodebuild", args: ["-version"], timeoutMs: 6000 },
      { name: "clang", exe: "clang", args: ["--version"] },
      { name: "swift", exe: "swift", args: ["--version"], timeoutMs: 6000 },
      { name: "pod (CocoaPods)", exe: "pod", args: ["--version"] },
      { name: "fastlane", exe: "fastlane", args: ["--version"], timeoutMs: 6000 },
    ],
  },
  {
    group: "CLI utilities",
    probes: [
      { name: "jq", exe: "jq", args: ["--version"] },
      { name: "yq", exe: "yq", args: ["--version"] },
      { name: "rg", exe: "rg", args: ["--version"] },
      { name: "fd", exe: "fd", args: ["--version"] },
      { name: "fzf", exe: "fzf", args: ["--version"] },
      { name: "bat", exe: "bat", args: ["--version"] },
      { name: "watchman", exe: "watchman", args: ["--version"] },
      { name: "tmux", exe: "tmux", args: ["-V"] },
      { name: "wget", exe: "wget", args: ["--version"] },
      { name: "curl", exe: "curl", args: ["--version"] },
      { name: "openssl", exe: "openssl", args: ["version"] },
      { name: "sqlite3", exe: "sqlite3", args: ["--version"] },
      { name: "ffmpeg", exe: "ffmpeg", args: ["-version"] },
    ],
  },
  {
    group: "Editors",
    probes: [
      { name: "code", exe: "code", args: ["--version"] },
      { name: "cursor", exe: "cursor", args: ["--version"] },
      { name: "subl", exe: "subl", args: ["--version"] },
      { name: "nvim", exe: "nvim", args: ["--version"] },
      { name: "vim", exe: "vim", args: ["--version"] },
    ],
  },
];

async function probeTool(probe: Probe, group: string): Promise<ToolInfo> {
  const path = findExecutable(probe.exe);
  if (!path) return { name: probe.name, found: false, group };
  const out = await run(path, probe.args, probe.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const version = out.ok ? versionFrom(out) : undefined;
  const error = !out.ok ? versionFrom(out) : undefined;
  return { name: probe.name, found: true, path, version, error, group };
}

function parseBoolish(text: string): boolean | null {
  if (/\benabled\b|\bon\b|\byes\b|status:\s*enabled/i.test(text)) return true;
  if (/\bdisabled\b|\boff\b|\bno\b|not\s+enabled/i.test(text)) return false;
  return null;
}

export async function runDoctor(cwd: string = process.cwd(), trustedProject = true): Promise<DoctorReport> {
  // ── System facts ────────────────────────────────────────────────────
  const [swVers, hwModel, cpuBrand, sip, gatekeeper, devMode, fileVault, rosetta, df, xcodeSelect] =
    await Promise.all([
      run("/usr/bin/sw_vers", []),
      run("/usr/sbin/sysctl", ["-n", "hw.model"]),
      run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
      run("/usr/bin/csrutil", ["status"]),
      run("/usr/sbin/spctl", ["--status"]),
      run("/usr/sbin/DevToolsSecurity", ["-status"]),
      run("/usr/bin/fdesetup", ["status"]),
      run("/usr/bin/pkgutil", ["--pkg-info", "com.apple.pkg.RosettaUpdateAuto"]),
      run("/bin/df", ["-k", "/"]),
      run("/usr/bin/xcode-select", ["-p"]),
    ]);

  const osInfo = {
    productName: matchLine(swVers.stdout, "ProductName") ?? "macOS",
    productVersion: matchLine(swVers.stdout, "ProductVersion") ?? os.release(),
    build: matchLine(swVers.stdout, "BuildVersion") ?? "",
  };

  // ── Xcode toolchain ─────────────────────────────────────────────────
  const [clang, swift] = await Promise.all([run("/usr/bin/clang", ["--version"]), run("/usr/bin/swift", ["--version"], 6000)]);
  const developerDir = xcodeSelect.ok ? xcodeSelect.stdout.trim() : null;
  const defaultClt = "/Library/Developer/CommandLineTools";
  const cltPath = existsSync(defaultClt)
    ? defaultClt
    : developerDir && /CommandLineTools/i.test(developerDir)
      ? developerDir
      : null;
  const xcodebuildProbe = TOOL_GROUPS.flatMap((g) => g.probes).find((p) => p.name === "xcodebuild")!;
  const xcodebuildInfo = await probeTool(xcodebuildProbe, "Apple / mobile");
  const xcodebuildVersion = xcodebuildInfo.version ?? null;
  const license = await run("/usr/bin/xcodebuild", ["-checkFirstLaunchStatus"], 4000);

  // ── Homebrew ────────────────────────────────────────────────────────
  const brewPath = findExecutable("brew");
  const brewVersion = brewPath ? versionFrom(await run(brewPath, ["--version"], 6000)) : undefined;
  const brewPrefix = brewPath ? (brewPath.replace(/\/bin\/brew$/, "") || null) : null;

  // ── Tool probes (parallel) ──────────────────────────────────────────
  const tools = (
    await Promise.all(TOOL_GROUPS.map((g) => Promise.all(g.probes.map((p) => probeTool(p, g.group)))))
  ).flat();

  // ── Permissions + Pi resources (independent, run together) ──────────
  const [permissions, piResources] = await Promise.all([checkPermissions(), Promise.resolve(scanPiResources(cwd, trustedProject))]);

  // ── Disk ────────────────────────────────────────────────────────────
  let disk: DoctorReport["disk"] = null;
  if (df.ok) {
    const parts = df.stdout.split("\n").filter(Boolean).at(-1)?.trim().split(/\s+/) ?? [];
    const totalK = Number(parts[1]);
    const freeK = Number(parts[3]);
    if (Number.isFinite(totalK)) disk = { mount: "/", totalBytes: totalK * 1024, freeBytes: Number.isFinite(freeK) ? freeK * 1024 : null };
  }

  return {
    platform: process.platform,
    os: osInfo,
    kernel: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    model: hwModel.ok && hwModel.stdout.trim() ? hwModel.stdout.trim() : null,
    cpu: cpuBrand.ok && cpuBrand.stdout.trim() ? cpuBrand.stdout.trim() : os.cpus()?.[0]?.model ?? null,
    memoryBytes: os.totalmem(),
    defaultShell: process.env.SHELL || "unknown",
    xcode: {
      commandLineToolsPath: cltPath,
      developerDir,
      xcodebuild: xcodebuildVersion,
      clang: versionFrom(clang) ?? null,
      swift: versionFrom(swift) ?? null,
      licenseAccepted: license.ok ? true : license.stderr.includes("license") ? false : null,
    },
    brew: brewPath ? { prefix: brewPrefix, version: brewVersion ?? null } : null,
    tools,
    system: {
      sip: parseBoolish(sip.stdout),
      gatekeeper: parseBoolish(gatekeeper.stdout),
      developerMode: parseBoolish(devMode.stdout),
      fileVault: parseBoolish(fileVault.stdout),
      rosetta: rosetta.ok,
    },
    permissions,
    pi: piResources,
    disk,
  };
}

function matchLine(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m?.[1]?.trim();
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function tri(v: boolean | null): string {
  return v === true ? "enabled" : v === false ? "disabled" : "unknown";
}

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export function formatDoctorReport(r: DoctorReport): string {
  const L: string[] = [];
  L.push("macOS Doctor");
  L.push("━━━━━━━━━━━━━");
  L.push(`OS: ${r.os.productName} ${r.os.productVersion}${r.os.build ? ` (${r.os.build})` : ""}`);
  L.push(`Architecture: ${r.architecture}`);
  if (r.model) L.push(`Model: ${r.model}`);
  if (r.cpu) L.push(`CPU: ${r.cpu}`);
  L.push(`Memory: ${fmtBytes(r.memoryBytes)}`);
  L.push(`Kernel: ${r.kernel}`);
  L.push(`Default shell: ${r.defaultShell}`);

  L.push("", "── Xcode / toolchain ──");
  L.push(`  ${r.xcode.commandLineToolsPath ? "✓" : "✗"} Command Line Tools${r.xcode.commandLineToolsPath ? `  ${r.xcode.commandLineToolsPath}` : "  (not selected)"}`);
  L.push(`  ${r.xcode.xcodebuild ? "✓" : "✗"} Xcode${r.xcode.xcodebuild ? `  ${r.xcode.xcodebuild}` : ""}`);
  L.push(`  ${r.xcode.clang ? "✓" : "✗"} clang${r.xcode.clang ? `  ${r.xcode.clang}` : ""}`);
  L.push(`  ${r.xcode.swift ? "✓" : "✗"} swift${r.xcode.swift ? `  ${r.xcode.swift}` : ""}`);
  if (r.xcode.licenseAccepted === false) L.push("  ⚠ Xcode license not accepted — run: sudo xcodebuild -license accept");

  if (r.brew) {
    L.push("", "── Homebrew ──");
    L.push(`  ✓ brew${r.brew.version ? `  ${r.brew.version}` : ""}`);
    if (r.brew.prefix) L.push(`  prefix: ${r.brew.prefix}`);
  }

  const groups = [...new Set(r.tools.map((t) => t.group))];
  for (const group of groups) {
    L.push("", `── ${group} ──`);
    for (const t of r.tools.filter((x) => x.group === group)) {
      if (t.found && t.version) L.push(`  ✓ ${t.name}  ${t.version}`);
      else if (t.found) L.push(`  ⚠ ${t.name}  — ${t.error ?? "not usable"}`);
      else L.push(`  ✗ ${t.name}`);
    }
  }

  L.push("", "── System security & features ──");
  L.push(`  System Integrity Protection: ${tri(r.system.sip)}`);
  L.push(`  Gatekeeper: ${tri(r.system.gatekeeper)}`);
  L.push(`  Developer Mode: ${tri(r.system.developerMode)}`);
  L.push(`  FileVault: ${tri(r.system.fileVault)}`);
  L.push(`  Rosetta 2: ${r.system.rosetta === true ? "installed" : r.system.rosetta === false ? "not installed" : "unknown"}`);

  // ── Permissions ──
  const perm = r.permissions;
  L.push("", "── Permissions (TCC) ──");
  const termName = perm.terminal.program ?? perm.terminal.process ?? "unknown";
  L.push(`  Terminal: ${termName}${perm.terminal.bundleId ? ` (${perm.terminal.bundleId})` : ""}  pid ${perm.terminal.pid}`);
  L.push(`  Full Disk Access: ${perm.tccReadable ? "✓ granted (TCC database readable)" : "✗ not granted (cannot read TCC database)"}`);
  if (perm.developerTools !== null) L.push(`  Developer Tools: ${perm.developerTools ? "enabled" : "disabled"}`);
  if (perm.granted.length === 0) {
    L.push("  No TCC grants recorded in the user database.");
  } else {
    const held = new Set(perm.currentTerminalGrants);
    for (const g of perm.granted) {
      const mark = held.has(g.label) ? "◀ this terminal" : `${g.clients.length} app(s)`;
      L.push(`  • ${g.label}  — ${mark}`);
    }
  }

  // ── Pi resources ──
  const pi = r.pi;
  L.push("", "── Pi extensions & skills ──");
  L.push(`  Agent dir: ${shortPath(pi.agentDir)}`);
  L.push(`  Settings: ${pi.settingsFiles.length ? pi.settingsFiles.map(shortPath).join(", ") : "(none found)"}`);
  L.push(`  Packages (${pi.packages.length}):`);
  if (pi.packages.length === 0) L.push("    (none)");
  for (const p of pi.packages) {
    const bundle = p.extensions || p.skills ? `  (extensions:${p.extensions} skills:${p.skills})` : "";
    L.push(`    • ${p.spec}${bundle}`);
  }
  L.push(`  Extensions (${pi.extensions.length}):`);
  if (pi.extensions.length === 0) L.push("    (none)");
  for (const e of pi.extensions) L.push(`    • [${e.source}] ${shortPath(e.path)}`);
  L.push(`  Skills (${pi.skills.length}):`);
  if (pi.skills.length === 0) L.push("    (none)");
  for (const s of pi.skills) {
    const desc = s.untrusted ? " — (description hidden: untrusted project)" : s.description ? ` — ${s.description.length > 80 ? s.description.slice(0, 80) + "…" : s.description}` : "";
    L.push(`    • ${s.name}${desc}  [${s.source}]`);
  }

  if (r.disk) {
    L.push("", "── Disk (/) ──");
    L.push(`  ${fmtBytes(r.disk.freeBytes)} free of ${fmtBytes(r.disk.totalBytes)}`);
  }

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Permissions (macOS TCC)
// ---------------------------------------------------------------------------

const TCC_SERVICE_LABELS: Record<string, string> = {
  kTCCServiceAccessibility: "Accessibility (UI automation)",
  kTCCServiceScreenCapture: "Screen Recording",
  kTCCServiceSystemPolicyAllFiles: "Full Disk Access",
  kTCCServiceSystemPolicyDesktopFolder: "Desktop folder",
  kTCCServiceSystemPolicyDocumentsFolder: "Documents folder",
  kTCCServiceSystemPolicyDownloadsFolder: "Downloads folder",
  kTCCServiceSystemPolicyRemovableVolumes: "Removable volumes",
  kTCCServiceSystemPolicyNetworkVolumes: "Network volumes",
  kTCCServiceListenEvent: "Input Monitoring",
  kTCCServicePostEvent: "Post events",
  kTCCServiceAppleEvents: "Automation (Apple Events)",
  kTCCServiceDeveloperTool: "Developer Tools",
  kTCCServiceCamera: "Camera",
  kTCCServiceMicrophone: "Microphone",
  kTCCServicePhotos: "Photos",
  kTCCServiceContactsLimited: "Contacts",
  kTCCServiceCalendar: "Calendar",
  kTCCServiceReminders: "Reminders",
  kTCCServiceBluetoothAlways: "Bluetooth",
  kTCCServiceEndpointSecurityClient: "Endpoint Security",
};

const TERM_PROGRAM_BUNDLES: Record<string, string> = {
  Apple_Terminal: "com.apple.Terminal",
  "iTerm.app": "com.googlecode.iterm2",
  WarpTerminal: "dev.warp.Warp-Stable",
  vscode: "com.microsoft.VSCode",
  Hyper: "co.zeit.hyper",
  WezTerm: "com.github.wez.wezterm",
  ghostty: "com.mitchellh.ghostty",
  Ghostty: "com.mitchellh.ghostty",
  Alacritty: "org.alacritty",
  kitty: "net.kovidgoyal.kitty",
  Tabby: "org.tabby",
};

async function queryTccDb(dbPath: string): Promise<{ readable: boolean; rows: { service: string; client: string; allowed: boolean }[]; error?: string }> {
  if (!existsSync(dbPath)) return { readable: false, rows: [], error: "TCC database not readable (needs Full Disk Access)" };
  // Modern macOS uses `auth_value` (0 denied, 2 allowed); older uses `allowed`.
  let column = "auth_value";
  const schema = await run("/usr/bin/sqlite3", ["-readonly", dbPath, "PRAGMA table_info(access);"], 4000);
  if (schema.ok && !/\bauth_value\b/.test(schema.stdout) && /\ballowed\b/.test(schema.stdout)) column = "allowed";
  const out = await run("/usr/bin/sqlite3", ["-readonly", "-separator", "|", dbPath, `SELECT service, client, ${column} FROM access;`], 4000);
  if (!out.ok) return { readable: false, rows: [], error: versionFrom(out) ?? "unable to read TCC database" };
  const rows = out.stdout
    .split(/\r?\n/)
    .map((line) => line.split("|"))
    .filter((parts) => parts.length >= 3)
    .map(([service, client, v]) => ({ service, client, allowed: Number(v) >= 1 }));
  return { readable: true, rows };
}

async function terminalIdentity(): Promise<PermissionsReport["terminal"]> {
  const program = process.env.TERM_PROGRAM || null;
  const bundleCandidates: string[] = [];
  if (process.env.__CFBundleIdentifier) bundleCandidates.push(process.env.__CFBundleIdentifier);
  if (program && TERM_PROGRAM_BUNDLES[program]) bundleCandidates.push(TERM_PROGRAM_BUNDLES[program]);

  let appPath: string | null = null;
  let processName: string | null = null;
  let cur = process.ppid;
  for (let i = 0; i < 6 && cur > 1; i++) {
    const out = await run("/bin/ps", ["-o", "ppid=,comm=", "-p", String(cur)]);
    const m = out.ok ? out.stdout.trim().match(/^(\d+)\s+(.+)$/) : null;
    if (!m) break;
    const comm = m[2];
    if (!processName) processName = comm.split("/").pop() || comm;
    const idx = comm.indexOf(".app/Contents/MacOS/");
    if (idx >= 0) {
      appPath = comm.slice(0, idx + 4);
      const plist = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")]);
      if (plist.ok && plist.stdout.trim()) bundleCandidates.push(plist.stdout.trim());
      break;
    }
    cur = Number(m[1]);
  }

  return { program, bundleId: bundleCandidates[0] ?? null, process: processName, appPath, pid: process.pid };
}

export async function checkPermissions(): Promise<PermissionsReport> {
  const terminal = await terminalIdentity();
  const userDb = join(os.homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db");
  const [tcc, devModeOut] = await Promise.all([queryTccDb(userDb), run("/usr/sbin/DevToolsSecurity", ["-status"])]);

  const byService = new Map<string, Set<string>>();
  if (tcc.readable) {
    for (const row of tcc.rows) {
      if (!row.allowed) continue;
      if (!byService.has(row.service)) byService.set(row.service, new Set());
      byService.get(row.service)!.add(row.client);
    }
  }
  const granted = [...byService.entries()]
    .map(([service, clients]) => ({ service, label: TCC_SERVICE_LABELS[service] ?? service, clients: [...clients].sort() }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const exactIds = [terminal.bundleId].filter(Boolean).map((s) => String(s).toLowerCase());
  const appPathLower = terminal.appPath?.toLowerCase() ?? null;
  const procLower = terminal.process?.toLowerCase() ?? null;
  const currentTerminalGrants: string[] = [];
  for (const g of granted) {
    const hit = g.clients.some((client) => {
      const c = client.toLowerCase();
      if (exactIds.some((id) => c === id)) return true;
      if (appPathLower && c.includes(appPathLower)) return true;
      // Process-name fallback only for literal-path clients, to avoid bundle-id
      // substring false positives (e.g. process "node" vs "com.foo.nodehelper").
      if (procLower && c.startsWith("/") && (c === procLower || c.endsWith("/" + procLower))) return true;
      return false;
    });
    if (hit) currentTerminalGrants.push(g.label);
  }

  return {
    terminal,
    fullDiskAccess: tcc.readable,
    tccReadable: tcc.readable,
    tccError: tcc.error,
    granted,
    currentTerminalGrants,
    developerTools: parseBoolish(devModeOut.stdout),
  };
}

// ---------------------------------------------------------------------------
// Pi resources (packages, extensions, skills)
// ---------------------------------------------------------------------------

function safeReadJsonFile(p: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const field = (key: string) =>
    m[1]
      .match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
  return { name: field("name"), description: field("description") };
}

/** Skill metadata comes from possibly-untrusted project files, so it is
 * flattened (no control chars) and length-capped before it can reach model
 * context via any output path (text, details, or JSON). */
function clipMeta(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  const c = s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max) + "…" : c;
}

function listSkillEntries(dir: string, source: string, includeDescription: boolean): PiResources["skills"] {
  const out: PiResources["skills"] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    try {
      if (isDir) {
        const skillFile = join(p, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
        out.push({
          source,
          name: clipMeta(fm.name ?? name, 64) ?? name,
          path: skillFile,
          description: includeDescription ? clipMeta(fm.description, 160) : undefined,
          untrusted: includeDescription ? undefined : true,
        });
      } else if (name.toLowerCase().endsWith(".md")) {
        const fm = parseFrontmatter(readFileSync(p, "utf8"));
        out.push({
          source,
          name: clipMeta(fm.name ?? name.replace(/\.md$/i, ""), 64) ?? name,
          path: p,
          description: includeDescription ? clipMeta(fm.description, 160) : undefined,
          untrusted: includeDescription ? undefined : true,
        });
      }
    } catch {
      /* unreadable entry — skip */
    }
  }
  return out;
}

function npmSpecName(spec: string): string | undefined {
  if (!spec.startsWith("npm:")) return undefined;
  const s = spec.slice(4);
  const at = s.startsWith("@") ? s.indexOf("@", 1) : s.indexOf("@");
  return (at > 0 ? s.slice(0, at) : s).trim() || undefined;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/)/, os.homedir());
}

/** Scan Pi's package settings, extension directories and skill directories. Read-only.
 * When `trustedProject` is false, project-scoped skills are listed without their
 * frontmatter description (attacker-controlled text must not reach model context
 * from an untrusted checkout) and are flagged `untrusted`. */
export function scanPiResources(cwd: string, trustedProject = true): PiResources {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent");
  const settingsPaths = [
    join(cwd, ".pi", "settings.json"),
    join(agentDir, "settings.json"),
    join(os.homedir(), ".pi", "agents", "settings.json"),
  ];
  const settingsFiles: string[] = [];
  const packageSpecs: string[] = [];
  const settingsExtensions: string[] = [];
  for (const p of settingsPaths) {
    const json = safeReadJsonFile(p);
    if (!json) continue;
    settingsFiles.push(p);
    for (const key of ["packages", "extensions"] as const) {
      const arr = json[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) if (typeof item === "string") (key === "packages" ? packageSpecs : settingsExtensions).push(item);
    }
  }

  const extensions: PiResources["extensions"] = [];
  for (const { source, dir } of [
    { source: "project", dir: join(cwd, ".pi", "extensions") },
    { source: "global", dir: join(agentDir, "extensions") },
  ]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isFile() && /\.(ts|js|mjs|cjs)$/i.test(name)) {
        extensions.push({ source, path: p });
      } else if (st.isDirectory() && ["index.ts", "index.js", "index.mjs", "index.cjs"].some((f) => existsSync(join(p, f)))) {
        extensions.push({ source, path: p });
      }
    }
  }
  for (const raw of settingsExtensions) extensions.push({ source: "settings", path: expandHome(raw) });

  const skills: PiResources["skills"] = [
    ...listSkillEntries(join(cwd, ".pi", "skills"), "project", trustedProject),
    ...listSkillEntries(join(agentDir, "skills"), "global", true),
    ...listSkillEntries(join(os.homedir(), ".pi", "agents", "skills"), "global", true),
  ];

  const packages = packageSpecs.map((spec) => {
    const name = npmSpecName(spec);
    let extCount = 0;
    let skillCount = 0;
    if (name) {
      for (const base of [join(agentDir, "npm", "node_modules", name), join(agentDir, "npm", name)]) {
        const manifest = safeReadJsonFile(join(base, "package.json"));
        const piField = manifest?.pi as { extensions?: unknown; skills?: unknown } | undefined;
        if (piField && typeof piField === "object") {
          if (Array.isArray(piField.extensions)) extCount = piField.extensions.length;
          if (Array.isArray(piField.skills)) skillCount = piField.skills.length;
          break;
        }
      }
    }
    return { spec, name, extensions: extCount, skills: skillCount };
  });

  return { agentDir, settingsFiles, packages, extensions, skills };
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

export interface ShellInfo {
  path: string;
  exists: boolean;
  current: boolean;
}

export function detectShells(): ShellInfo[] {
  let list: string[] = [];
  try {
    list = readFileSync("/etc/shells", "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch {
    list = [];
  }
  for (const fallback of ["/bin/zsh", "/bin/bash", "/bin/sh", "/opt/homebrew/bin/bash", "/usr/local/bin/fish"]) {
    if (!list.includes(fallback) && existsSync(fallback)) list.push(fallback);
  }
  const current = process.env.SHELL || "";
  return [...new Set(list)].map((path) => ({ path, exists: existsSync(path), current: path === current }));
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function piMacosToolsExtension(pi: ExtensionAPI) {
  if (process.env.PI_MACOS_TOOLS_ENABLED === "false") return;

  pi.registerTool({
    name: "mac_doctor",
    label: "macOS: Doctor",
    description:
      "Run a read-only macOS developer-environment health check: OS/hardware, Xcode toolchain, Homebrew, ~55 common developer tools on PATH, system security features (SIP, Gatekeeper, Developer Mode, FileVault, Rosetta), macOS TCC permission grants (Accessibility, Screen Recording, Full Disk Access, Input Monitoring, Automation, …), installed Pi packages/extensions/skills, and free disk space. Use format:\"json\" for structured output.",
    promptSnippet: "Run macOS developer-environment doctor",
    promptGuidelines: [
      "Use to diagnose missing toolchains, check whether a tool is installed, review permission grants, or list installed Pi extensions and skills.",
      "Read-only: it only runs --version probes, system status queries, and read-only sqlite queries against the TCC database.",
    ],
    parameters: Type.Object({
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      const report = await runDoctor(ctx?.cwd, ctx?.isProjectTrusted?.() === true);
      return p.format === "json" ? tr(JSON.stringify(report, null, 2), report) : tr(formatDoctorReport(report), report);
    },
  });

  pi.registerTool({
    name: "mac_permissions",
    label: "macOS: Permissions",
    description:
      "Report macOS TCC permission grants from the user privacy database: Accessibility, Screen Recording, Full Disk Access, Input Monitoring, Automation, Developer Tools, etc. Shows which are held by this terminal and, as a side effect, whether this process has Full Disk Access (the database is only readable with it). Read-only.",
    promptSnippet: "Inspect macOS permission (TCC) grants",
    promptGuidelines: [
      "Use when the user is missing UI automation, screen capture, or file access, or asks which apps hold a permission.",
      "If the TCC database is unreadable, tell the user to grant Full Disk Access to their terminal.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const p = await checkPermissions();
      const lines: string[] = [];
      const termName = p.terminal.program ?? p.terminal.process ?? "unknown";
      lines.push(`Terminal: ${termName}${p.terminal.bundleId ? ` (${p.terminal.bundleId})` : ""} pid ${p.terminal.pid}`);
      lines.push(`Full Disk Access: ${p.tccReadable ? "✓ granted" : `✗ not granted${p.tccError ? ` — ${p.tccError}` : ""}`}`);
      if (p.developerTools !== null) lines.push(`Developer Tools: ${p.developerTools ? "enabled" : "disabled"}`);
      if (p.granted.length === 0) lines.push("No TCC grants recorded in the user database.");
      else {
        const held = new Set(p.currentTerminalGrants);
        lines.push("Granted services:");
        for (const g of p.granted) lines.push(`  • ${g.label}${held.has(g.label) ? "  ◀ this terminal" : `  (${g.clients.length} app(s))`}`);
      }
      return tr(lines.join("\n"), p);
    },
  });

  pi.registerTool({
    name: "mac_pi_resources",
    label: "macOS: Pi Resources",
    description:
      "List installed Pi packages (from settings.json), extension files, and skills (with name/description parsed from SKILL.md frontmatter) across global (~/.pi/agent) and project (.pi) scopes. Read-only.",
    promptSnippet: "List installed Pi extensions, packages and skills",
    promptGuidelines: ["Use to see what Pi capabilities are installed before relying on them."],
    parameters: Type.Object({}),
    async execute(_id, _p, _signal, _onUpdate, ctx) {
      const res = scanPiResources(ctx?.cwd ?? process.cwd(), ctx?.isProjectTrusted?.() === true);
      const lines: string[] = [];
      lines.push(`Agent dir: ${res.agentDir}`);
      lines.push(`Settings: ${res.settingsFiles.length ? res.settingsFiles.join(", ") : "(none found)"}`);
      lines.push(`Packages (${res.packages.length}): ${res.packages.map((p) => p.spec).join(", ") || "(none)"}`);
      lines.push(`Extensions (${res.extensions.length}):`);
      for (const e of res.extensions) lines.push(`  • [${e.source}] ${e.path}`);
      if (res.extensions.length === 0) lines.push("  (none)");
      lines.push(`Skills (${res.skills.length}):`);
      for (const s of res.skills) {
        const desc = s.untrusted ? " — (description hidden: untrusted project)" : s.description ? ` — ${s.description}` : "";
        lines.push(`  • ${s.name}${desc}  [${s.source}]`);
      }
      if (res.skills.length === 0) lines.push("  (none)");
      return tr(lines.join("\n"), res);
    },
  });

  pi.registerTool({
    name: "mac_tool_discover",
    label: "macOS: Discover Tool",
    description: "Check whether a command exists on PATH (searching PATH plus common Homebrew/local bin dirs) and where it resolves.",
    promptSnippet: "Check macOS tool availability",
    promptGuidelines: ["Use to verify a CLI tool is installed before invoking it."],
    parameters: Type.Object({ name: Type.String({ description: "Executable name, e.g. 'node' or 'brew'" }) }),
    async execute(_id, p) {
      const name = String(p.name);
      if (name.startsWith("-") || name.includes("\0")) return tr(`✗ invalid tool name: ${name}`);
      const found = findExecutable(name);
      if (!found) return tr(`✗ ${name} not found on PATH`, { found: false });
      const out = await run(found, ["--version"]);
      const version = versionFrom(out);
      return tr(`✓ ${name} at:\n  ${found}${version ? `\n  ${version}` : ""}`, { found: true, path: found, version });
    },
  });

  pi.registerTool({
    name: "mac_shell_detect",
    label: "macOS: Detect Shells",
    description: "List login shells from /etc/shells plus common shells, and show which one this session uses ($SHELL).",
    promptSnippet: "Detect available macOS shells",
    promptGuidelines: ["Use before generating shell commands or configuring shell profiles."],
    parameters: Type.Object({}),
    async execute() {
      const shells = detectShells();
      const lines = shells.map((s) => `  ${s.exists ? "✓" : "✗"} ${s.path}${s.current ? " [current]" : ""}`);
      return tr(`Current shell: ${process.env.SHELL || "unknown"}\nAvailable shells:\n${lines.join("\n")}`, { shells });
    },
  });

  // ── Commands ──
  pi.registerCommand("mac-doctor", {
    description: "Run the macOS developer-environment doctor.",
    handler: async (_args, ctx) => {
      const report = await runDoctor(ctx?.cwd, ctx?.isProjectTrusted?.() === true);
      ctx?.ui?.notify?.("macOS Doctor complete.", "info");
      process.stdout.write(formatDoctorReport(report) + "\n");
    },
  });

  pi.registerCommand("mac-shell", {
    description: "List available macOS shells and the current one.",
    handler: async (_args, ctx) => {
      const shells = detectShells();
      ctx?.ui?.notify?.(`Current shell: ${process.env.SHELL || "unknown"}`, "info");
      process.stdout.write(shells.map((s) => `${s.exists ? "✓" : "✗"} ${s.path}${s.current ? " [current]" : ""}`).join("\n") + "\n");
    },
  });
}

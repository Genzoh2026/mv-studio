// Finding the Claude Code CLI, and telling the user how to install it when it is missing.
// Install commands are the ones documented at https://code.claude.com/docs/en/setup.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DOCS_URL = "https://code.claude.com/docs/en/setup";
const VERSION_TIMEOUT_MS = 10_000;

const nativeInstallPath = () => join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");

/** The first line of `<command> --version`, or null when it cannot be run. */
function versionOf(command, { shell }) {
  return new Promise((done) => {
    execFile(command, ["--version"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell }, (error, stdout) => {
      done(error ? null : stdout.trim().split(/\r?\n/)[0] || null);
    });
  });
}

/**
 * @returns {Promise<{found: boolean, command: string|null, version: string|null, where: string|null}>}
 *   `command` is what to run: "claude" (on PATH) or the full path of the native install, which is looked up as a
 *   fallback because an installer's PATH change does not reach processes that were already running.
 */
export async function detectClaude() {
  // On Windows an npm install is a .cmd shim, which only a shell can run.
  const onPath = await versionOf("claude", { shell: process.platform === "win32" });
  if (onPath) return { found: true, command: "claude", version: onPath, where: "PATH" };
  const native = nativeInstallPath();
  if (await access(native).then(() => true, () => false)) {
    const version = await versionOf(native, { shell: false });
    if (version) return { found: true, command: native, version, where: native };
  }
  return { found: false, command: null, version: null, where: null };
}

/** @returns {{label: string, command: string}[]} */
export function installCommands(platform = process.platform) {
  if (platform === "win32") {
    return [
      { label: "Windows (PowerShell)", command: "irm https://claude.ai/install.ps1 | iex" },
      { label: "Windows (WinGet)", command: "winget install Anthropic.ClaudeCode" },
    ];
  }
  if (platform === "darwin") {
    return [
      { label: "macOS", command: "curl -fsSL https://claude.ai/install.sh | bash" },
      { label: "macOS (Homebrew)", command: "brew install --cask claude-code" },
    ];
  }
  return [{ label: "Linux / WSL", command: "curl -fsSL https://claude.ai/install.sh | bash" }];
}

/** Plain-text guide for a terminal (LF line breaks). */
export function installGuideText(platform = process.platform) {
  const commands = installCommands(platform).map((c) => `  ${c.label}:  ${c.command}`).join("\n");
  return [
    "Claude Code が見つかりません。",
    `公式の導入手順: ${DOCS_URL}`,
    "",
    commands,
    "",
    "導入したら、新しいターミナルで  claude --version  を実行して確認し、",
    "アプリの ⚙ 設定 →「再確認」を押してください。",
    "それでも見つからないときは、このアプリを再起動してください(PATH は起動時に読み込まれます)。",
    "初回は claude を起動し、ブラウザでログインします(Pro / Max / Team / Enterprise / Console のいずれかが必要です)。",
  ].join("\n");
}

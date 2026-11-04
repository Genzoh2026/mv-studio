// The "install" button for catalog entries. It runs the catalog's own commands (already limited to a few safe forms) for a
// chosen project, or for all projects when the user picks that in the confirmation. The user always sees the exact commands
// first; nothing here can run a command that is not in the catalog, and the page cannot send one.
import { spawn } from "node:child_process";
import { commandProblem } from "./catalog.mjs";

const MAX_LOG_LINES = 300;
const SHOWN_LOG_LINES = 80;
const COMMAND_KINDS = new Set(["skills", "plugin", "mcp"]);
export const SCOPES = ["project", "user"];

/** The command for a scope: the catalog's project command as it is, or its user-scope twin. Pure. */
export function forScope(kind, command, scope) {
  if (scope === "project") return command;
  if (kind === "skills") return command.replace(" -a claude-code", " -g -a claude-code");
  return command.replace("--scope project", "--scope user");
}

/**
 * What installing an entry would run, or why it cannot. Pure apart from the lookups it is given.
 * @param {{catalog: object, id: string, scope: string, pjDir: string|null, userDir: string, claudeCommand: string}} input
 *   `pjDir` is the project folder for the project scope; `userDir` is where a user-scope command is run from (any folder).
 * @returns {{ok: boolean, reason: string|null, entry?: object, steps: {command: string, display: string, run: string, cwd: string}[]}}
 */
export function planInstall({ catalog, id, scope, pjDir, userDir, claudeCommand }) {
  const fail = (reason) => ({ ok: false, reason, steps: [] });
  const entry = catalog?.entries?.find((e) => e.id === id);
  if (!entry) return fail(`no catalog entry "${id}"`);
  if (!COMMAND_KINDS.has(entry.kind) || !entry.install?.commands?.length) return fail("this entry is not installed by the app (follow its steps by hand)");
  if (!SCOPES.includes(scope)) return fail(`scope must be one of ${SCOPES.join(", ")}`);
  if (scope === "project" && !pjDir) return fail("choose a project to install into");
  const cwd = scope === "project" ? pjDir : userDir;
  const steps = [];
  for (const original of entry.install.commands) {
    const command = forScope(entry.kind, original, scope);
    // Both the catalog's command and the derived one are checked, so a mistake in either never runs.
    const why = commandProblem(entry.kind, original) ?? commandProblem(entry.kind, command, { scope });
    if (why) return fail(`the catalog command is not allowed (${why}): ${original}`);
    // claude may live at a full path (the native install); the shell needs it quoted then.
    const run = command.startsWith("claude ") && claudeCommand !== "claude" ? `"${claudeCommand}"${command.slice("claude".length)}` : command;
    steps.push({ command, display: command, run, cwd });
  }
  return { ok: true, reason: null, entry, steps };
}

/** Runs one validated command line through the shell (the commands are npx and claude, which are .cmd shims on Windows). */
function runLine(line, { cwd, signal, onData }) {
  return new Promise((resolve) => {
    let child;
    try {
      // The line was checked against a strict whitelist (no quotes, pipes, ampersands, semicolons, redirects or $()).
      child = spawn(line, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", CI: "1" } });
    } catch (err) {
      onData(String(err.message));
      return resolve(1);
    }
    const stop = () => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill();
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => onData(String(chunk)));
    child.stderr.on("data", (chunk) => onData(String(chunk)));
    child.on("error", (err) => { onData(err.message); resolve(1); });
    child.on("close", (code) => { signal?.removeEventListener("abort", stop); resolve(code ?? 1); });
  });
}

// Colour codes and box-drawing from the CLIs make a poor log; keep the words.
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");
const BOX = /[│├└┌┐┘─╮╯╭╰◇◆●○]/g;
const cleanLine = (line) => line.replace(ANSI, "").replace(BOX, " ").replace(/\s+/g, " ").trim();

/**
 * @param {{getCatalog: () => object|null, pjDirOf: (pj: string) => Promise<string|null>, userDir: string,
 *   claudeCommand: () => string, isBusy?: () => boolean, onFinished?: () => void, run?: typeof runLine}} options
 */
export function createCatalogInstaller({ getCatalog, pjDirOf, userDir, claudeCommand, isBusy = () => false, onFinished = () => {}, run = runLine }) {
  let state = { state: "idle", entryId: null, scope: null, pj: null, steps: [], log: [], error: null, startedAt: null, finishedAt: null };
  let controller = null;

  async function plan({ id, scope, pj }) {
    const pjDir = scope === "project" && pj ? await pjDirOf(pj) : null;
    if (scope === "project" && pj && !pjDir) return { ok: false, reason: "that project does not exist", steps: [] };
    return planInstall({ catalog: getCatalog(), id, scope, pjDir, userDir, claudeCommand: claudeCommand() });
  }

  const snapshot = () => ({
    state: state.state, entryId: state.entryId, scope: state.scope, pj: state.pj,
    steps: state.steps.map(({ display, state: s }) => ({ display, state: s })),
    log: state.log.slice(-SHOWN_LOG_LINES), error: state.error, startedAt: state.startedAt, finishedAt: state.finishedAt,
  });

  return {
    snapshot,
    running: () => state.state === "running",

    /** What a start would run (the confirmation screen shows exactly this). */
    async preview(request) {
      const result = await plan(request);
      return { ok: result.ok, reason: result.reason, steps: result.steps.map(({ display, cwd }) => ({ display, cwd })) };
    },

    async start(request) {
      if (state.state === "running") throw new Error("another install is running; wait until it finishes");
      if (isBusy()) throw new Error("the tools setup is running; wait until it finishes");
      const result = await plan(request);
      if (!result.ok) throw new Error(result.reason);
      controller = new AbortController();
      const { signal } = controller;
      state = { state: "running", entryId: request.id, scope: request.scope, pj: request.scope === "project" ? request.pj : null, steps: result.steps.map((s) => ({ ...s, state: "waiting" })), log: [], error: null, startedAt: Date.now(), finishedAt: null };
      const push = (text) => {
        for (const line of text.split(/[\r\n]+/)) { const clean = cleanLine(line); if (clean) state.log.push(clean.slice(0, 300)); }
        if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
      };
      (async () => {
        try {
          for (const step of state.steps) {
            step.state = "running";
            push(`> ${step.display}`);
            const code = await run(step.run, { cwd: step.cwd, signal, onData: push });
            if (signal.aborted) throw new Error("cancelled");
            if (code !== 0) { step.state = "error"; throw new Error(state.log.filter((l) => !l.startsWith("> ")).slice(-3).join(" / ") || `the command exited with code ${code}`); }
            step.state = "done";
          }
          state.state = "done";
        } catch (err) {
          const cancelled = signal.aborted;
          for (const step of state.steps) if (step.state === "running") step.state = cancelled ? "cancelled" : "error";
          state.state = cancelled ? "cancelled" : "error";
          state.error = cancelled ? null : err.message;
        } finally {
          state.finishedAt = Date.now();
          controller = null;
          onFinished();
        }
      })();
      return snapshot();
    },

    cancel() {
      if (state.state !== "running") return false;
      controller?.abort();
      return true;
    },
  };
}

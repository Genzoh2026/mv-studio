// The "install" button for catalog entries. It runs the catalog's own commands (already limited to a few safe forms) for what
// the user chooses in the confirmation: one project, every project of this workspace (the ones that exist and the ones made
// later), or all projects of the user's Claude (user scope). The user always sees the exact commands first; nothing here can
// run a command that is not in the catalog, and the page cannot send one.
import { spawn } from "node:child_process";
import { commandProblem } from "./catalog.mjs";

const MAX_LOG_LINES = 300;
const SHOWN_LOG_LINES = 80;
const COMMAND_KINDS = new Set(["skills", "plugin", "mcp"]);
export const SCOPES = ["workspace", "project", "user"];
/** The scope an auto-install into a newly created project reports (it is a project-scope install made for the user). */
const AUTO = "auto";

/** The command for a scope: the catalog's project command as it is (project and workspace), or its user-scope twin. Pure. */
export function forScope(kind, command, scope) {
  if (scope === "project" || scope === "workspace") return command;
  if (kind === "skills") return command.replace(" -a claude-code", " -g -a claude-code");
  return command.replace("--scope project", "--scope user");
}

/**
 * What installing an entry would run, or why it cannot. Pure apart from the lookups it is given.
 * @param {{catalog: object, id: string, scope: string, pjDir?: string|null, pjDirs?: {name: string, dir: string}[], userDir: string,
 *   claudeCommand: string}} input
 *   `pjDir` is the folder for the project scope, `pjDirs` every project folder for the workspace scope, `userDir` is where a
 *   user-scope command is run from (any folder).
 * @returns {{ok: boolean, reason: string|null, entry?: object, steps: {command: string, display: string, run: string, cwd: string, group: string}[]}}
 *   Steps carry a `group` (the project they belong to) so a failure in one project does not stop the others.
 */
export function planInstall({ catalog, id, scope, pjDir = null, pjDirs = [], userDir, claudeCommand }) {
  const fail = (reason) => ({ ok: false, reason, steps: [] });
  const entry = catalog?.entries?.find((e) => e.id === id);
  if (!entry) return fail(`no catalog entry "${id}"`);
  if (!COMMAND_KINDS.has(entry.kind) || !entry.install?.commands?.length) return fail("this entry is not installed by the app (follow its steps by hand)");
  if (!SCOPES.includes(scope)) return fail(`scope must be one of ${SCOPES.join(", ")}`);
  if (scope === "project" && !pjDir) return fail("choose a project to install into");
  const targets = scope === "workspace" ? pjDirs : [{ name: scope === "user" ? "user" : "project", dir: scope === "user" ? userDir : pjDir }];
  const steps = [];
  for (const original of entry.install.commands) {
    const command = forScope(entry.kind, original, scope);
    // Both the catalog's command and the derived one are checked, so a mistake in either never runs.
    const why = commandProblem(entry.kind, original) ?? commandProblem(entry.kind, command, { scope: scope === "user" ? "user" : "project" });
    if (why) return fail(`the catalog command is not allowed (${why}): ${original}`);
  }
  for (const target of targets) {
    for (const original of entry.install.commands) {
      const command = forScope(entry.kind, original, scope);
      // claude may live at a full path (the native install); the shell needs it quoted then.
      const run = command.startsWith("claude ") && claudeCommand !== "claude" ? `"${claudeCommand}"${command.slice("claude".length)}` : command;
      steps.push({ command, display: command, run, cwd: target.dir, group: target.name, entryId: id });
    }
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
 * @param {{getCatalog: () => object|null, pjDirOf: (pj: string) => Promise<string|null>, pjDirsOf: () => Promise<{name: string, dir: string}[]>,
 *   userDir: string, claudeCommand: () => string,
 *   autoStore: {read: () => Promise<string[]>, write: (ids: string[]) => Promise<void>},
 *   isBusy?: () => boolean, onFinished?: () => void, run?: typeof runLine}} options
 *   `autoStore` keeps the entries that are installed into every new project; `pjDirsOf` lists the existing projects.
 */
export function createCatalogInstaller({ getCatalog, pjDirOf, pjDirsOf = async () => [], userDir, claudeCommand, autoStore = { read: async () => [], write: async () => {} }, isBusy = () => false, onFinished = () => {}, run = runLine }) {
  let state = { state: "idle", entryId: null, scope: null, pj: null, steps: [], log: [], error: null, startedAt: null, finishedAt: null };
  let controller = null;
  const waitingProjects = []; // new projects that still need their automatic installs

  /** One entry (`id`) or several at once (`ids`). With several, a step's group is "<entry> @ <project>" so a failure skips only that entry in that project. */
  async function plan({ id, ids, scope, pj }) {
    const pjDir = scope === "project" && pj ? await pjDirOf(pj) : null;
    if (scope === "project" && pj && !pjDir) return { ok: false, reason: "that project does not exist", steps: [] };
    const pjDirs = scope === "workspace" ? await pjDirsOf() : [];
    const one = (entryId) => planInstall({ catalog: getCatalog(), id: entryId, scope, pjDir, pjDirs, userDir, claudeCommand: claudeCommand() });
    if (!Array.isArray(ids)) return one(id);
    if (!ids.length) return { ok: false, reason: "choose at least one entry", steps: [] };
    const steps = [];
    for (const entryId of [...new Set(ids)]) {
      const planned = one(entryId);
      if (!planned.ok) return planned;
      steps.push(...planned.steps.map((s) => ({ ...s, group: `${entryId} @ ${s.group}` })));
    }
    return { ok: true, reason: null, steps };
  }

  const snapshot = () => ({
    state: state.state, entryId: state.entryId, count: state.count ?? 1, scope: state.scope, pj: state.pj,
    steps: state.steps.map(({ display, group, state: s }) => ({ display, group, state: s })),
    log: state.log.slice(-SHOWN_LOG_LINES), error: state.error, startedAt: state.startedAt, finishedAt: state.finishedAt,
  });

  /**
   * Runs the steps of a plan in the background. A step that fails stops only its own group (its project): the other projects
   * still get theirs, and the run ends as an error that names the projects that failed.
   */
  function execute(planned, { entryId, scope, pj, count = 1 }, onFinish) {
    controller = new AbortController();
    const { signal } = controller;
    state = { state: "running", entryId, count, scope, pj, steps: planned.steps.map((s) => ({ ...s, state: "waiting" })), log: [], error: null, startedAt: Date.now(), finishedAt: null };
    const push = (text) => {
      for (const line of text.split(/[\r\n]+/)) { const clean = cleanLine(line); if (clean) state.log.push(clean.slice(0, 300)); }
      if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
    };
    (async () => {
      const failed = new Map(); // group -> last lines of its output
      try {
        for (const step of state.steps) {
          if (failed.has(step.group)) { step.state = "skipped"; continue; }
          step.state = "running";
          push(`> ${step.group !== "project" && step.group !== "user" ? `[${step.group}] ` : ""}${step.display}`);
          const code = await run(step.run, { cwd: step.cwd, signal, onData: push });
          if (signal.aborted) throw new Error("cancelled");
          if (code === 0) { step.state = "done"; continue; }
          step.state = "error";
          failed.set(step.group, state.log.filter((l) => !l.startsWith("> ") && !l.startsWith("[")).slice(-2).join(" / ") || `exit code ${code}`);
        }
        await onFinish?.(state.steps);
        if (failed.size) throw new Error([...failed].map(([group, why]) => `${group}: ${why}`).join(" ; "));
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
        pumpAuto();
      }
    })();
    return snapshot();
  }

  const waitUntilIdle = () => new Promise((resolve) => {
    const check = () => (state.state === "running" ? setTimeout(check, 100) : resolve());
    check();
  });

  let pumping = false;
  /** Gives each new project the entries that every project should have, one after the other, behind whatever is running. */
  async function pumpAuto() {
    if (pumping || state.state === "running" || !waitingProjects.length) return;
    pumping = true;
    try {
      while (waitingProjects.length) {
        const pj = waitingProjects.shift();
        const dir = await pjDirOf(pj);
        const ids = dir ? await autoStore.read().catch(() => []) : [];
        for (const id of ids) {
          const planned = planInstall({ catalog: getCatalog(), id, scope: "project", pjDir: dir, userDir, claudeCommand: claudeCommand() });
          if (!planned.ok) continue;
          await waitUntilIdle(); // a manual install may have started between two entries
          execute(planned, { entryId: id, scope: AUTO, pj });
          await waitUntilIdle();
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    snapshot,
    running: () => state.state === "running",

    /** What a start would run (the confirmation screen shows exactly this). */
    async preview(request) {
      const result = await plan(request);
      const groups = [...new Set(result.steps.map((s) => s.group.split(" @ ").pop()))];
      // For the workspace scope the commands repeat per project: show each command once and name the projects.
      const unique = result.steps.filter((s, i) => result.steps.findIndex((o) => o.display === s.display) === i);
      return { ok: result.ok, reason: result.reason, steps: unique.map(({ display, cwd }) => ({ display, cwd })), targets: request.scope === "workspace" ? groups : [], auto: request.scope === "workspace" };
    },

    async start(request) {
      if (state.state === "running") throw new Error("another install is running; wait until it finishes");
      if (isBusy()) throw new Error("the tools setup is running; wait until it finishes");
      const planned = await plan(request);
      if (!planned.ok) throw new Error(planned.reason);
      const wanted = Array.isArray(request.ids) ? [...new Set(request.ids)] : [request.id];
      // After a workspace install, every project created from now on gets the entries that were fully installed too.
      const register = request.scope === "workspace" ? async (steps) => {
        const complete = wanted.filter((id) => steps.filter((s) => s.entryId === id).every((s) => s.state === "done"));
        const ids = await autoStore.read().catch(() => []);
        const next = [...ids, ...complete.filter((id) => !ids.includes(id))];
        if (next.length !== ids.length) await autoStore.write(next);
      } : undefined;
      return execute(planned, { entryId: wanted.length === 1 ? wanted[0] : null, scope: request.scope, pj: request.scope === "project" ? request.pj : null, count: wanted.length }, register);
    },

    /** A project was just created: queue the entries that every project of this workspace should have. */
    queueAuto(pj) {
      waitingProjects.push(pj);
      pumpAuto();
    },

    /** The entries that are installed into every new project. */
    async auto() { return autoStore.read().catch(() => []); },

    /** Switches the automatic install of an entry into new projects on or off (it does not touch existing projects). */
    async setAuto(id, enabled) {
      const entry = getCatalog()?.entries?.find((e) => e.id === id);
      if (!entry || !COMMAND_KINDS.has(entry.kind)) throw new Error("this entry cannot be installed by the app");
      const ids = (await autoStore.read().catch(() => [])).filter((existing) => existing !== id);
      await autoStore.write(enabled ? [...ids, id] : ids);
      return this.auto();
    },

    cancel() {
      if (state.state !== "running") return false;
      controller?.abort();
      return true;
    },
  };
}

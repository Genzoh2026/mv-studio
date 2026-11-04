// One-button setup of the audio tools. It only ever touches the workspace's own Python environment
// (<workspace>/.mv-studio/venv): it creates it if needed and installs Demucs and numpy there, optionally with the
// CUDA build of PyTorch. Other Pythons on the computer are never modified. Everything it runs is shown to the user first,
// and every command is built here as an argument list (nothing goes through a shell).
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

export const GPU_TORCH_INDEX = "https://download.pytorch.org/whl/cu126";
const MAX_LOG_LINES = 300;
const SHOWN_LOG_LINES = 80;
const PIP_FLAGS = ["--no-input", "--progress-bar", "off"];

const quote = (part) => (/[\s"]/.test(part) ? `"${part}"` : part);
/** The command as the user would type it (shown in the confirmation and the log). */
export const displayCommand = (args) => args.map(quote).join(" ");

/**
 * What the setup would run. Pure: everything it needs is passed in.
 * @param {{venvDir: string, venvPython: string, venvExists: boolean, venvTorch: string|null, venvCuda: boolean,
 *   base: {command: string, pre: string[]}|null, gpu: string|null, wantGpu: boolean}} input
 * @returns {{ok: boolean, reason: string|null, steps: {id: string, label: string, args: string[], display: string}[], gpuStep: boolean}}
 */
export function planSetup({ venvDir, venvPython, venvExists, venvTorch, venvCuda, base, gpu, wantGpu }) {
  const steps = [];
  const add = (id, label, args) => steps.push({ id, label, args, display: displayCommand(args) });
  if (!venvExists) {
    if (!base) return { ok: false, reason: "Python 3 が見つかりません。先に Python を入れてください(下の手順)。", steps: [], gpuStep: false };
    add("venv", "専用の環境を作る", [base.command, ...base.pre, "-m", "venv", venvDir]);
  }
  const gpuStep = Boolean(wantGpu && gpu && !venvCuda);
  if (gpuStep) {
    // A venv that has no PyTorch yet gets the CUDA build directly; one that already has the CPU build is switched over.
    const swap = venvExists && venvTorch;
    add("torch-gpu", "GPU 版の PyTorch を入れる", [venvPython, "-m", "pip", "install", ...PIP_FLAGS, ...(swap ? ["--upgrade", "--force-reinstall", "--no-deps"] : []), "torch", "--index-url", GPU_TORCH_INDEX]);
  }
  // numpy is named on purpose: Demucs needs it but does not install it on most systems.
  add("demucs", "Demucs と numpy を入れる", [venvPython, "-m", "pip", "install", ...PIP_FLAGS, "demucs", "numpy"]);
  return { ok: true, reason: null, steps, gpuStep };
}

const exists = (path) => stat(path).then((s) => s.isFile(), () => false);

// PyTorch ships files whose paths are about 150 characters below the environment folder; Windows stops at 260 unless
// long paths are switched on, so a deep workspace folder makes the install fail half way.
const LONG_PATH_LIMIT = 90;

/** True when LongPathsEnabled is switched on in Windows (read-only registry query). */
function longPathsEnabled() {
  return new Promise((resolve) => {
    const child = spawn("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(/0x1\s*$/m.test(out)));
  });
}

/** A warning for a workspace path that is too deep for the install to succeed, or null. */
export async function pathWarning(venvDir, platform = process.platform) {
  if (platform !== "win32" || venvDir.length <= LONG_PATH_LIMIT || (await longPathsEnabled())) return null;
  return `この場所は、パスが長すぎます(${venvDir.length} 文字)。Windows の上限(260 文字)のため、導入が途中で失敗することがあります。MV Studio のフォルダを、もっと短い場所(例: C:\\mvs)に置くか、Windows の「長いパスを有効にする」設定を使ってください。`;
}

/** Stops a process and anything it started (pip may start builds). */
function killTree(child) {
  if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else child.kill();
}

/**
 * @param {{tools: object, isBusy: () => boolean, spawnStep?: typeof runStep}} options
 *   `tools` is the audio-tools object; `isBusy` says whether a song job is running (they must not overlap: pip may swap
 *   the very PyTorch a separation is using).
 */
export function createInstaller({ tools, isBusy, spawnStep = runStep }) {
  let state = { state: "idle", steps: [], log: [], error: null, startedAt: null, finishedAt: null, gpu: false };
  let controller = null;

  async function inspect(wantGpu) {
    const status = await tools.status({ refresh: true });
    const venv = await tools.inspectVenv();
    const venvExists = await exists(tools.venvPython);
    return planSetup({
      venvDir: tools.venvDir, venvPython: tools.venvPython, venvExists,
      venvTorch: venv?.torch ?? null, venvCuda: Boolean(venv?.cuda),
      base: status.python.found ? await tools.basePython() : null,
      gpu: await tools.gpuName(), wantGpu,
    });
  }

  const publicState = () => ({
    state: state.state,
    steps: state.steps.map(({ id, label, display, state: s }) => ({ id, label, display, state: s })),
    log: state.log.slice(-SHOWN_LOG_LINES),
    error: state.error, startedAt: state.startedAt, finishedAt: state.finishedAt, gpu: state.gpu,
  });

  return {
    snapshot: publicState,
    running: () => state.state === "running",

    /** What a start would do, for the confirmation screen. */
    async preview({ gpu = false } = {}) {
      const plan = await inspect(gpu);
      const gpuName = await tools.gpuName();
      return { ok: plan.ok, reason: plan.reason, warning: await pathWarning(tools.venvDir), steps: plan.steps.map(({ id, label, display }) => ({ id, label, display })), gpuAvailable: Boolean(gpuName), gpuName, gpuStep: plan.gpuStep, venvDir: tools.venvDir };
    },

    async start({ gpu = false } = {}) {
      if (state.state === "running") throw new Error("a setup is already running");
      if (isBusy()) throw new Error("a separation or analysis is running; wait until it finishes");
      const plan = await inspect(gpu);
      if (!plan.ok) throw new Error(plan.reason);
      controller = new AbortController();
      state = { state: "running", steps: plan.steps.map((s) => ({ ...s, state: "waiting" })), log: [], error: null, startedAt: Date.now(), finishedAt: null, gpu: plan.gpuStep };
      const signal = controller.signal;
      const push = (text) => { for (const line of text.split(/[\r\n]+/)) if (line.trim()) state.log.push(line.slice(0, 400)); if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES); };
      // Runs in the background; the page polls snapshot().
      (async () => {
        try {
          for (const step of state.steps) {
            step.state = "running";
            push(`> ${step.display}`);
            const code = await spawnStep(step.args, { signal, onData: push });
            if (signal.aborted) throw new Error("cancelled");
            if (code !== 0) { step.state = "error"; throw new Error(failureMessage(state.log, code)); }
            step.state = "done";
          }
          await tools.status({ refresh: true });
          state.state = "done";
        } catch (err) {
          const cancelled = signal.aborted;
          for (const step of state.steps) if (step.state === "running") step.state = cancelled ? "cancelled" : "error";
          state.state = cancelled ? "cancelled" : "error";
          state.error = cancelled ? null : err.message;
          await tools.status({ refresh: true }).catch(() => {});
        } finally {
          state.finishedAt = Date.now();
          controller = null;
        }
      })();
      return publicState();
    },

    cancel() {
      if (state.state !== "running") return false;
      controller?.abort();
      return true;
    },
  };
}

/** The last meaningful lines of a failed step, for the message the page shows. */
function failureMessage(log, code) {
  const lines = log.filter((line) => !line.startsWith("> ")).slice(-3);
  return lines.length ? lines.join(" / ") : `the command exited with code ${code}`;
}

/** Runs one command and streams its output; resolves with the exit code. */
function runStep(args, { signal, onData }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(args[0], args.slice(1), {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
    } catch (err) {
      onData(String(err.message));
      return resolve(1);
    }
    const stop = () => killTree(child);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => onData(String(chunk)));
    child.stderr.on("data", (chunk) => onData(String(chunk)));
    child.on("error", (err) => { onData(err.message); resolve(1); });
    child.on("close", (code) => { signal?.removeEventListener("abort", stop); resolve(code ?? 1); });
  });
}

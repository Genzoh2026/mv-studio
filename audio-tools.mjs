// The optional audio tools behind song separation and beat analysis: a Python (with numpy for the beats, and Demucs for the
// stems) and ffmpeg. Nothing is bundled or installed by the app. It finds what the computer has, says what is missing and
// how to get it, and runs the scripts in tools/ with a fixed argument list (never through a shell).
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MODELS = ["htdemucs", "htdemucs_ft"];
export const DEFAULT_MODEL = "htdemucs";
const PROBE_TIMEOUT_MS = 20_000;
const STDERR_TAIL = 1500;
const SETTINGS_DIR = ".mv-studio";

/** What to type to run a Python: a command and the arguments that go before the script. */
const asCommand = (command, pre = []) => ({ command, pre });

/** Runs a command to completion and returns its stdout, or null when it cannot run or fails. */
function capture(command, args, timeoutMs = PROBE_TIMEOUT_MS, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      return resolve(null);
    }
    let out = "";
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/**
 * @param {{workspace: string, toolsDir: string, env?: NodeJS.ProcessEnv, platform?: string}} options
 */
export function createAudioTools({ workspace, toolsDir, env = process.env, platform = process.platform }) {
  const settingsFile = join(workspace, SETTINGS_DIR, "settings.json");
  const venvPython = platform === "win32" ? join(workspace, SETTINGS_DIR, "venv", "Scripts", "python.exe") : join(workspace, SETTINGS_DIR, "venv", "bin", "python");
  let cached = null;

  async function readSettings() {
    try {
      const data = JSON.parse(await readFile(settingsFile, "utf8"));
      return {
        pythonPath: typeof data.pythonPath === "string" && data.pythonPath ? data.pythonPath : null,
        model: MODELS.includes(data.model) ? data.model : DEFAULT_MODEL,
      };
    } catch {
      return { pythonPath: null, model: DEFAULT_MODEL };
    }
  }

  async function writeSettings(settings) {
    await mkdir(dirname(settingsFile), { recursive: true });
    const tmp = `${settingsFile}.tmp`;
    await writeFile(tmp, JSON.stringify(settings, null, 2));
    await rename(tmp, settingsFile);
  }

  /** Pythons to try, best guess first: the user's choice, the workspace's own environment, then the system's. */
  async function candidates(settings) {
    const list = [];
    if (env.MV_STUDIO_PYTHON) list.push(asCommand(env.MV_STUDIO_PYTHON));
    if (settings.pythonPath) list.push(asCommand(settings.pythonPath));
    if (await stat(venvPython).then((s) => s.isFile(), () => false)) list.push(asCommand(venvPython));
    if (platform === "win32") list.push(asCommand("py", ["-3"]), asCommand("python"));
    else list.push(asCommand("python3"), asCommand("python"));
    return list;
  }

  /** Asks one Python what it has (tools/probe.py). Null when it does not run. */
  async function probe(candidate) {
    const out = await capture(candidate.command, [...candidate.pre, join(toolsDir, "probe.py")], PROBE_TIMEOUT_MS, { ...process.env, ...env });
    try {
      return out ? { ...JSON.parse(out.trim().split("\n").pop()), ...candidate } : null;
    } catch {
      return null;
    }
  }

  async function detect() {
    const settings = await readSettings();
    // The most capable Python wins (Demucs, then numpy, then one that merely runs); on a tie, the earlier candidate:
    // the user's own choice and the workspace environment come before whatever the system has.
    // A Demucs that is installed but fails to load still beats none: it is one missing package away from working.
    const score = (found) => (found.demucs ? (found.demucs_error ? 1 : 2) : 0) + (found.numpy ? 1 : 0);
    let best = null;
    for (const candidate of await candidates(settings)) {
      const found = await probe(candidate);
      if (found && (!best || score(found) > score(best))) best = found;
      if (best && score(best) === 3) break;
    }
    const ffmpegOut = await capture("ffmpeg", ["-version"]);
    const ffmpeg = ffmpegOut ? { found: true, version: /ffmpeg version (\S+)/.exec(ffmpegOut)?.[1] ?? "?" } : { found: false };
    const python = best ? { found: true, command: best.command, pre: best.pre, version: best.python } : { found: false };
    const numpy = best?.numpy ?? null;
    const demucs = best?.demucs ?? null;
    const demucsError = best?.demucs_error ?? null;
    const cuda = Boolean(best?.cuda);
    // An NVIDIA GPU is only worth mentioning if PyTorch cannot use it yet.
    const gpuOut = cuda ? null : await capture("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], 8000);
    const gpu = gpuOut?.trim().split("\n")[0]?.trim() || null;
    cached = {
      python: { found: python.found, version: python.version ?? null, where: python.found ? [python.command, ...python.pre].join(" ") : null },
      numpy, demucs, demucsError, torch: best?.torch ?? null, cuda, gpu, ffmpeg,
      model: settings.model,
      pythonPath: settings.pythonPath,
      ready: { beats: python.found && Boolean(numpy) && ffmpeg.found, separate: python.found && Boolean(demucs) && !demucsError && ffmpeg.found },
      install: installHelp({ python, numpy, demucs, demucsError, gpu, cuda, ffmpeg, workspace, platform, venvPython }),
      _run: python.found ? { command: python.command, pre: python.pre } : null,
    };
    return cached;
  }

  /** The status the page shows (never the internal run command). */
  const publicStatus = (status) => { const { _run, ...rest } = status; return rest; };

  return {
    /** Detection runs on first use and again on request, because the user may install something while the app runs. */
    async status({ refresh = false } = {}) {
      if (!cached || refresh) await detect();
      return publicStatus(cached);
    },

    /** Saves the user's choice of Python (or null to go back to automatic) after checking that it runs. */
    async setPython(path) {
      if (path !== null) {
        if (typeof path !== "string" || !path.trim() || path.includes("\0")) throw new Error("python: a file path is expected");
        const info = await stat(path.trim()).catch(() => null);
        if (!info?.isFile()) throw new Error(`python: ${path} is not a file`);
        if (!(await probe(asCommand(path.trim())))) throw new Error(`python: ${path} did not run (is it a Python 3?)`);
      }
      await writeSettings({ ...(await readSettings()), pythonPath: path === null ? null : path.trim() });
      return this.status({ refresh: true });
    },

    /** Where the app's own Python environment lives (the only one the setup ever changes). */
    venvDir: join(workspace, SETTINGS_DIR, "venv"),
    venvPython,

    /** What the workspace environment can do (null when it does not exist or does not run). */
    async inspectVenv() {
      return (await stat(venvPython).then((s) => s.isFile(), () => false)) ? probe(asCommand(venvPython)) : null;
    },

    /** The Python to create the workspace environment with: whichever was found. */
    async basePython() {
      if (!cached) await detect();
      return cached._run;
    },

    /** The NVIDIA GPU's name, or null. Independent of which Python is in use. */
    async gpuName() {
      const out = await capture("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], 8000);
      return out?.trim().split(String.fromCharCode(10))[0]?.trim() || null;
    },

    async setModel(model) {
      if (!MODELS.includes(model)) throw new Error(`model: one of ${MODELS.join(", ")}`);
      await writeSettings({ ...(await readSettings()), model });
      return this.status({ refresh: true });
    },

    /**
     * Runs tools/<script> with the detected Python. Resolves when the script prints DONE and exits 0.
     * `onProgress(percent)` gets the script's "PROGRESS n" lines. `signal` stops the process.
     */
    async runScript(script, args, { onProgress = () => {}, signal } = {}) {
      if (!cached) await detect();
      if (!cached._run) throw new Error("Python was not found");
      const { command, pre } = cached._run;
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...pre, join(toolsDir, script), ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        let stdout = "";
        let tail = "";
        let done = false;
        const stop = () => child.kill();
        signal?.addEventListener("abort", stop, { once: true });
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const lines = stdout.split("\n");
          stdout = lines.pop();
          for (const line of lines) {
            const progress = /^PROGRESS (\d+)/.exec(line);
            if (progress) onProgress(Number(progress[1]));
            else if (line.trim() === "DONE") done = true;
          }
        });
        child.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-STDERR_TAIL); });
        child.on("error", (err) => reject(err));
        child.on("close", (code) => {
          signal?.removeEventListener("abort", stop);
          if (signal?.aborted) return reject(new Error("cancelled"));
          if (code === 0 && done) return resolve();
          reject(new Error(lastLine(tail) || `${script} exited with code ${code}`));
        });
      });
    },
  };
}

const lastLine = (text) => text.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "";

/** Commands for what is missing, in the order to run them. Shown to the user, never run by the app. */
export function installHelp({ python, numpy, demucs, demucsError = null, gpu = null, cuda = false, ffmpeg, workspace, platform, venvPython }) {
  const steps = [];
  const win = platform === "win32";
  const quote = (p) => (p.includes(" ") ? `"${p}"` : p);
  // The Python that will run Demucs: the one found, or the workspace environment the steps below create.
  const runner = python.found && demucs ? [python.command, ...(python.pre ?? [])].map(quote).join(" ") : `"${venvPython}"`;
  if (!python.found) {
    steps.push({ kind: "system", label: "Python 3 を入れる", command: win ? "winget install Python.Python.3.12" : platform === "darwin" ? "brew install python" : "sudo apt install python3 python3-venv", note: "入れたら、アプリの「再確認」を押します(PATH は起動時に読み込まれるので、見つからなければアプリを再起動してください)。PyTorch が対応するのは Python 3.9〜3.12 ごろまでです" });
  }
  if (!ffmpeg.found) {
    steps.push({ kind: "system", label: "ffmpeg を入れる", command: win ? "winget install Gyan.FFmpeg" : platform === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg" });
  }
  if (!demucs) {
    const venv = join(workspace, SETTINGS_DIR, "venv");
    steps.push(
      { label: "専用の環境を作る(ワークスペースの中。他の Python を汚しません)", command: `${win ? "python" : "python3"} -m venv "${venv}"` },
      // numpy is listed on purpose: Demucs needs it but does not install it on most systems.
      { label: "Demucs を入れる(曲の分離に必要。数 GB のダウンロードがあります)", command: `"${venvPython}" -m pip install demucs numpy` },
    );
  } else if (demucsError) {
    // Installed but it does not load: usually one package that Demucs needs and does not install itself.
    const missing = /No module named '([\w]+)/.exec(demucsError)?.[1];
    steps.push(missing
      ? { label: `Demucs が読み込めません(${missing} がありません)。足りないものを入れる`, command: `${runner} -m pip install ${Object.hasOwn(PIP_NAMES, missing) ? PIP_NAMES[missing] : missing}`, note: demucsError }
      : { label: "Demucs が読み込めません。入れ直す", command: `${runner} -m pip install --upgrade --force-reinstall demucs numpy`, note: demucsError });
  } else if (!numpy) {
    steps.push({ label: "numpy を入れる(ビート解析に必要)", command: `${runner} -m pip install numpy` });
  }
  // The default PyTorch from PyPI is the CPU build on Windows and macOS, so a GPU stays idle until it is swapped.
  if (gpu && !cuda) {
    steps.push({
      label: `GPU(${gpu})で速くする: GPU 版の PyTorch に入れ替える(約 3 GB。任意)`,
      command: `${runner} -m pip install --upgrade --force-reinstall --no-deps torch --index-url https://download.pytorch.org/whl/cu126`,
      note: "PyTorch 公式の手順です(https://pytorch.org/get-started/locally/)。入れ替えたら「再確認」で「GPU が使えます」になれば成功です。GPU がなくても分離は動きます(CPU は遅めです)。",
    });
  }
  return steps;
}

// A few packages are installed under another name than they are imported as.
const PIP_NAMES = { yaml: "pyyaml", cv2: "opencv-python", sklearn: "scikit-learn" };

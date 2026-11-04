import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAudioTools, installHelp } from "../audio-tools.mjs";

const TOOLS_DIR = fileURLToPath(new URL("../tools", import.meta.url));
const base = { python: { found: true, command: "/v/bin/python", pre: [] }, numpy: "1", demucs: "4.1.0", demucsError: null, gpu: null, cuda: false, ffmpeg: { found: true }, workspace: "/w", platform: "linux", venvPython: "/w/.mv-studio/venv/bin/python" };

test("a fresh install always includes numpy: Demucs needs it but does not install it", () => {
  const steps = installHelp({ ...base, python: { found: true, command: "python3", pre: [] }, numpy: null, demucs: null });
  assert.match(steps.at(-1).command, /pip install demucs numpy$/);
});

test("a Demucs that is installed but does not load gets the fix for the package it lacks", () => {
  const missing = installHelp({ ...base, numpy: null, demucsError: "ModuleNotFoundError: No module named 'numpy'" });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].command, "/v/bin/python -m pip install numpy");
  assert.match(missing[0].label, /numpy がありません/);
  const aliased = installHelp({ ...base, demucsError: "ModuleNotFoundError: No module named 'yaml'" });
  assert.match(aliased[0].command, /pip install pyyaml$/);
  const odd = installHelp({ ...base, demucsError: "ModuleNotFoundError: No module named 'constructor'" });
  assert.match(odd[0].command, /pip install constructor$/, "a name that is also an Object property is passed through as it is");
  const unknown = installHelp({ ...base, demucsError: "ImportError: DLL load failed" });
  assert.match(unknown[0].command, /--force-reinstall demucs numpy$/);
});

test("the GPU step appears only when there is an NVIDIA GPU that PyTorch is not using", () => {
  const idle = installHelp({ ...base, gpu: "NVIDIA GeForce RTX 4080 SUPER" });
  assert.equal(idle.length, 1);
  assert.match(idle[0].label, /RTX 4080 SUPER/);
  assert.match(idle[0].command, /--force-reinstall --no-deps torch --index-url https:\/\/download\.pytorch\.org\/whl\/cu126$/);
  assert.deepEqual(installHelp({ ...base, gpu: "NVIDIA GeForce RTX 4080 SUPER", cuda: true }), [], "already using it");
  assert.deepEqual(installHelp({ ...base }), [], "no GPU, nothing to say");
  // Before Demucs exists, the GPU step targets the environment the other steps create.
  const fresh = installHelp({ ...base, demucs: null, numpy: null, gpu: "GPU" });
  assert.match(fresh.at(-1).command, /^"\/w\/\.mv-studio\/venv\/bin\/python" -m pip install/);
});

test("the probe reports a Demucs that fails to import, and the app will not call it ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mvs-probe-"));
  try {
    // A stand-in "demucs" whose entry point needs a package nobody has, like the real one needs numpy.
    const fake = join(root, "fake", "demucs");
    await mkdir(fake, { recursive: true });
    await writeFile(join(fake, "__init__.py"), '__version__ = "9.9.9"\n');
    await writeFile(join(fake, "separate.py"), "import a_package_nobody_has\n");
    const env = { MV_STUDIO_PYTHON: process.env.MV_STUDIO_PYTHON ?? (process.platform === "win32" ? "python" : "python3"), PYTHONPATH: join(root, "fake") };
    const tools = createAudioTools({ workspace: join(root, "ws"), toolsDir: TOOLS_DIR, env });
    const status = await tools.status();
    if (!status.python.found) return t.skip("no Python available here");
    assert.equal(status.demucs, "9.9.9");
    assert.match(status.demucsError, /a_package_nobody_has/);
    assert.equal(status.ready.separate, false);
    assert.match(status.install[0].command, /pip install a_package_nobody_has$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { GPU_TORCH_INDEX, createInstaller, displayCommand, planSetup } from "../audio-install.mjs";

const VENV = "/w/.mv-studio/venv";
const VENV_PY = "/w/.mv-studio/venv/bin/python";
const base = { venvDir: VENV, venvPython: VENV_PY, venvExists: false, venvTorch: null, venvCuda: false, base: { command: "python3", pre: [] }, gpu: null, wantGpu: false };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a fresh setup creates the workspace environment and installs Demucs with numpy into it", () => {
  const plan = planSetup(base);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((s) => s.id), ["venv", "demucs"]);
  assert.deepEqual(plan.steps[0].args, ["python3", "-m", "venv", VENV]);
  assert.deepEqual(plan.steps[1].args.slice(0, 4), [VENV_PY, "-m", "pip", "install"]);
  assert.deepEqual(plan.steps[1].args.slice(-2), ["demucs", "numpy"]);
});

test("every pip step targets the workspace environment, never another Python", () => {
  for (const input of [base, { ...base, venvExists: true }, { ...base, gpu: "RTX", wantGpu: true }, { ...base, venvExists: true, venvTorch: "2.14.1+cpu", gpu: "RTX", wantGpu: true }]) {
    for (const step of planSetup(input).steps.filter((s) => s.args.includes("pip"))) assert.equal(step.args[0], VENV_PY, step.display);
  }
});

test("an existing environment is not created again, and a missing Python stops the plan with a reason", () => {
  assert.deepEqual(planSetup({ ...base, venvExists: true }).steps.map((s) => s.id), ["demucs"]);
  const none = planSetup({ ...base, base: null });
  assert.equal(none.ok, false);
  assert.match(none.reason, /Python 3 が見つかりません/);
  assert.equal(planSetup({ ...base, base: null, venvExists: true }).ok, true, "the environment exists, so no other Python is needed");
});

test("the GPU step comes before Demucs, installs fresh into an empty environment and swaps an existing CPU build", () => {
  const fresh = planSetup({ ...base, gpu: "RTX 4080", wantGpu: true });
  assert.deepEqual(fresh.steps.map((s) => s.id), ["venv", "torch-gpu", "demucs"]);
  assert.ok(fresh.steps[1].args.includes("--index-url") && fresh.steps[1].args.includes(GPU_TORCH_INDEX));
  assert.equal(fresh.steps[1].args.includes("--force-reinstall"), false, "nothing to replace yet");
  const swap = planSetup({ ...base, venvExists: true, venvTorch: "2.14.1+cpu", gpu: "RTX 4080", wantGpu: true });
  assert.deepEqual(swap.steps.map((s) => s.id), ["torch-gpu", "demucs"]);
  assert.ok(swap.steps[0].args.includes("--force-reinstall") && swap.steps[0].args.includes("--no-deps"));
  assert.equal(planSetup({ ...base, gpu: "RTX 4080", wantGpu: false }).gpuStep, false, "only when asked for");
  assert.equal(planSetup({ ...base, venvExists: true, venvTorch: "2.14.1+cu126", venvCuda: true, gpu: "RTX 4080", wantGpu: true }).gpuStep, false, "already a GPU build");
  assert.equal(planSetup({ ...base, gpu: null, wantGpu: true }).gpuStep, false, "no GPU, no GPU build");
});

test("the commands shown to the user are exactly the ones that run, with spaces quoted", () => {
  assert.equal(displayCommand(["/a b/python", "-m", "pip", "install", "x"]), '"/a b/python" -m pip install x');
});

/** An audio-tools stand-in: no real Python is touched. */
const fakeTools = () => ({
  venvDir: VENV, venvPython: VENV_PY,
  refreshed: 0,
  status: async function () { this.refreshed++; return { python: { found: true }, ready: { separate: true, beats: true } }; },
  inspectVenv: async () => null,
  basePython: async () => ({ command: "python3", pre: [] }),
  gpuName: async () => null,
});
const until = async (installer, states) => { for (let i = 0; i < 400 && !states.includes(installer.snapshot().state); i++) await wait(5); return installer.snapshot(); };

test("the installer runs the steps in order, logs their output, and refreshes the tool status when done", async () => {
  const ran = [];
  const tools = fakeTools();
  const installer = createInstaller({
    tools, isBusy: () => false,
    spawnStep: async (args, { onData }) => { ran.push(args.at(-1)); onData(`output of ${args.at(-1)}\n`); await wait(5); return 0; },
  });
  await installer.start({});
  const done = await until(installer, ["done", "error"]);
  assert.equal(done.state, "done");
  assert.deepEqual(ran, [VENV, "numpy"]);
  assert.deepEqual(done.steps.map((s) => s.state), ["done", "done"]);
  assert.ok(done.log.some((line) => line.startsWith("> ")), "each command is logged before it runs");
  assert.ok(done.log.includes(`output of ${VENV}`));
  assert.ok(tools.refreshed >= 2, "status is refreshed before planning and after finishing");
});

test("a failing step stops the setup and reports the last lines of its output", async () => {
  let calls = 0;
  const installer = createInstaller({
    tools: fakeTools(), isBusy: () => false,
    spawnStep: async (args, { onData }) => { calls++; onData("collecting\nERROR: No matching distribution found for demucs\n"); return 1; },
  });
  await installer.start({});
  const result = await until(installer, ["done", "error"]);
  assert.equal(result.state, "error");
  assert.equal(calls, 1, "the next step does not run after a failure");
  assert.match(result.error, /No matching distribution/);
  assert.deepEqual(result.steps.map((s) => s.state), ["error", "waiting"]);
});

test("cancelling stops the running step through its signal", async () => {
  const installer = createInstaller({
    tools: fakeTools(), isBusy: () => false,
    spawnStep: (args, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(1))),
  });
  await installer.start({});
  await wait(10);
  assert.equal(installer.cancel(), true);
  const result = await until(installer, ["cancelled", "error", "done"]);
  assert.equal(result.state, "cancelled");
  assert.equal(result.error, null);
  assert.equal(installer.cancel(), false, "nothing left to cancel");
});

test("a setup refuses to start while a song job is running or another setup is, and without a usable Python", async () => {
  const busy = createInstaller({ tools: fakeTools(), isBusy: () => true, spawnStep: async () => 0 });
  await assert.rejects(busy.start({}), /separation or analysis is running/);
  const slow = createInstaller({ tools: fakeTools(), isBusy: () => false, spawnStep: (args, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(1))) });
  await slow.start({});
  await assert.rejects(slow.start({}), /already running/);
  slow.cancel();
  await until(slow, ["cancelled"]);
  const noPython = { ...fakeTools(), status: async () => ({ python: { found: false }, ready: {} }), basePython: async () => null };
  await assert.rejects(createInstaller({ tools: noPython, isBusy: () => false, spawnStep: async () => 0 }).start({}), /Python 3 が見つかりません/);
});

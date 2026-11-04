import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAudioTools, installHelp } from "../audio-tools.mjs";
import { createJobs } from "../jobs.mjs";
import { SongJobError, createSongJobs, findSongAudio, listStems } from "../song-jobs.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = async (manager, id) => { while (["queued", "running"].includes(manager.list().find((j) => j.id === id)?.state)) await wait(5); return manager.list().find((j) => j.id === id); };
const TOOLS_DIR = fileURLToPath(new URL("../tools", import.meta.url));

test("jobs run one at a time, in order, and report progress and errors", async () => {
  const log = [];
  let concurrent = 0;
  let peak = 0;
  const manager = createJobs({
    run: async (job, { progress }) => {
      concurrent++; peak = Math.max(peak, concurrent);
      try {
        log.push(`start ${job.base}`);
        progress(40);
        await wait(15);
        if (job.base === "bad") throw new Error("boom");
        log.push(`end ${job.base}`);
      } finally {
        concurrent--;
      }
    },
  });
  const a = manager.enqueue({ pj: "p", base: "a", kind: "beats" });
  const bad = manager.enqueue({ pj: "p", base: "bad", kind: "beats" });
  const c = manager.enqueue({ pj: "p", base: "c", kind: "separate" });
  assert.equal(manager.enqueue({ pj: "p", base: "a", kind: "beats" }).id, a.id, "the same song and kind is not queued twice");
  await settled(manager, c.id);
  assert.deepEqual(log, ["start a", "end a", "start bad", "start c", "end c"]);
  assert.equal(peak, 1, "never two jobs at once");
  const byBase = Object.fromEntries(manager.list().map((j) => [j.base, j]));
  assert.equal(byBase.a.state, "done");
  assert.equal(byBase.a.progress, 100);
  assert.equal(byBase.bad.state, "error");
  assert.equal(byBase.bad.error, "boom");
  assert.equal(byBase.c.state, "done");
  assert.equal("paths" in byBase.a, false, "server-side details are not listed");
});

test("cancelling stops a running job through its signal and drops a waiting one", async () => {
  const manager = createJobs({
    run: (job, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")));
      if (job.base === "quick") resolve();
    }),
  });
  const slow = manager.enqueue({ pj: "p", base: "slow", kind: "separate" });
  const queued = manager.enqueue({ pj: "p", base: "quick", kind: "separate" });
  await wait(10);
  assert.equal(manager.cancel(queued.id), true);
  assert.equal(manager.cancel(slow.id), true);
  const after = await settled(manager, slow.id);
  assert.equal(after.state, "cancelled");
  assert.equal(after.error, null);
  assert.equal(manager.list().find((j) => j.id === queued.id).state, "cancelled");
  assert.equal(manager.cancel("nope"), false);
  assert.equal(manager.dismiss(slow.id), true);
  assert.equal(manager.list().some((j) => j.id === slow.id), false);
});

test("a new run replaces the earlier result of the same job", async () => {
  const manager = createJobs({ run: async () => {} });
  const first = manager.enqueue({ pj: "p", base: "a", kind: "beats" });
  await settled(manager, first.id);
  const second = manager.enqueue({ pj: "p", base: "a", kind: "beats" });
  await settled(manager, second.id);
  assert.equal(manager.list("p").length, 1);
  assert.notEqual(first.id, second.id);
});

test("findSongAudio finds the audio file and never leaves Output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mvs-song-"));
  try {
    await mkdir(join(root, "Output", "song"), { recursive: true });
    await writeFile(join(root, "Output", "song", "x.wav"), "w");
    await writeFile(join(root, "outside.mp3"), "o");
    assert.equal((await findSongAudio(root, "song/x")).file, join(root, "Output", "song", "x.wav"));
    for (const bad of ["song/none", "../outside", "..\\..\\outside", "", null, "/etc/passwd", "song/x\0"]) assert.equal(await findSongAudio(root, bad), null, String(bad));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("listStems lists the four stems in a fixed order with paths under Output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mvs-stems-"));
  try {
    const dir = join(root, "Output", "song", "x.stems");
    await mkdir(dir, { recursive: true });
    for (const name of ["other.wav", "vocals.wav", "notes.txt"]) await writeFile(join(dir, name), "12345");
    const stems = await listStems(join(root, "Output", "song", "x"), join(root, "Output"));
    assert.deepEqual(stems.map((s) => [s.name, s.path, s.size]), [["vocals", "song/x.stems/vocals.wav", 5], ["other", "song/x.stems/other.wav", 5]]);
    assert.deepEqual(await listStems(join(root, "Output", "song", "none"), join(root, "Output")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a song job is refused with a clear message when the tools or the audio are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mvs-refuse-"));
  try {
    await mkdir(join(root, "Output", "song"), { recursive: true });
    await writeFile(join(root, "Output", "song", "x.mp3"), "a");
    const tools = { status: async () => ({ ready: { beats: false, separate: false }, model: "htdemucs", cuda: false }) };
    const jobs = createSongJobs({ tools });
    await assert.rejects(jobs.enqueue({ pj: "p", pjDir: root, base: "song/none", kind: "beats" }), /no audio file/);
    await assert.rejects(jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "separate" }), /Demucs is not set up/);
    await assert.rejects(jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "beats" }), /numpy and ffmpeg/);
    await assert.rejects(jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "hack" }), SongJobError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installHelp lists only what is missing, with the workspace environment for Demucs", () => {
  const all = installHelp({ python: { found: false }, numpy: null, demucs: null, ffmpeg: { found: false }, workspace: "/w", platform: "linux", venvPython: "/w/.mv-studio/venv/bin/python" });
  assert.deepEqual(all.map((s) => s.label.split("(")[0].trim()), ["Python 3 を入れる", "ffmpeg を入れる", "専用の環境を作る", "Demucs を入れる"]);
  assert.match(all[3].command, /\.mv-studio\/venv\/bin\/python" -m pip install demucs/);
  const none = installHelp({ python: { found: true, command: "python3" }, numpy: "1", demucs: "4", ffmpeg: { found: true }, workspace: "/w", platform: "linux", venvPython: "x" });
  assert.deepEqual(none, []);
  const onlyNumpy = installHelp({ python: { found: true, command: "python3", pre: [] }, numpy: null, demucs: "4", ffmpeg: { found: true }, workspace: "/w", platform: "linux", venvPython: "x" });
  assert.match(onlyNumpy[0].command, /pip install numpy/);
});

test("setPython refuses things that are not a runnable Python, and the setting survives", async () => {
  const root = await mkdtemp(join(tmpdir(), "mvs-tools-"));
  try {
    const tools = createAudioTools({ workspace: root, toolsDir: TOOLS_DIR, env: {}, platform: process.platform });
    await assert.rejects(tools.setPython("/does/not/exist"), /not a file/);
    await assert.rejects(tools.setPython(join(root, "notes.txt")), /not a file/);
    await writeFile(join(root, "notes.txt"), "x");
    await assert.rejects(tools.setPython(join(root, "notes.txt")), /did not run/);
    await assert.rejects(tools.setModel("evil-model"), /model: one of/);
    assert.equal((await tools.setModel("htdemucs_ft")).model, "htdemucs_ft");
    assert.equal((await createAudioTools({ workspace: root, toolsDir: TOOLS_DIR, env: {}, platform: process.platform }).status()).model, "htdemucs_ft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("beat analysis finds the tempo and the hits of a synthetic 120 BPM drum loop (needs Python with numpy, and ffmpeg)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mvs-beats-"));
  try {
    const tools = createAudioTools({ workspace: root, toolsDir: TOOLS_DIR });
    if (!(await tools.status()).ready.beats) return t.skip("Python with numpy, and ffmpeg, are not available here");
    const sr = 22050;
    const seconds = 16;
    const pcm = new Int16Array(sr * seconds);
    const kick = (at) => { for (let i = 0; i < sr * 0.12; i++) { const t0 = i / sr; pcm[at + i] += Math.round(20000 * Math.sin(2 * Math.PI * (110 * Math.exp(-t0 * 18) + 45) * t0) * Math.exp(-t0 * 22)); } };
    for (let beat = 0; beat < seconds * 2 - 1; beat += 2) kick(Math.round((0.2 + beat * 0.5) * sr)); // a kick every second, beat grid 0.5 s
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length * 2, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length * 2, 40);
    const wav = join(root, "loop.wav");
    await writeFile(wav, Buffer.concat([header, Buffer.from(pcm.buffer)]));
    const out = join(root, "beats.json");
    const seen = [];
    await tools.runScript("beats.py", ["--input", wav, "--out", out], { onProgress: (p) => seen.push(p) });
    const result = JSON.parse(await (await import("node:fs/promises")).readFile(out, "utf8"));
    assert.equal(result.source, "local");
    assert.ok(Math.abs(result.kick.length - seconds) <= 2, `kicks: ${result.kick.length}`);
    assert.ok(Math.abs(result.kick[0] - 0.2) < 0.07, `first kick at ${result.kick[0]}`);
    assert.ok(seen.includes(100));
    assert.deepEqual((await readdir(root)).sort(), ["beats.json", "loop.wav"]);
    // a missing file is an error with a readable message, not a hang
    await assert.rejects(tools.runScript("beats.py", ["--input", join(root, "missing.wav"), "--out", out]), /file not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

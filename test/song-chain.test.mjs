import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SongJobError, createSongJobs } from "../song-jobs.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (manager, check) => { for (let i = 0; i < 400 && !check(manager.list()); i++) await wait(5); return manager.list(); };
const argOf = (args, flag) => args[args.indexOf(flag) + 1];

/** A project with one song, and audio tools that only record what they were asked to do. */
async function scenario(run, { beatsReady = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mvs-chain-"));
  const song = join(root, "Output", "song");
  await mkdir(song, { recursive: true });
  await writeFile(join(song, "x.mp3"), "audio");
  const calls = [];
  const tools = {
    status: async () => ({ ready: { separate: true, beats: beatsReady }, model: "htdemucs", cuda: false }),
    runScript: async (script, args, { onProgress }) => {
      calls.push({ script, drums: args.includes("--drums") });
      onProgress?.(50);
      if (script === "separate.py") { await mkdir(argOf(args, "--out-dir"), { recursive: true }); await writeFile(join(argOf(args, "--out-dir"), "drums.wav"), "d"); }
      else await writeFile(argOf(args, "--out"), "{}");
    },
  };
  try { await run({ root, song, tools, calls, jobs: createSongJobs({ tools }) }); } finally { await rm(root, { recursive: true, force: true }); }
}

test("separate-then-beats runs the separation, then the analysis, which uses the new drums stem", async () => {
  await scenario(async ({ root, song, calls, jobs }) => {
    const job = await jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "separate", then: "beats" });
    assert.equal(job.then, "beats");
    const list = await until(jobs.manager, (l) => l.length === 2 && l.every((j) => j.state === "done"));
    assert.deepEqual(list.map((j) => j.kind).sort(), ["beats", "separate"]);
    assert.deepEqual(calls, [{ script: "separate.py", drums: false }, { script: "beats.py", drums: true }]);
    assert.ok(existsSync(join(song, "x.stems", "drums.wav")));
    assert.ok(existsSync(join(song, "x.beats.json")));
  });
});

test("a plain separation does not queue an analysis", async () => {
  await scenario(async ({ root, calls, jobs }) => {
    await jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "separate" });
    await until(jobs.manager, (l) => l.every((j) => j.state === "done"));
    await wait(30);
    assert.deepEqual(calls.map((c) => c.script), ["separate.py"]);
    assert.equal(jobs.manager.list().length, 1);
  });
});

test("only the analysis may follow a separation, and it needs the analysis tools up front", async () => {
  await scenario(async ({ root, jobs }) => {
    await assert.rejects(jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "beats", then: "beats" }), SongJobError);
    await assert.rejects(jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "separate", then: "rm -rf" }), /only "beats"/);
  });
  await scenario(async ({ root, jobs }) => {
    await assert.rejects(jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "separate", then: "beats" }), /numpy and ffmpeg/);
    assert.equal(jobs.manager.list().length, 0, "nothing was queued");
  }, { beatsReady: false });
});

test("if the separation fails, the analysis does not run", async () => {
  await scenario(async ({ root, tools, calls, jobs }) => {
    tools.runScript = async (script) => { calls.push({ script }); throw new Error("No module named 'numpy'"); };
    await jobs.enqueue({ pj: "p", pjDir: root, base: "song/x", kind: "separate", then: "beats" });
    const list = await until(jobs.manager, (l) => l.every((j) => !["queued", "running"].includes(j.state)));
    assert.equal(list.length, 1);
    assert.equal(list[0].state, "error");
    assert.match(list[0].error, /numpy が入っていません/);
    assert.deepEqual(calls.map((c) => c.script), ["separate.py"]);
  });
});

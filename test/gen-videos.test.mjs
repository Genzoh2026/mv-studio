import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanGen, readGen } from "../gen.mjs";
import { VideoError, listNumberedVideos, trashVideos, videoPath } from "../videos.mjs";
import { listNumberedImages } from "../images.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), "mvs-gen-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("cleanGen keeps known fields, clamps them, and drops what it does not know", () => {
  const gen = cleanGen({
    kind: "cut",
    inputs: [{ type: "song", name: "s.mp3" }, { type: "image", name: "a.png" }, { type: "secret", name: "x" }, { type: "image" }, null],
    method: { tool: "kling", model: "v2", prompt: "p".repeat(9000), params: { seconds: 5, hd: true, nested: { a: 1 }, list: [1] }, created_at: "2026-11-04T01:02:03Z" },
    parent: { name: "cut-1.mp4", comments: ["c-1", 5, "c-2"] },
    note: "memo",
    command: "rm -rf /",
  });
  assert.equal(gen.kind, "cut");
  assert.deepEqual(gen.inputs, [{ type: "song", name: "s.mp3" }, { type: "image", name: "a.png" }]);
  assert.equal(gen.method.prompt.length, 4000);
  assert.deepEqual(gen.method.params, [["seconds", "5"], ["hd", "true"]]);
  assert.equal(gen.method.createdAt, "2026-11-04T01:02:03.000Z");
  assert.deepEqual(gen.parent, { name: "cut-1.mp4", comments: ["c-1", "c-2"] });
  assert.equal("command" in gen, false);
});

test("cleanGen turns unknown kinds, bad dates and non-objects into safe values", () => {
  const gen = cleanGen({ kind: "other", method: { created_at: "yesterday" } });
  assert.equal(gen.kind, null);
  assert.equal(gen.method.createdAt, null);
  assert.deepEqual(gen.inputs, []);
  assert.equal(gen.parent, null);
  for (const bad of [null, "text", 5, [1, 2]]) assert.equal(cleanGen(bad), null);
});

test("readGen: no sidecar is null, a broken one is an error, a good one is cleaned", async () => {
  await scratch(async (dir) => {
    assert.equal(await readGen(dir, "none.mp4"), null);
    await writeFile(join(dir, "broken.gen.json"), "{ nope");
    assert.match((await readGen(dir, "broken.mp4")).error, /broken JSON/);
    await writeFile(join(dir, "list.gen.json"), "[1]");
    assert.deepEqual(await readGen(dir, "list.webm"), { error: "not a JSON object" });
    await writeFile(join(dir, "ok.gen.json"), JSON.stringify({ kind: "final", note: "done" }));
    const gen = await readGen(dir, "ok.mp4");
    assert.equal(gen.kind, "final");
    assert.equal(gen.note, "done");
  });
});

test("videoPath only accepts plain mp4 and webm names", () => {
  const dir = join("w", "video");
  assert.equal(videoPath(dir, "a.mp4"), join(dir, "a.mp4"));
  assert.equal(videoPath(dir, "A.WEBM"), join(dir, "A.WEBM"));
  for (const bad of ["../a.mp4", "sub/a.mp4", ".h.mp4", "a.mov", "a.json", "a.gen.json", "", null]) assert.equal(videoPath(dir, bad), null, String(bad));
});

test("the video library lists videos with ids and provenance, and ignores the sidecars and the ledger", async () => {
  await scratch(async (dir) => {
    await writeFile(join(dir, "cut1.mp4"), "x");
    await writeFile(join(dir, "cut1.gen.json"), JSON.stringify({ kind: "cut", inputs: [{ type: "image", name: "a.png" }] }));
    await writeFile(join(dir, "outside.webm"), "y");
    const list = await listNumberedVideos(dir);
    assert.deepEqual(list.map((v) => v.name).sort(), ["cut1.mp4", "outside.webm"]);
    const cut = list.find((v) => v.name === "cut1.mp4");
    assert.equal(cut.gen.kind, "cut");
    assert.equal(list.find((v) => v.name === "outside.webm").gen, null);
    assert.deepEqual(list.map((v) => v.id).sort(), [1, 2]);
    assert.deepEqual((await listNumberedVideos(dir)).map((v) => v.id).sort(), [1, 2]);
  });
});

test("an image with a sidecar carries its provenance, one without is the user's", async () => {
  await scratch(async (dir) => {
    await writeFile(join(dir, "made.png"), PNG);
    await writeFile(join(dir, "made.gen.json"), JSON.stringify({ kind: "still", method: { tool: "comfyui" } }));
    await writeFile(join(dir, "mine.png"), PNG);
    const byName = Object.fromEntries((await listNumberedImages(dir)).map((i) => [i.name, i]));
    assert.equal(byName["made.png"].gen.method.tool, "comfyui");
    assert.equal(byName["mine.png"].gen, null);
  });
});

test("trashVideos moves videos and refuses bad names", async () => {
  await scratch(async (root) => {
    const dir = join(root, "video");
    const trash = join(root, "_Trash");
    await import("node:fs/promises").then((fs) => fs.mkdir(dir));
    await writeFile(join(dir, "a.mp4"), "x");
    const result = await trashVideos(dir, trash, ["a.mp4", "../a.mp4"]);
    assert.deepEqual(result.moved, ["a.mp4"]);
    assert.equal(result.failed[0].error, "invalid name");
    await assert.rejects(trashVideos(dir, trash, []), VideoError);
  });
});

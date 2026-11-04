import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrashError, collectSet, deleteItems, emptyTrash, listTrash, mediaSets, restoreItems, trashSets } from "../trash.mjs";

const PJ = "20261104-demo";
const validPjName = (name) => /^[\p{L}\p{N}_-]{1,64}$/u.test(name);

/** A workspace with one project that has a song set, two images and a video. */
async function workspace(run) {
  const root = await mkdtemp(join(tmpdir(), "mvs-trash-"));
  const pjDir = join(root, "PJs", PJ);
  const song = join(pjDir, "Output", "song");
  const image = join(pjDir, "Output", "image");
  await mkdir(join(song, "x.stems"), { recursive: true });
  await mkdir(image, { recursive: true });
  for (const [dir, name, body] of [
    [song, "x.mp3", "audio"], [song, "x.suno.json", "{}"], [song, "x.analysis.json", "{}"], [song, "other.mp3", "keep"],
    [song, "x.stems/vocals.wav", "v"], [image, "a.png", "A"], [image, "a.gen.json", "{}"], [image, "b.png", "B"],
  ]) await writeFile(join(dir, name), body);
  const ctx = { root, pjDir, song, image, trashRoot: join(root, "_Trash"), pjsRoot: join(root, "PJs") };
  try { await run(ctx); } finally { await rm(root, { recursive: true, force: true }); }
}

test("collectSet gathers only the allowed siblings of one song, folders included", async () => {
  await workspace(async ({ song }) => {
    const names = await collectSet(song, "x", [".mp3", ".suno.json", ".analysis.json", ".stems", ".gen.json"]);
    assert.deepEqual(names.sort(), ["x.analysis.json", "x.mp3", "x.stems", "x.suno.json"]);
    assert.deepEqual(await collectSet(song, "x", [".mp3"]), ["x.mp3"]);
    assert.deepEqual(await collectSet(join(song, "nope"), "x", [".mp3"]), []);
  });
});

test("mediaSets takes the .gen.json along only when every file sharing its stem is going", () => {
  const isMedia = (n) => /\.(png|jpg)$/.test(n);
  const dir = ["a.png", "a.jpg", "a.gen.json", "b.png"];
  assert.deepEqual(mediaSets(dir, ["a.png"], isMedia, [".gen.json"]), [{ label: "a.png", base: "a", files: ["a.png"] }]);
  const both = mediaSets(dir, ["a.png", "a.jpg"], isMedia, [".gen.json"]);
  assert.deepEqual(both.map((s) => s.files).flat().sort(), ["a.gen.json", "a.gen.json", "a.jpg", "a.png"]);
  assert.deepEqual(mediaSets(dir, ["b.png"], isMedia, [".gen.json"])[0].files, ["b.png"]);
});

test("a trashed song moves with all its sidecars, leaves the others, and can be restored to the same place", async () => {
  await workspace(async (ctx) => {
    const names = await collectSet(ctx.song, "x", [".mp3", ".suno.json", ".analysis.json", ".stems"]);
    const result = await trashSets({ ...ctx, pjName: PJ, kind: "song", dir: "Output/song", sets: [{ label: "x", base: "x", files: names }] });
    assert.deepEqual(result, { moved: ["x"], failed: [] });
    assert.deepEqual((await readdir(ctx.song)).sort(), ["other.mp3"]);
    const [entry] = await listTrash(ctx.trashRoot);
    assert.equal(entry.kind, "song");
    assert.equal(entry.pj, PJ);
    assert.deepEqual(entry.items, [{ index: 0, label: "x", count: 4 }]);

    const back = await restoreItems({ ...ctx, items: [{ id: entry.id, index: 0 }], validPjName });
    assert.deepEqual(back.failed, []);
    assert.deepEqual((await readdir(ctx.song)).sort(), ["other.mp3", "x.analysis.json", "x.mp3", "x.stems", "x.suno.json"]);
    assert.equal(await readFile(join(ctx.song, "x.stems", "vocals.wav"), "utf8"), "v");
    assert.deepEqual(await listTrash(ctx.trashRoot), []); // the empty batch folder is gone
  });
});

test("restoring never overwrites: a taken name moves the whole set to -2", async () => {
  await workspace(async (ctx) => {
    const names = await collectSet(ctx.image, "a", [".png", ".gen.json"]);
    await trashSets({ ...ctx, pjName: PJ, kind: "image", dir: "Output/image", sets: [{ label: "a.png", base: "a", files: names }] });
    await writeFile(join(ctx.image, "a.png"), "NEW");
    const [entry] = await listTrash(ctx.trashRoot);
    const back = await restoreItems({ ...ctx, items: [{ id: entry.id, index: 0 }], validPjName });
    assert.equal(back.restored[0].as, "a-2.png");
    assert.equal(await readFile(join(ctx.image, "a.png"), "utf8"), "NEW");
    assert.equal(await readFile(join(ctx.image, "a-2.png"), "utf8"), "A");
    assert.ok(existsSync(join(ctx.image, "a-2.gen.json")), "the sidecar follows the new name");
  });
});

test("one batch with several items: restore and delete pick the right ones", async () => {
  await workspace(async (ctx) => {
    const sets = [
      { label: "a.png", base: "a", files: ["a.png", "a.gen.json"] },
      { label: "b.png", base: "b", files: ["b.png"] },
    ];
    await trashSets({ ...ctx, pjName: PJ, kind: "image", dir: "Output/image", sets });
    const [entry] = await listTrash(ctx.trashRoot);
    assert.deepEqual(entry.items.map((i) => i.label), ["a.png", "b.png"]);
    // delete item 0 for good, restore item 1: the indexes refer to the manifest before either runs
    const del = await deleteItems({ trashRoot: ctx.trashRoot, items: [{ id: entry.id, index: 0 }] });
    assert.equal(del.deleted, 1);
    const [after] = await listTrash(ctx.trashRoot);
    assert.deepEqual(after.items, [{ index: 0, label: "b.png", count: 1 }]);
    await restoreItems({ ...ctx, items: [{ id: after.id, index: 0 }], validPjName });
    assert.deepEqual((await readdir(ctx.image)).sort(), ["b.png"]);
    assert.deepEqual(await listTrash(ctx.trashRoot), []);
  });
});

test("selecting several items of one batch at once works whatever order they come in", async () => {
  await workspace(async (ctx) => {
    await trashSets({ ...ctx, pjName: PJ, kind: "image", dir: "Output/image", sets: [{ label: "a.png", base: "a", files: ["a.png"] }, { label: "b.png", base: "b", files: ["b.png"] }] });
    const [entry] = await listTrash(ctx.trashRoot);
    const result = await restoreItems({ ...ctx, items: [{ id: entry.id, index: 0 }, { id: entry.id, index: 1 }, { id: entry.id, index: 1 }], validPjName });
    assert.equal(result.restored.length, 2);
    assert.deepEqual((await readdir(ctx.image)).sort(), ["a.gen.json", "a.png", "b.png"]);
  });
});

test("a set that cannot move completely is rolled back and reported", async () => {
  await workspace(async (ctx) => {
    const result = await trashSets({ ...ctx, pjName: PJ, kind: "image", dir: "Output/image", sets: [{ label: "a.png", base: "a", files: ["a.png", "missing.gen.json"] }] });
    assert.deepEqual(result.moved, []);
    assert.equal(result.failed[0].name, "a.png");
    assert.ok(existsSync(join(ctx.image, "a.png")), "the first file was put back");
    assert.deepEqual(await listTrash(ctx.trashRoot), []);
  });
});

test("trashSets refuses a folder outside the project", async () => {
  await workspace(async (ctx) => {
    await assert.rejects(trashSets({ ...ctx, pjName: PJ, kind: "image", dir: "../../..", sets: [{ label: "x", base: "x", files: ["x"] }] }), TrashError);
  });
});

test("restore needs its project, and a trash id cannot point outside the trash", async () => {
  await workspace(async (ctx) => {
    await trashSets({ ...ctx, pjName: PJ, kind: "image", dir: "Output/image", sets: [{ label: "b.png", base: "b", files: ["b.png"] }] });
    const [entry] = await listTrash(ctx.trashRoot);
    await rm(ctx.pjDir, { recursive: true });
    const lost = await restoreItems({ ...ctx, items: [{ id: entry.id, index: 0 }], validPjName });
    assert.match(lost.failed[0].error, /restore it first/);
    for (const id of ["..", "../PJs", ".hidden"]) {
      const bad = await deleteItems({ trashRoot: ctx.trashRoot, items: [{ id, index: 0 }] });
      assert.equal(bad.deleted, 0, id);
      assert.match(bad.failed[0].error, /bad trash id/);
    }
    assert.ok(existsSync(ctx.pjsRoot));
  });
});

test("whole projects in the older layout are listed, restored, and emptied; unknown folders are left alone", async () => {
  await workspace(async (ctx) => {
    const legacy = join(ctx.trashRoot, `${PJ}-old__2026-11-03T10-20-30-123Z`);
    await mkdir(join(legacy, "Output"), { recursive: true });
    await writeFile(join(legacy, "CLAUDE.md"), "notes");
    await mkdir(join(ctx.trashRoot, "my own folder"), { recursive: true });
    const [entry] = await listTrash(ctx.trashRoot);
    assert.deepEqual([entry.kind, entry.pj, entry.at], ["pj", `${PJ}-old`, "2026-11-03T10:20:30.123Z"]);
    await restoreItems({ ...ctx, items: [{ id: entry.id, index: 0 }], validPjName });
    assert.equal(await readFile(join(ctx.pjsRoot, `${PJ}-old`, "CLAUDE.md"), "utf8"), "notes");

    await trashSets({ ...ctx, pjName: PJ, kind: "image", dir: "Output/image", sets: [{ label: "b.png", base: "b", files: ["b.png"] }] });
    const emptied = await emptyTrash(ctx.trashRoot);
    assert.equal(emptied.deleted, 1);
    assert.deepEqual(await readdir(ctx.trashRoot), ["my own folder"]);
    assert.equal(emptied.left, 1);
  });
});

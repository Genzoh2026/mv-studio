import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNumbered } from "../library-core.mjs";

const songs = (...bases) => async () => bases.map((name, i) => ({ name, mtime: 1000 + i }));

async function scratch(run) {
  const root = await mkdtemp(join(tmpdir(), "mvs-song-ids-"));
  try { await run(join(root, "Output", "song")); } finally { await rm(root, { recursive: true, force: true }); }
}

test("songs are numbered by base path, and the ledger folder is created when it does not exist yet", async () => {
  await scratch(async (dir) => {
    const first = await listNumbered(dir, songs("song/a", "song/b"));
    assert.deepEqual(first.map((s) => [s.name, s.id]), [["song/a", 1], ["song/b", 2]]);
    const ledger = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    assert.deepEqual(ledger.items.map((i) => [i.id, i.name]), [[1, "song/a"], [2, "song/b"]]);
    assert.equal(ledger.next, 3);
  });
});

test("a song keeps its id when its audio arrives later (same base path), and a removed song's id is never reused", async () => {
  await scratch(async (dir) => {
    await listNumbered(dir, songs("song/a", "song/preview"));
    // the preview gets downloaded: still "song/preview", so still #2
    assert.equal((await listNumbered(dir, songs("song/a", "song/preview"))).find((s) => s.name === "song/preview").id, 2);
    // song/a is trashed, a new song appears: the gap stays and the new song is #3
    const next = await listNumbered(dir, songs("song/preview", "song/new"));
    assert.deepEqual(next.map((s) => [s.name, s.id]), [["song/preview", 2], ["song/new", 3]]);
    // song/a comes back later: a new song, a new id
    const back = await listNumbered(dir, songs("song/a", "song/preview", "song/new"));
    assert.equal(back.find((s) => s.name === "song/a").id, 4);
  });
});

test("an empty library writes no ledger", async () => {
  await scratch(async (dir) => {
    assert.deepEqual(await listNumbered(dir, songs()), []);
    await assert.rejects(readFile(join(dir, "index.json")), /ENOENT/);
  });
});

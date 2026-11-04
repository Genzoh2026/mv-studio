import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageError, MAX_IMAGE_BYTES, cleanStem, imagePath, listImages, listNumberedImages, saveImage, sniffImage } from "../images.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a....");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")]);

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), "mvs-img-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("sniffImage recognises the supported formats by header and nothing else", () => {
  assert.equal(sniffImage(PNG), ".png");
  assert.equal(sniffImage(JPG), ".jpg");
  assert.equal(sniffImage(GIF), ".gif");
  assert.equal(sniffImage(WEBP), ".webp");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(sniffImage(Buffer.from("MZ executable")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("cleanStem strips folders, extension and characters Windows rejects", () => {
  assert.equal(cleanStem("C:\\Users\\me\\pic.png"), "pic");
  assert.equal(cleanStem("../../etc/passwd"), "passwd");
  assert.equal(cleanStem('a<b>:"c|?*.jpg'), "a_b___c___");
  assert.equal(cleanStem("  ..hidden.. .png"), "hidden");
  assert.equal(cleanStem("風景 1.webp"), "風景 1");
  assert.equal(cleanStem("CON.png"), "_CON");
  assert.equal(cleanStem(""), "image");
  assert.equal(cleanStem("...png"), "image");
  assert.ok(cleanStem("x".repeat(500)).length <= 100);
});

test("saveImage names the file by its content, never overwrites, and refuses non-images", async () => {
  await scratch(async (root) => {
    const dir = join(root, "Output", "image");
    assert.equal(await saveImage(dir, "cat.jpeg", PNG), "cat.png"); // the extension follows the bytes, not the claim
    assert.equal(await saveImage(dir, "cat.png", PNG), "cat-2.png");
    assert.equal(await saveImage(dir, "cat.png", PNG), "cat-3.png");
    await assert.rejects(saveImage(dir, "x.png", Buffer.from("not an image")), ImageError);
    await assert.rejects(saveImage(dir, "x.png", Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])), /too large/);
    assert.deepEqual((await listImages(dir)).map((i) => i.name).sort(), ["cat-2.png", "cat-3.png", "cat.png"]);
  });
});

test("imagePath only accepts plain image file names", () => {
  const dir = join("w", "image");
  assert.equal(imagePath(dir, "a.png"), join(dir, "a.png"));
  for (const bad of ["../a.png", "sub/a.png", "sub\\a.png", ".hidden.png", "a.svg", "a.txt", "", null, 5]) {
    assert.equal(imagePath(dir, bad), null, String(bad));
  }
});

test("listImages ignores other files and folders, and a missing folder is empty", async () => {
  await scratch(async (root) => {
    assert.deepEqual(await listImages(join(root, "nope")), []);
    await writeFile(join(root, "a.png"), PNG);
    await writeFile(join(root, "notes.txt"), "x");
    await writeFile(join(root, "icon.svg"), "<svg/>");
    const [only, ...rest] = await listImages(root);
    assert.equal(only.name, "a.png");
    assert.equal(only.size, PNG.length);
    assert.deepEqual(rest, []);
  });
});

const idsByName = (list) => Object.fromEntries(list.map((i) => [i.name, i.id]));

test("numbering: ids start at 1, follow file age for a batch, and stay stable", async () => {
  await scratch(async (dir) => {
    for (const [name, secondsAgo] of [["newer.png", 10], ["older.png", 100]]) {
      await writeFile(join(dir, name), PNG);
      const t = new Date(Date.now() - secondsAgo * 1000);
      await utimes(join(dir, name), t, t);
    }
    assert.deepEqual(idsByName(await listNumberedImages(dir)), { "older.png": 1, "newer.png": 2 });
    await writeFile(join(dir, "third.png"), PNG);
    assert.deepEqual(idsByName(await listNumberedImages(dir)), { "older.png": 1, "newer.png": 2, "third.png": 3 });
    assert.deepEqual(idsByName(await listNumberedImages(dir)), { "older.png": 1, "newer.png": 2, "third.png": 3 });
  });
});

test("numbering: a removed image leaves a gap and its id is never reused", async () => {
  await scratch(async (dir) => {
    await writeFile(join(dir, "a.png"), PNG);
    await writeFile(join(dir, "b.png"), PNG);
    await listNumberedImages(dir);
    await rm(join(dir, "b.png"));
    assert.deepEqual(idsByName(await listNumberedImages(dir)), { "a.png": 1 });
    await writeFile(join(dir, "c.png"), PNG);
    assert.deepEqual(idsByName(await listNumberedImages(dir)), { "a.png": 1, "c.png": 3 });
    // The same name coming back after a sync is a new picture, so it is a new id.
    await rm(join(dir, "a.png"));
    await listNumberedImages(dir);
    await writeFile(join(dir, "a.png"), JPG);
    assert.equal(idsByName(await listNumberedImages(dir))["a.png"], 4);
  });
});

test("numbering: simultaneous requests never hand out the same id", async () => {
  await scratch(async (dir) => {
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) await writeFile(join(dir, name), PNG);
    const results = await Promise.all(Array.from({ length: 8 }, () => listNumberedImages(dir)));
    const ids = results[0].map((i) => i.id).sort();
    assert.deepEqual(ids, [1, 2, 3, 4]);
    for (const result of results) assert.deepEqual(idsByName(result), idsByName(results[0]));
  });
});

test("numbering: an unreadable ledger is kept aside and numbering restarts instead of being overwritten", async () => {
  await scratch(async (dir) => {
    await writeFile(join(dir, "a.png"), PNG);
    await writeFile(join(dir, "index.json"), "{ not json");
    assert.deepEqual(idsByName(await listNumberedImages(dir)), { "a.png": 1 });
    const kept = (await readdir(dir)).filter((n) => n.startsWith("index.broken-"));
    assert.equal(kept.length, 1);
    assert.equal(await readFile(join(dir, kept[0]), "utf8"), "{ not json");
  });
});

test("numbering: a missing folder is an empty library and no ledger is created", async () => {
  await scratch(async (root) => {
    const dir = join(root, "none");
    assert.deepEqual(await listNumberedImages(dir), []);
    assert.deepEqual(await readdir(root), []);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageError, MAX_IMAGE_BYTES, cleanStem, imagePath, listImages, saveImage, sniffImage, trashImages } from "../images.mjs";

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

test("trashImages moves valid files, keeps bytes, and reports bad names without stopping", async () => {
  await scratch(async (root) => {
    const dir = join(root, "image");
    const trash = join(root, "_Trash", "images", "pj__stamp");
    const name = await saveImage(dir, "keep.png", JPG);
    await writeFile(join(root, "outside.png"), PNG);
    const result = await trashImages(dir, trash, [name, "../outside.png", "missing.png", name]);
    assert.deepEqual(result.moved, [name]);
    assert.deepEqual(result.failed.map((f) => f.name).sort(), ["../outside.png", "missing.png"]);
    assert.ok(existsSync(join(root, "outside.png")));
    assert.ok(!existsSync(join(dir, name)));
    assert.deepEqual(await readFile(join(trash, name)), JPG);
    await assert.rejects(trashImages(dir, trash, []), ImageError);
  });
});

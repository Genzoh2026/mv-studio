import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewError, markDone, markSent, readReview, requestMarkdown, saveUserPins, writeRequest, deletePins } from "../review.mjs";
import { resolveVideo } from "../agent-api.mjs";

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), "mvs-review-"));
  await writeFile(join(dir, "cut.mp4"), "v1");
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const touch = async (file, whenMs) => { await utimes(file, whenMs / 1000, whenMs / 1000); };

test("no review file is an empty review; a broken one is reported and left alone", async () => {
  await scratch(async (dir) => {
    assert.deepEqual(await readReview(dir, "cut.mp4"), { version: 1, next: 1, pins: [] });
    await writeFile(join(dir, "cut.review.json"), "{ nope");
    await assert.rejects(readReview(dir, "cut.mp4"), /broken/);
    await assert.rejects(saveUserPins(dir, "cut.mp4", []), /broken/, "never overwrites what it cannot read");
    assert.equal(await readFile(join(dir, "cut.review.json"), "utf8"), "{ nope");
  });
});

test("the user's pins get numbers that are never reused, and the file clamps what it stores", async () => {
  await scratch(async (dir) => {
    let review = await saveUserPins(dir, "cut.mp4", [{ t: 12.34567, x: 1.5, y: 0.25, text: "口元を隠す" }, { t: 3, text: "全体を明るく" }]);
    assert.deepEqual(review.pins.map((p) => [p.id, p.t, p.x, p.y]), [[2, 3, null, null], [1, 12.346, 1, 0.25]], "sorted by time; place clamped to 0..1; no place = whole picture");
    review = await saveUserPins(dir, "cut.mp4", review.pins.filter((p) => p.id !== 2));
    review = await saveUserPins(dir, "cut.mp4", [...review.pins, { t: 5, text: "new" }]);
    assert.deepEqual(review.pins.map((p) => p.id), [3, 1], "the deleted pin 2 is not reused; pins are sorted by time (5s, then 12s)");
    assert.equal(review.next, 4);
    await assert.rejects(saveUserPins(dir, "cut.mp4", [{ text: "no time" }]), /time/);
    await assert.rejects(saveUserPins(dir, "cut.mp4", "x"), ReviewError);
  });
});

test("editing a sent pin makes it unsent again; the page cannot set sent or done marks", async () => {
  await scratch(async (dir) => {
    let review = await saveUserPins(dir, "cut.mp4", [{ t: 1, text: "a" }]);
    review = await markSent(dir, "cut.mp4", [1], 1000);
    assert.equal(review.pins[0].sentAt, 1000);
    review = await saveUserPins(dir, "cut.mp4", [{ id: 1, t: 1, text: "a", sentAt: 9, status: "done", doneAt: 9, fixedIn: "x.mp4" }]);
    assert.deepEqual([review.pins[0].sentAt, review.pins[0].status], [1000, "open"], "unchanged pin keeps the real sent mark; the page's values are ignored");
    review = await saveUserPins(dir, "cut.mp4", [{ id: 1, t: 1, text: "a, changed" }]);
    assert.equal(review.pins[0].sentAt, null, "changed text must be sent again");
  });
});

test("the request file lists the open pins with time and place, and refuses when there is nothing to send", async () => {
  await scratch(async (dir) => {
    await assert.rejects(writeRequest(dir, "cut.mp4", { id: 3, name: "cut.mp4" }), /no open pin/);
    await saveUserPins(dir, "cut.mp4", [{ t: 72.5, x: 0.72, y: 0.18, text: "口元を隠す\n暗く" }, { t: 5, text: "" }, { t: 9, text: "切り替えを拍に合わせる" }]);
    const written = await writeRequest(dir, "cut.mp4", { id: 3, name: "cut.mp4" });
    assert.deepEqual(written.ids, [3, 1], "the pin without a comment is not sent");
    assert.equal(written.file, "cut.review.md");
    const md = await readFile(join(dir, "cut.review.md"), "utf8");
    assert.match(md, /# 動画 #3 cut\.mp4/);
    assert.match(md, /【修正】ピン1 1:12\.500 \(x 72%, y 18%\) 口元を隠す \/ 暗く/);
    assert.match(md, /【修正】ピン3 0:09\.000 \(全体\) 切り替えを拍に合わせる/);
    assert.match(requestMarkdown({ id: 1, name: "a.mp4" }, [{ id: 1, status: "done", text: "x", t: 1, x: null, y: null }]), /^# 動画 #1/, "done pins are not requested again");
  });
});

test("a pin is done only when it was sent and a NEWER other video exists", async () => {
  await scratch(async (dir) => {
    await saveUserPins(dir, "cut.mp4", [{ t: 1, text: "a" }, { t: 2, text: "b" }]);
    await assert.rejects(markDone(dir, "cut.mp4", [1], "cut-v2.mp4"), /does not exist/);
    await writeFile(join(dir, "cut-v2.mp4"), "v2");
    await touch(join(dir, "cut-v2.mp4"), 500);
    await assert.rejects(markDone(dir, "cut.mp4", [1], "cut-v2.mp4"), /not sent/);
    await markSent(dir, "cut.mp4", [1], 1000);
    await assert.rejects(markDone(dir, "cut.mp4", [1], "cut-v2.mp4"), /older than the moment/);
    await assert.rejects(markDone(dir, "cut.mp4", [1], "cut.mp4"), /NEW version/);
    await assert.rejects(markDone(dir, "cut.mp4", [1], "../x.mp4"), /NEW version/);
    await assert.rejects(markDone(dir, "cut.mp4", [9], "cut-v2.mp4"), /does not exist on/);
    await touch(join(dir, "cut-v2.mp4"), 2000);
    // pin 2 was never sent, so the whole report is refused and pin 1 stays open too
    await assert.rejects(markDone(dir, "cut.mp4", [1, 2], "cut-v2.mp4"), /pin 2 was not sent/);
    assert.equal((await readReview(dir, "cut.mp4")).pins.find((p) => p.id === 1).status, "open");
    const review = await markDone(dir, "cut.mp4", [1], "cut-v2.mp4", 3000);
    assert.deepEqual(review.pins.map((p) => [p.id, p.status, p.fixedIn, p.doneAt]), [[1, "done", "cut-v2.mp4", 3000], [2, "open", null, null]]);
    await assert.rejects(markDone(dir, "cut.mp4", [1], "cut-v2.mp4"), /already done/);
  });
});

test("finished pins survive the page's old list, can be deleted by the user, and cannot be edited", async () => {
  await scratch(async (dir) => {
    await saveUserPins(dir, "cut.mp4", [{ t: 1, text: "a" }]);
    await markSent(dir, "cut.mp4", [1], 1000);
    await writeFile(join(dir, "cut-v2.mp4"), "v2");
    await touch(join(dir, "cut-v2.mp4"), 2000);
    await markDone(dir, "cut.mp4", [1], "cut-v2.mp4", 3000);
    let review = await saveUserPins(dir, "cut.mp4", [{ id: 1, t: 1, text: "changed after done" }]);
    assert.deepEqual([review.pins[0].text, review.pins[0].status], ["a", "done"]);
    review = await saveUserPins(dir, "cut.mp4", []);
    assert.equal(review.pins.length, 1, "a stale list that lacks a finished pin does not delete it");
    review = await deletePins(dir, "cut.mp4", [1]);
    assert.equal(review.pins.length, 0);
    assert.ok((await readdir(dir)).every((n) => !n.endsWith(".tmp")), "no temp file is left");
  });
});

test("resolveVideo accepts an id, #id or a file name", () => {
  const videos = [{ id: 3, name: "cut.mp4" }, { id: 4, name: "cut-v2.mp4" }];
  assert.equal(resolveVideo(videos, "#3").name, "cut.mp4");
  assert.equal(resolveVideo(videos, 4).name, "cut-v2.mp4");
  assert.equal(resolveVideo(videos, "cut.mp4").id, 3);
  assert.throws(() => resolveVideo(videos, "9"), /no video #9/);
  assert.throws(() => resolveVideo(videos, "nope.mp4"), /no video named/);
});

test("a new pin keeps the number the page counted for it, but never one that is already taken", async () => {
  await scratch(async (dir) => {
    let review = await saveUserPins(dir, "cut.mp4", [{ id: 1, t: 1, text: "a" }]);
    review = await saveUserPins(dir, "cut.mp4", [...review.pins, { id: 3, t: 2, text: "b" }, { id: 1, t: 9, text: "collides" }]);
    assert.deepEqual(review.pins.map((p) => p.id).sort(), [1, 3, 4], "3 is kept (the page skipped 2); the colliding new pin gets the next free number");
    assert.equal(review.next, 5);
  });
});

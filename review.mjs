// Review pins on a video: <name>.review.json next to it. A pin is a time (and, usually, a place on the picture) with a comment
// that says what to change. The user adds and edits pins in the app; the app sends them to Claude as a short Markdown file
// (<name>.review.md); Claude fixes the video as a NEW version and marks the pins done through the app's MCP tool.
// A pin is only done when it was sent AND a video newer than the sending exists, so "done" always means "a fix was made".
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { withLock } from "./library-core.mjs";
import { videoPath } from "./videos.mjs";

export const REVIEW_EXT = ".review.json";
export const REVIEW_MD_EXT = ".review.md";
export const MAX_PINS = 300;
const MAX_TEXT = 2000;
const MAX_NAME = 200;

export class ReviewError extends Error {}

const stemOf = (videoName) => videoName.slice(0, videoName.length - extname(videoName).length);
export const reviewFile = (dir, videoName) => join(dir, `${stemOf(videoName)}${REVIEW_EXT}`);
export const reviewMarkdownFile = (dir, videoName) => join(dir, `${stemOf(videoName)}${REVIEW_MD_EXT}`);

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const unit = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);
const stamp = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : null);

/** A stored pin with every field clamped; null when it is not a pin. Pins are data to show, never instructions. */
function cleanPin(raw) {
  if (!isObject(raw) || !Number.isInteger(raw.id) || raw.id < 1) return null;
  if (typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t < 0) return null;
  const x = unit(raw.x);
  const y = unit(raw.y);
  return {
    id: raw.id,
    t: Math.round(raw.t * 1000) / 1000,
    x: x === null || y === null ? null : x,
    y: x === null || y === null ? null : y,
    text: typeof raw.text === "string" ? raw.text.slice(0, MAX_TEXT) : "",
    status: raw.status === "done" ? "done" : "open",
    createdAt: stamp(raw.createdAt),
    sentAt: stamp(raw.sentAt),
    doneAt: raw.status === "done" ? stamp(raw.doneAt) : null,
    fixedIn: raw.status === "done" && typeof raw.fixedIn === "string" ? raw.fixedIn.slice(0, MAX_NAME) : null,
  };
}

const empty = () => ({ version: 1, next: 1, pins: [] });

function cleanReview(raw) {
  if (!isObject(raw) || !Array.isArray(raw.pins)) return null;
  const pins = raw.pins.map(cleanPin).filter(Boolean).slice(0, MAX_PINS).sort((a, b) => a.t - b.t || a.id - b.id);
  const top = pins.reduce((max, pin) => Math.max(max, pin.id), 0);
  return { version: 1, next: Math.max(Number.isInteger(raw.next) ? raw.next : 1, top + 1), pins };
}

/** The video's review: no file is an empty review; an unreadable file is reported, never overwritten silently. */
export async function readReview(dir, videoName) {
  let data;
  try {
    data = await readFile(reviewFile(dir, videoName), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return empty();
    throw new ReviewError(`cannot read the review file: ${err.code ?? err.message}`);
  }
  try {
    return cleanReview(JSON.parse(data)) ?? (() => { throw new Error("not a review object"); })();
  } catch (err) {
    throw new ReviewError(`the review file is broken (${err.message}); fix or move ${stemOf(videoName)}${REVIEW_EXT}`);
  }
}

async function writeReview(dir, videoName, review) {
  await mkdir(dir, { recursive: true });
  const file = reviewFile(dir, videoName);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(review, null, 2));
  await rename(tmp, file);
}

/** Runs a change of one video's review after the others, so the app and Claude never overwrite each other. */
const changeReview = (dir, videoName, change) => withLock(reviewFile(dir, videoName), async () => {
  const review = await readReview(dir, videoName);
  const next = await change(review);
  await writeReview(dir, videoName, next);
  return next;
});

/**
 * The user's edit of the pin list: pins that are not sent are deleted, new ones are added, text and place of open pins change.
 * What belongs to the app and to Claude (status, sent and done marks) is never taken from the page.
 * @param {{id?: number, t: number, x?: number|null, y?: number|null, text?: string}[]} incoming
 */
export async function saveUserPins(dir, videoName, incoming) {
  if (!Array.isArray(incoming) || incoming.length > MAX_PINS) throw new ReviewError(`pins: at most ${MAX_PINS} expected`);
  return changeReview(dir, videoName, (review) => {
    const byId = new Map(review.pins.map((pin) => [pin.id, pin]));
    let next = review.next;
    const pins = [];
    for (const raw of incoming) {
      const existing = Number.isInteger(raw?.id) ? byId.get(raw.id) : null;
      if (existing?.status === "done") { pins.push(existing); continue; } // a finished pin is history
      const edited = cleanPin({ ...raw, id: existing?.id ?? next, status: "open" });
      if (!edited) throw new ReviewError("a pin needs a time (seconds, 0 or more)");
      if (existing) {
        // Changed text or place must be sent again.
        const same = existing.text === edited.text && existing.t === edited.t && existing.x === edited.x && existing.y === edited.y;
        pins.push({ ...edited, createdAt: existing.createdAt, sentAt: same ? existing.sentAt : null });
      } else {
        next += 1;
        pins.push({ ...edited, createdAt: Date.now(), sentAt: null });
      }
    }
    // Done pins the page did not list (an older copy of the list) stay: only the user deletes, and only open pins.
    const listed = new Set(pins.map((pin) => pin.id));
    for (const pin of review.pins) if (pin.status === "done" && !listed.has(pin.id)) pins.push(pin);
    return cleanReview({ next, pins });
  });
}

/** Deletes pins by id (the user's action, including finished ones). */
export function deletePins(dir, videoName, ids) {
  const drop = new Set(ids);
  return changeReview(dir, videoName, (review) => ({ ...review, pins: review.pins.filter((pin) => !drop.has(pin.id)) }));
}

/** Remembers that these open pins were handed to Claude, now. */
export function markSent(dir, videoName, ids, now = Date.now()) {
  const sent = new Set(ids);
  return changeReview(dir, videoName, (review) => ({ ...review, pins: review.pins.map((pin) => (pin.status === "open" && sent.has(pin.id) ? { ...pin, sentAt: now } : pin)) }));
}

/**
 * Claude's report: these pins were fixed in the video `fixedIn`. Only pins that were sent are accepted, and only when `fixedIn`
 * is another video of the folder that was written after the pins were sent. Nothing is changed unless every pin passes.
 */
export function markDone(dir, videoName, ids, fixedIn, now = Date.now()) {
  return changeReview(dir, videoName, async (review) => {
    if (!Array.isArray(ids) || !ids.length) throw new ReviewError("pins: give the ids of the pins that were fixed");
    if (!videoPath(dir, fixedIn) || fixedIn === videoName) throw new ReviewError("fixed_in: give the file name of the NEW version of the video (not the old one)");
    const fixed = await stat(join(dir, fixedIn)).catch(() => null);
    if (!fixed?.isFile()) throw new ReviewError(`fixed_in: ${fixedIn} does not exist in the video folder`);
    const targets = new Set(ids);
    for (const id of targets) {
      const pin = review.pins.find((p) => p.id === id);
      if (!pin) throw new ReviewError(`pin ${id} does not exist on ${videoName}`);
      if (pin.status === "done") throw new ReviewError(`pin ${id} is already done`);
      if (!pin.sentAt) throw new ReviewError(`pin ${id} was not sent to Claude yet; the user sends pins with the 修正を依頼 button`);
      if (fixed.mtimeMs < pin.sentAt) throw new ReviewError(`${fixedIn} is older than the moment pin ${id} was sent; write the fixed video first`);
    }
    return { ...review, pins: review.pins.map((pin) => (targets.has(pin.id) ? { ...pin, status: "done", doneAt: now, fixedIn } : pin)) };
  });
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
const percent = (v) => `${Math.round(v * 100)}%`;

/** The Markdown Claude reads: one line per open pin with the time, the place and the comment. */
export function requestMarkdown(video, pins) {
  const open = pins.filter((pin) => pin.status === "open" && pin.text.trim());
  const lines = [
    `# 動画 #${video.id} ${video.name} の修正指示`,
    "",
    "- 元の動画は上書きせず、新しいバージョン(例: `-v2`)として出力してください。`.gen.json` の `parent` に元の動画を書いてください。",
    "- 直したら、MCP ツール `resolve_review_pins` で、直したピン番号と新しい動画のファイル名を報告してください。",
    "- 位置は画面の左上を 0%・0% とした割合です。位置がないものは、その時刻の動画全体への指示です。",
    "",
    ...open.map((pin) => `- 【修正】ピン${pin.id} ${clock(pin.t)} ${pin.x === null ? "(全体)" : `(x ${percent(pin.x)}, y ${percent(pin.y)})`} ${pin.text.trim().replace(/\s*\n\s*/g, " / ")}`),
    "",
  ];
  return lines.join("\n");
}

/** Writes <name>.review.md for the open, commented pins; returns the pin ids it contains and the Markdown. */
export async function writeRequest(dir, videoName, video) {
  const review = await readReview(dir, videoName);
  const pins = review.pins.filter((pin) => pin.status === "open" && pin.text.trim());
  if (!pins.length) throw new ReviewError("there is no open pin with a comment to send");
  const markdown = requestMarkdown(video, pins);
  await writeFile(reviewMarkdownFile(dir, videoName), markdown);
  return { ids: pins.map((pin) => pin.id), markdown, file: `${stemOf(videoName)}${REVIEW_MD_EXT}` };
}

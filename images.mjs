// The image library of one project: <PJ>/Output/image/. Files dropped in by the user and files Claude saves there
// show up alike. Everything that decides what may be written, read or moved lives here, apart from the HTTP layer.
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_TRASH_IMAGES = 200;
const MAX_STEM = 100;
const MAX_SUFFIX = 999;
// SVG is left out on purpose: it can carry scripts.
const CONTENT_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".gif", "image/gif"]]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g;

export class ImageError extends Error {}

/** The canonical extension for the bytes, judged by the file header, or null when it is not a supported image. */
export function sniffImage(buf) {
  const starts = (bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
  if (starts([0xff, 0xd8, 0xff])) return ".jpg";
  if (starts([0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return ".gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return ".webp";
  return null;
}

/** A safe file stem from a name the browser sent: no folders, no characters Windows rejects, never empty. */
export function cleanStem(raw) {
  let stem = String(raw ?? "").split(/[\\/]/).pop();
  stem = stem.slice(0, stem.length - extname(stem).length);
  stem = stem.replace(UNSAFE_NAME_CHARS, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, MAX_STEM).replace(/[\s.]+$/, "");
  if (!stem) return "image";
  return WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem;
}

/** Saves an image without ever overwriting: a taken name gets -2, -3, ... Returns the file name used. */
export async function saveImage(dir, rawName, buf) {
  if (buf.length > MAX_IMAGE_BYTES) throw new ImageError(`too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
  const ext = sniffImage(buf);
  if (!ext) throw new ImageError("not a supported image (png, jpg, webp, gif)");
  await mkdir(dir, { recursive: true });
  const stem = cleanStem(rawName);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = `${stem}${n === 1 ? "" : `-${n}`}${ext}`;
    try {
      await writeFile(join(dir, name), buf, { flag: "wx" });
      return name;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new ImageError("too many files with this name");
}

/** The file's path if `name` is a plain image file name inside `dir`, else null. */
export function imagePath(dir, name) {
  if (typeof name !== "string" || !name || name !== basename(name) || name.startsWith(".")) return null;
  return CONTENT_TYPES.has(extname(name).toLowerCase()) ? join(dir, name) : null;
}

export const contentTypeOf = (name) => CONTENT_TYPES.get(extname(name).toLowerCase());

/** Images directly inside the folder, newest first. A missing folder is an empty library. */
export async function listImages(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile() || !imagePath(dir, entry.name)) continue;
    const { size, mtimeMs } = await stat(join(dir, entry.name));
    images.push({ name: entry.name, size, mtime: mtimeMs });
  }
  return images.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

/** Moves images into `destDir` (nothing is deleted for good). Reports per file instead of stopping at the first error. */
export async function trashImages(dir, destDir, names) {
  if (!Array.isArray(names) || !names.length || names.length > MAX_TRASH_IMAGES) {
    throw new ImageError(`names: 1-${MAX_TRASH_IMAGES} file names expected`);
  }
  const moved = [];
  const failed = [];
  for (const name of new Set(names)) {
    const from = imagePath(dir, name);
    if (!from) {
      failed.push({ name: String(name), error: "invalid name" });
      continue;
    }
    try {
      await mkdir(destDir, { recursive: true });
      await rename(from, join(destDir, name));
      moved.push(name);
    } catch (err) {
      failed.push({ name, error: err.code ?? err.message });
    }
  }
  return { moved, failed };
}

// ---- numbering: every image gets an id (1, 2, 3, ...) so the user can say "image 3" to Claude ----
// The ledger is <dir>/index.json. Only this app writes it; Claude reads it to turn an id into a file name.
// Ids are never reused: a trashed image leaves a gap, so an old "image 3" can never mean another picture later.
const INDEX_FILE = "index.json";
const emptyIndex = () => ({ version: 1, next: 1, items: [] });
const locks = new Map();

/** Runs tasks for one folder one at a time, so two requests can never hand out the same id. */
function withLock(dir, task) {
  const run = (locks.get(dir) ?? Promise.resolve()).then(task);
  locks.set(dir, run.catch(() => {}));
  return run;
}

const isValidIndex = (v) => v && v.version === 1 && Number.isInteger(v.next) && v.next >= 1 && Array.isArray(v.items)
  && v.items.every((i) => Number.isInteger(i?.id) && i.id >= 1 && i.id < v.next && typeof i.name === "string");

async function readIndex(dir) {
  let text;
  try {
    text = await readFile(join(dir, INDEX_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyIndex();
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    if (isValidIndex(parsed)) return parsed;
  } catch { /* fall through to the backup below */ }
  // Never overwrite what we cannot read: keep it for the user, then start a new ledger (ids restart at 1).
  const backup = `index.broken-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await rename(join(dir, INDEX_FILE), join(dir, backup));
  console.warn(`${join(dir, INDEX_FILE)} was unreadable; kept as ${backup} and numbering restarted`);
  return emptyIndex();
}

async function writeIndex(dir, index) {
  const tmp = join(dir, `${INDEX_FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(index, null, 2));
  await rename(tmp, join(dir, INDEX_FILE));
}

/** The folder's images with their ids. New files get the next ids (oldest first); vanished files drop out of the ledger. */
export function listNumberedImages(dir) {
  return withLock(dir, async () => {
    const images = await listImages(dir);
    const index = await readIndex(dir);
    const present = new Set(images.map((image) => image.name));
    const known = new Set(index.items.map((item) => item.name));
    const items = index.items.filter((item) => present.has(item.name));
    let next = index.next;
    const fresh = images.filter((image) => !known.has(image.name)).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const image of fresh) items.push({ id: next++, name: image.name, added: Date.now() });
    if (fresh.length || items.length !== index.items.length) await writeIndex(dir, { version: 1, next, items });
    const idOf = new Map(items.map((item) => [item.name, item.id]));
    return images.map((image) => ({ ...image, id: idOf.get(image.name) }));
  });
}

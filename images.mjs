// The image library of one project: <PJ>/Output/image/. Files dropped in by the user and files Claude saves there
// show up alike. Everything that decides what may be written, read or moved lives here, apart from the HTTP layer.
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { attachGen } from "./gen.mjs";
import { listNumbered, trashFiles } from "./library-core.mjs";

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
export const trashImages = (dir, destDir, names) => trashFiles(dir, destDir, names, { pathOf: imagePath, max: MAX_TRASH_IMAGES, Fail: ImageError });

/** The folder's images with their ids and, when Claude wrote one, their provenance (<name>.gen.json). */
export const listNumberedImages = (dir) => listNumbered(dir, listImages).then((images) => attachGen(dir, images));


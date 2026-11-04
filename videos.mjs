// The video library of one project: <PJ>/Output/video/ (cuts and finished MVs). Claude and the user put files there;
// the app lists, plays and trashes them. Playback depends on the browser, so mp4 (H.264) and webm are what is shown.
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { attachGen } from "./gen.mjs";
import { listNumbered, trashFiles } from "./library-core.mjs";

export const MAX_TRASH_VIDEOS = 200;
const CONTENT_TYPES = new Map([[".mp4", "video/mp4"], [".webm", "video/webm"]]);

export class VideoError extends Error {}

/** The file's path if `name` is a plain video file name inside `dir`, else null. */
export function videoPath(dir, name) {
  if (typeof name !== "string" || !name || name !== basename(name) || name.startsWith(".")) return null;
  return CONTENT_TYPES.has(extname(name).toLowerCase()) ? join(dir, name) : null;
}

export const videoContentType = (name) => CONTENT_TYPES.get(extname(name).toLowerCase());

/** Videos directly inside the folder, newest first. A missing folder is an empty library. */
export async function listVideos(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile() || !videoPath(dir, entry.name)) continue;
    const { size, mtimeMs } = await stat(join(dir, entry.name));
    videos.push({ name: entry.name, size, mtime: mtimeMs });
  }
  return videos.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

export const trashVideos = (dir, destDir, names) => trashFiles(dir, destDir, names, { pathOf: videoPath, max: MAX_TRASH_VIDEOS, Fail: VideoError });

/** The folder's videos with their ids and provenance (<name>.gen.json). */
export const listNumberedVideos = (dir) => listNumbered(dir, listVideos).then((videos) => attachGen(dir, videos));

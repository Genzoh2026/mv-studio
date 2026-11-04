// The workspace trash: <workspace>/_Trash. Nothing in the app deletes for good except the trash screen, on the user's click.
// A trashed song, image or video moves WITH its sidecar files (.suno.json, .gen.json, stems, ...), and every move writes a
// manifest so it can be put back where it came from. Whole projects keep the older layout: _Trash/<name>__<time>/.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";

export const MANIFEST = "manifest.json";
export const MAX_TRASH_BATCH = 200;
const FILES_DIR = "files";
const LEGACY_PJ = /^(.+)__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const MAX_SUFFIX = 999;

export class TrashError extends Error {}

// One trash operation at a time: they all rewrite manifests or move folders.
let chain = Promise.resolve();
const exclusive = (task) => {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const exists = (path) => stat(path).then(() => true, () => false);
const insideOf = (parent, child) => child === parent || child.startsWith(parent + sep);
const toPosix = (path) => path.split(sep).join("/");

/** The names in `dir` that belong to a file set: `base` plus one of the allowed suffixes (case-insensitive). */
export async function collectSet(dir, base, suffixes) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const allowed = new Set(suffixes.map((s) => s.toLowerCase()));
  return names.filter((name) => name.startsWith(base) && allowed.has(name.slice(base.length).toLowerCase()));
}

/**
 * Sets for trashing media files by name: each file travels with its `.gen.json`, but that sidecar is shared by every
 * file with the same stem (a.png, a.jpg), so it moves only once all of them are going.
 * @param {string[]} dirNames every file name in the folder
 * @param {string[]} names the media files to trash
 * @param {(name: string) => boolean} isMedia
 * @param {string[]} sidecarSuffixes e.g. [".gen.json"]
 */
export function mediaSets(dirNames, names, isMedia, sidecarSuffixes) {
  const stemOf = (name) => name.slice(0, name.length - extname(name).length);
  const going = new Set(names);
  return [...going].map((name) => {
    const stem = stemOf(name);
    const sharing = dirNames.filter((other) => isMedia(other) && stemOf(other) === stem);
    const lastOne = sharing.every((other) => going.has(other));
    const sidecars = lastOne ? dirNames.filter((other) => sidecarSuffixes.some((s) => other.toLowerCase() === `${stem}${s}`.toLowerCase())) : [];
    return { label: name, base: stem, files: [name, ...sidecars] };
  });
}

async function readManifest(batchDir) {
  try {
    const manifest = JSON.parse(await readFile(join(batchDir, MANIFEST), "utf8"));
    return manifest?.version === 1 && Array.isArray(manifest.items) ? manifest : null;
  } catch {
    return null;
  }
}

const writeManifest = (batchDir, manifest) => writeFile(join(batchDir, MANIFEST), JSON.stringify(manifest, null, 2));

/** Moves files back where they were if a set only half moved. */
async function undoMoves(moves) {
  for (const [from, to] of moves.reverse()) await rename(to, from).catch(() => {});
}

/**
 * Moves file sets of one project into a new batch folder. Reports per set; a set either moves completely or not at all.
 * @param {{trashRoot: string, pjName: string, pjDir: string, kind: "song"|"image"|"video", dir: string,
 *   sets: {label: string, base: string, files: string[]}[]}} options `dir` is the folder holding the sets, relative to pjDir
 */
export function trashSets({ trashRoot, pjName, pjDir, kind, dir, sets }) {
  return exclusive(async () => {
    if (!sets.length || sets.length > MAX_TRASH_BATCH) throw new TrashError(`1-${MAX_TRASH_BATCH} items expected`);
    const absDir = resolve(pjDir, dir);
    if (!insideOf(resolve(pjDir), absDir)) throw new TrashError("folder is outside the project");
    let batchDir = join(trashRoot, `${stamp()}__${pjName}__${kind}`);
    for (let n = 2; await exists(batchDir); n++) batchDir = join(trashRoot, `${stamp()}__${pjName}__${kind}-${n}`);
    const target = join(batchDir, FILES_DIR, dir);
    const items = [];
    const failed = [];
    for (const set of sets) {
      const moves = [];
      try {
        await mkdir(target, { recursive: true });
        for (const file of set.files) {
          const from = join(absDir, file);
          const to = join(target, file);
          await rename(from, to);
          moves.push([from, to]);
        }
        items.push({ label: set.label, base: set.base, files: set.files });
      } catch (err) {
        await undoMoves(moves);
        failed.push({ name: set.label, error: err.code ?? err.message });
      }
    }
    if (items.length) await writeManifest(batchDir, { version: 1, pj: pjName, kind, at: new Date().toISOString(), dir: toPosix(dir), items });
    else await rm(batchDir, { recursive: true, force: true });
    return { moved: items.map((i) => i.label), failed };
  });
}

/** Everything in the trash that this app recognises, newest first. Other things in the folder are left alone. */
export async function listTrash(trashRoot) {
  let names;
  try {
    names = await readdir(trashRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const entries = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const batchDir = join(trashRoot, entry.name);
    const manifest = await readManifest(batchDir);
    if (manifest) {
      entries.push({
        id: entry.name, kind: manifest.kind, pj: manifest.pj, at: manifest.at,
        items: manifest.items.map((item, index) => ({ index, label: item.label, count: item.files.length })),
      });
      continue;
    }
    const legacy = LEGACY_PJ.exec(entry.name);
    if (legacy) {
      const [, pj, day, hh, mm, ss, ms] = legacy;
      entries.push({ id: entry.name, kind: "pj", pj, at: `${day}T${hh}:${mm}:${ss}.${ms}Z`, items: [{ index: 0, label: pj, count: 1 }] });
    }
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

const trashDirOf = (trashRoot, id) => {
  // The id comes from the client: only a plain folder name inside the trash is acceptable.
  if (typeof id !== "string" || !id || id !== basename(id) || id.startsWith(".")) throw new TrashError("bad trash id");
  return join(trashRoot, id);
};

/** A free name for `base` in `dir` such that base+rest is free for every `rest`: base, base-2, base-3, ... */
async function freeBase(dir, base, rests) {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await Promise.all(rests.map((rest) => exists(join(dir, `${candidate}${rest}`))))).some(Boolean)) return candidate;
  }
  throw new TrashError("too many files with this name");
}

/** Takes one item out of its batch (the batch folder goes when it was the last), via `place(files, manifest, item)`. */
async function takeItem(trashRoot, id, index, place) {
  const batchDir = trashDirOf(trashRoot, id);
  const manifest = await readManifest(batchDir);
  if (!manifest) {
    if (index !== 0 || !LEGACY_PJ.test(id)) throw new TrashError("unknown trash entry");
    return place(null, null, null, batchDir);
  }
  const item = manifest.items[index];
  if (!item) throw new TrashError("unknown trash item");
  const result = await place(join(batchDir, FILES_DIR, manifest.dir), manifest, item, batchDir);
  manifest.items.splice(index, 1);
  if (manifest.items.length) await writeManifest(batchDir, manifest);
  else await rm(batchDir, { recursive: true, force: true });
  return result;
}

/**
 * Puts items back where they came from (a taken name gets -2, -3, ...; nothing is overwritten). Items are picked by
 * {id, index}; indexes are resolved against the manifest as it is now, so ids of one batch are handled highest first.
 */
export function restoreItems({ trashRoot, pjsRoot, items, validPjName }) {
  return exclusive(async () => {
    const restored = [];
    const failed = [];
    for (const { id, index } of orderForRemoval(items)) {
      try {
        restored.push(await takeItem(trashRoot, id, index, async (from, manifest, item, batchDir) => {
          if (!manifest) { // a whole project from the older layout
            const pj = LEGACY_PJ.exec(id)[1];
            if (!validPjName(pj)) throw new TrashError("bad project name");
            const name = await freeBase(pjsRoot, pj, [""]);
            await mkdir(pjsRoot, { recursive: true });
            await rename(batchDir, join(pjsRoot, name));
            return { name };
          }
          const pjDir = join(pjsRoot, manifest.pj);
          if (!validPjName(manifest.pj) || !(await exists(pjDir))) throw new TrashError(`project ${manifest.pj} is not there; restore it first`);
          const to = resolve(pjDir, manifest.dir);
          if (!insideOf(resolve(pjDir), to)) throw new TrashError("bad folder in the trash record");
          const rests = item.files.map((file) => file.slice(item.base.length));
          const base = await freeBase(to, item.base, rests);
          await mkdir(to, { recursive: true });
          const moves = [];
          try {
            for (const [i, file] of item.files.entries()) {
              const target = join(to, `${base}${rests[i]}`);
              await rename(join(from, file), target);
              moves.push([join(from, file), target]);
            }
          } catch (err) {
            await undoMoves(moves);
            throw err;
          }
          return { name: item.label, as: `${base}${item.label.slice(item.base.length)}` };
        }));
      } catch (err) {
        failed.push({ id, index, error: err.message });
      }
    }
    return { restored, failed };
  });
}

/** Deletes items for good. Only called from the trash screen after the user confirmed. */
export function deleteItems({ trashRoot, items }) {
  return exclusive(async () => {
    let deleted = 0;
    const failed = [];
    for (const { id, index } of orderForRemoval(items)) {
      try {
        await takeItem(trashRoot, id, index, async (from, manifest, item, batchDir) => {
          if (!manifest) return rm(batchDir, { recursive: true, force: true });
          for (const file of item.files) await rm(join(from, file), { recursive: true, force: true });
        });
        deleted++;
      } catch (err) {
        failed.push({ id, index, error: err.message });
      }
    }
    return { deleted, failed };
  });
}

/** Deletes every recognised entry for good; anything else in the folder stays. */
export function emptyTrash(trashRoot) {
  return exclusive(async () => {
    const entries = await listTrash(trashRoot);
    for (const entry of entries) await rm(trashDirOf(trashRoot, entry.id), { recursive: true, force: true });
    let left = 0;
    try { left = (await readdir(trashRoot)).length; } catch { /* no trash folder */ }
    return { deleted: entries.length, left };
  });
}

/** Removing an item shifts the later indexes of its batch, so take the highest index first; duplicates are dropped. */
function orderForRemoval(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_TRASH_BATCH) throw new TrashError(`1-${MAX_TRASH_BATCH} items expected`);
  const seen = new Set();
  return items
    .filter((item) => Number.isInteger(item?.index) && typeof item?.id === "string" && !seen.has(`${item.id}/${item.index}`) && seen.add(`${item.id}/${item.index}`))
    .sort((a, b) => a.id.localeCompare(b.id) || b.index - a.index);
}

// ---- what a song, an image and a video bring along ----
// Only these suffixes travel with a file (so "x" never drags "x.other.mp3" along).
const SONG_SUFFIXES = [".mp3", ".wav", ".m4a", ".ogg", ".suno.json", ".analysis.json", ".lyrics.json", ".beats.json", ".gen.json", ".lrc", ".txt", ".md", ".stems"];
const SONG_CORE = [".mp3", ".wav", ".m4a", ".ogg", ".suno.json"]; // a set without one of these is not a song (it could be a note)
const MEDIA_SIDECARS = [".gen.json"];

/**
 * Trashes images or videos by file name, each with its provenance file. Bad or missing names are reported, not fatal.
 * @param {{trashRoot: string, pjName: string, pjDir: string, kind: "image"|"video", names: unknown, isMedia: (name: string) => boolean}} options
 */
export async function trashMediaByName({ trashRoot, pjName, pjDir, kind, names, isMedia }) {
  if (!Array.isArray(names) || !names.length || names.length > MAX_TRASH_BATCH) throw new TrashError(`names: 1-${MAX_TRASH_BATCH} file names expected`);
  const dir = join(pjDir, "Output", kind);
  const present = new Set(await readdir(dir).catch(() => []));
  const failed = [];
  const valid = [];
  for (const name of new Set(names)) {
    if (typeof name !== "string" || name !== basename(name) || !isMedia(name)) failed.push({ name: String(name), error: "invalid name" });
    else if (!present.has(name)) failed.push({ name, error: "not found" });
    else valid.push(name);
  }
  if (!valid.length) return { moved: [], failed };
  const sets = mediaSets([...present], valid, isMedia, MEDIA_SIDECARS);
  const result = await trashSets({ trashRoot, pjName, pjDir, kind, dir: `Output/${kind}`, sets });
  return { moved: result.moved, failed: [...failed, ...result.failed] };
}

/**
 * Trashes songs by their base path under Output (e.g. "song/x"), each with everything that belongs to it.
 * @param {{trashRoot: string, pjName: string, pjDir: string, bases: unknown}} options
 */
export async function trashSongsByBase({ trashRoot, pjName, pjDir, bases }) {
  if (!Array.isArray(bases) || !bases.length || bases.length > MAX_TRASH_BATCH) throw new TrashError(`bases: 1-${MAX_TRASH_BATCH} song paths expected`);
  const output = resolve(pjDir, "Output");
  const failed = [];
  const byDir = new Map();
  for (const raw of new Set(bases)) {
    const target = typeof raw === "string" && raw && !raw.includes("\0") ? resolve(output, raw) : null;
    if (!target || !target.startsWith(output + sep)) {
      failed.push({ name: String(raw), error: "invalid path" });
      continue;
    }
    const dir = resolve(target, "..");
    const stem = basename(target);
    const files = await collectSet(dir, stem, SONG_SUFFIXES);
    if (!files.some((file) => SONG_CORE.includes(file.slice(stem.length).toLowerCase()))) {
      failed.push({ name: stem, error: "not found" });
      continue;
    }
    byDir.set(dir, [...(byDir.get(dir) ?? []), { label: stem, base: stem, files }]);
  }
  const moved = [];
  for (const [dir, sets] of byDir) {
    const result = await trashSets({ trashRoot, pjName, pjDir, kind: "song", dir: toPosix(dir.slice(resolve(pjDir).length + 1)), sets });
    moved.push(...result.moved);
    failed.push(...result.failed);
  }
  return { moved, failed };
}


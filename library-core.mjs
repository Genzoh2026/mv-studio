// What the image and video libraries share: the numbering ledger (index.json).
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---- numbering: every file gets an id (1, 2, 3, ...) so the user can say "image 3" to Claude ----
// The ledger is <dir>/index.json. Only this app writes it; Claude reads it to turn an id into a file name.
// Ids are never reused: a trashed file leaves a gap, so an old "image 3" can never mean another picture later.
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

/**
 * The folder's files (from `listFn`, each with a `name`) with ids. New files get the next ids (oldest first);
 * vanished files drop out of the ledger.
 */
export function listNumbered(dir, listFn) {
  return withLock(dir, async () => {
    const files = await listFn(dir);
    const index = await readIndex(dir);
    const present = new Set(files.map((file) => file.name));
    const known = new Set(index.items.map((item) => item.name));
    const items = index.items.filter((item) => present.has(item.name));
    let next = index.next;
    const fresh = files.filter((file) => !known.has(file.name)).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const file of fresh) items.push({ id: next++, name: file.name, added: Date.now() });
    if (fresh.length || items.length !== index.items.length) await writeIndex(dir, { version: 1, next, items });
    const idOf = new Map(items.map((item) => [item.name, item.id]));
    return files.map((file) => ({ ...file, id: idOf.get(file.name) }));
  });
}

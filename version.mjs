// A fingerprint of the app's own files. The server records it at start and reports it; the launcher compares it
// with the current files to tell whether a running server is older than the code on disk.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT_FILES = ["server.mjs", "sessions.mjs", "drafts.mjs", "version.mjs", "suno.mcp.json", "package.json"];
const DIRS = ["public", "rules"];

async function* filesIn(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesIn(full);
    else yield full;
  }
}

/** @param {string} appDir the app folder (where server.mjs lives) */
export async function codeFingerprint(appDir) {
  const paths = ROOT_FILES.map((name) => join(appDir, name));
  for (const dir of DIRS) for await (const file of filesIn(join(appDir, dir))) paths.push(file);
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    // Relative and slash-separated: the server and the launcher may spell the app folder differently.
    hash.update(relative(appDir, path).split(sep).join("/")).update("\0").update(await readFile(path)).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

// Minimal MV Studio: a Claude Code terminal (left) and the assets of one MV project (right).
// Layout: <workspace>/PJs/<YYYYMMDD-name>/Output/<kind>/...  The folder is the API:
// Claude writes files there, this app only reads them (and creates new project folders).
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { readAnalysisSummary, readBeatsSummary, readTimingsSummary } from "./analysis.mjs";
import { createAudioTools } from "./audio-tools.mjs";
import { createInstaller } from "./audio-install.mjs";
import { createAgentAuth } from "./agent-auth.mjs";
import { createAgentApi } from "./agent-api.mjs";
import { loadCatalog } from "./catalog.mjs";
import { createSongJobs, listStems } from "./song-jobs.mjs";
import { ConflictError, listDrafts, readVoices, saveHuman } from "./drafts.mjs";
import { ImageError, MAX_IMAGE_BYTES, contentTypeOf, imagePath, listNumberedImages, saveImage } from "./images.mjs";
import { listNumberedVideos, videoContentType, videoPath } from "./videos.mjs";
import { listNumbered } from "./library-core.mjs";
import { deleteItems, emptyTrash, listTrash, restoreItems, trashMediaByName, trashSongsByBase } from "./trash.mjs";
import { AudioError, MAX_AUDIO_BYTES, saveAudioStream } from "./audio.mjs";
import { SessionLimitError, createSessions } from "./sessions.mjs";
import { DOCS_URL, detectClaude, installCommands, installGuideText } from "./claude-cli.mjs";
import { codeFingerprint } from "./version.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4200);
const WORKSPACE = resolve(process.argv[2] ?? process.cwd());
const PJS = join(WORKSPACE, "PJs");
// "Deleting" a project moves it here, so nothing is lost for good; emptying it is the user's call.
const TRASH = join(WORKSPACE, "_Trash");
const MAX_TRASH_BATCH = 30;
const HERE = fileURLToPath(new URL(".", import.meta.url));
// Lets the launcher tell whether this process is older than the files on disk.
const CODE_VERSION = await codeFingerprint(HERE);
const MAX_DEPTH = 3;
const MAX_BODY = 4096;
const MAX_DRAFT_BODY = 100_000;
const MAX_TYPED = 600;
const CLAUDE_MISSING_CLOSE_CODE = 4004; // the page shows the server's guide instead of its generic closed message
const STARTED_AT = Date.now();
// start.cmd sets this and relaunches the server when it exits with RESTART_EXIT_CODE.
const SUPERVISED = process.env.MV_STUDIO_SUPERVISED === "1";
const RESTART_EXIT_CODE = 75;
const SHUTDOWN_DELAY_MS = 300;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
const LYRICS_EXTS = [".lrc", ".txt", ".md"];
const SUNO_META_EXT = ".suno.json";
const MAX_SETTINGS = 20;
const MAX_SETTING_KEY = 40;
const MAX_SETTING_VALUE = 200;
const SUNO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUNO_COVER = /^https:\/\/cdn\d*\.suno\.ai\/[\w.-]+$/;
const PJ_NAME = /^[\p{L}\p{N}_-]{1,64}$/u;
const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript"],
  "/drafts.js": ["public/drafts.js", "text/javascript"],
  "/media-library.js": ["public/media-library.js", "text/javascript"],
  "/upload.js": ["public/upload.js", "text/javascript"],
  "/trash.js": ["public/trash.js", "text/javascript"],
  "/song-tools.js": ["public/song-tools.js", "text/javascript"],
  "/audio-tools-panel.js": ["public/audio-tools-panel.js", "text/javascript"],
  "/job-bar.js": ["public/job-bar.js", "text/javascript"],
  "/toast.js": ["public/toast.js", "text/javascript"],
  "/rail.js": ["public/rail.js", "text/javascript"],
  "/settings.js": ["public/settings.js", "text/javascript"],
  "/app.css": ["public/app.css", "text/css"],
  "/vendor/xterm.js": ["node_modules/@xterm/xterm/lib/xterm.js", "text/javascript"],
  "/vendor/xterm.css": ["node_modules/@xterm/xterm/css/xterm.css", "text/css"],
  "/vendor/fit.js": ["node_modules/@xterm/addon-fit/lib/addon-fit.js", "text/javascript"],
};

// The app's rules reach Claude through --append-system-prompt-file on every launch, so a project's own
// CLAUDE.md is the user's space for notes. (Older projects still carry a copy of earlier rules there.)
const PROJECT_NOTES = `# MV project

Notes for Claude about this MV go here. MV Studio's own rules are supplied by the app at launch.
`;

// ConPTY cannot launch bare names or .cmd shims ("File not found"), so claude is started through a shell.
const SHELL = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
// Suno is passed per launch (nothing is written to the user's Claude settings); sign-in is done once via /mcp.
// Two servers reach Claude: Suno (remote) and MV Studio itself (a small local one, mcp-server.mjs, for separation and beat analysis).
const MCP_CONFIGS = [join(HERE, "suno.mcp.json"), join(HERE, "mv-studio.mcp.json")];
const RULES_FILE = join(HERE, "rules", "mv-studio.md");
const quote = (s) => `'${s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
// Where the Claude CLI is. Re-detected on demand: it may be installed while the app is running.
let claude = await detectClaude();
if (!claude.found) console.warn("Claude Code was not found.\n" + installGuideText());

/** The shell command line that starts Claude with the app's MCP config and rules. */
function claudeCommandLine() {
  const run = claude.command === "claude" || !claude.command ? "claude"
    : process.platform === "win32" ? `& ${quote(claude.command)}` : quote(claude.command);
  return `${run} --mcp-config ${MCP_CONFIGS.map(quote).join(" ")} --append-system-prompt-file ${quote(RULES_FILE)}`;
}
const shellArgs = () => process.platform === "win32"
  ? ["-NoLogo", "-NoExit", "-Command", claudeCommandLine()]
  : ["-lc", `${claudeCommandLine()}; exec "$SHELL"`];

/** What the page needs to know about the CLI, including how to install it when it is missing. */
const claudeStatus = () => ({
  found: claude.found,
  version: claude.version,
  where: claude.where,
  platform: process.platform,
  install: claude.found ? null : { docs: DOCS_URL, commands: installCommands() },
});

// Drop the parent session's markers, or a Claude started from inside Claude runs as a child session.
function childEnv(project) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^CLAUDE_?CODE/i.test(k)));
  // What the MV Studio MCP server (mcp-server.mjs, started by Claude from mv-studio.mcp.json) needs to call this app back:
  // where it is, which project this Claude belongs to, and a token that works for that project only.
  return project ? {
    ...env,
    MV_STUDIO_URL: `http://${HOST}:${PORT}`,
    MV_STUDIO_PJ: project,
    MV_STUDIO_TOKEN: agentAuth.tokenFor(project),
    MV_STUDIO_APP_DIR: HERE,
    MV_STUDIO_NODE: process.execPath,
  } : env;
}

const sessions = createSessions({ command: SHELL, args: shellArgs, env: childEnv });
// Song separation and beat analysis run in a Python found on this computer; nothing is bundled (see audio-tools.mjs).
const audioTools = createAudioTools({ workspace: WORKSPACE, toolsDir: join(HERE, "tools") });
// The installer and the song jobs exclude each other: pip may replace the very PyTorch a separation is using.
let installer = null;
const songJobs = createSongJobs({ tools: audioTools, blocked: () => Boolean(installer?.running()) });
installer = createInstaller({ tools: audioTools, isBusy: () => songJobs.manager.busy() });
// The Claude of each project may ask for separation, beat analysis and the tool setup through this (see agent-api.mjs).
// The secret is random per run. MV_STUDIO_AGENT_SECRET (hex) fixes it, which only exists so a test can compute a token.
const agentAuth = createAgentAuth(process.env.MV_STUDIO_AGENT_SECRET ? Buffer.from(process.env.MV_STUDIO_AGENT_SECRET, "hex") : undefined);
// The curated list of video skills and plugins (catalog/video-tools.json). An invalid file is reported and the list is switched off,
// so a broken edit can never put an unchecked command in front of Claude.
let videoCatalog = null;
try {
  videoCatalog = await loadCatalog(join(HERE, "catalog", "video-tools.json"));
} catch (err) {
  console.error(`The video tools catalog is not available: ${err.message}`);
}

/** `claude plugin list --json` for a project (what is installed there and for the user), cached briefly; null when it cannot be read. */
const pluginCache = new Map();
const PLUGIN_CACHE_MS = 20_000;
const PLUGIN_LIST_TIMEOUT_MS = 20_000;
function getPlugins(pjDirPath) {
  const hit = pluginCache.get(pjDirPath);
  if (hit && Date.now() - hit.at < PLUGIN_CACHE_MS) return hit.value;
  const value = new Promise((resolve) => {
    if (!claude.found) return resolve(null);
    // Fixed arguments only. On Windows an npm install of claude is a .cmd shim, which only a shell can run.
    execFile(claude.command, ["plugin", "list", "--json"], { cwd: pjDirPath, timeout: PLUGIN_LIST_TIMEOUT_MS, windowsHide: true, shell: process.platform === "win32", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      try { resolve(error ? null : JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
  pluginCache.set(pjDirPath, { at: Date.now(), value });
  return value;
}

const agentApi = createAgentApi({ auth: agentAuth, existingPjDir, listNumberedSongs, songJobs, installer, audioTools, readBody, json, catalog: videoCatalog, getPlugins });

/** Resolve a project name from the client to its folder, or null. The name must be a plain folder name under PJs. */
function pjDir(name) {
  if (!name || !PJ_NAME.test(name)) return null;
  return join(PJS, name);
}

/** Project cards for the library: name, song count, cover, last change, and whether Claude is running there. */
async function listPjs() {
  let names;
  try {
    const entries = await readdir(PJS, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && PJ_NAME.test(e.name)).map((e) => e.name).sort().reverse();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const running = new Set(sessions.running());
  return Promise.all(names.map(async (name) => {
    const songs = await listSongs(name);
    const folderMtime = (await stat(join(PJS, name))).mtimeMs;
    return {
      name,
      songs: songs.length,
      cover: songs.find((s) => s.cover)?.cover ?? null,
      mtime: Math.max(folderMtime, ...songs.map((s) => s.mtime)),
      running: running.has(name),
    };
  }));
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

async function createPj(title) {
  if (!PJ_NAME.test(title ?? "")) throw new Error("name: letters, digits, - and _ only (1-64 chars)");
  const name = `${today()}-${title}`;
  const dir = join(PJS, name);
  await mkdir(join(dir, "Output", "song"), { recursive: true });
  // wx: never overwrite rules the user may have edited in an existing project.
  await writeFile(join(dir, "CLAUDE.md"), PROJECT_NOTES, { flag: "wx" }).catch((err) => {
    if (err.code !== "EEXIST") throw err;
  });
  return name;
}

/** Move projects to _Trash. A project with a running Claude is refused (its files are in use). */
async function trashPjs(names) {
  if (!Array.isArray(names) || !names.length || names.length > MAX_TRASH_BATCH) {
    throw new Error(`names: 1-${MAX_TRASH_BATCH} project names expected`);
  }
  const running = new Set(sessions.running());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const moved = [];
  const failed = [];
  for (const name of names) {
    const dir = pjDir(name);
    if (!dir) failed.push({ name, error: "invalid name" });
    else if (running.has(name)) failed.push({ name, error: "Claude is running there; end it first" });
    else {
      try {
        await mkdir(TRASH, { recursive: true });
        await rename(dir, join(TRASH, `${name}__${stamp}`));
        moved.push(name);
      } catch (err) {
        failed.push({ name, error: err.code ?? err.message });
      }
    }
  }
  return { moved, failed };
}

async function* walk(dir, depth = 0) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Stems belong to their song (shown under it), so they are not songs of their own.
      if (entry.name.endsWith(".stems")) continue;
      if (depth < MAX_DEPTH) yield* walk(full, depth + 1);
    } else yield full;
  }
}

async function readLyrics(base) {
  for (const ext of LYRICS_EXTS) {
    try { return await readFile(base + ext, "utf8"); } catch { /* try the next extension */ }
  }
  return null;
}

/** A song Claude registered without downloading it: <title>.suno.json (id, title, duration, style, lyrics). */
async function readPreview(file, base) {
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    console.warn(`skipped ${file}: ${err.message}`);
    return null;
  }
  // The id ends up in an iframe URL, so only a real UUID is accepted.
  if (typeof data.id !== "string" || !SUNO_ID.test(data.id)) {
    console.warn(`skipped ${file}: "id" is not a Suno clip id`);
    return null;
  }
  return {
    sunoId: data.id,
    title: String(data.title ?? basename(base)),
    // Shown as an <img>, so only Suno's own CDN is accepted.
    cover: typeof data.cover === "string" && SUNO_COVER.test(data.cover) ? data.cover : null,
    detail: {
      style: typeof data.style === "string" ? data.style : null,
      duration: Number(data.duration) || null,
      kind: typeof data.type === "string" ? data.type.slice(0, MAX_SETTING_VALUE) : null,
      createdAt: Number.isNaN(Date.parse(data.created_at)) ? null : new Date(data.created_at).toISOString(),
      settings: cleanSettings(data.settings),
      lyrics: typeof data.lyrics === "string" ? data.lyrics : await readLyrics(base),
    },
    mtime: (await stat(file)).mtimeMs,
  };
}

/** What Claude asked Suno for at creation time. Only flat primitive values are shown, as text. */
function cleanSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .slice(0, MAX_SETTINGS)
    .map(([k, v]) => [k.slice(0, MAX_SETTING_KEY), String(v).slice(0, MAX_SETTING_VALUE)]);
}

/**
 * The project's songs with ids (#1, #2, ...) from Output/song/index.json, keyed by each song's base path ("song/x"),
 * so a song keeps its id when its audio is downloaded later. Only the opened project is numbered: the project list also
 * reads songs, and it must not write a ledger into every project.
 */
async function listNumberedSongs(pj) {
  const songs = await listSongs(pj);
  const numbered = await listNumbered(join(pjDir(pj), "Output", "song"), async () => songs.map((s) => ({ name: s.base, mtime: s.mtime })));
  const idOf = new Map(numbered.map((n) => [n.name, n.id]));
  return songs.map((s) => ({ ...s, id: idOf.get(s.base) }));
}

async function listSongs(pj) {
  const output = join(pjDir(pj), "Output");
  const local = [];
  const previews = [];
  const downloaded = new Set();
  for await (const file of walk(output)) {
    if (file.endsWith(SUNO_META_EXT)) {
      const preview = await readPreview(file, file.slice(0, -SUNO_META_EXT.length));
      if (preview) previews.push({ ...preview, base: file.slice(0, -SUNO_META_EXT.length) });
    } else if (AUDIO.has(extname(file).toLowerCase())) {
      const base = file.slice(0, -extname(file).length);
      downloaded.add(base);
      local.push({
        base,
        path: file.slice(output.length + 1).split(sep).join("/"),
        title: basename(base),
        lyrics: await readLyrics(base),
        mtime: (await stat(file)).mtimeMs,
      });
    }
  }
  // Once the mp3 is downloaded, the local player replaces the preview and keeps its details.
  const previewOf = new Map(previews.map((p) => [p.base, p]));
  // Analysis files sit next to the song (same base path).
  const analysed = new Map();
  for (const base of [...local.map((s) => s.base), ...previews.map((p) => p.base)]) {
    analysed.set(base, {
      analysis: await readAnalysisSummary(base),
      timings: await readTimingsSummary(base),
      beats: await readBeatsSummary(base),
      stems: await listStems(base, output),
    });
  }
  // The base path under Output ("song/x") names a song for the trash: everything beside it goes along.
  const relBase = (base) => base.slice(output.length + 1).split(sep).join("/");
  const ready = local.map(({ base, lyrics, ...rest }) => {
    const preview = previewOf.get(base);
    const detail = preview?.detail ?? { style: null, duration: null, kind: null, createdAt: null, settings: [], lyrics: null };
    return { ...rest, base: relBase(base), sunoId: preview?.sunoId ?? null, cover: preview?.cover ?? null, ...analysed.get(base), detail: { ...detail, lyrics: lyrics ?? detail.lyrics } };
  });
  const pending = previews.filter((p) => !downloaded.has(p.base)).map(({ base, ...rest }) => ({ ...rest, base: relBase(base), name: basename(base), ...analysed.get(base) }));
  return [...ready, ...pending].sort((a, b) => b.mtime - a.mtime);
}

async function serveAudio(req, res, url) {
  const dir = pjDir(url.searchParams.get("pj"));
  const output = dir && join(dir, "Output");
  const target = output && resolve(output, url.searchParams.get("p") ?? "");
  if (!target || !target.startsWith(output + sep) || !AUDIO.has(extname(target).toLowerCase())) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const { size } = await stat(target);
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, {
      "content-type": "audio/" + extname(target).slice(1),
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
      ...(range && { "content-range": `bytes ${start}-${end}/${size}` }),
    });
    createReadStream(target, { start, end }).pipe(res);
  } catch (err) {
    res.writeHead(404);
    res.end(`not found: ${err.code}`);
  }
}

const imageDir = (pjDirPath) => join(pjDirPath, "Output", "image");

/** The raw bytes of an upload. Refused as soon as it is known to be over the limit. */
async function readBinary(req, limit) {
  if (Number(req.headers["content-length"]) > limit) throw new ImageError(`too large (max ${limit / 1024 / 1024} MB)`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ImageError(`too large (max ${limit / 1024 / 1024} MB)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Moves images (with their .gen.json) to the trash, from where the trash screen can restore them. */
async function trashProjectImages(pjName, names) {
  const result = await trashMediaByName({ trashRoot: TRASH, pjName, pjDir: pjDir(pjName), kind: "image", names, isMedia: (name) => Boolean(imagePath("", name)) });
  // Retire the moved files' ids now, so a new file with the same name cannot inherit one.
  await listNumberedImages(imageDir(pjDir(pjName)));
  return result;
}

async function serveImage(res, url) {
  const dir = await existingPjDir(url.searchParams.get("pj"));
  const target = dir && imagePath(imageDir(dir), url.searchParams.get("name"));
  if (!target) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const { size } = await stat(target);
    res.writeHead(200, {
      "content-type": contentTypeOf(target),
      "content-length": size,
      "x-content-type-options": "nosniff",
      // The page adds ?v=<mtime>, so a changed file gets a new URL.
      "cache-control": "private, max-age=3600",
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(404);
    res.end(`not found: ${err.code}`);
  }
}

const videoDir = (pjDirPath) => join(pjDirPath, "Output", "video");

/** Moves videos (with their .gen.json) to the trash (same idea as images). */
async function trashProjectVideos(pjName, names) {
  const result = await trashMediaByName({ trashRoot: TRASH, pjName, pjDir: pjDir(pjName), kind: "video", names, isMedia: (name) => Boolean(videoPath("", name)) });
  await listNumberedVideos(videoDir(pjDir(pjName)));
  return result;
}

/** The byte range a Range header asks for, {start, end} (inclusive), or null when it cannot be satisfied. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) { // "-N": the last N bytes
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : null;
}

/** Video bytes with Range support: browsers seek by asking for pieces, so without it a video cannot be scrubbed. */
async function serveVideo(req, res, url) {
  const dir = await existingPjDir(url.searchParams.get("pj"));
  const target = dir && videoPath(videoDir(dir), url.searchParams.get("name"));
  if (!target) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const { size } = await stat(target);
    const asked = req.headers.range;
    const range = asked ? parseRange(asked, size) : { start: 0, end: size - 1 };
    if (!range) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(asked ? 206 : 200, {
      "content-type": videoContentType(target),
      "accept-ranges": "bytes",
      "content-length": range.end - range.start + 1,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
      ...(asked && { "content-range": `bytes ${range.start}-${range.end}/${size}` }),
    });
    createReadStream(target, range).pipe(res);
  } catch (err) {
    res.writeHead(404);
    res.end(`not found: ${err.code}`);
  }
}

async function readBody(req, limit = MAX_BODY) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("body too large");
  }
  return JSON.parse(body || "{}");
}

/** The project's folder if the name is valid and the folder exists, else null. */
async function existingPjDir(name) {
  const dir = pjDir(name);
  return dir && (await stat(dir).then((s) => s.isDirectory(), () => false)) ? dir : null;
}

const sameOrigin = (req) => req.headers.origin === `http://${HOST}:${PORT}`;

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** Ends every Claude session, then exits shortly so the HTTP response above is delivered first. */
function shutdown(code) {
  sessions.endAll();
  songJobs.manager.stopAll();
  installer.cancel();
  setTimeout(() => process.exit(code), SHUTDOWN_DELAY_MS);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (await agentApi(req, res, url)) return;
    const fixed = STATIC[url.pathname];
    if (fixed) {
      // no-store: a stale tab must never keep an old UI after the app is updated.
      res.writeHead(200, { "content-type": fixed[1], "cache-control": "no-store" });
      return res.end(readFileSync(join(HERE, fixed[0])));
    }
    if (url.pathname === "/api/pjs" && req.method === "GET") return json(res, 200, await listPjs());
    if (url.pathname === "/api/pjs" && req.method === "POST") {
      // Other sites must not be able to create folders on this machine.
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, { name: await createPj((await readBody(req)).name) });
    }
    if (url.pathname === "/api/pjs/trash" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, await trashPjs((await readBody(req)).names));
    }
    if (url.pathname === "/api/sessions/end" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const name = (await readBody(req)).pj;
      if (!pjDir(name)) return json(res, 400, { error: "bad project" });
      return json(res, 200, { ended: sessions.end(name) });
    }
    if (url.pathname === "/api/drafts" && req.method === "GET") {
      const dir = await existingPjDir(url.searchParams.get("pj"));
      return dir ? json(res, 200, await listDrafts(dir)) : json(res, 400, { error: "bad project" });
    }
    if (url.pathname === "/api/voices" && req.method === "GET") {
      const dir = await existingPjDir(url.searchParams.get("pj"));
      return dir ? json(res, 200, await readVoices(dir)) : json(res, 400, { error: "bad project" });
    }
    if (url.pathname === "/api/drafts/save" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const body = await readBody(req, MAX_DRAFT_BODY);
      const dir = await existingPjDir(body.pj);
      if (!dir) return json(res, 400, { error: "bad project" });
      return json(res, 200, { mtime: await saveHuman(dir, body.name, body.data, body.baseMtime) });
    }
    if (url.pathname === "/api/images" && req.method === "GET") {
      const dir = await existingPjDir(url.searchParams.get("pj"));
      return dir ? json(res, 200, await listNumberedImages(imageDir(dir))) : json(res, 400, { error: "bad project" });
    }
    if (url.pathname === "/api/images/upload" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const dir = await existingPjDir(url.searchParams.get("pj"));
      if (!dir) return json(res, 400, { error: "bad project" });
      const bytes = await readBinary(req, MAX_IMAGE_BYTES);
      await listNumberedImages(imageDir(dir)); // files removed outside the app give up their ids before the new one is saved
      const name = await saveImage(imageDir(dir), url.searchParams.get("name"), bytes);
      const id = (await listNumberedImages(imageDir(dir))).find((image) => image.name === name)?.id;
      return json(res, 200, { name, id });
    }
    if (url.pathname === "/api/images/trash" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const body = await readBody(req, MAX_DRAFT_BODY);
      if (!(await existingPjDir(body.pj))) return json(res, 400, { error: "bad project" });
      return json(res, 200, await trashProjectImages(body.pj, body.names));
    }
    if (url.pathname === "/image" && req.method === "GET") return serveImage(res, url);
    if (url.pathname === "/api/videos" && req.method === "GET") {
      const dir = await existingPjDir(url.searchParams.get("pj"));
      return dir ? json(res, 200, await listNumberedVideos(videoDir(dir))) : json(res, 400, { error: "bad project" });
    }
    if (url.pathname === "/api/videos/trash" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const body = await readBody(req, MAX_DRAFT_BODY);
      if (!(await existingPjDir(body.pj))) return json(res, 400, { error: "bad project" });
      return json(res, 200, await trashProjectVideos(body.pj, body.names));
    }
    if (url.pathname === "/video" && req.method === "GET") return serveVideo(req, res, url);
    if (url.pathname === "/api/server" && req.method === "GET") {
      return json(res, 200, {
        pid: process.pid,
        port: PORT,
        workspace: WORKSPACE,
        startedAt: STARTED_AT,
        supervised: SUPERVISED,
        codeVersion: CODE_VERSION,
        claude: claudeStatus(),
        node: process.version,
        sessions: sessions.running(),
      });
    }
    if (url.pathname === "/api/claude/recheck" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      claude = await detectClaude();
      return json(res, 200, claudeStatus());
    }
    if (url.pathname === "/api/server/stop" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      json(res, 200, { stopping: true });
      return shutdown(0);
    }
    if (url.pathname === "/api/server/restart" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      if (!SUPERVISED) return json(res, 409, { error: "Restart only works when started with start.cmd." });
      json(res, 200, { restarting: true });
      return shutdown(RESTART_EXIT_CODE);
    }
    if (url.pathname === "/api/sessions/type" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const { pj, text } = await readBody(req);
      if (!pjDir(pj)) return json(res, 400, { error: "bad project" });
      // One plain line only: no newline (it would submit) and no escape sequences.
      if (typeof text !== "string" || !text || text.length > MAX_TYPED || CONTROL_CHARS.test(text)) {
        return json(res, 400, { error: `text: 1-${MAX_TYPED} characters, no control characters` });
      }
      return sessions.type(pj, text) ? json(res, 200, { typed: true }) : json(res, 409, { error: "no running session for this project" });
    }
    if (url.pathname === "/api/songs/upload" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const dir = await existingPjDir(url.searchParams.get("pj"));
      if (!dir) return json(res, 400, { error: "bad project" });
      if (Number(req.headers["content-length"]) > MAX_AUDIO_BYTES) throw new AudioError(`too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB)`);
      return json(res, 200, { name: await saveAudioStream(join(dir, "Output", "song"), url.searchParams.get("name"), req) });
    }
    if (url.pathname === "/api/songs/trash" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const body = await readBody(req, MAX_DRAFT_BODY);
      if (!(await existingPjDir(body.pj))) return json(res, 400, { error: "bad project" });
      // A song that is being separated or analysed has files in use: leave it where it is.
      const busy = new Set(songJobs.manager.list(body.pj).filter((j) => ["queued", "running"].includes(j.state)).map((j) => j.base));
      const bases = body.bases;
      const skipped = Array.isArray(bases) ? bases.filter((b) => busy.has(b)).map((b) => ({ name: b, error: "a separation or analysis is running for this song" })) : [];
      const rest = Array.isArray(bases) ? bases.filter((b) => !busy.has(b)) : bases;
      const answer = Array.isArray(rest) && !rest.length && skipped.length
        ? { moved: [], failed: [] } // everything asked for is busy: report that, not an "empty list" error
        : await trashSongsByBase({ trashRoot: TRASH, pjName: body.pj, pjDir: pjDir(body.pj), bases: rest });
      await listNumberedSongs(body.pj); // retire the moved songs' ids now, so a song put back later is a new one
      return json(res, 200, { moved: answer.moved, failed: [...skipped, ...answer.failed] });
    }
    if (url.pathname === "/api/audio-tools" && req.method === "GET") return json(res, 200, await audioTools.status({ refresh: url.searchParams.get("refresh") === "1" }));
    if (url.pathname === "/api/audio-tools/python" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, await audioTools.setPython((await readBody(req)).path ?? null));
    }
    if (url.pathname === "/api/audio-install" && req.method === "GET") return json(res, 200, installer.snapshot());
    if (url.pathname === "/api/audio-install/plan" && req.method === "GET") return json(res, 200, await installer.preview({ gpu: url.searchParams.get("gpu") === "1" }));
    if (url.pathname === "/api/audio-install/start" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const body = await readBody(req);
      // The page shows the plan and asks first; the server insists that it did.
      if (body.confirmed !== true) return json(res, 400, { error: "the setup needs the user's confirmation" });
      return json(res, 200, await installer.start({ gpu: body.gpu === true }));
    }
    if (url.pathname === "/api/audio-install/cancel" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, { cancelled: installer.cancel() });
    }
    if (url.pathname === "/api/audio-tools/model" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, await audioTools.setModel((await readBody(req)).model));
    }
    if (url.pathname === "/api/songs/process" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      const body = await readBody(req);
      const dir = await existingPjDir(body.pj);
      if (!dir) return json(res, 400, { error: "bad project" });
      const job = await songJobs.enqueue({ pj: body.pj, pjDir: dir, base: body.base, kind: body.kind, then: body.then });
      return json(res, 200, songJobs.manager.list(body.pj).find((j) => j.id === job.id));
    }
    if (url.pathname === "/api/jobs" && req.method === "GET") return json(res, 200, songJobs.manager.list(url.searchParams.get("pj") || undefined));
    if (url.pathname === "/api/jobs/cancel" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, { cancelled: songJobs.manager.cancel((await readBody(req)).id) });
    }
    if (url.pathname === "/api/jobs/dismiss" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, { dismissed: songJobs.manager.dismiss((await readBody(req)).id) });
    }
    if (url.pathname === "/api/trash" && req.method === "GET") return json(res, 200, await listTrash(TRASH));
    if (url.pathname === "/api/trash/restore" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, await restoreItems({ trashRoot: TRASH, pjsRoot: PJS, items: (await readBody(req, MAX_DRAFT_BODY)).items, validPjName: (name) => PJ_NAME.test(name) }));
    }
    // The only places where anything is deleted for good: the trash screen, after the user confirmed there.
    if (url.pathname === "/api/trash/delete" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, await deleteItems({ trashRoot: TRASH, items: (await readBody(req, MAX_DRAFT_BODY)).items }));
    }
    if (url.pathname === "/api/trash/empty" && req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad origin" });
      return json(res, 200, await emptyTrash(TRASH));
    }
    if (url.pathname === "/api/songs") {
      if (!pjDir(url.searchParams.get("pj"))) return json(res, 400, { error: "bad project" });
      return json(res, 200, await listNumberedSongs(url.searchParams.get("pj")));
    }
    if (url.pathname === "/file") return serveAudio(req, res, url);
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error(`${req.method} ${url.pathname}:`, err.message);
    json(res, err instanceof ConflictError ? 409 : 400, { error: err.message });
  }
});

const wss = new WebSocketServer({ server, path: "/term" });
wss.on("connection", async (ws, req) => {
  // Block other sites from opening a shell on this machine.
  if (!sameOrigin(req)) return ws.close(1008, "bad origin");
  const dir = pjDir(new URL(req.url, `http://${HOST}`).searchParams.get("pj"));
  if (!dir || !(await stat(dir).then((s) => s.isDirectory(), () => false))) return ws.close(1008, "bad project");
  const name = basename(dir);
  // A new session needs the CLI; one that is already running obviously has it.
  if (!sessions.running().includes(name)) {
    if (!claude.found) claude = await detectClaude();
    if (!claude.found) {
      ws.send(`\r\n${installGuideText().replaceAll("\n", "\r\n")}\r\n`);
      return ws.close(CLAUDE_MISSING_CLOSE_CODE, "claude not found");
    }
  }
  try {
    sessions.attach(name, dir, ws);
  } catch (err) {
    if (!(err instanceof SessionLimitError)) throw err;
    ws.send(`\r\n[${err.message}]\r\n`);
    ws.close(1013, "session limit");
  }
});

// Sessions are child processes of this server; take them down with it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { sessions.endAll(); process.exit(0); });
}
process.on("exit", () => { sessions.endAll(); songJobs.manager.stopAll(); installer.cancel(); });

server.listen(PORT, HOST, () => console.log(`MV Studio: http://${HOST}:${PORT}  (workspace: ${WORKSPACE})`));

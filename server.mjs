// Minimal MV Studio: a Claude Code terminal (left) and the assets of one MV project (right).
// Layout: <workspace>/PJs/<YYYYMMDD-name>/Output/<kind>/...  The folder is the API:
// Claude writes files there, this app only reads them (and creates new project folders).
import { createServer } from "node:http";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SessionLimitError, createSessions } from "./sessions.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4200);
const WORKSPACE = resolve(process.argv[2] ?? process.cwd());
const PJS = join(WORKSPACE, "PJs");
// "Deleting" a project moves it here, so nothing is lost for good; emptying it is the user's call.
const TRASH = join(WORKSPACE, "_Trash");
const MAX_TRASH_BATCH = 30;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAX_DEPTH = 3;
const MAX_BODY = 4096;
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
const LYRICS_EXTS = [".lrc", ".txt", ".md"];
const SUNO_META_EXT = ".suno.json";
const SUNO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUNO_COVER = /^https:\/\/cdn\d*\.suno\.ai\/[\w.-]+$/;
const PJ_NAME = /^[\p{L}\p{N}_-]{1,64}$/u;
const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript"],
  "/app.css": ["public/app.css", "text/css"],
  "/vendor/xterm.js": ["node_modules/@xterm/xterm/lib/xterm.js", "text/javascript"],
  "/vendor/xterm.css": ["node_modules/@xterm/xterm/css/xterm.css", "text/css"],
  "/vendor/fit.js": ["node_modules/@xterm/addon-fit/lib/addon-fit.js", "text/javascript"],
};

// Written into each new project so Claude knows where assets go.
const PROJECT_RULES = `# MV project

- Save every generated asset under \`Output/\`, grouped by kind.
- Suno downloads are limited per month, so do NOT download right after creating a song.
  Instead, once the song is playable, save \`Output/song/<name>.suno.json\` with:
  \`{"id": "<clip id>", "title": "...", "duration": <seconds>, "style": "...", "lyrics": "...", "cover": "<cover_image_url>"}\`.
  (\`cover\` is the song's cover_image_url from Suno; the library uses it as the project's thumbnail.)
  The app shows an embedded Suno player from it, so the user can listen before deciding.
- One generation can return several clips (\`clip_ids\`; Suno decides how many). Save ALL of them,
  one file per clip, named \`<title>-1.suno.json\`, \`<title>-2.suno.json\`, ... (a single clip needs no suffix).
  Previewing costs no download credit, so do not drop any clip yourself; the user picks.
- Download only the songs the user picks (ask first; it may spend a download credit): save the mp3 as
  \`Output/song/<name>.mp3\` (same name as its .suno.json). The app then switches to the local player.
- The app next to this terminal shows what is in \`Output/\`; do not put assets anywhere else.
`;

// ConPTY cannot launch bare names or .cmd shims ("File not found"), so claude is started through a shell.
const SHELL = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
// Suno is passed per launch (nothing is written to the user's Claude settings); sign-in is done once via /mcp.
const MCP_CONFIG = join(HERE, "suno.mcp.json");
const quote = (s) => `'${s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
const CLAUDE_COMMAND = `claude --mcp-config ${quote(MCP_CONFIG)}`;
const SHELL_ARGS = process.platform === "win32" ? ["-NoLogo", "-NoExit", "-Command", CLAUDE_COMMAND] : ["-lc", `${CLAUDE_COMMAND}; exec "$SHELL"`];

// Drop the parent session's markers, or a Claude started from inside Claude runs as a child session.
function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^CLAUDE_?CODE/i.test(k)));
}

const sessions = createSessions({ command: SHELL, args: SHELL_ARGS, env: childEnv });

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
  await writeFile(join(dir, "CLAUDE.md"), PROJECT_RULES, { flag: "wx" }).catch((err) => {
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
    duration: Number(data.duration) || null,
    style: typeof data.style === "string" ? data.style : null,
    // Shown as an <img>, so only Suno's own CDN is accepted.
    cover: typeof data.cover === "string" && SUNO_COVER.test(data.cover) ? data.cover : null,
    lyrics: typeof data.lyrics === "string" ? data.lyrics : await readLyrics(base),
    mtime: (await stat(file)).mtimeMs,
  };
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
  // Once the mp3 is downloaded, the local player replaces the preview and keeps its lyrics.
  const previewOf = new Map(previews.map((p) => [p.base, p]));
  const ready = local.map(({ base, ...rest }) => ({
    ...rest,
    lyrics: rest.lyrics ?? previewOf.get(base)?.lyrics ?? null,
    cover: previewOf.get(base)?.cover ?? null,
  }));
  const pending = previews.filter((p) => !downloaded.has(p.base)).map(({ base, ...rest }) => rest);
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

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error("body too large");
  }
  return JSON.parse(body || "{}");
}

const sameOrigin = (req) => req.headers.origin === `http://${HOST}:${PORT}`;

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
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
    if (url.pathname === "/api/songs") {
      if (!pjDir(url.searchParams.get("pj"))) return json(res, 400, { error: "bad project" });
      return json(res, 200, await listSongs(url.searchParams.get("pj")));
    }
    if (url.pathname === "/file") return serveAudio(req, res, url);
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error(`${req.method} ${url.pathname}:`, err.message);
    json(res, 400, { error: err.message });
  }
});

const wss = new WebSocketServer({ server, path: "/term" });
wss.on("connection", async (ws, req) => {
  // Block other sites from opening a shell on this machine.
  if (!sameOrigin(req)) return ws.close(1008, "bad origin");
  const dir = pjDir(new URL(req.url, `http://${HOST}`).searchParams.get("pj"));
  if (!dir || !(await stat(dir).then((s) => s.isDirectory(), () => false))) return ws.close(1008, "bad project");
  try {
    sessions.attach(basename(dir), dir, ws);
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
process.on("exit", () => sessions.endAll());

server.listen(PORT, HOST, () => console.log(`MV Studio: http://${HOST}:${PORT}  (workspace: ${WORKSPACE})`));

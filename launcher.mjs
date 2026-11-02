// Starts MV Studio the safe way. Usage: node launcher.mjs [workspace] [port]   (start.cmd calls this)
//  - port free                      -> start the server (restarting it when the app asks) and open the browser
//  - an up-to-date MV Studio runs   -> only open the browser
//  - an older MV Studio runs        -> offer to restart it (it ends the Claude sessions running there) or open it anyway
//  - anything else holds the port   -> say so and stop
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { codeFingerprint } from "./version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const RESTART_EXIT_CODE = 75;
const PROBE_TIMEOUT_MS = 2000;
const WAIT_UP_MS = 20_000;
const WAIT_RESTART_MS = 60_000;
const POLL_MS = 500;

const workspace = resolve(process.argv[2] ?? resolve(HERE, "..", "workspace"));
const port = Number(process.argv[3] ?? process.env.PORT ?? 4200);
const base = `http://${HOST}:${port}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const isPortOpen = () => new Promise((done) => {
  const socket = net.connect({ host: HOST, port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
});

/** What a running MV Studio reports about itself, or null when nothing answers like one. */
async function probe() {
  try {
    const res = await fetch(`${base}/api/server`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return null;
    const info = await res.json();
    return typeof info?.codeVersion === "string" ? info : null;
  } catch {
    return null;
  }
}

function openBrowser() {
  if (process.env.MV_STUDIO_NO_BROWSER) return;
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", base]]
    : process.platform === "darwin" ? ["open", [base]] : ["xdg-open", [base]];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(POLL_MS);
  }
  return null;
}

/** One line of input (also works with piped input); an empty answer when the input ends first. */
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const closed = new Promise((done) => rl.once("close", () => done("")));
    return (await Promise.race([rl.question(question), closed])).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

const sameFolder = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** An MV Studio is already running on the port. */
async function attach(info, currentVersion) {
  if (!sameFolder(info.workspace, workspace)) {
    console.log(`Port ${port} already runs MV Studio for another workspace:\n  ${info.workspace}\nClose it, or start on another port:  start.cmd "${workspace}" ${port + 1}`);
    return 1;
  }
  if (info.codeVersion === currentVersion) {
    console.log(`MV Studio is already running (up to date). Opening the page: ${base}`);
    openBrowser();
    return 0;
  }
  const count = info.sessions.length;
  console.log(`MV Studio is already running, but with older code than the files on disk.`);
  console.log(`Restarting it ends ${count} running Claude session(s)${count ? `: ${info.sessions.join(", ")}` : ""}.`);
  const answer = await ask("[R] restart it now   [O] open the page as it is   [Q] quit  > ");
  if (answer === "o") { openBrowser(); return 0; }
  if (answer !== "r") { console.log("Nothing changed."); return 1; }
  if (!info.supervised) {
    console.log("That server was not started by start.cmd, so it cannot restart itself. Close its window, then run start.cmd again.");
    return 1;
  }
  const res = await fetch(`${base}/api/server/restart`, {
    method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}",
  });
  if (!res.ok) { console.log(`Restart was refused: ${(await res.json()).error}`); return 1; }
  const fresh = await waitUntil(async () => {
    const next = await probe();
    return next && next.startedAt !== info.startedAt ? next : null;
  }, WAIT_RESTART_MS);
  if (!fresh) { console.log("The server did not come back in time. Check its window."); return 1; }
  console.log("Restarted. Opening the page.");
  openBrowser();
  return 0;
}

/** Run the server here; start it again whenever it exits asking for a restart. */
async function serve() {
  await mkdir(workspace, { recursive: true });
  const opened = waitUntil(probe, WAIT_UP_MS).then((up) => { if (up) openBrowser(); });
  for (;;) {
    const child = spawn(process.execPath, [resolve(HERE, "server.mjs"), workspace], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(port), MV_STUDIO_SUPERVISED: "1" },
    });
    const code = await new Promise((done) => child.on("exit", (exitCode) => done(exitCode ?? 1)));
    if (code !== RESTART_EXIT_CODE) { await opened; return code; }
    console.log("Restarting...");
  }
}

async function main() {
  if (!(await isPortOpen())) return serve();
  const info = await probe();
  if (!info) {
    console.log(`Port ${port} is already in use by something that is not a current MV Studio (or an older version that cannot report its state).`);
    console.log(`Close it first, or start on another port:  start.cmd "${workspace}" ${port + 1}`);
    return 1;
  }
  return attach(info, await codeFingerprint(HERE));
}

process.exitCode = await main();

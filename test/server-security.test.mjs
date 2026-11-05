import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** Starts the real server on a free port with an empty workspace; `run` talks to it with raw headers. */
async function withServer(run) {
  const workspace = await mkdtemp(join(tmpdir(), "mvs-sec-"));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, workspace], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10_000);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("MV Studio:")) { clearTimeout(timer); resolve(); } });
    child.on("exit", () => reject(new Error("server exited early")));
  });
  /** One request with exactly the headers given (Host and Origin included). */
  const call = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
  try { await run({ port, call }); } finally { child.kill(); await rm(workspace, { recursive: true, force: true }); }
}

test("a request that names another site in Host is refused (DNS rebinding), 127.0.0.1 and localhost are served", async () => {
  await withServer(async ({ port, call }) => {
    assert.equal((await call("GET", "/api/server", { host: `evil.example:${port}` })).status, 403);
    assert.equal((await call("GET", "/api/pjs", { host: "evil.example" })).status, 403);
    assert.equal((await call("GET", "/api/pjs", { host: `127.0.0.1:${port}` })).status, 200);
    assert.equal((await call("GET", "/api/pjs", { host: `localhost:${port}` })).status, 200);
    assert.equal((await call("GET", "/api/pjs", { host: `127.0.0.1:${port + 1}` })).status, 403, "right name, wrong port");
  });
});

test("changes need our own Origin: 127.0.0.1 and localhost work, another site or none does not", async () => {
  await withServer(async ({ port, call }) => {
    const json = { "content-type": "application/json" };
    const body = JSON.stringify({ name: "Test" });
    const asHost = (host, origin) => ({ ...json, host, ...(origin ? { origin } : {}) });
    const evil = await call("POST", "/api/pjs", asHost(`127.0.0.1:${port}`, "http://evil.example"), body);
    assert.equal(evil.status, 403);
    assert.equal((await call("POST", "/api/pjs", asHost(`127.0.0.1:${port}`), body)).status, 403, "no Origin at all");
    const viaLocalhost = await call("POST", "/api/pjs", asHost(`localhost:${port}`, `http://localhost:${port}`), body);
    assert.equal(viaLocalhost.status, 200, viaLocalhost.text);
  });
});

test("a broken JSON body is a plain 400; the app's own failures are not passed on with their details", async () => {
  await withServer(async ({ port, call }) => {
    const origin = `http://127.0.0.1:${port}`;
    const headers = { host: `127.0.0.1:${port}`, origin, "content-type": "application/json" };
    const bad = await call("POST", "/api/pjs", headers, "{ nope");
    assert.equal(bad.status, 400);
    assert.match(bad.text, /invalid JSON/);
  });
});

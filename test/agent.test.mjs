import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentApi, resolveSong } from "../agent-api.mjs";
import { createAgentAuth } from "../agent-auth.mjs";
import { validateCatalog } from "../catalog.mjs";

const MCP_SERVER = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url));

test("a token works for its own project only, and only for the secret that made it", () => {
  const auth = createAgentAuth(Buffer.from("secret-one"));
  const token = auth.tokenFor("p1");
  assert.equal(auth.verify("p1", token), true);
  assert.equal(auth.verify("p2", token), false, "another project");
  assert.equal(auth.verify("p1", token.slice(0, -1) + "0"), false, "a changed token");
  assert.equal(auth.verify("p1", ""), false);
  assert.equal(auth.verify("", token), false);
  assert.equal(auth.verify("p1", undefined), false);
  assert.equal(createAgentAuth(Buffer.from("secret-two")).verify("p1", token), false, "an app restart (new secret) invalidates it");
});

const songs = [
  { id: 1, base: "song/first", title: "first", path: "song/first.mp3", stems: [], beats: null },
  { id: 3, base: "song/third", title: "third", path: "song/third.mp3", stems: [{ name: "drums", path: "song/third.stems/drums.wav" }], beats: { bpm: 120, bpmAlternatives: [60], kick: 10, snare: 5, hat: 20, usedDrumsStem: true } },
  { id: 4, base: "song/dup", title: "same", path: null, stems: [], beats: null },
  { id: 5, base: "song/dup2", title: "same", path: null, stems: [], beats: null },
];

test("a song is found by id, #id or name, and an unclear reference is refused with advice", () => {
  assert.equal(resolveSong(songs, 3), "song/third");
  assert.equal(resolveSong(songs, "#3"), "song/third");
  assert.equal(resolveSong(songs, "3"), "song/third");
  assert.equal(resolveSong(songs, "third"), "song/third");
  assert.equal(resolveSong(songs, "song/first"), "song/first");
  assert.throws(() => resolveSong(songs, 99), /no song #99.*list_songs/);
  assert.throws(() => resolveSong(songs, "same"), /matches 2 songs/);
  assert.throws(() => resolveSong(songs, "nothing"), /no song named/);
  assert.throws(() => resolveSong(songs, ""), /give an id/);
});

/** The app side, faked: the real auth and the real agent API over HTTP, with recording stand-ins for the queue. */
async function fakeApp(opts = {}) {
  const auth = createAgentAuth(Buffer.from("test-secret"));
  const calls = { enqueued: [], cancelled: [], setup: [] };
  let jobs = [{ id: "job-1", pj: "p1", base: "song/third", kind: "beats", then: null, requestedBy: "claude", state: "running", progress: 40, error: null }];
  const state = { jobs: () => jobs, set: (next) => { jobs = next; } };
  const songJobs = {
    manager: { list: (pj) => jobs.filter((job) => job.pj === pj), cancel: (id) => { calls.cancelled.push(id); return true; } },
    enqueue: async (spec) => { calls.enqueued.push(spec); const job = { id: `job-new-${calls.enqueued.length}`, pj: spec.pj, base: spec.base, kind: spec.kind, then: spec.then ?? null, requestedBy: spec.requestedBy, state: "queued", progress: 0, error: null }; jobs = [...jobs, job]; return job; },
  };
  const installer = { snapshot: () => ({ state: "idle", steps: [], log: [], error: null }), cancel: () => true, start: async ({ gpu }) => { calls.setup.push({ gpu }); return { state: "running", steps: [{ state: "running", label: "make env" }], log: ["> python -m venv"], error: null }; } };
  const api = createAgentApi({
    auth, listVideos: opts.listVideos, videoDirOf: opts.videoDirOf,
    existingPjDir: async (pj) => (pj === "p1" || pj === "p2" ? `/work/${pj}` : null),
    listNumberedSongs: async () => songs,
    songJobs, installer, audioTools: { status: async () => ({ ready: { separate: true, beats: true } }) },
    catalog: opts.catalog ?? null, getPlugins: async () => opts.plugins ?? null,
    readBody: async (req) => { let text = ""; for await (const chunk of req) text += chunk; return JSON.parse(text || "{}"); },
    json: (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); },
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try { if (!(await api(req, res, url))) { res.writeHead(404); res.end(); } }
    catch (err) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: err.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { auth, calls, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Talks MCP to mcp-server.mjs the way Claude does: JSON-RPC lines on stdin and stdout. */
function mcpClient(env) {
  const child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim()) { const message = JSON.parse(line); pending.get(message.id)?.(message); }
    }
  });
  const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  return {
    request,
    async tool(name, args = {}) { const answer = await request("tools/call", { name, arguments: args }); const text = answer.result.content[0].text; return { isError: Boolean(answer.result.isError), text, data: answer.result.isError ? null : JSON.parse(text) }; },
    close: () => child.kill(),
  };
}

const envFor = (app, pj = "p1", token = app.auth.tokenFor(pj)) => ({ MV_STUDIO_URL: app.url, MV_STUDIO_PJ: pj, MV_STUDIO_TOKEN: token });

test("MCP: handshake, tool list, and a song list with the ids and files Claude needs", async () => {
  const app = await fakeApp();
  const client = mcpClient(envFor(app));
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "mv-studio");
    const list = await client.request("tools/list");
    assert.deepEqual(list.result.tools.map((t) => t.name), ["list_songs", "separate_song", "analyze_beats", "job_status", "wait_for_job", "cancel_job", "list_review_pins", "resolve_review_pins", "list_video_tools", "audio_tools_status", "setup_audio_tools"]);
    assert.ok(list.result.tools.every((t) => t.description && t.inputSchema.type === "object"));
    const { data } = await client.tool("list_songs");
    const third = data.songs.find((s) => s.id === 3);
    assert.equal(third.audio, "Output/song/third.mp3");
    assert.deepEqual(third.stems, { drums: "Output/song/third.stems/drums.wav" });
    assert.equal(third.beats.file, "Output/song/third.beats.json");
    assert.equal(third.beats.used_drums_stem, true);
    assert.deepEqual(third.running.map((j) => j.job_id), ["job-1"]);
    assert.equal(data.songs.find((s) => s.id === 1).stems, null);
  } finally { client.close(); await app.close(); }
});

test("MCP: asking for a separation reaches the queue as Claude's request, and the follow-up analysis is opt-in", async () => {
  const app = await fakeApp();
  const client = mcpClient(envFor(app));
  try {
    const first = await client.tool("separate_song", { song: "#3", then_beats: true });
    assert.equal(first.data.kind, "separate");
    assert.equal(first.data.then, "beats");
    const second = await client.tool("analyze_beats", { song: "first" });
    assert.equal(second.data.kind, "beats");
    assert.deepEqual(app.calls.enqueued.map((c) => [c.pj, c.base, c.kind, c.then, c.requestedBy]), [["p1", "song/third", "separate", "beats", "claude"], ["p1", "song/first", "beats", undefined, "claude"]]);
    const unclear = await client.tool("separate_song", { song: 42 });
    assert.equal(unclear.isError, true);
    assert.match(unclear.text, /no song #42.*list_songs/);
  } finally { client.close(); await app.close(); }
});

test("MCP: a wrong token, or another project's token, is refused", async () => {
  const app = await fakeApp();
  try {
    for (const env of [envFor(app, "p1", "0".repeat(64)), envFor(app, "p1", app.auth.tokenFor("p2"))]) {
      const client = mcpClient(env);
      try { const answer = await client.tool("list_songs"); assert.equal(answer.isError, true); assert.match(answer.text, /bad token/); } finally { client.close(); }
    }
  } finally { await app.close(); }
});

test("MCP: wait_for_job returns when the job finishes, and says so when it is still running", async () => {
  const app = await fakeApp();
  const client = mcpClient(envFor(app));
  try {
    const running = await client.tool("wait_for_job", { job_id: "job-1", timeout_seconds: 1 });
    assert.equal(running.data.finished, false);
    assert.match(running.data.note, /call wait_for_job again/);
    setTimeout(() => app.state.set(app.state.jobs().map((job) => ({ ...job, state: "done", progress: 100 }))), 300);
    const done = await client.tool("wait_for_job", { job_id: "job-1", timeout_seconds: 10 });
    assert.equal(done.data.finished, true);
    assert.equal(done.data.state, "done");
    const missing = await client.tool("wait_for_job", { job_id: "nope" });
    assert.equal(missing.isError, true);
  } finally { client.close(); await app.close(); }
});

test("MCP: cancel only reaches this project's jobs, and the tool setup defaults to the CPU build", async () => {
  const app = await fakeApp();
  const client = mcpClient(envFor(app));
  try {
    assert.equal((await client.tool("cancel_job", { job_id: "someone-elses" })).data.cancelled, false);
    assert.deepEqual(app.calls.cancelled, []);
    assert.equal((await client.tool("cancel_job", { job_id: "job-1" })).data.cancelled, true);
    const plain = await client.tool("setup_audio_tools");
    assert.equal(plain.data.state, "running");
    await client.tool("setup_audio_tools", { gpu: true });
    assert.deepEqual(app.calls.setup, [{ gpu: false }, { gpu: true }]);
    assert.equal((await client.tool("audio_tools_status")).data.ready.separate, true);
  } finally { client.close(); await app.close(); }
});

test("MCP: when the app is not reachable the tool says what to do instead of failing silently", async () => {
  const client = mcpClient({ MV_STUDIO_URL: "http://127.0.0.1:9", MV_STUDIO_PJ: "p1", MV_STUDIO_TOKEN: "x" });
  try {
    const answer = await client.tool("list_songs");
    assert.equal(answer.isError, true);
    assert.match(answer.text, /not reachable.*reopen this project/);
  } finally { client.close(); }
});

const toolCatalog = {
  version: 1, updated: "2026-11-05", policy_ja: ["rule"],
  entries: [
    { id: "hyper", name: "Hyper", kind: "plugin", category: ["render"], maker: "official", status: "recommended", summary_ja: "s", use_when_ja: "u", source: "https://example.com", license: "MIT", requires: [], costs: "none", signin: false, verified: "2026-11-05", evidence: ["https://example.com"], provides: { plugin: "hyper@hyper" }, install: { commands: ["claude plugin install hyper@hyper --scope project"] } },
    { id: "gen", name: "Gen", kind: "connector", category: ["generation"], maker: "official", status: "optional", summary_ja: "s", use_when_ja: "u", source: "https://example.com", license: "x", requires: [], costs: "paid-accounts", signin: true, verified: "2026-11-05", evidence: ["https://example.com"], manual_steps_ja: ["do it"] },
  ],
  watchlist: [{ name: "w", source: "https://example.com", reason_ja: "r" }],
};

test("MCP: list_video_tools returns the curated list with this project's install state, and can filter by category", async () => {
  assert.deepEqual(validateCatalog(toolCatalog), []);
  const app = await fakeApp({ catalog: toolCatalog, plugins: [{ id: "hyper@hyper", scope: "project", enabled: true }] });
  const client = mcpClient(envFor(app));
  try {
    const all = await client.tool("list_video_tools");
    assert.deepEqual(all.data.entries.map((e) => [e.id, e.installed.state]), [["hyper", "installed"], ["gen", "manual"]]);
    assert.equal(all.data.entries[0].install.commands[0], "claude plugin install hyper@hyper --scope project");
    assert.ok(all.data.policy_ja.length && all.data.watchlist.length);
    assert.ok(all.data.entries.every((e) => !("evidence" in e)));
    const generation = await client.tool("list_video_tools", { category: "generation" });
    assert.deepEqual(generation.data.entries.map((e) => e.id), ["gen"]);
  } finally { client.close(); await app.close(); }
});

test("MCP: without a loadable catalog the tool says so instead of returning an empty list", async () => {
  const app = await fakeApp();
  const client = mcpClient(envFor(app));
  try {
    const answer = await client.tool("list_video_tools");
    assert.equal(answer.isError, true);
    assert.match(answer.text, /catalog could not be loaded/);
  } finally { client.close(); await app.close(); }
});

test("MCP: Claude reads the review pins and reports fixes; unsent pins and stale videos are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mvs-mcp-review-"));
  await writeFile(join(dir, "cut.mp4"), "v1");
  const { saveUserPins, markSent } = await import("../review.mjs");
  const app = await fakeApp({ listVideos: async () => [{ id: 7, name: "cut.mp4" }], videoDirOf: () => dir });
  const client = mcpClient(envFor(app));
  try {
    await saveUserPins(dir, "cut.mp4", [{ t: 4, x: 0.5, y: 0.5, text: "暗くする" }]);
    const listed = await client.tool("list_review_pins", { video: "#7" });
    assert.deepEqual(listed.data.pins.map((p) => [p.id, p.text, p.status]), [[1, "暗くする", "open"]]);
    assert.match((await client.tool("resolve_review_pins", { video: 7, pins: [1], fixed_in: "cut-v2.mp4" })).text, /does not exist/);
    await writeFile(join(dir, "cut-v2.mp4"), "v2");
    assert.match((await client.tool("resolve_review_pins", { video: 7, pins: [1], fixed_in: "cut-v2.mp4" })).text, /not sent/);
    await markSent(dir, "cut.mp4", [1], Date.now() - 1000);
    const done = await client.tool("resolve_review_pins", { video: "cut.mp4", pins: [1], fixed_in: "cut-v2.mp4" });
    assert.deepEqual(done.data, { video: "cut.mp4", done: [1], still_open: [] });
    assert.match((await client.tool("list_review_pins", { video: 99 })).text, /no video #99/);
  } finally {
    client.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

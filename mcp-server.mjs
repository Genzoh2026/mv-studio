#!/usr/bin/env node
// MV Studio's own MCP server: the tools the Claude inside a project uses to work with the app's audio functions
// (song list, stem separation, beat analysis, the tool setup). Claude starts it from mv-studio.mcp.json; it talks to the
// running app over HTTP with a token that is valid for this project only, so the app's job queue, progress bar and song
// cards update exactly as if the user had pressed the buttons. No dependencies: MCP over stdio is newline-delimited JSON-RPC.
import { createInterface } from "node:readline";

const BASE_URL = process.env.MV_STUDIO_URL;
const TOKEN = process.env.MV_STUDIO_TOKEN;
const PROJECT = process.env.MV_STUDIO_PJ;
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 55; // under typical tool-call time limits; Claude calls again if the job is still running
const POLL_MS = 1000;
const ACTIVE = ["queued", "running"];

const songProperty = { description: "The song: its id (3 or \"#3\") as shown in the app and returned by list_songs, or its name" };
const TOOLS = [
  {
    name: "list_songs",
    description: "List this MV project's songs with their ids (#N) and what exists for each: the audio file, the stems (vocals/drums/bass/other), the beat analysis (tempo estimate, kick/snare/hat counts) and any job running for it. File paths are relative to the project folder; read them directly.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "separate_song",
    description: "Split a song into vocals, drums, bass and other with Demucs. Runs in the background on the user's computer and shows in the app (progress bar, song card). Returns a job id; use wait_for_job to wait. Free (no credits). Set then_beats to analyse the beats right after, using the new drums stem.",
    inputSchema: { type: "object", properties: { song: songProperty, then_beats: { type: "boolean", description: "Also analyse the beats when the separation finishes (recommended for video timing)" } }, required: ["song"], additionalProperties: false },
  },
  {
    name: "analyze_beats",
    description: "Find kick, snare and hat times, a beat grid and a tempo estimate for a song, saved as <song>.beats.json. Much more accurate if the song has been separated first (the drums stem is used). The tempo is an estimate; the hit times are the reliable part. Returns a job id; use wait_for_job.",
    inputSchema: { type: "object", properties: { song: songProperty }, required: ["song"], additionalProperties: false },
  },
  {
    name: "job_status",
    description: "The separation / analysis jobs of this project and the state of the audio tools setup (running, waiting, done, failed).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wait_for_job",
    description: `Wait until a job (or "setup" for the audio tools setup) finishes, up to ${MAX_WAIT_S} seconds, then report its state. If it is still running, call this again.`,
    inputSchema: { type: "object", properties: { job_id: { type: "string", description: "The job id, or \"setup\"" }, timeout_seconds: { type: "number", description: `Default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}` } }, required: ["job_id"], additionalProperties: false },
  },
  {
    name: "cancel_job",
    description: "Cancel a waiting or running job (or \"setup\").",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
  },
  {
    name: "list_review_pins",
    description: "The review pins the user put on a video in the app: each has an id, a time in seconds, a position (x, y as 0-1 from the top left, or null for the whole picture), the comment, and whether it is open or done. The user sends pins to you with a message pointing to a <video>.review.md file; use this to read them directly.",
    inputSchema: { type: "object", properties: { video: { description: "The video: its id (3 or \"#3\") or file name" } }, required: ["video"], additionalProperties: false },
  },
  {
    name: "resolve_review_pins",
    description: "After you made a FIXED NEW VERSION of a video (never overwrite the old one), report which pins it fixes. The app marks them done. It refuses pins that were not sent to you, and a fixed_in video that does not exist or is older than the moment the pins were sent. Pins you could not fix stay open: tell the user why.",
    inputSchema: { type: "object", properties: { video: { description: "The ORIGINAL video the pins are on: its id or file name" }, pins: { type: "array", items: { type: "integer" }, description: "Ids of the pins that the new version fixes" }, fixed_in: { type: "string", description: "File name of the new version in Output/video, e.g. cut3-v2.mp4" } }, required: ["video", "pins", "fixed_in"], additionalProperties: false },
  },
  {
    name: "list_video_tools",
    description: "The curated list of skills, plugins, MCP servers and tools for making videos (render, music-video, animation, generation, captions, editing, audio), each with what it is for, what it needs, costs, sign-in, the exact install commands, and whether it is installed in THIS project. Only entries in this list may be proposed. Call it when a video task starts, before suggesting any tool. See the rules for how to install.",
    inputSchema: { type: "object", properties: { category: { type: "string", enum: ["render", "music-video", "animation", "generation", "captions", "editing", "audio"], description: "Only entries of this category" } }, additionalProperties: false },
  },
  {
    name: "audio_tools_status",
    description: "Whether the audio tools are ready: Python, numpy, Demucs, ffmpeg, GPU. ready.separate and ready.beats say what can be used now.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "setup_audio_tools",
    description: "Install the audio tools when they are missing (ready.separate or ready.beats is false and you need them). It creates and fills the app's own Python environment inside the workspace (about 0.7 GB, a few minutes); nothing else on the computer is changed. Python and ffmpeg themselves cannot be installed this way: if they are missing, tell the user. Use gpu: true only if the user asked for the GPU build. Returns at once; use wait_for_job with job_id \"setup\".",
    inputSchema: { type: "object", properties: { gpu: { type: "boolean", description: "Install the CUDA build of PyTorch (about 3 GB more). Only when the user asked for it" } }, additionalProperties: false },
  },
];

class ToolError extends Error {}

async function api(method, route, body) {
  if (!BASE_URL || !TOKEN || !PROJECT) throw new ToolError("This server was not started by MV Studio (MV_STUDIO_URL / MV_STUDIO_TOKEN / MV_STUDIO_PJ are missing).");
  let response;
  try {
    response = await fetch(`${BASE_URL}/api/agent/${route}${route.includes("?") ? "&" : "?"}pj=${encodeURIComponent(PROJECT)}`, {
      method,
      headers: { "x-mv-studio-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify({ ...body, pj: PROJECT }) : undefined,
    });
  } catch (err) {
    throw new ToolError(`MV Studio is not reachable at ${BASE_URL} (${err.message}). It may have been restarted; ask the user to reopen this project.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ToolError(data.error ?? `MV Studio answered ${response.status}`);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(jobId, timeoutSeconds) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutSeconds) || DEFAULT_WAIT_S, 1), MAX_WAIT_S) * 1000;
  for (;;) {
    const { jobs, setup } = await api("GET", "jobs");
    const entry = jobId === "setup" ? { id: "setup", ...setup } : jobs.find((job) => job.id === jobId);
    if (!entry) throw new ToolError(`no job ${jobId} (it may have been dismissed; use job_status)`);
    const finished = jobId === "setup" ? entry.state !== "running" : !ACTIVE.includes(entry.state);
    if (finished || Date.now() >= deadline) {
      const next = jobs.find((job) => job.state === "queued" && job.id !== jobId);
      return { ...summary(entry), finished, ...(finished ? {} : { note: "still running; call wait_for_job again" }), ...(next ? { next_in_queue: summary(next) } : {}) };
    }
    await sleep(POLL_MS);
  }
}

/** A job, trimmed to what Claude needs. */
function summary(job) {
  if (job.id === "setup") return { job_id: "setup", state: job.state, steps: job.steps?.map((s) => `${s.state}: ${s.label}`), error: job.error, last_log: job.log?.slice(-5) };
  return { job_id: job.id, song: job.base, kind: job.kind, then: job.then, state: job.state, progress: job.progress, error: job.error };
}

const HANDLERS = {
  list_songs: () => api("GET", "songs"),
  separate_song: async ({ song, then_beats }) => summary(await api("POST", "process", { song, kind: "separate", then_beats: then_beats === true })),
  analyze_beats: async ({ song }) => summary(await api("POST", "process", { song, kind: "beats" })),
  job_status: async () => {
    const { jobs, setup } = await api("GET", "jobs");
    return { jobs: jobs.map(summary), setup: setup.state === "idle" ? null : summary({ id: "setup", ...setup }) };
  },
  wait_for_job: ({ job_id, timeout_seconds }) => waitForJob(job_id, timeout_seconds),
  cancel_job: ({ job_id }) => api("POST", "cancel", { job_id }),
  list_review_pins: ({ video }) => api("GET", `review?video=${encodeURIComponent(video)}`),
  resolve_review_pins: ({ video, pins, fixed_in }) => api("POST", "review-resolve", { video, pins, fixed_in }),
  list_video_tools: ({ category }) => api("GET", category ? `video-tools?category=${encodeURIComponent(category)}` : "video-tools"),
  audio_tools_status: () => api("GET", "audio-tools"),
  setup_audio_tools: async ({ gpu }) => summary({ id: "setup", ...(await api("POST", "audio-setup", { gpu: gpu === true })) }),
};

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolError(`unknown tool: ${name}`);
  return handler(args ?? {});
}

// ---- JSON-RPC over stdio ----
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // a notification (e.g. notifications/initialized): nothing to answer
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "mv-studio", version: "1.0.0" },
        instructions: "Tools for this MV project's songs: separate stems, analyse beats, follow the jobs. The app shows the same jobs to the user.",
      } });
    }
    case "ping": return send({ jsonrpc: "2.0", id, result: {} });
    case "tools/list": return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    case "tools/call": {
      try {
        const result = await callTool(params?.name, params?.arguments);
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      } catch (err) {
        if (!(err instanceof ToolError)) console.error("mv-studio mcp:", err);
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: err instanceof ToolError ? err.message : `unexpected error: ${err.message}` }] } });
      }
    }
    default: return fail(id, -32601, `method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
  handle(message).catch((err) => { console.error("mv-studio mcp:", err); if (message.id !== undefined) fail(message.id, -32603, "internal error"); });
});

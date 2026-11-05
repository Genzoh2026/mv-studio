// The HTTP surface for the Claude that runs inside a project: list songs, ask for a separation or a beat analysis,
// follow the jobs, and set up the audio tools. Every call carries the project's token and can only touch that project.
// Claude cannot trash or delete anything through here, and cannot reach other projects.

import { describeCatalog } from "./catalog.mjs";
import { ReviewError, markDone, readReview } from "./review.mjs";

const PREFIX = "/api/agent/";
const ACTIVE = ["queued", "running"];

/** The song a reference points to: "3", "#3", 3, a base path ("song/x"), or a unique title. */
export function resolveSong(songs, ref) {
  if (typeof ref === "number" || /^#?\d+$/.test(String(ref ?? "").trim())) {
    const id = Number(String(ref).replace("#", ""));
    const found = songs.find((song) => song.id === id);
    if (!found) throw new Error(`there is no song #${id} in this project (use list_songs to see the ids)`);
    return found.base;
  }
  const name = String(ref ?? "").trim();
  if (!name) throw new Error("song: give an id (3 or #3) or a name");
  const matches = songs.filter((song) => song.base === name || song.base === `song/${name}` || song.title === name || song.name === name);
  if (matches.length === 1) return matches[0].base;
  throw new Error(matches.length ? `"${name}" matches ${matches.length} songs; use the id instead` : `no song named "${name}" (use list_songs to see the ids)`);
}

/** The video a reference points to: "3", "#3", 3 or a file name. */
export function resolveVideo(videos, ref) {
  if (typeof ref === "number" || /^#?\d+$/.test(String(ref ?? "").trim())) {
    const id = Number(String(ref).replace("#", ""));
    const found = videos.find((video) => video.id === id);
    if (!found) throw new ReviewError(`there is no video #${id} in this project`);
    return found;
  }
  const name = String(ref ?? "").trim();
  const found = videos.find((video) => video.name === name);
  if (!found) throw new ReviewError(`no video named "${name}" (give its id like 3, or the file name)`);
  return found;
}

/**
 * @param {{auth: {verify: (pj: string, token: string) => boolean}, existingPjDir: (pj: string) => Promise<string|null>,
 *   listNumberedSongs: (pj: string) => Promise<object[]>, songJobs: object, installer: object, audioTools: object,
 *   readBody: (req: import("node:http").IncomingMessage) => Promise<any>, json: (res: any, status: number, value: unknown) => void}} deps
 * @returns {(req: import("node:http").IncomingMessage, res: any, url: URL) => Promise<boolean>} true when the request was handled
 */
export function createAgentApi({ listVideos = async () => [], videoDirOf = (dir) => dir, auth, existingPjDir, listNumberedSongs, songJobs, installer, audioTools, readBody, json, catalog = null, getPlugins = async () => null }) {
  /** One song as Claude needs it: where its files are (relative to the project) and what exists. */
  const describe = (song, jobs) => ({
    id: song.id,
    name: song.base,
    title: song.title,
    audio: song.path ? `Output/${song.path}` : null,
    stems: song.stems?.length ? Object.fromEntries(song.stems.map((stem) => [stem.name, `Output/${stem.path}`])) : null,
    beats: song.beats && !song.beats.error ? { file: `Output/${song.base}.beats.json`, bpm_estimate: song.beats.bpm, bpm_alternatives: song.beats.bpmAlternatives, kick: song.beats.kick, snare: song.beats.snare, hat: song.beats.hat, used_drums_stem: song.beats.usedDrumsStem } : null,
    running: jobs.filter((job) => job.base === song.base && ACTIVE.includes(job.state)).map((job) => ({ job_id: job.id, kind: job.kind, state: job.state, progress: job.progress })),
  });

  return async function handle(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const route = url.pathname.slice(PREFIX.length);
    const body = req.method === "POST" ? await readBody(req) : {};
    const pj = url.searchParams.get("pj") ?? body.pj;
    if (!auth.verify(pj, req.headers["x-mv-studio-token"])) { json(res, 403, { error: "bad token" }); return true; }
    const dir = await existingPjDir(pj);
    if (!dir) { json(res, 400, { error: "bad project" }); return true; }
    const ok = (value) => { json(res, 200, value); return true; };

    if (route === "songs" && req.method === "GET") {
      const jobs = songJobs.manager.list(pj);
      return ok({ songs: (await listNumberedSongs(pj)).map((song) => describe(song, jobs)) });
    }
    if (route === "jobs" && req.method === "GET") return ok({ jobs: songJobs.manager.list(pj), setup: installer.snapshot() });
    if (route === "video-tools" && req.method === "GET") {
      if (!catalog) {
        json(res, 503, { error: "the video tools catalog could not be loaded (see the app's log)" });
        return true;
      }
      const category = url.searchParams.get("category") || undefined;
      return ok(await describeCatalog(catalog, { pjDir: dir, plugins: await getPlugins(dir), category }));
    }
    if (route === "audio-tools" && req.method === "GET") return ok(await audioTools.status({ refresh: url.searchParams.get("refresh") === "1" }));
    if (route === "process" && req.method === "POST") {
      if (body.kind !== "separate" && body.kind !== "beats") {
        json(res, 400, { error: "kind: separate or beats" });
        return true;
      }
      const base = resolveSong(await listNumberedSongs(pj), body.song);
      const job = await songJobs.enqueue({ pj, pjDir: dir, base, kind: body.kind, then: body.then_beats === true && body.kind === "separate" ? "beats" : undefined, requestedBy: "claude" });
      return ok(songJobs.manager.list(pj).find((entry) => entry.id === job.id));
    }
    if (route === "cancel" && req.method === "POST") {
      if (body.job_id === "setup") return ok({ cancelled: installer.cancel() });
      const mine = songJobs.manager.list(pj).some((job) => job.id === body.job_id);
      return ok({ cancelled: mine ? songJobs.manager.cancel(body.job_id) : false });
    }
    if (route === "audio-setup" && req.method === "POST") {
      // The user authorised this once in the rules: when the audio tools are missing, Claude sets them up (same steps as the
      // Settings button: only the workspace environment is changed). The GPU build is only for when the user asked for it.
      return ok(await installer.start({ gpu: body.gpu === true }));
    }
    if (route === "review" && req.method === "GET") {
      try {
        const video = resolveVideo(await listVideos(dir), url.searchParams.get("video"));
        const review = await readReview(videoDirOf(dir), video.name);
        return ok({ video: video.name, id: video.id, pins: review.pins });
      } catch (err) {
        if (!(err instanceof ReviewError)) throw err;
        json(res, 400, { error: err.message });
        return true;
      }
    }
    if (route === "review-resolve" && req.method === "POST") {
      // Claude reports which pins it fixed and in which new video; the app checks that the pins were sent and the video is newer.
      try {
        const video = resolveVideo(await listVideos(dir), body.video);
        const ids = (Array.isArray(body.pins) ? body.pins : [body.pins]).map((p) => Number(String(p).replace(/^ピン|^#/, "")));
        const review = await markDone(videoDirOf(dir), video.name, ids, body.fixed_in);
        return ok({ video: video.name, done: ids, still_open: review.pins.filter((pin) => pin.status === "open").map((pin) => pin.id) });
      } catch (err) {
        if (!(err instanceof ReviewError)) throw err;
        json(res, 400, { error: err.message });
        return true;
      }
    }
    json(res, 404, { error: "unknown agent route" });
    return true;
  };
}

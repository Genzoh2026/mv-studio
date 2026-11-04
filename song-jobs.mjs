// Separation and beat analysis of one song: finds its audio file, runs the right script, and puts the result beside the
// song (<song>.stems/ and <song>.beats.json). The song is named by its base path under Output, e.g. "song/x".
import { readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import { createJobs } from "./jobs.mjs";

export const STEM_NAMES = ["vocals", "drums", "bass", "other"];
export const STEM_LABELS = { vocals: "声", drums: "ドラム", bass: "ベース", other: "その他" };
export const STEMS_EXT = ".stems";
export const BEATS_EXT = ".beats.json";
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".ogg"];
export const KINDS = ["separate", "beats"];

export class SongJobError extends Error {}

const exists = (path) => stat(path).then(() => true, () => false);

/** The song's audio file for a base path, or null. The base must stay inside Output. */
export async function findSongAudio(pjDir, base) {
  const output = resolve(pjDir, "Output");
  const target = typeof base === "string" && base && !base.includes("\0") ? resolve(output, base) : null;
  if (!target || !target.startsWith(output + sep)) return null;
  for (const ext of AUDIO_EXTS) if (await exists(target + ext)) return { file: target + ext, stemBase: target };
  return null;
}

/** The stems that exist for a song, in a fixed order, as paths relative to Output (for the audio route). */
export async function listStems(stemBase, outputRoot) {
  let names;
  try {
    names = await readdir(stemBase + STEMS_EXT);
  } catch {
    return [];
  }
  const stems = [];
  for (const name of STEM_NAMES) {
    const file = names.find((n) => n.toLowerCase() === `${name}.wav`);
    if (!file) continue;
    const full = join(stemBase + STEMS_EXT, file);
    stems.push({ name, label: STEM_LABELS[name], path: full.slice(outputRoot.length + 1).split(sep).join("/"), size: (await stat(full)).size });
  }
  return stems;
}

/** @param {{tools: ReturnType<import("./audio-tools.mjs").createAudioTools>, onChange?: () => void}} options */
export function createSongJobs({ tools }) {
  const manager = createJobs({ run: (job, ctx) => runJob(job, ctx) });

  /** A Python "No module named X" is not something the user can act on; say what to do. */
  const explain = (err) => {
    const missing = /No module named '([\w.]+)'/.exec(err.message)?.[1];
    return missing ? new Error(`Python に ${missing} が入っていません。左端の ⚙ 設定 > 音声ツール の手順で入れて、「再確認」を押してください。`) : err;
  };

  async function runJob(job, ctx) {
    try {
      await runJobUnchecked(job, ctx);
    } catch (err) {
      throw explain(err);
    }
  }

  async function runJobUnchecked(job, { signal, progress }) {
    const { file, stemBase } = job.paths;
    const id = randomUUID().slice(0, 8);
    if (job.kind === "separate") {
      const target = stemBase + STEMS_EXT;
      const tmp = join(resolve(target, ".."), `.stems-tmp-${id}`);
      try {
        await tools.runScript("separate.py", ["--input", file, "--out-dir", tmp, "--model", job.model, "--device", job.device], { onProgress: progress, signal });
        if (await exists(target)) throw new SongJobError("stems already exist (move them to the trash first)");
        await rename(tmp, target);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return;
    }
    const target = stemBase + BEATS_EXT;
    const tmp = join(resolve(target, ".."), `.beats-tmp-${id}.json`);
    const drums = join(stemBase + STEMS_EXT, "drums.wav");
    const args = ["--input", file, "--out", tmp, ...((await exists(drums)) ? ["--drums", drums] : [])];
    try {
      await tools.runScript("beats.py", args, { onProgress: progress, signal });
      await rename(tmp, target); // derived data, so a newer analysis replaces the older one
    } finally {
      await rm(tmp, { force: true });
    }
  }

  return {
    manager,

    /** Queues a job after checking the song and the tools. Throws SongJobError with a message the page can show. */
    async enqueue({ pj, pjDir, base, kind }) {
      if (!KINDS.includes(kind)) throw new SongJobError(`kind: one of ${KINDS.join(", ")}`);
      const paths = await findSongAudio(pjDir, base);
      if (!paths) throw new SongJobError("this song has no audio file yet (download or add it first)");
      const status = await tools.status();
      if (!status.ready[kind === "separate" ? "separate" : "beats"]) {
        throw new SongJobError(kind === "separate" ? "Demucs is not set up (see Settings > Audio tools)" : "Python with numpy and ffmpeg are not set up (see Settings > Audio tools)");
      }
      if (kind === "separate" && (await exists(paths.stemBase + STEMS_EXT))) throw new SongJobError("stems already exist for this song");
      return manager.enqueue({ pj, base, kind, paths, model: status.model, device: status.cuda ? "cuda" : "cpu", title: basename(base) });
    },
  };
}

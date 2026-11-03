// Song analysis files written by Claude next to a song: <name>.analysis.json (Suno audio-analysis: beats, tempo,
// key, sections) and <name>.lyrics.json (Suno audio-lyrics-alignment: word timings). The app only reads them and
// shows a one-line summary; it never trusts their shape beyond what is checked here.
import { readFile, stat } from "node:fs/promises";

export const ANALYSIS_EXT = ".analysis.json";
export const LYRICS_TIMINGS_EXT = ".lyrics.json";
const MAX_BYTES = 4 * 1024 * 1024; // a 6-minute song is well under 1 MB; anything bigger is not ours
const KEY_MAX = 40;

// The song list refreshes every few seconds; a summary is recomputed only when the file changed.
const cache = new Map();

async function summarise(file, summarize) {
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    cache.delete(file);
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === info.mtimeMs && hit.size === info.size) return hit.summary;
  let summary;
  if (info.size > MAX_BYTES) summary = { error: "file is too large" };
  else {
    try {
      summary = summarize(JSON.parse(await readFile(file, "utf8")), info.mtimeMs);
    } catch (err) {
      // A broken file is reported, never overwritten or deleted.
      summary = { error: err.message };
    }
  }
  cache.set(file, { mtime: info.mtimeMs, size: info.size, summary });
  return summary;
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Summary of <base>.analysis.json, or null when the song has not been analysed. */
export function readAnalysisSummary(base) {
  return summarise(base + ANALYSIS_EXT, (d, mtime) => {
    if (typeof d !== "object" || d === null || Array.isArray(d)) return { error: "analysis must be an object" };
    return {
      bpm: finite(d.bpm),
      key: typeof d.key === "string" ? d.key.slice(0, KEY_MAX) : null,
      timeSignature: finite(d.time_signature),
      sections: Array.isArray(d.sections) ? d.sections.length : 0,
      beats: Array.isArray(d.beats) ? d.beats.length : 0,
      mtime,
    };
  });
}

/** Summary of <base>.lyrics.json (word timings), or null when absent. */
export function readTimingsSummary(base) {
  return summarise(base + LYRICS_TIMINGS_EXT, (d, mtime) => {
    const words = d?.words;
    if (!Array.isArray(words)) return { error: "lyrics timings need a words array" };
    return { words: words.length, mtime };
  });
}

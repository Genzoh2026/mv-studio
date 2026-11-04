// Adding a song file to <PJ>/Output/song/. Songs can be large (a wav is easily 100 MB), so the upload is streamed to a
// temporary file instead of being held in memory, checked by its header on the way, and only then given its final name.
import { createWriteStream } from "node:fs";
import { copyFile, constants, link, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cleanStem } from "./images.mjs";

export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const HEADER_BYTES = 12;
const MAX_SUFFIX = 999;

export class AudioError extends Error {}

/** The canonical extension for the bytes, judged by the file header, or null when it is not a supported song file. */
export function sniffAudio(head) {
  const at = (text, offset = 0) => head.length >= offset + text.length && head.subarray(offset, offset + text.length).toString("latin1") === text;
  if (at("ID3") || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return ".mp3";
  if (at("RIFF") && at("WAVE", 8)) return ".wav";
  if (at("ftyp", 4)) return ".m4a";
  if (at("OggS")) return ".ogg";
  return null;
}

/** Checks the first bytes and the total size while the data flows through; fails the pipeline on the first problem. */
function checker(limit, found) {
  let size = 0;
  let head = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > limit) return done(new AudioError(`too large (max ${limit / 1024 / 1024} MB)`));
      if (!found.ext) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= HEADER_BYTES) {
          found.ext = sniffAudio(head);
          if (!found.ext) return done(new AudioError("not a supported audio file (mp3, wav, m4a, ogg)"));
        }
      }
      done(null, chunk);
    },
    flush(done) {
      // A file shorter than the header is judged now.
      if (!found.ext) found.ext = sniffAudio(head);
      done(found.ext ? null : new AudioError("not a supported audio file (mp3, wav, m4a, ogg)"));
    },
  });
}

/** Gives the finished temporary file its final name without ever overwriting: a taken name gets -2, -3, ... */
async function nameWithoutOverwrite(dir, tmp, stem, ext) {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = `${stem}${n === 1 ? "" : `-${n}`}${ext}`;
    try {
      await link(tmp, join(dir, name));
      return name;
    } catch (err) {
      if (err.code === "EEXIST") continue;
      // A file system without hard links: copy, still refusing to overwrite.
      try {
        await copyFile(tmp, join(dir, name), constants.COPYFILE_EXCL);
        return name;
      } catch (copyErr) {
        if (copyErr.code !== "EEXIST") throw copyErr;
      }
    }
  }
  throw new AudioError("too many files with this name");
}

/**
 * Saves the stream as a song. Returns the file name used (its extension follows the content, not the claimed name).
 * @param {string} dir the project's Output/song folder
 * @param {string} rawName the name the browser sent
 * @param {import("node:stream").Readable} stream the request body
 */
export async function saveAudioStream(dir, rawName, stream, limit = MAX_AUDIO_BYTES) {
  await mkdir(dir, { recursive: true });
  // A leading dot keeps a half-written upload out of the song list.
  const tmp = join(dir, `.upload-${randomUUID()}.tmp`);
  const found = { ext: null };
  try {
    await pipeline(stream, checker(limit, found), createWriteStream(tmp, { flags: "wx" }));
    return await nameWithoutOverwrite(dir, tmp, cleanStem(rawName), found.ext);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

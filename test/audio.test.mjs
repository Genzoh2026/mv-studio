import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AudioError, saveAudioStream, sniffAudio } from "../audio.mjs";

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(40, 1)]);
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(40, 2)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WAVEfmt "), Buffer.alloc(20)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(20)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(30)]);

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), "mvs-audio-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Delivered in small pieces on purpose: the header check must work when the first chunk is shorter than the header.
const pieces = (buf, size = 5) => Readable.from((function* () { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); })());

test("sniffAudio recognises mp3, wav, m4a and ogg by header and nothing else", () => {
  assert.equal(sniffAudio(MP3), ".mp3");
  assert.equal(sniffAudio(MP3_FRAME), ".mp3");
  assert.equal(sniffAudio(WAV), ".wav");
  assert.equal(sniffAudio(M4A), ".m4a");
  assert.equal(sniffAudio(OGG), ".ogg");
  assert.equal(sniffAudio(Buffer.from("<html>not audio at all")), null);
  assert.equal(sniffAudio(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), null);
  assert.equal(sniffAudio(Buffer.alloc(0)), null);
});

test("saveAudioStream stores the bytes under a name that follows the content and never overwrites", async () => {
  await scratch(async (root) => {
    const dir = join(root, "Output", "song");
    assert.equal(await saveAudioStream(dir, "my song.wav", pieces(MP3)), "my song.mp3"); // the claimed .wav is ignored
    assert.equal(await saveAudioStream(dir, "my song.mp3", pieces(MP3)), "my song-2.mp3");
    assert.equal(await saveAudioStream(dir, "C:\\music\\track.ogg", pieces(OGG)), "track.ogg");
    assert.deepEqual(await readFile(join(dir, "my song-2.mp3")), MP3);
    assert.deepEqual((await readdir(dir)).sort(), ["my song-2.mp3", "my song.mp3", "track.ogg"]); // no temporary files left
  });
});

test("saveAudioStream refuses non-audio, tiny junk and oversized data, and leaves nothing behind", async () => {
  await scratch(async (root) => {
    const dir = join(root, "song");
    await assert.rejects(saveAudioStream(dir, "a.mp3", pieces(Buffer.from("<html>" + "x".repeat(200)))), AudioError);
    await assert.rejects(saveAudioStream(dir, "a.mp3", pieces(Buffer.from("hi"))), AudioError);
    await assert.rejects(saveAudioStream(dir, "a.mp3", pieces(Buffer.concat([MP3, Buffer.alloc(500)])), 100), /too large/);
    assert.deepEqual(await readdir(dir), []);
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { readAnalysisSummary, readTimingsSummary } from "../analysis.mjs";

describe("song analysis files", () => {
  let dir;
  const base = () => join(dir, "song");
  before(async () => { dir = await mkdtemp(join(tmpdir(), "mvstudio-analysis-")); });
  after(() => rm(dir, { recursive: true, force: true }));

  test("no file means not analysed", async () => {
    assert.equal(await readAnalysisSummary(base()), null);
    assert.equal(await readTimingsSummary(base()), null);
  });

  test("summarises tempo, key, sections and beats", async () => {
    await writeFile(base() + ".analysis.json", JSON.stringify({
      bpm: 120.5, key: "C major", time_signature: 4,
      sections: [{ start_s: 0, end_s: 8, label: "A" }, { start_s: 8, end_s: 16, label: "B" }],
      beats: [[0.1, 1], [0.6, 2], [1.1, 3]],
    }));
    const summary = await readAnalysisSummary(base());
    assert.deepEqual(
      [summary.bpm, summary.key, summary.timeSignature, summary.sections, summary.beats],
      [120.5, "C major", 4, 2, 3],
    );
  });

  test("a part Suno could not produce stays empty, not an error", async () => {
    await writeFile(base() + ".analysis.json", JSON.stringify({ bpm: null, key: null, sections: [], beats: [] }));
    const summary = await readAnalysisSummary(base());
    assert.deepEqual([summary.bpm, summary.key, summary.sections, summary.beats], [null, null, 0, 0]);
  });

  test("wrong types are ignored instead of shown", async () => {
    await writeFile(base() + ".analysis.json", JSON.stringify({ bpm: "fast", key: 5, sections: "x", beats: {} }));
    const summary = await readAnalysisSummary(base());
    assert.deepEqual([summary.bpm, summary.key, summary.sections, summary.beats], [null, null, 0, 0]);
  });

  test("a broken file is reported, not thrown", async () => {
    await writeFile(base() + ".analysis.json", "{not json");
    assert.ok((await readAnalysisSummary(base())).error);
    await writeFile(base() + ".analysis.json", "[1,2]");
    assert.match((await readAnalysisSummary(base())).error, /object/);
  });

  test("counts word timings and rejects a file without words", async () => {
    await writeFile(base() + ".lyrics.json", JSON.stringify({ words: [{}, {}, {}] }));
    assert.equal((await readTimingsSummary(base())).words, 3);
    await writeFile(base() + ".lyrics.json", JSON.stringify({ words: "nope" }));
    assert.ok((await readTimingsSummary(base())).error);
  });
});

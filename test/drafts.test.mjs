import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { cleanDraft, listDrafts, readVoices, saveHuman, ValidationError } from "../drafts.mjs";

// Dummy ids only: these never refer to a real Suno account.
const CLIP = "11111111-2222-3333-4444-555555555555";
const draft = (settings = {}) => ({ title: "t", style: "s", lyrics: "l", settings });

describe("draft settings", () => {
  test("an old draft without the new fields gets defaults", () => {
    const { settings } = cleanDraft(draft({ vocal_gender: "female", instrumental: false }));
    assert.equal(settings.mode, "new");
    assert.equal(settings.source_id, "");
    assert.equal(settings.voice_id, "");
    assert.equal(settings.audio_influence, null);
    assert.equal(settings.negative_style, "");
  });

  test("a cover keeps its source, voice and influence", () => {
    const { settings } = cleanDraft(draft({
      mode: "cover", source_id: CLIP, source_title: "Song", voice_id: "voice_abc-1", voice_name: "Me", audio_influence: 0.4,
    }));
    assert.deepEqual(
      [settings.mode, settings.source_id, settings.voice_id, settings.audio_influence],
      ["cover", CLIP, "voice_abc-1", 0.4],
    );
  });

  test("a cover without a source still saves (a draft in progress)", () => {
    assert.equal(cleanDraft(draft({ mode: "cover" })).settings.source_id, "");
  });

  for (const [name, settings] of [
    ["unknown mode", { mode: "remix" }],
    ["source that is not a Suno id", { mode: "cover", source_id: "../../etc/passwd" }],
    ["voice id with odd characters", { voice_id: "a b;c" }],
    ["audio_influence out of range", { audio_influence: 1.5 }],
    ["negative_style too long", { negative_style: "x".repeat(1001) }],
    ["negative_style not text", { negative_style: 5 }],
  ]) {
    test(`rejects ${name}`, () => assert.throws(() => cleanDraft(draft(settings)), ValidationError));
  }
});

describe("voices.json", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mvstudio-voices-"));
    await mkdir(join(dir, "Drafts"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test("missing file means not fetched yet", async () => {
    assert.deepEqual(await readVoices(dir), { fetched: false, voices: [] });
  });

  test("keeps id and name only and drops malformed entries", async () => {
    await writeFile(join(dir, "Drafts", "voices.json"), JSON.stringify({
      updated_at: "2026-11-04T00:00:00Z",
      voices: [
        { id: "voice_1", name: "Dummy A", secret: "must not leak" },
        { id: "bad id!", name: "Broken" },
        { name: "no id" },
        { id: "voice_2" },
      ],
    }));
    const result = await readVoices(dir);
    assert.deepEqual(result.voices, [{ id: "voice_1", name: "Dummy A" }, { id: "voice_2", name: "voice_2" }]);
    assert.equal(result.fetched, true);
  });

  test("a broken file is reported, not thrown", async () => {
    await writeFile(join(dir, "Drafts", "voices.json"), "{not json");
    const result = await readVoices(dir);
    assert.equal(result.fetched, false);
    assert.ok(result.error);
  });
});

describe("saving", () => {
  test("round-trips the new settings through the human file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mvstudio-save-"));
    try {
      await saveHuman(dir, "case1", draft({ mode: "cover", source_id: CLIP, voice_id: "v1" }), null);
      const [saved] = await listDrafts(dir);
      assert.deepEqual(
        [saved.name, saved.human.draft.settings.mode, saved.human.draft.settings.source_id, saved.human.draft.settings.voice_id],
        ["case1", "cover", CLIP, "v1"],
      );
      await assert.rejects(saveHuman(dir, "case1", draft(), null), /already exists/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

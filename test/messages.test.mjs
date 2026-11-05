import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { langOf, tr } from "../messages.mjs";
import { MESSAGES_EN } from "../messages-en.mjs";
import { installHelp } from "../audio-tools.mjs";
import { planSetup } from "../audio-install.mjs";
import { installGuideText } from "../claude-cli.mjs";
import { requestMarkdown } from "../review.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const JAPANESE = /[぀-ヿ一-鿿]/;
const HOLES = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join(",");

/** Every Japanese text the server code passes to tr(lang, "..."). */
function usedKeys() {
  const keys = new Map();
  const call = /\btr\(\s*lang\s*,\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/g;
  for (const file of readdirSync(ROOT).filter((name) => name.endsWith(".mjs") && !["messages.mjs", "messages-en.mjs"].includes(name))) {
    for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(call)) {
      const key = match[2].replace(/\\(.)/g, (all, c) => c);
      if (JAPANESE.test(key)) keys.set(key, file);
    }
  }
  return keys;
}

test("every Japanese text the server writes has an English text with the same {holes}, and nothing is unused", () => {
  const used = usedKeys();
  for (const [key, file] of used) {
    assert.ok(key in MESSAGES_EN, `${file}: no English text for: ${key.slice(0, 60)}`);
    assert.equal(HOLES(MESSAGES_EN[key]), HOLES(key), `${file}: {holes} differ for: ${key.slice(0, 60)}`);
  }
  for (const [key, value] of Object.entries(MESSAGES_EN)) {
    assert.ok(!JAPANESE.test(value), `Japanese left in the English text of: ${key.slice(0, 50)}`);
    assert.ok(used.has(key), `unused entry: ${key.slice(0, 50)}`);
  }
});

test("langOf follows the page's x-mv-lang header and is Japanese otherwise", () => {
  assert.equal(langOf({ headers: { "x-mv-lang": "en" } }), "en");
  assert.equal(langOf({ headers: { "x-mv-lang": "ja" } }), "ja");
  assert.equal(langOf({ headers: { "x-mv-lang": "fr" } }), "ja");
  assert.equal(langOf({ headers: {} }), "ja");
  assert.equal(langOf(undefined), "ja");
  assert.equal(tr("en", "Python 3 を入れる"), "Install Python 3");
  assert.equal(tr("ja", "Python 3 を入れる"), "Python 3 を入れる");
});

test("the install steps, the setup plan, the Claude Code guide and the fix instructions come out in English on request", () => {
  const found = { python: { found: false }, numpy: null, demucs: null, ffmpeg: { found: false }, workspace: "/w", platform: "win32", venvPython: "/w/venv/python" };
  const steps = installHelp({ ...found, gpu: "RTX 4080", lang: "en" });
  assert.deepEqual(steps.map((s) => s.label).filter((l) => JAPANESE.test(l)), [], "no Japanese label left");
  assert.ok(steps.every((s) => !JAPANESE.test(s.note ?? "")), "no Japanese note left");
  assert.ok(installHelp({ ...found, lang: "ja" }).some((s) => JAPANESE.test(s.label)), "Japanese stays the default");
  const plan = planSetup({ venvDir: "/w/venv", venvPython: "/w/venv/python", venvExists: false, venvTorch: null, venvCuda: false, base: null, gpu: null, wantGpu: false, lang: "en" });
  assert.match(plan.reason, /Python 3 was not found/);
  assert.ok(!JAPANESE.test(installGuideText("win32", "en")));
  assert.ok(JAPANESE.test(installGuideText("win32")));
  const video = { id: 3, name: "cut.mp4" };
  const pins = [{ id: 1, status: "open", text: "hide the mouth", t: 72.5, x: 0.5, y: 0.25 }, { id: 2, status: "open", text: "brighter", t: 5, x: null, y: null }];
  const en = requestMarkdown(video, pins, "en");
  assert.ok(!JAPANESE.test(en), en);
  assert.match(en, /# Fix instructions for video #3 cut\.mp4/);
  assert.match(en, /- \[Fix\] Pin 1 1:12\.500 \(x 50%, y 25%\) hide the mouth/);
  assert.match(en, /- \[Fix\] Pin 2 0:05\.000 \(whole picture\) brighter/);
  assert.match(requestMarkdown(video, pins, "ja"), /【修正】ピン1 1:12\.500/);
});

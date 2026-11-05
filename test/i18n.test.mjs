import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { detectLanguage, translate } from "../public/i18n.js";
import { EN } from "../public/i18n-en.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const JAPANESE = /[぀-ヿ一-鿿]/;
const HOLES = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join(",");

/** Every Japanese text the screen code passes to t(...), plus the Japanese texts of index.html. */
function usedKeys() {
  const keys = new Map(); // key -> where
  const call = /\bt\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  for (const file of readdirSync(PUBLIC).filter((name) => name.endsWith(".js") && !["i18n.js", "i18n-en.js"].includes(name))) {
    for (const match of readFileSync(join(PUBLIC, file), "utf8").matchAll(call)) {
      const key = match[2].replace(/\\(.)/g, (all, c) => c);
      if (JAPANESE.test(key)) keys.set(key, file);
      // a template literal with ${...} cannot be looked up by its text
      assert.ok(!(match[1] === "`" && key.includes("${")), `${file}: t(\`...\${}\`) must use {holes} instead: ${key.slice(0, 50)}`);
    }
  }
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  for (const match of html.matchAll(/>([^<>]*[぀-ヿ一-鿿][^<>]*)</g)) keys.set(match[1].trim(), "index.html");
  for (const match of html.matchAll(/(?:title|placeholder|aria-label)="([^"]*[぀-ヿ一-鿿][^"]*)"/g)) keys.set(match[1], "index.html");
  return keys;
}

test("every Japanese text shown by the screen has an English text, with the same {holes}", () => {
  const missing = [];
  const holes = [];
  for (const [key, file] of usedKeys()) {
    if (!(key in EN)) missing.push(`${file}: ${key.slice(0, 60)}`);
    else if (HOLES(key) !== HOLES(EN[key])) holes.push(`${file}: ${key.slice(0, 60)}`);
  }
  assert.deepEqual(missing, [], "texts without an English entry");
  assert.deepEqual(holes, [], "texts whose {holes} differ from the English one");
});

test("the English dictionary has no Japanese in its values, no empty values and no unused entries", () => {
  const used = usedKeys();
  for (const [key, value] of Object.entries(EN)) {
    assert.ok(!JAPANESE.test(value), `Japanese left in the English text of: ${key.slice(0, 50)}`);
    assert.ok(value.trim() !== "", `empty English text of: ${key.slice(0, 50)}`);
    assert.ok(used.has(key), `unused entry (delete it or use it): ${key.slice(0, 50)}`);
  }
});

test("translate: Japanese is the key, English comes from the dictionary, {holes} are filled, a missing text stays Japanese", () => {
  const dictionary = { "{n} 件を選択中": "{n} selected", "保存": "Save" };
  assert.equal(translate("ja", "{n} 件を選択中", { n: 3 }, dictionary), "3 件を選択中");
  assert.equal(translate("en", "{n} 件を選択中", { n: 3 }, dictionary), "3 selected");
  assert.equal(translate("en", "保存", undefined, dictionary), "Save");
  assert.equal(translate("en", "未翻訳", undefined, dictionary), "未翻訳");
  assert.equal(translate("en", "{n} 件を選択中", {}, dictionary), "{n} selected", "a hole without a value stays as it is");
  assert.equal(translate("en", "保存", { n: 1 }, dictionary), "Save");
});

test("the first language comes from the browser (Japanese for ja, English otherwise) and a saved choice wins", () => {
  assert.equal(detectLanguage(null, "ja"), "ja");
  assert.equal(detectLanguage(null, "ja-JP"), "ja");
  assert.equal(detectLanguage(null, "en-US"), "en");
  assert.equal(detectLanguage(null, "fr"), "en");
  assert.equal(detectLanguage(null, ""), "en");
  assert.equal(detectLanguage("ja", "en-US"), "ja");
  assert.equal(detectLanguage("en", "ja-JP"), "en");
  assert.equal(detectLanguage("xx", "ja-JP"), "ja", "an unknown saved value is ignored");
});

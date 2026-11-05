// Display language (Japanese / English). The Japanese text is written in the code itself and is also the key: t("曲を追加")
// returns it as it is in Japanese, and the English dictionary (i18n-en.js) in English. A text that has no English entry
// stays Japanese (npm test makes sure none is missing). Texts with values use {name} holes: t("{n} 件を選択中", { n: 3 }).
// The language is chosen once per page load: the first time from the browser's language, afterwards from what the user picked
// (🌐 in the left bar), and switching reloads the page so every screen is drawn again in the new language.
import { EN } from "./i18n-en.js";

const STORAGE_KEY = "mv-studio:lang";
export const LANGS = [["ja", "日本語"], ["en", "English"]];

/** The language to use: the saved choice, else the browser's (Japanese for ja*, English otherwise). */
export function detectLanguage(saved, browserLanguage) {
  if (saved === "ja" || saved === "en") return saved;
  return String(browserLanguage ?? "").toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** The text in `language`; {name} holes are filled from `vars` (a hole without a value stays as it is). */
export function translate(language, text, vars, dictionary = EN) {
  const base = language === "en" ? (dictionary[text] ?? text) : text;
  return vars ? base.replace(/\{(\w+)\}/g, (hole, name) => (name in vars ? String(vars[name]) : hole)) : base;
}

const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
export const lang = detectLanguage(saved, typeof navigator === "undefined" ? "" : navigator.language);
if (typeof document !== "undefined") document.documentElement.lang = lang;

export const locale = lang === "ja" ? "ja-JP" : "en-US";
export const t = (text, vars) => translate(lang, text, vars);

/** Chooses the language and redraws everything by reloading the page. */
export function setLang(next) {
  localStorage.setItem(STORAGE_KEY, next);
  location.reload();
}

/**
 * The fixed markup of index.html is translated in place (its text, title, placeholder and aria-label); everything the scripts
 * draw goes through t() instead. Run once at start.
 */
export function translateStatic(root = document) {
  if (lang === "ja") return;
  for (const el of root.querySelectorAll("*")) {
    if (!el.children.length && el.textContent.trim() && EN[el.textContent.trim()]) el.textContent = EN[el.textContent.trim()];
    for (const attr of ["title", "placeholder", "aria-label"]) {
      const value = el.getAttribute(attr);
      if (value && EN[value]) el.setAttribute(attr, EN[value]);
    }
  }
  if (EN[document.title]) document.title = EN[document.title];
}

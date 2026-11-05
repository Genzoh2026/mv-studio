// Display language (Japanese / English). The Japanese text is written in the code itself and is also the key: t("曲を追加")
// returns it as it is in Japanese, and the English dictionary (i18n-en.js) in English. A text that has no English entry
// stays Japanese (npm test makes sure none is missing). Texts with values use {name} holes: t("{n} 件を選択中", { n: 3 }).
// The language is chosen once per page load: the first time from the browser's language, afterwards from what the user picked
// (🌐 in the left bar), and switching reloads the page so every screen is drawn again in the new language.
// Every request the page makes carries the language (x-mv-lang), so the texts the server writes follow it too.
import { detectLanguage, translate as translateWith } from "./i18n-core.js";
import { EN } from "./i18n-en.js";

const STORAGE_KEY = "mv-studio:lang";
export const LANGS = [["ja", "日本語"], ["en", "English"]];

export { detectLanguage };
/** The text in `language` from the screen's English dictionary (or `dictionary`). */
export const translate = (language, text, vars, dictionary = EN) => translateWith(language, text, vars, dictionary);

const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
export const lang = detectLanguage(saved, typeof navigator === "undefined" ? "" : navigator.language);
if (typeof document !== "undefined") document.documentElement.lang = lang;

export const locale = lang === "ja" ? "ja-JP" : "en-US";
export const t = (text, vars) => translate(lang, text, vars);

if (typeof window !== "undefined" && window.fetch) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("x-mv-lang")) headers.set("x-mv-lang", lang);
    return originalFetch(input, { ...init, headers });
  };
}

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

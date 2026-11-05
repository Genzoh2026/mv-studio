// The language logic without anything that belongs to a browser, shared by the screen (i18n.js) and the server (messages.mjs).
// Japanese text is the key; a dictionary maps it to English. {name} holes are filled from `vars`.

/** The language to use: the saved choice, else the browser's (Japanese for ja*, English otherwise). */
export function detectLanguage(saved, browserLanguage) {
  if (saved === "ja" || saved === "en") return saved;
  return String(browserLanguage ?? "").toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** The text in `language`; {name} holes are filled from `vars` (a hole without a value stays as it is). */
export function translate(language, text, vars, dictionary) {
  const base = language === "en" ? (dictionary[text] ?? text) : text;
  return vars ? base.replace(/\{(\w+)\}/g, (hole, name) => (name in vars ? String(vars[name]) : hole)) : base;
}

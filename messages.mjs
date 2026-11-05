// The language of the texts the server writes (install steps, the Claude Code install guide, job errors, the fix instructions that
// Claude reads). The page sends its language with every request (x-mv-lang, see public/i18n.js); the Japanese text in the code is
// the key, and messages-en.mjs holds the English.
import { translate } from "./public/i18n-core.js";
import { MESSAGES_EN } from "./messages-en.mjs";

/** The language of a request: "en" when the page asks for it, otherwise Japanese. */
export const langOf = (req) => (req?.headers?.["x-mv-lang"] === "en" ? "en" : "ja");

/** The text in `lang` ("ja" or "en"); {name} holes are filled from `vars`. */
export const tr = (lang, text, vars) => translate(lang, text, vars, MESSAGES_EN);

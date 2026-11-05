// The language tool of the left bar (just above the power button): choose Japanese or English. Choosing reloads the page.
import { LANGS, lang, setLang } from "./i18n.js";

export const langTool = {
  id: "lang",
  icon: "🌐",
  title: "言語 / Language", // both languages on purpose: it must be findable whichever one is showing
  position: "bottom",
  open(body) {
    for (const [code, label] of LANGS) {
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        className: code === lang ? "lang-choice on" : "lang-choice",
        textContent: label,
        onclick: () => { if (code !== lang) setLang(code); },
      });
      body.append(button);
    }
  },
};

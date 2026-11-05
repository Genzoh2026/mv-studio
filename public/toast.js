import { t } from "/i18n.js";
// Transient messages float over the page instead of living in the layout, so showing or hiding one never
// pushes the content around. A toast with an action stays until it is answered or closed.
const container = document.getElementById("toasts");
const timers = new Map();
const AUTO_HIDE_MS = { info: 6000, warn: 10000, error: 10000 };

/**
 * @param {string} text
 * @param {{key?: string, kind?: "info"|"warn"|"error", action?: {label: string, run: () => void}|null}} [options]
 *   `key` replaces an earlier toast with the same key instead of stacking another one.
 */
export function toast(text, { key = text, kind = "info", action = null } = {}) {
  dismiss(key);
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.dataset.key = key;
  el.append(Object.assign(document.createElement("span"), { textContent: text }));
  if (action) {
    el.append(Object.assign(document.createElement("button"), {
      type: "button",
      textContent: action.label,
      onclick: () => { dismiss(key); action.run(); },
    }));
  }
  el.append(Object.assign(document.createElement("button"), {
    type: "button", className: "close", textContent: "✕", title: t("閉じる"), onclick: () => dismiss(key),
  }));
  container.append(el);
  if (!action) timers.set(key, setTimeout(() => dismiss(key), AUTO_HIDE_MS[kind]));
}

export function dismiss(key) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
}

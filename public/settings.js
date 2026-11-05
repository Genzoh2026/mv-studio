// The settings tool: Claude Code and the audio tools, each a collapsible section with a one-line status.
// (The video tools catalog is the separate library tool, library.js; restarting and stopping the server is power.js.)
import { toast } from "/toast.js";
import { createAudioToolsPanel } from "/audio-tools-panel.js";
import { t } from "/i18n.js";

const REFRESH_MS = 5000;
const SECTIONS_KEY = "mv-studio:settings-sections";

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const post = (path) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

/**
 * A collapsible section with a one-line status in its header. Whether it is open is remembered; a section that needs attention
 * opens by itself the first time (only if the user never chose).
 */
function makeSection(id, title, headingId) {
  const saved = () => { try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}"); } catch { return {}; } };
  const el = h("details", { className: "sec" });
  const label = h("span", { className: "sec-title", textContent: title, id: headingId });
  const summaryText = h("span", { className: "sec-sum" });
  const box = h("div", { className: "sec-body" });
  el.append(h("summary", {}, label, summaryText), box);
  if (saved()[id] !== undefined) el.open = saved()[id];
  let programmatic = false;
  el.addEventListener("toggle", () => {
    if (programmatic) return;
    localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...saved(), [id]: el.open }));
  });
  return {
    el, box,
    setSummary(text, level = "neutral") {
      summaryText.textContent = text;
      summaryText.dataset.level = level;
      // Needs attention and the user never chose: show it, without recording that as a choice.
      if (saved()[id] === undefined && (level === "warn" || level === "bad") && !el.open) { programmatic = true; el.open = true; queueMicrotask(() => { programmatic = false; }); }
    },
  };
}

export const settingsTool = {
  id: "settings",
  icon: "⚙",
  title: t("設定"),
  open(body) {
    const claudeSection = makeSection("claude", "Claude Code");
    const audioSection = makeSection("audio", t("音声ツール"), "audio-tools-heading");
    const claudeBox = claudeSection.box;
    body.append(claudeSection.el, audioSection.el);

    let status = null;

    function copyButton(text) {
      return h("button", {
        type: "button", textContent: t("コピー"),
        onclick: async () => { await navigator.clipboard.writeText(text); toast(t("コピーしました"), { key: "copied" }); },
      });
    }

    async function recheck() {
      const res = await post("/api/claude/recheck");
      if (!res.ok) return toast((await res.json()).error, { key: "claude", kind: "error" });
      if (status) status.claude = await res.json();
      renderClaude();
      document.dispatchEvent(new CustomEvent("claude-status", { detail: status?.claude }));
      toast(status?.claude?.found ? t("Claude Code を検出しました({version})", { version: status.claude.version }) : t("まだ見つかりません"), {
        key: "claude", kind: status?.claude?.found ? "info" : "warn",
      });
    }

    /** Install help is shown only while the CLI is missing; the commands come from the server (official docs). */
    function renderClaude() {
      const claude = status?.claude;
      claudeSection.setSummary(!claude ? t("確認中…") : claude.found ? `✓ ${claude.version.split(" ")[0]}` : t("✗ 見つかりません"), !claude ? "neutral" : claude.found ? "ok" : "bad");
      const recheckBtn = h("button", { type: "button", textContent: t("再確認"), onclick: recheck });
      if (!claude) return claudeBox.replaceChildren(h("p", { className: "sec-note", textContent: t("確認中…") }));
      if (claude.found) {
        return claudeBox.replaceChildren(
          h("p", { className: "sec-note", textContent: `${claude.version} · ${claude.where}` }),
          recheckBtn,
        );
      }
      claudeBox.replaceChildren(
        h("p", { className: "bad", textContent: t("Claude Code が見つかりません") }),
        h("p", { className: "sec-note", textContent: t("次のコマンドで導入できます(公式の手順)。") }),
        ...claude.install.commands.map((c) => h("div", { className: "cmd" },
          h("span", { className: "sec-note", textContent: c.label }),
          h("pre", { textContent: c.command }),
          copyButton(c.command),
        )),
        h("a", { href: claude.install.docs, target: "_blank", rel: "noopener noreferrer", textContent: t("公式の導入手順を開く ↗") }),
        h("p", { className: "sec-note", textContent: t("導入したら「再確認」を押します。見つからないままなら、アプリを再起動してください(PATH は起動時に読み込まれます)。初回は claude を起動して、ブラウザでログインします(Pro / Max / Team / Enterprise / Console のいずれかが必要です)。") }),
        recheckBtn,
      );
    }

    async function load() {
      try {
        const res = await fetch("/api/server");
        if (res.ok) status = await res.json();
      } catch { /* the server may be restarting; keep the last status */ }
      renderClaude();
      if (status) document.dispatchEvent(new CustomEvent("claude-status", { detail: status.claude }));
    }

    // The audio tools (separation, beat analysis) have their own module.
    const audioPanel = createAudioToolsPanel(audioSection.box, audioSection);

    renderClaude();
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { clearInterval(timer); audioPanel.destroy(); };
  },
};

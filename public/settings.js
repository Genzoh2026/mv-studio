// The settings tool: server status plus restart and stop. Both end every running Claude session, so they ask first.
import { toast } from "/toast.js";
import { createAudioToolsPanel } from "/audio-tools-panel.js";
import { createVideoToolsPanel } from "/video-tools-panel.js";

const REFRESH_MS = 5000;
const SECTIONS_KEY = "mv-studio:settings-sections";

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
const RESTART_POLL_MS = 1000;
const RESTART_TIMEOUT_MS = 60_000;

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const post = (path) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatUptime(startedAt) {
  const minutes = Math.floor((Date.now() - startedAt) / 60_000);
  if (minutes < 1) return "1分未満";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}時間${minutes % 60}分` : `${minutes}分`;
}

export const settingsTool = {
  id: "settings",
  icon: "⚙",
  title: "設定",
  open(body) {
    const rows = h("dl", { className: "info" });
    const actions = h("div", { className: "panel-actions" });
    const note = h("p", { className: "sec-note" });
    const claudeSection = makeSection("claude", "Claude Code");
    const audioSection = makeSection("audio", "音声ツール", "audio-tools-heading");
    const videoSection = makeSection("video", "動画ツール", "video-tools-heading");
    const serverSection = makeSection("server", "サーバー");
    const claudeBox = claudeSection.box;
    serverSection.box.append(rows, actions, note);
    body.append(claudeSection.el, audioSection.el, videoSection.el, serverSection.el);

    let status = null;
    let confirming = null; // "restart" | "stop" | null
    let finished = false;  // the server was stopped or is restarting: stop polling it

    function copyButton(text) {
      return h("button", {
        type: "button", textContent: "コピー",
        onclick: async () => { await navigator.clipboard.writeText(text); toast("コピーしました", { key: "copied" }); },
      });
    }

    async function recheck() {
      const res = await post("/api/claude/recheck");
      if (!res.ok) return toast((await res.json()).error, { key: "claude", kind: "error" });
      if (status) status.claude = await res.json();
      renderClaude();
      document.dispatchEvent(new CustomEvent("claude-status", { detail: status?.claude }));
      toast(status?.claude?.found ? `Claude Code を検出しました(${status.claude.version})` : "まだ見つかりません", {
        key: "claude", kind: status?.claude?.found ? "info" : "warn",
      });
    }

    /** Install help is shown only while the CLI is missing; the commands come from the server (official docs). */
    function renderClaude() {
      const claude = status?.claude;
      claudeSection.setSummary(!claude ? "確認中…" : claude.found ? `✓ ${claude.version.split(" ")[0]}` : "✗ 見つかりません", !claude ? "neutral" : claude.found ? "ok" : "bad");
      const recheckBtn = h("button", { type: "button", textContent: "再確認", onclick: recheck });
      if (!claude) return claudeBox.replaceChildren(h("p", { className: "meta", textContent: "確認中…" }));
      if (claude.found) {
        return claudeBox.replaceChildren(
          h("p", { className: "sec-note", textContent: `${claude.version} · ${claude.where}` }),
          recheckBtn,
        );
      }
      claudeBox.replaceChildren(
        h("p", { className: "bad", textContent: "Claude Code が見つかりません" }),
        h("p", { className: "meta", textContent: "次のコマンドで導入できます(公式の手順)。" }),
        ...claude.install.commands.map((c) => h("div", { className: "cmd" },
          h("span", { className: "meta", textContent: c.label }),
          h("pre", { textContent: c.command }),
          copyButton(c.command),
        )),
        h("a", { href: claude.install.docs, target: "_blank", rel: "noopener noreferrer", textContent: "公式の導入手順を開く ↗" }),
        h("p", { className: "meta", textContent: "導入したら「再確認」を押します。見つからないままなら、アプリを再起動してください(PATH は起動時に読み込まれます)。初回は claude を起動して、ブラウザでログインします(Pro / Max / Team / Enterprise / Console のいずれかが必要です)。" }),
        recheckBtn,
      );
    }

    function renderInfo() {
      const s = status;
      const entries = s
        ? [
          ["稼働時間", formatUptime(s.startedAt)],
          ["ポート", String(s.port)],
          ["ワークスペース", s.workspace],
          ["実行中の Claude", s.sessions.length ? `${s.sessions.length} 個(${s.sessions.join("、")})` : "なし"],
        ]
        : [["状態", "読み込み中…"]];
      rows.replaceChildren(...entries.flatMap(([k, v]) => [h("dt", { textContent: k }), h("dd", { textContent: v })]));
      serverSection.setSummary(s ? `稼働 ${formatUptime(s.startedAt)} · :${s.port}${s.sessions.length ? ` · Claude ${s.sessions.length}` : ""}` : "確認中…", "neutral");
    }

    function renderActions() {
      if (finished) return actions.replaceChildren();
      if (confirming) {
        const count = status?.sessions.length ?? 0;
        const what = confirming === "restart" ? "再起動" : "停止";
        const impact = count ? `実行中の Claude ${count} 個が終了します。` : "";
        actions.replaceChildren(
          h("p", { textContent: `${impact}サーバーを${what}します。続けますか?` }),
          h("button", { type: "button", className: "danger", textContent: `${what}する`, onclick: () => run(confirming) }),
          h("button", { type: "button", textContent: "やめる", onclick: () => { confirming = null; renderActions(); } }),
        );
        return;
      }
      const restartBtn = h("button", { type: "button", textContent: "再起動", onclick: () => { confirming = "restart"; renderActions(); } });
      restartBtn.disabled = Boolean(status) && !status.supervised;
      actions.replaceChildren(
        restartBtn,
        h("button", { type: "button", textContent: "停止", onclick: () => { confirming = "stop"; renderActions(); } }),
      );
      note.textContent = status && !status.supervised
        ? "再起動は、start.cmd から起動したときだけ使えます(停止は使えます)。"
        : "";
    }

    async function load() {
      if (finished) return;
      try {
        const res = await fetch("/api/server");
        if (res.ok) status = await res.json();
      } catch { /* the server may be going down; keep the last status */ }
      renderInfo();
      renderClaude();
      if (status) document.dispatchEvent(new CustomEvent("claude-status", { detail: status.claude }));
      if (!confirming) renderActions();
    }

    async function run(kind) {
      const startedAt = status?.startedAt;
      const res = await post(`/api/server/${kind}`);
      const answer = await res.json();
      if (!res.ok) {
        confirming = null;
        renderActions();
        return toast(answer.error, { key: "server", kind: "error" });
      }
      finished = true;
      confirming = null;
      renderActions();
      if (kind === "stop") {
        rows.replaceChildren();
        note.textContent = "停止しました。もう一度使うには、start.cmd で起動してください。";
        return;
      }
      note.textContent = "再起動しています…(終わると、画面を自動で読み込み直します)";
      await waitForRestart(startedAt);
    }

    async function waitForRestart(oldStartedAt) {
      const deadline = Date.now() + RESTART_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(RESTART_POLL_MS);
        try {
          const res = await fetch("/api/server", { cache: "no-store" });
          // The old process may answer once more before it exits; a new start time means the new server is up.
          if (res.ok && (await res.json()).startedAt !== oldStartedAt) return location.reload();
        } catch { /* still down */ }
      }
      note.textContent = "再起動を確認できませんでした。start.cmd のウィンドウを確認してください。";
    }

    // The audio tools (separation, beat analysis) have their own module: status plus a one-button setup.
    const audioPanel = createAudioToolsPanel(audioSection.box, audioSection);
    const videoPanel = createVideoToolsPanel(videoSection.box, videoSection);

    renderInfo();
    renderClaude();
    renderActions();
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { clearInterval(timer); audioPanel.destroy(); videoPanel.destroy(); };
  },
};

// The settings tool: server status plus restart and stop. Both end every running Claude session, so they ask first.
import { toast } from "/toast.js";

const REFRESH_MS = 5000;
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
    const note = h("p", { className: "meta" });
    body.append(h("h4", { textContent: "サーバー" }), rows, actions, note);

    let status = null;
    let confirming = null; // "restart" | "stop" | null
    let finished = false;  // the server was stopped or is restarting: stop polling it

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

    renderInfo();
    renderActions();
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  },
};

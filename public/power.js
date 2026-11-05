// The power tool: whether the server is running, and restart / stop. Both end every running Claude session, so they ask first.
// It is a separate button at the bottom of the rail (away from the settings) so that it is not pressed by accident.
import { toast } from "/toast.js";
import { t } from "/i18n.js";

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
  if (minutes < 1) return t("1分未満");
  const hours = Math.floor(minutes / 60);
  return hours ? t("{h}時間{m}分", { h: hours, m: minutes % 60 }) : t("{m}分", { m: minutes });
}

export const powerTool = {
  id: "power",
  icon: "⏻",
  title: t("電源"),
  position: "bottom",
  open(body) {
    const rows = h("dl", { className: "info" });
    const actions = h("div", { className: "power-actions" });
    const note = h("p", { className: "sec-note" });
    body.append(h("div", { className: "sec" }, h("div", { className: "sec-body" }, rows)), actions, note);

    let status = null;
    let confirming = null; // "restart" | "stop" | null
    let finished = false;  // the server was stopped or is restarting: stop polling it

    function renderInfo() {
      const s = status;
      const entries = s
        ? [
          [t("稼働時間"), formatUptime(s.startedAt)],
          [t("ポート"), String(s.port)],
          [t("ワークスペース"), s.workspace],
          [t("実行中の Claude"), s.sessions.length ? t("{n} 個({names})", { n: s.sessions.length, names: s.sessions.join(t("、")) }) : t("なし")],
        ]
        : [[t("状態"), t("読み込み中…")]];
      rows.replaceChildren(...entries.flatMap(([k, v]) => [h("dt", { textContent: k }), h("dd", { textContent: v })]));
    }

    function action(label, what, kind, disabled = false) {
      const button = h("button", { type: "button", textContent: label, onclick: () => { confirming = kind; renderActions(); } });
      button.disabled = disabled;
      return h("div", { className: "power-action" }, button, h("span", { className: "sec-note", textContent: what }));
    }

    function renderActions() {
      if (finished) return actions.replaceChildren();
      if (confirming) {
        const count = status?.sessions.length ?? 0;
        const restart = confirming === "restart";
        const impact = count ? t("実行中の Claude {n} 個が終了します。", { n: count }) : "";
        actions.replaceChildren(h("div", { className: "vt-confirm" },
          h("p", { textContent: `${impact}${restart ? t("サーバーを再起動します。続けますか?") : t("サーバーを停止します。続けますか?")}` }),
          h("div", { className: "panel-actions" },
            h("button", { type: "button", className: "danger", textContent: restart ? t("再起動する") : t("停止する"), onclick: () => run(confirming) }),
            h("button", { type: "button", textContent: t("やめる"), onclick: () => { confirming = null; renderActions(); } }))));
        return;
      }
      const canRestart = !status || status.supervised;
      actions.replaceChildren(
        action(t("再起動"), t("新しいコードで起動し直します"), "restart", !canRestart),
        action(t("停止"), t("アプリを止めます"), "stop"),
      );
      note.textContent = status && !status.supervised ? t("再起動は、start.cmd から起動したときだけ使えます(停止は使えます)。") : "";
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
        note.textContent = t("停止しました。もう一度使うには、start.cmd で起動してください。");
        return;
      }
      note.textContent = t("再起動しています…(終わると、画面を自動で読み込み直します)");
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
      note.textContent = t("再起動を確認できませんでした。start.cmd のウィンドウを確認してください。");
    }

    renderInfo();
    renderActions();
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  },
};

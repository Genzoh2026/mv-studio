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
    const claudeBox = h("div", { className: "claude-box" });
    const audioBox = h("div", { className: "claude-box" });
    body.append(h("h4", { textContent: "Claude Code" }), claudeBox, h("h4", { textContent: "音声ツール(曲の分離・ビート解析)" }), audioBox, h("h4", { textContent: "サーバー" }), rows, actions, note);

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
      const recheckBtn = h("button", { type: "button", textContent: "再確認", onclick: recheck });
      if (!claude) return claudeBox.replaceChildren(h("p", { className: "meta", textContent: "確認中…" }));
      if (claude.found) {
        return claudeBox.replaceChildren(
          h("p", { className: "ok", textContent: `検出済み: ${claude.version}` }),
          h("p", { className: "meta", textContent: claude.where }),
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

    // ---- audio tools: what this computer has for separating songs and finding beats ----
    let audio = null;
    let audioKey = null;

    async function loadAudio(refresh = false) {
      try {
        const res = await fetch(`/api/audio-tools${refresh ? "?refresh=1" : ""}`);
        if (res.ok) audio = await res.json();
      } catch { /* the server may be restarting */ }
      renderAudio();
      document.dispatchEvent(new CustomEvent("audio-tools-changed"));
    }

    async function saveAudio(path, payload, message) {
      const res = await post(path, payload);
      const answer = await res.json();
      if (!res.ok) return toast(answer.error, { key: "audio-tools", kind: "error" });
      audio = answer;
      renderAudio(true);
      document.dispatchEvent(new CustomEvent("audio-tools-changed"));
      toast(message, { key: "audio-tools" });
    }

    function renderAudio(force = false) {
      const key = JSON.stringify(audio);
      if (!force && key === audioKey) return;
      audioKey = key;
      if (!audio) return audioBox.replaceChildren(h("p", { className: "meta", textContent: "確認中…(初回は数秒かかります)" }));
      const mark = (ok, text) => h("p", { className: ok ? "ok" : "bad", textContent: `${ok ? "✓" : "✗"} ${text}` });
      const pythonInput = h("input", { type: "text", placeholder: "Python の実行ファイルのパス(空欄 = 自動)", value: audio.pythonPath ?? "", style: "width: 100%" });
      const model = h("select", {}, ...["htdemucs", "htdemucs_ft"].map((m) => h("option", { value: m, selected: m === audio.model, textContent: m === "htdemucs" ? "htdemucs(標準・速い)" : "htdemucs_ft(高精度・約4倍遅い)" })));
      model.addEventListener("change", () => saveAudio("/api/audio-tools/model", { model: model.value }, `分離のモデルを ${model.value} にしました`));
      audioBox.replaceChildren(
        mark(audio.python.found, audio.python.found ? `Python ${audio.python.version}(${audio.python.where})` : "Python が見つかりません"),
        mark(Boolean(audio.numpy), audio.numpy ? `numpy ${audio.numpy}(ビート解析)` : "numpy がありません(ビート解析に必要)"),
        mark(Boolean(audio.demucs), audio.demucs ? `Demucs ${audio.demucs}(曲の分離)` : "Demucs がありません(曲の分離に必要)"),
        mark(audio.ffmpeg.found, audio.ffmpeg.found ? `ffmpeg ${audio.ffmpeg.version}` : "ffmpeg が見つかりません"),
        h("p", { className: "meta", textContent: audio.cuda ? "GPU(CUDA)が使えます。分離は速くなります。" : "GPU は使っていません(CPU で動きます。曲 1 分で数十秒〜数分)。" }),
        ...audio.install.flatMap((step) => [
          h("p", { className: "meta", textContent: step.label }),
          h("div", { className: "cmd" }, h("pre", { textContent: step.command }), copyButton(step.command)),
          ...(step.note ? [h("p", { className: "meta", textContent: step.note })] : []),
        ]),
        h("div", { className: "panel-actions" },
          h("button", { type: "button", textContent: "再確認", onclick: async () => { audio = null; renderAudio(true); await loadAudio(true); toast(audio?.ready.separate ? "分離とビート解析が使えます" : audio?.ready.beats ? "ビート解析が使えます(分離には Demucs が必要です)" : "まだ足りないものがあります", { key: "audio-tools", kind: audio?.ready.beats ? "info" : "warn" }); } }),
        ),
        h("p", { className: "meta", textContent: "別の Python を使う場合は、そのパスを指定します(Demucs を入れた環境など)。" }),
        pythonInput,
        h("div", { className: "panel-actions" },
          h("button", { type: "button", textContent: "このパスを使う", onclick: () => saveAudio("/api/audio-tools/python", { path: pythonInput.value.trim() || null }, pythonInput.value.trim() ? "Python のパスを保存しました" : "自動検出に戻しました") }),
          h("button", { type: "button", textContent: "自動に戻す", onclick: () => saveAudio("/api/audio-tools/python", { path: null }, "自動検出に戻しました") }),
        ),
        h("label", { className: "meta", textContent: "分離のモデル: " }, model),
      );
    }

    renderInfo();
    renderClaude();
    renderActions();
    renderAudio();
    load();
    loadAudio();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  },
};

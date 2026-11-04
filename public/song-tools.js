// What a song card gets for songs that have an audio file: separate into stems, analyse the beats, a progress line,
// the stems as children of the card, and the beat summary. The work itself runs on the server (Demucs and a small numpy
// script from the computer's own Python); this file only asks for it and shows where it stands.
import { toast } from "/toast.js";

const KIND_LABELS = { separate: "分離", beats: "ビート解析" };
// A job can finish in under a second; its result line stays this long so it is not missed.
const RECENT_DONE_MS = 8000;
const justFinished = (job) => job.state === "done" && Boolean(job.finishedAt) && Date.now() - job.finishedAt < RECENT_DONE_MS;
const tookText = (job) => (job.startedAt && job.finishedAt ? `(${((job.finishedAt - job.startedAt) / 1000).toFixed(1)} 秒)` : "");
// The settings tool is the first button of the left rail; opening it shows the one-button setup.
// It opens the panel if needed and brings the audio tools section (with the setup button) into view.
const openSettings = () => {
  const rail = document.querySelector(".rail-btn");
  if (rail && !rail.classList.contains("on")) rail.click();
  setTimeout(() => {
    const heading = document.getElementById("audio-tools-heading");
    heading?.closest("details")?.setAttribute("open", ""); // the section may be folded
    heading?.scrollIntoView({ block: "start" });
  }, 200);
};

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const post = (path, payload) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

/** @param {{getProject: () => string}} options */
export function createSongTools({ getProject }) {
  let tools = null;     // what /api/audio-tools said last (null until the first answer)
  let jobs = [];
  const lines = new Map(); // song base -> its progress line, updated in place so a playing song is never redrawn
  const dismissed = new Set();
  const confirming = new Map(); // base -> song, while the card asks whether to separate before analysing

  const jobsOf = (base) => jobs.filter((job) => job.base === base);
  // Until the first answer is in, assume the tool is there, so a button does not flash "needs setup" at every start.
  const missing = (kind) => Boolean(tools) && !tools.ready[kind === "separate" ? "separate" : "beats"];

  async function loadTools() {
    try {
      const res = await fetch("/api/audio-tools");
      if (res.ok) tools = await res.json();
    } catch { /* the server may be restarting */ }
  }

  document.addEventListener("audio-tools-changed", loadTools);

  async function start(song, kind) {
    const label = KIND_LABELS[kind];
    if (!tools) await loadTools();
    if (missing(kind)) {
      // Do not just say it is missing: open the place where one button fixes it.
      openSettings();
      return toast(`${label}には、音声ツールの導入が必要です。設定を開きました。「音声ツールを導入する」ボタンを押すと、自動で入ります(約 0.7 GB)。`, { key: "song-tool", kind: "warn", action: { label: "設定を開く", run: openSettings } });
    }
    // Beats work without stems but are rougher: say so and let the user choose.
    if (kind === "beats" && !song.stems?.length) {
      confirming.set(song.base, song);
      return renderLine(song.base);
    }
    await begin(song, kind);
  }

  /** Queues the job on the server. `then` = "beats" makes a separation continue into the analysis by itself. */
  async function begin(song, kind, then = null) {
    confirming.delete(song.base);
    const res = await post("/api/songs/process", { pj: getProject(), base: song.base, kind, ...(then ? { then } : {}) });
    const answer = await res.json();
    renderLine(song.base);
    if (!res.ok) return toast(answer.error, { key: "song-tool", kind: "error" });
    dismissed.delete(answer.id);
    jobs = [...jobs.filter((job) => job.id !== answer.id), answer];
    renderLine(song.base);
    document.dispatchEvent(new CustomEvent("jobs-changed")); // the bottom bar looks right away instead of at its next check
    toast(then ? `「${song.title}」を分離して、続けてビート解析します。画面を閉じても進みます。` : `「${song.title}」の${KIND_LABELS[kind]}を始めました。終わるとここに結果が出ます。`, { key: "song-tool" });
  }

  /** The question shown in the card: separating first makes the snare and hat times better. */
  function confirmRow(song) {
    const needsSetup = missing("separate");
    return h("div", { className: "job confirm" },
      h("span", { textContent: "分離していない曲です。先に声・ドラムなどを分離すると、スネアやハイハットの時刻の精度が上がります(分離は数分かかります)。どうしますか?" }),
      h("button", { type: "button", className: "primary", textContent: needsSetup ? "分離してから解析(要導入)" : "分離してから解析", onclick: () => (needsSetup ? start(song, "separate") : begin(song, "separate", "beats")) }),
      h("button", { type: "button", textContent: "このまま解析", title: "分離せずに、全体の音から解析します(スネア・ハイハットはやや粗くなります)", onclick: () => begin(song, "beats") }),
      h("button", { type: "button", textContent: "やめる", onclick: () => { confirming.delete(song.base); renderLine(song.base); } }),
    );
  }

  const button = (text, title, onclick, props = {}) => h("button", { type: "button", className: "dl", textContent: text, title, onclick, ...props });

  /** The buttons for a song card's header (only for songs that have an audio file). */
  function buttons(song) {
    if (!song.path) return [];
    const stemsDone = song.stems?.length > 0;
    const busy = (kind) => jobsOf(song.base).some((job) => job.kind === kind && ["queued", "running"].includes(job.state));
    return [
      stemsDone
        ? h("span", { className: "badge", textContent: "分離済み", title: "ステムは、下の「ステム」で聴けます" })
        : button(missing("separate") ? "🎚 声・楽器に分離(要導入)" : "🎚 声・楽器に分離", missing("separate") ? "音声ツールの導入が必要です。押すと、導入の画面を開きます" : "曲を 声 / ドラム / ベース / その他 に分けます(この PC で実行。数分かかります)", () => start(song, "separate"), { disabled: busy("separate"), className: missing("separate") ? "dl needs-setup" : "dl" }),
      button(
        (song.beats && !song.beats.error ? "🔁 ビートを再解析" : "🥁 ビート解析") + (missing("beats") ? "(要導入)" : ""),
        missing("beats") ? "音声ツールの導入が必要です。押すと、導入の画面を開きます" : stemsDone ? "ドラムのステムを使って、キック・スネア・ハイハットの時刻を求めます" : "キック・スネア・ハイハットの時刻とテンポを求めます。先に「分離」すると、より正確になります",
        () => start(song, "beats"), { disabled: busy("beats"), className: missing("beats") ? "dl needs-setup" : "dl" },
      ),
    ];
  }

  function renderLine(base) {
    const el = lines.get(base);
    if (!el) return;
    const shown = jobsOf(base).filter((job) => !dismissed.has(job.id) && (["queued", "running", "error"].includes(job.state) || justFinished(job)));
    const ask = confirming.get(base);
    el.hidden = shown.length === 0 && !ask;
    el.replaceChildren(...(ask ? [confirmRow(ask)] : []), ...shown.map((job) => {
      const label = KIND_LABELS[job.kind];
      const row = h("div", { className: `job ${job.state}` });
      if (job.state === "done") {
        row.append(h("span", { textContent: `✓ ${label}が終わりました ${tookText(job)}${job.then ? "。続けてビート解析します" : ""}` }));
      } else if (job.state === "error") {
        row.append(h("span", { textContent: `${label}に失敗しました: ${job.error}` }),
          h("button", { type: "button", textContent: "✕", title: "閉じる", onclick: async () => { dismissed.add(job.id); await post("/api/jobs/dismiss", { id: job.id }); renderLine(base); } }));
      } else {
        const text = (job.state === "queued" ? `${label}: 順番待ち…` : `${label}中… ${job.progress}%`) + (job.then ? "(終わると、続けてビート解析)" : "");
        row.append(h("progress", { max: 100, value: job.state === "running" ? job.progress : 0 }), h("span", { textContent: text }),
          h("button", { type: "button", textContent: "取り消し", onclick: async () => { await post("/api/jobs/cancel", { id: job.id }); await refresh(); } }));
      }
      return row;
    }));
  }

  /** An (initially empty) progress line for a card; refresh() fills it in place. */
  function line(song) {
    const el = h("div", { className: "job-line", hidden: true });
    lines.set(song.base, el);
    renderLine(song.base);
    return el;
  }

  async function refresh() {
    if (!tools) await loadTools();
    try {
      const res = await fetch(`/api/jobs?pj=${encodeURIComponent(getProject())}`);
      if (res.ok) jobs = await res.json();
    } catch { /* keep the last list */ }
    for (const base of lines.keys()) renderLine(base);
  }

  /** The four stems as children of the song card. Null when the song has none. */
  function stemsPanel(song) {
    if (!song.stems?.length) return null;
    const box = h("details", { className: "stems" }, h("summary", { textContent: `ステム(${song.stems.map((s) => s.label).join("・")})` }));
    for (const stem of song.stems) {
      const audio = h("audio", { controls: true, preload: "none", src: `/file?pj=${encodeURIComponent(getProject())}&p=${encodeURIComponent(stem.path)}` });
      box.append(h("div", { className: "stem" }, h("span", { className: "stem-label", textContent: stem.label }), audio));
    }
    return box;
  }

  /** The "ビート" row of the detail panel, or null. The tempo is labelled as an estimate on purpose. */
  function beatsText(song) {
    const b = song.beats;
    if (!b) return null;
    if (b.error) return `ビート解析ファイルを読めません: ${b.error}`;
    const tempo = b.bpm === null ? "テンポ不明" : `BPM 約${Math.round(b.bpm)}(推定${b.bpmAlternatives.length ? `。別の候補: ${b.bpmAlternatives.map(Math.round).join("・")}` : ""})`;
    return [tempo, `キック ${b.kick} / スネア ${b.snare} / ハイハット ${b.hat}`, b.usedDrumsStem ? "ドラムのステムで解析" : "全体の音から解析(分離すると、より正確)"].join(" · ");
  }

  /** What makes a card out of date: finished results change it, progress does not (so playback is not interrupted). */
  // The labels depend on whether the tools are there, so a change of that redraws the cards too.
  const cardKey = (song) => [song.stems?.length ?? 0, song.beats?.mtime ?? song.beats?.error ?? null, missing("separate"), missing("beats")];

  function resetLines() { lines.clear(); }

  return { buttons, line, refresh, stemsPanel, beatsText, cardKey, resetLines };
}

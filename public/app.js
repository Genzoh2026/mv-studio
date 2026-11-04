import { createDraftsTab } from "/drafts.js";
import { createMediaLibrary } from "/media-library.js";
import { attachDropZone, uploadFiles } from "/upload.js";
import { toast } from "/toast.js";
import { createRail } from "/rail.js";
import { settingsTool } from "/settings.js";
import { trashTool } from "/trash.js";

const $ = (id) => document.getElementById(id);
const libraryBox = $("library");
const songsBox = $("songs");

// The library shows every project; opening one attaches the terminal to that project's Claude session.
let projects = [];
let attached = ""; // project whose Claude session the terminal shows (kept when going back to the library)
let viewing = "";  // project whose songs are shown; "" means the library

// ---- terminal ----
const term = new Terminal({ fontSize: 14, cursorBlink: true, theme: { background: "#14161a" } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("term"));
term.write("プロジェクトを開くと、ここで Claude が起動します。\r\n");
let ws = null;
const CLAUDE_MISSING_CLOSE_CODE = 4004; // the server already printed install help into the terminal

const sendSize = (cols = term.cols, rows = term.rows) => ws?.readyState === 1 && ws.send(`\u0000resize:${cols},${rows}`);
term.onData((data) => ws?.readyState === 1 && ws.send(data));
term.onResize(() => sendSize());
addEventListener("resize", () => fit.fit());

function connect(pj) {
  ws?.close(); // detaches only; the session keeps running on the server
  term.reset();
  const socket = new WebSocket(`ws://${location.host}/term?pj=${encodeURIComponent(pj)}`);
  ws = socket;
  socket.onopen = () => {
    fit.fit();
    // A reattached TUI only redraws on a size change, so nudge it.
    sendSize(Math.max(term.cols - 1, 1), term.rows);
    setTimeout(() => sendSize(), 80);
  };
  socket.onmessage = (event) => term.write(event.data);
  socket.onclose = (event) => { if (ws === socket && event.code !== CLAUDE_MISSING_CLOSE_CODE) term.write("\r\n[session closed - open the project again to restart]\r\n"); };
  attached = pj;
}

// ---- splitter: drag the border to resize the terminal; the width is remembered ----
const SPLIT_KEY = "mv-studio:left-width";
const DEFAULT_LEFT_PERCENT = 38;
const MIN_LEFT_PX = 320;
const MIN_RIGHT_PX = 420;
const SPLITTER_PX = 8;
const KEY_STEP_PX = 24;
const splitter = $("splitter");
let fitFrame = 0;

function setLeftWidth(px) {
  const railPx = $("rail").getBoundingClientRect().width;
  const max = Math.max(innerWidth - railPx - SPLITTER_PX - MIN_RIGHT_PX, MIN_LEFT_PX);
  const clamped = Math.min(Math.max(px, MIN_LEFT_PX), max);
  document.body.style.setProperty("--left", `${clamped}px`);
  // Refit once per frame: the terminal must follow the new width without re-rendering on every pixel.
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => fit.fit());
  return clamped;
}

const savedWidth = Number(localStorage.getItem(SPLIT_KEY));
if (savedWidth > 0) setLeftWidth(savedWidth);
const currentLeft = () => $("term").getBoundingClientRect().width;

splitter.addEventListener("pointerdown", (event) => {
  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add("drag");
  document.body.classList.add("dragging");
});
splitter.addEventListener("pointermove", (event) => {
  if (splitter.hasPointerCapture(event.pointerId)) setLeftWidth(event.clientX - $("rail").getBoundingClientRect().width);
});
splitter.addEventListener("pointerup", (event) => {
  splitter.releasePointerCapture(event.pointerId);
  splitter.classList.remove("drag");
  document.body.classList.remove("dragging");
  localStorage.setItem(SPLIT_KEY, String(Math.round(currentLeft())));
});
splitter.addEventListener("dblclick", () => {
  document.body.style.removeProperty("--left");
  localStorage.removeItem(SPLIT_KEY);
  requestAnimationFrame(() => fit.fit());
});
splitter.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const next = setLeftWidth(currentLeft() + (event.key === "ArrowRight" ? KEY_STEP_PX : -KEY_STEP_PX));
  localStorage.setItem(SPLIT_KEY, String(Math.round(next)));
});
addEventListener("resize", () => { if (savedWidth > 0 || document.body.style.getPropertyValue("--left")) setLeftWidth(currentLeft()); });

// ---- tool rail: add future tools to this list ----
createRail({
  rail: $("rail"),
  panel: $("rail-panel"),
  handle: $("rail-handle"),
  tools: [settingsTool, trashTool],
  onLayout: () => fit.fit(),
});

// ---- library ----
const nameParts = (name) => {
  const m = /^(\d{4})(\d{2})(\d{2})-(.*)$/.exec(name);
  return m ? { date: `${m[2]}/${m[3]}`, title: m[4] } : { date: "", title: name };
};

let libraryKey = null;
const selected = new Set(); // projects ticked for deletion
let confirming = false;

async function loadLibrary() {
  const res = await fetch("/api/pjs");
  if (!res.ok) return;
  projects = await res.json();
  const key = JSON.stringify(projects);
  if (key === libraryKey) return;
  libraryKey = key;
  // Forget ticks for projects that vanished or started running meanwhile.
  for (const name of [...selected]) {
    const p = projects.find((x) => x.name === name);
    if (!p || p.running) selected.delete(name);
  }
  renderLibrary();
  renderBar();
}

// ---- delete: tick projects, confirm, move them to _Trash (never deleted for good) ----
function renderBar() {
  const bar = $("lib-bar");
  bar.hidden = selected.size === 0;
  if (bar.hidden) { confirming = false; return; }
  const text = document.createElement("span");
  const buttons = [];
  if (confirming) {
    text.textContent = `次の ${selected.size} 件を workspace\\_Trash へ移動します(完全には削除されません): ${[...selected].join("、")}`;
    buttons.push(button("移動する", moveSelectedToTrash, "danger"), button("やめる", () => { confirming = false; renderBar(); }));
  } else {
    text.textContent = `${selected.size} 件を選択中`;
    buttons.push(button("ゴミ箱へ移動", () => { confirming = true; renderBar(); }, "danger"), button("選択解除", clearSelection));
  }
  bar.replaceChildren(text, ...buttons);
}

function button(label, onClick, extraClass = "") {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.className = extraClass;
  el.addEventListener("click", onClick);
  return el;
}

function clearSelection() {
  selected.clear();
  confirming = false;
  renderLibrary();
  renderBar();
}

async function moveSelectedToTrash() {
  const names = [...selected];
  const res = await fetch("/api/pjs/trash", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ names }),
  });
  const body = await res.json();
  if (!res.ok) { toast(body.error, { kind: "error" }); return; }
  if (body.moved.includes(attached)) attached = "";
  if (body.failed.length) {
    toast(`移動できなかった PJ: ${body.failed.map((f) => `${f.name}(${f.error})`).join("、")}`, { key: "trash-failed", kind: "error" });
  }
  if (body.moved.length) {
    toast(`${body.moved.length} 件を workspace\\_Trash へ移動しました(左端のゴミ箱から戻せます)`, { key: "trash-done" });
  }
  selected.clear();
  confirming = false;
  libraryKey = null;
  await loadLibrary();
  renderBar();
}

function renderLibrary() {
  const q = $("lib-filter").value.trim().toLowerCase();
  const shown = projects.filter((p) => p.name.toLowerCase().includes(q));
  if (!projects.length) {
    return libraryBox.replaceChildren(note("プロジェクトがありません。右上の「+ 新規」で作成してください。"));
  }
  if (!shown.length) return libraryBox.replaceChildren(note("該当する PJ がありません。"));
  const grid = document.createElement("div");
  grid.className = "grid";
  grid.append(...shown.map(projectCard));
  libraryBox.replaceChildren(grid);
}

function note(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

function projectCard(project) {
  const { date, title } = nameParts(project.name);
  const el = document.createElement("div");
  el.className = "pj-card";
  el.tabIndex = 0;
  el.role = "button";
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (project.cover) {
    const img = document.createElement("img");
    img.src = project.cover;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    thumb.append(img);
  } else thumb.textContent = "♪";
  const name = document.createElement("div");
  name.className = "pj-name";
  name.textContent = title;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [date, `${project.songs}曲`].filter(Boolean).join(" · ");
  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.className = "pick";
  pick.checked = selected.has(project.name);
  pick.disabled = project.running;
  pick.title = project.running ? "実行中は削除できません。先に「終了」してください" : "削除する PJ として選択";
  pick.setAttribute("aria-label", `${title} を選択`);
  pick.addEventListener("click", (event) => event.stopPropagation());
  pick.addEventListener("change", () => {
    if (pick.checked) selected.add(project.name); else selected.delete(project.name);
    confirming = false;
    renderBar();
  });
  thumb.append(pick);
  el.append(thumb, name, meta);
  if (project.running) {
    const row = document.createElement("div");
    row.className = "running";
    const dot = document.createElement("span");
    dot.textContent = "● 実行中";
    const end = document.createElement("button");
    end.type = "button";
    end.textContent = "終了";
    end.title = "この PJ の Claude を終了する";
    end.addEventListener("click", (event) => { event.stopPropagation(); endSession(project.name); });
    row.append(dot, end);
    el.append(row);
  }
  el.addEventListener("click", () => openProject(project.name));
  el.addEventListener("keydown", (event) => { if (event.key === "Enter") openProject(project.name); });
  return el;
}

async function endSession(pj) {
  await fetch("/api/sessions/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pj }),
  });
  libraryKey = null;
  await loadLibrary();
}

// ---- songs of the opened project; re-render only on change so playback is not interrupted ----
let songsKey = null;

async function refreshSongs() {
  if (!viewing) return;
  const res = await fetch(`/api/songs?pj=${encodeURIComponent(viewing)}`);
  if (!res.ok) return;
  const songs = await res.json();
  shownSongs = songs;
  const bases = new Set(songs.map((s) => s.base));
  for (const base of selectedSongs) if (!bases.has(base)) selectedSongs.delete(base);
  renderSongsBar();
  const key = viewing + JSON.stringify(songs.map((s) => [s.base, s.path ?? s.sunoId, s.mtime, s.analysis?.mtime ?? s.analysis?.error, s.timings?.mtime ?? s.timings?.error]));
  if (key === songsKey) return;
  songsKey = key;
  songChecks.clear();
  if (!songs.length) {
    return songsList.replaceChildren(note("曲はまだありません。ここへ曲(mp3・wav・m4a・ogg)をドラッグ&ドロップするか、左の Claude に「Suno で曲を作って、試聴用に保存して」と頼んでください。"));
  }
  songsList.replaceChildren(...songs.map(songCard));
}

// Adding songs from outside the app (a file already on this computer): drop them on the tab or pick them.
const MAX_SONG_FILES = 10;
const MAX_SONG_BYTES = 200 * 1024 * 1024;
const songsList = document.createElement("div");
const songsDrop = Object.assign(document.createElement("div"), { className: "img-drop", hidden: true, textContent: "ここにドロップして追加" });
const songsPicker = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true, accept: "audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.wav,.m4a,.ogg" });
const songsAdd = Object.assign(document.createElement("button"), { type: "button", textContent: "+ 曲を追加", onclick: () => songsPicker.click() });
const songsProgress = Object.assign(document.createElement("span"), { className: "meta" });
const songsToolbar = Object.assign(document.createElement("div"), { className: "img-toolbar" });
songsToolbar.append(songsAdd, songsProgress, songsPicker);
const songsBar = Object.assign(document.createElement("div"), { className: "img-bar", hidden: true });
songsBox.append(songsToolbar, songsBar, songsList, songsDrop);

// ---- choosing songs for the trash (the list is not redrawn on a click, so a playing song keeps playing) ----
const selectedSongs = new Set(); // base paths under Output, e.g. "song/x"
let shownSongs = [];
let lastPickedSong = -1;
let confirmingSongs = false;
const songChecks = new Map();    // base -> its checkbox, so a range click can tick the others without redrawing

function pickSong(song, event) {
  const index = shownSongs.findIndex((s) => s.base === song.base);
  const range = event.shiftKey && lastPickedSong >= 0
    ? shownSongs.slice(Math.min(lastPickedSong, index), Math.max(lastPickedSong, index) + 1)
    : [song];
  const on = songChecks.get(song.base).checked;
  for (const s of range) {
    if (on) selectedSongs.add(s.base); else selectedSongs.delete(s.base);
    const box = songChecks.get(s.base);
    if (box) { box.checked = on; box.closest(".song")?.classList.toggle("selected", on); }
  }
  lastPickedSong = index;
  confirmingSongs = false;
  renderSongsBar();
}

function renderSongsBar() {
  const count = selectedSongs.size;
  songsBar.hidden = count === 0;
  if (!count) { confirmingSongs = false; return songsBar.replaceChildren(); }
  const button = (textContent, onclick, className = "") => Object.assign(document.createElement("button"), { type: "button", textContent, onclick, className });
  const text = (textContent) => Object.assign(document.createElement("span"), { textContent });
  if (confirmingSongs) {
    return songsBar.replaceChildren(
      text(`${count} 曲を、付随ファイル(Suno 情報・解析・歌詞など)ごと workspace\\_Trash へ移動します。完全には削除されません。続けますか?`),
      button("ごみ箱へ移動", trashSelectedSongs, "danger"),
      button("やめる", () => { confirmingSongs = false; renderSongsBar(); }),
    );
  }
  songsBar.replaceChildren(
    text(`${count} 曲を選択中`),
    button("ごみ箱へ…", () => { confirmingSongs = true; renderSongsBar(); }),
    button("選択を解除", () => {
      selectedSongs.clear();
      confirmingSongs = false;
      for (const box of songChecks.values()) { box.checked = false; box.closest(".song")?.classList.remove("selected"); }
      renderSongsBar();
    }),
  );
}

async function trashSelectedSongs() {
  const target = viewing;
  const res = await fetch("/api/songs/trash", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pj: target, bases: [...selectedSongs] }),
  });
  const answer = await res.json();
  if (!res.ok) return toast(answer.error, { key: "song-trash", kind: "error" });
  // The server names a moved song by its file stem; drop every selected path that ends in one.
  for (const stem of answer.moved) for (const base of [...selectedSongs]) if (base === stem || base.endsWith(`/${stem}`)) selectedSongs.delete(base);
  confirmingSongs = false;
  if (answer.moved.length) toast(`${answer.moved.length} 曲をゴミ箱へ移動しました(左端のゴミ箱から戻せます)`, { key: "song-trash" });
  if (answer.failed.length) toast(`移動できませんでした: ${answer.failed.map((f) => `${f.name}(${f.error})`).join("、")}`, { key: "song-trash-failed", kind: "error" });
  if (viewing === target) { songsKey = null; await refreshSongs(); }
}

async function addSongs(files) {
  const target = viewing;
  if (!target) return;
  await uploadFiles({
    files, unit: "曲", maxFiles: MAX_SONG_FILES, maxBytes: MAX_SONG_BYTES, toastKey: "song",
    urlFor: (name) => `/api/songs/upload?pj=${encodeURIComponent(target)}&name=${encodeURIComponent(name)}`,
    onProgress: (remaining) => { songsProgress.textContent = remaining ? `追加中… 残り ${remaining} 曲` : ""; },
  });
  if (viewing === target) { songsKey = null; await refreshSongs(); }
}
songsPicker.addEventListener("change", () => { addSongs(songsPicker.files); songsPicker.value = ""; });
attachDropZone(songsBox, songsDrop, addSongs);

function songCard(song) {
  const el = document.createElement("section");
  el.className = "song";
  const head = document.createElement("div");
  head.className = "song-head";
  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.className = "song-pick";
  pick.title = "選択(Shift で範囲選択)";
  pick.setAttribute("aria-label", `${song.title} を選択`);
  pick.checked = selectedSongs.has(song.base);
  el.classList.toggle("selected", pick.checked);
  songChecks.set(song.base, pick);
  pick.addEventListener("click", (event) => pickSong(song, event));
  const title = document.createElement("h2");
  title.textContent = song.title;
  head.append(pick, title);
  if (!song.path) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "試聴(未ダウンロード)";
    head.append(badge);
  }
  if (!song.path && song.name) head.append(downloadButton(song));
  if (song.sunoId) head.append(analyzeButton(song));
  if (song.detail.duration) {
    const dur = document.createElement("span");
    dur.className = "meta dur";
    dur.textContent = `${Math.round(song.detail.duration)}秒`;
    head.append(dur);
  }
  el.append(head, player(song));
  const details = detailsPanel(song);
  if (details) el.append(details);
  return el;
}

/** Puts a one-line, tagged request for exactly this song into Claude's input. Enter stays with the user (a download may spend a credit). */
function downloadButton(song) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dl";
  button.textContent = "⬇ ダウンロードを頼む";
  button.title = "この曲の mp3 を、Claude に取得して保存してもらいます(ダウンロード枠を使うことがあります)";
  button.addEventListener("click", async () => {
    if (!claudeReady) {
      return toast("Claude Code が見つかりません。左端の ⚙ 設定に導入方法があります。", { key: "dl", kind: "error" });
    }
    const name = song.name;
    const text = `【ダウンロード】曲「${name}」(Output/song/${name}.suno.json)を Suno から mp3 でダウンロードして、Output/song/${name}.mp3 に保存してください。ダウンロード枠を使う場合は、実行する前に、私に確認してください。`;
    try {
      await typeToTerminal(text);
      toast("ターミナルにダウンロードの依頼を入力しました。内容を確認して、左の Enter キーで送信してください。", { key: "dl" });
    } catch (err) {
      toast(`ターミナルに入力できませんでした: ${err.message}`, { key: "dl", kind: "error" });
    }
  });
  return button;
}

/** One-line, tagged request to analyse this song (beats, key, sections, word timings). Analysis spends no credit. */
function analyzeButton(song) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dl";
  const done = song.analysis && !song.analysis.error && song.timings && !song.timings.error;
  button.textContent = done ? "🔁 解析をやり直す" : "🎼 解析を頼む";
  button.title = "ビート・キー・セクションと、歌詞の単語ごとのタイミングを Claude に取得して保存してもらいます(生成枠は使いません)";
  button.addEventListener("click", async () => {
    if (!claudeReady) {
      return toast("Claude Code が見つかりません。左端の ⚙ 設定に導入方法があります。", { key: "an", kind: "error" });
    }
    // Downloaded songs are named by their file; a preview-only song by its .suno.json.
    const name = song.name ?? song.title;
    const text = `【解析】曲「${name}」(Output/song/${name}.suno.json)をビート解析と歌詞タイミングの取得で解析して、Output/song/${name}.analysis.json と Output/song/${name}.lyrics.json に保存してください。`;
    try {
      await typeToTerminal(text);
      toast("ターミナルに解析の依頼を入力しました。内容を確認して、左の Enter キーで送信してください。", { key: "an" });
    } catch (err) {
      toast(`ターミナルに入力できませんでした: ${err.message}`, { key: "an", kind: "error" });
    }
  });
  return button;
}

/** "解析" row text for the detail panel, or null when the song has not been analysed. */
function analysisText(song) {
  const parts = [];
  const a = song.analysis;
  if (a?.error) parts.push(`ビート解析ファイルを読めません: ${a.error}`);
  else if (a) {
    parts.push([
      a.bpm !== null && `BPM ${a.bpm}`,
      a.key,
      a.timeSignature !== null && `${a.timeSignature}拍子`,
      `${a.sections}セクション`,
      `${a.beats}拍`,
    ].filter(Boolean).join(" · "));
  }
  const t = song.timings;
  if (t?.error) parts.push(`歌詞タイミングを読めません: ${t.error}`);
  else if (t) parts.push(`歌詞タイミング ${t.words}語`);
  return parts.length ? parts.join(" / ") : null;
}

function player(song) {
  if (song.path) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = `/file?pj=${encodeURIComponent(viewing)}&p=${encodeURIComponent(song.path)}`;
    return audio;
  }
  // Not downloaded yet: listen through Suno's own embed (no download credit is spent).
  const frame = document.createElement("iframe");
  frame.src = `https://suno.com/embed/${song.sunoId}`;
  frame.allow = "autoplay";
  frame.sandbox = "allow-scripts allow-same-origin allow-popups";
  frame.loading = "lazy";
  return frame;
}

/** Collapsed "詳細": style, what was requested, creation time, lyrics, link to Suno. Null when there is nothing to show. */
function detailsPanel(song) {
  const d = song.detail;
  const created = d.createdAt ? new Date(d.createdAt).toLocaleString("ja-JP") : null;
  const rows = [
    ["スタイル", d.style],
    ["作成", [created, d.kind].filter(Boolean).join(" · ") || null],
    ["解析", analysisText(song)],
  ].filter(([, value]) => value);
  if (!rows.length && !d.settings.length && !d.lyrics && !song.sunoId) return null;

  const box = document.createElement("details");
  box.className = "detail";
  const summary = document.createElement("summary");
  summary.textContent = "詳細";
  const list = document.createElement("dl");
  for (const [label, value] of rows) list.append(...defRow(label, value));
  if (d.settings.length) {
    // Written by Claude at creation time; Suno cannot return these afterwards.
    list.append(...defRow("生成時の指定", d.settings.map(([k, v]) => `${k}: ${v}`).join(" / ")));
  }
  box.append(summary, list);
  if (d.lyrics) {
    const label = document.createElement("div");
    label.className = "meta";
    label.textContent = "歌詞";
    const pre = document.createElement("pre");
    pre.className = "lyrics";
    pre.textContent = d.lyrics;
    box.append(label, pre);
  }
  if (song.sunoId) {
    const link = document.createElement("a");
    link.href = `https://suno.com/song/${song.sunoId}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Suno で開く ↗";
    box.append(link);
  }
  return box;
}

function defRow(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
}

// ---- navigation ----
// Inside a project there are two tabs: the drafting space and the songs.
let tab = "songs";
// Puts a line into the project's Claude input and focuses the terminal. Enter stays with the user.
async function typeToTerminal(text) {
  const res = await fetch("/api/sessions/type", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pj: viewing, text }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  term.focus();
}

// Whether the Claude CLI is installed; the settings panel shows how to install it when it is not.
let claudeReady = true;
const RAIL_POLL_MS = 10_000;
function setClaudeStatus(claude) {
  claudeReady = !claude || claude.found;
  document.querySelector(".rail-btn")?.classList.toggle("alert", !claudeReady);
}
document.addEventListener("claude-status", (event) => setClaudeStatus(event.detail));
async function pollClaudeStatus() {
  try {
    const res = await fetch("/api/server", { cache: "no-store" });
    if (res.ok) setClaudeStatus((await res.json()).claude);
  } catch { /* the server may be restarting */ }
}
pollClaudeStatus();
setInterval(pollClaudeStatus, RAIL_POLL_MS);

const draftsTab = createDraftsTab({ root: $("drafts"), getProject: () => viewing, typeToTerminal, isClaudeReady: () => claudeReady });

// A link in one library's provenance panel can point into the other one.
const libraries = {
  image: createMediaLibrary({ root: $("images"), getProject: () => viewing, kind: "image", openOther: (kind, name) => showLibraryFile(kind, name) }),
  video: createMediaLibrary({ root: $("videos"), getProject: () => viewing, kind: "video", openOther: (kind, name) => showLibraryFile(kind, name) }),
};
const tabOfKind = { image: "images", video: "videos" };
function showLibraryFile(kind, name) {
  showTab(tabOfKind[kind]);
  libraries[kind].openByName(name);
}
// The panes inside a project, by the data-tab of their button.
const tabBoxes = { drafts: $("drafts"), songs: songsBox, images: $("images"), videos: $("videos") };

function showTab(next) {
  tab = next;
  for (const button of document.querySelectorAll("#tabs button")) button.classList.toggle("on", button.dataset.tab === next);
  for (const [id, box] of Object.entries(tabBoxes)) box.hidden = id !== next;
  songsKey = null;
  selectedSongs.clear();
  confirmingSongs = false;
  lastPickedSong = -1;
  renderSongsBar();
  libraries.image.reset();
  libraries.video.reset();
  refreshActiveTab();
}

const refreshers = { songs: () => refreshSongs(), images: () => libraries.image.refresh(), videos: () => libraries.video.refresh(), drafts: () => draftsTab.refresh() };
const refreshActiveTab = () => refreshers[tab]();

function showLibrary() {
  viewing = "";
  $("lib-header").hidden = false;
  libraryBox.hidden = false;
  $("pj-header").hidden = true;
  $("tabs").hidden = true;
  for (const box of Object.values(tabBoxes)) box.hidden = true;
  libraryKey = null;
  loadLibrary();
}

function openProject(pj, preferredTab) {
  // Only a different project restarts the terminal view; the same one just shows its running session.
  if (pj !== attached) connect(pj);
  viewing = pj;
  $("pj-title").textContent = pj;
  $("lib-header").hidden = true;
  libraryBox.hidden = true;
  $("pj-header").hidden = false;
  $("tabs").hidden = false;
  // A project with songs opens on its songs; an empty one opens on the drafting space.
  showTab(preferredTab ?? (projects.find((p) => p.name === pj)?.songs ? "songs" : "drafts"));
}

for (const button of document.querySelectorAll("#tabs button")) button.addEventListener("click", () => showTab(button.dataset.tab));

$("back").addEventListener("click", showLibrary);
$("lib-filter").addEventListener("input", renderLibrary);

$("new-pj").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("new-name");
  const res = await fetch("/api/pjs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.value.trim() }),
  });
  const body = await res.json();
  if (!res.ok) { toast(body.error, { kind: "error" }); return; }
  input.value = "";
  openProject(body.name, "drafts");
});

showLibrary();
setInterval(() => (viewing ? refreshActiveTab() : loadLibrary()), 2500);

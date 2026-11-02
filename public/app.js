import { createDraftsTab } from "/drafts.js";
import { toast } from "/toast.js";
import { createRail } from "/rail.js";
import { settingsTool } from "/settings.js";

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
  tools: [settingsTool],
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
    toast(`${body.moved.length} 件を workspace\\_Trash へ移動しました(戻すときは PJs へ戻します)`, { key: "trash-done" });
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
  const key = viewing + JSON.stringify(songs.map((s) => [s.path ?? s.sunoId, s.mtime]));
  if (key === songsKey) return;
  songsKey = key;
  if (!songs.length) {
    return songsBox.replaceChildren(note("曲はまだありません。左の Claude に「Suno で曲を作って、試聴用に保存して」と頼んでください。"));
  }
  songsBox.replaceChildren(...songs.map(songCard));
}

function songCard(song) {
  const el = document.createElement("section");
  el.className = "song";
  const head = document.createElement("div");
  head.className = "song-head";
  const title = document.createElement("h2");
  title.textContent = song.title;
  head.append(title);
  if (!song.path) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "試聴(未ダウンロード)";
    head.append(badge);
  }
  if (!song.path && song.name) head.append(downloadButton(song));
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

function showTab(next) {
  tab = next;
  for (const button of document.querySelectorAll("#tabs button")) button.classList.toggle("on", button.dataset.tab === next);
  $("drafts").hidden = next !== "drafts";
  songsBox.hidden = next !== "songs";
  songsKey = null;
  refreshActiveTab();
}

const refreshActiveTab = () => (tab === "songs" ? refreshSongs() : draftsTab.refresh());

function showLibrary() {
  viewing = "";
  $("lib-header").hidden = false;
  libraryBox.hidden = false;
  $("pj-header").hidden = true;
  $("tabs").hidden = true;
  $("drafts").hidden = true;
  songsBox.hidden = true;
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

const $ = (id) => document.getElementById(id);
const libraryBox = $("library");
const songsBox = $("songs");
const msg = $("msg");

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
  socket.onclose = () => { if (ws === socket) term.write("\r\n[session closed - open the project again to restart]\r\n"); };
  attached = pj;
}

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
  if (!res.ok) { msg.textContent = body.error; return; }
  if (body.moved.includes(attached)) attached = "";
  msg.textContent = body.failed.length
    ? `移動できなかった PJ: ${body.failed.map((f) => `${f.name}(${f.error})`).join("、")}`
    : "";
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
  const key = viewing + JSON.stringify(songs.map((s) => [s.path ?? s.sunoId, s.mtime, s.lyrics?.length]));
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
  const title = document.createElement("h2");
  title.textContent = song.title;
  el.append(title);
  if (song.sunoId) {
    // Not downloaded yet: listen through Suno's own embed (no download credit is spent).
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "試聴(未ダウンロード)";
    title.append(" ", badge);
    const frame = document.createElement("iframe");
    frame.src = `https://suno.com/embed/${song.sunoId}`;
    frame.allow = "autoplay";
    frame.sandbox = "allow-scripts allow-same-origin allow-popups";
    frame.loading = "lazy";
    el.append(frame);
    const info = [song.duration && `${Math.round(song.duration)}秒`, song.style].filter(Boolean).join(" / ");
    if (info) {
      const small = document.createElement("div");
      small.className = "meta";
      small.textContent = info;
      el.append(small);
    }
  } else {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = `/file?pj=${encodeURIComponent(viewing)}&p=${encodeURIComponent(song.path)}`;
    el.append(audio);
  }
  if (song.lyrics) {
    const pre = document.createElement("pre");
    pre.textContent = song.lyrics;
    el.append(pre);
  }
  return el;
}

// ---- navigation ----
function showLibrary() {
  viewing = "";
  $("lib-header").hidden = false;
  libraryBox.hidden = false;
  $("pj-header").hidden = true;
  songsBox.hidden = true;
  libraryKey = null;
  loadLibrary();
}

function openProject(pj) {
  // Only a different project restarts the terminal view; the same one just shows its running session.
  if (pj !== attached) connect(pj);
  viewing = pj;
  songsKey = null;
  $("pj-title").textContent = pj;
  $("lib-header").hidden = true;
  libraryBox.hidden = true;
  $("pj-header").hidden = false;
  songsBox.hidden = false;
  refreshSongs();
}

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
  if (!res.ok) { msg.textContent = body.error; return; }
  msg.textContent = "";
  input.value = "";
  openProject(body.name);
});

showLibrary();
setInterval(() => (viewing ? refreshSongs() : loadLibrary()), 2500);

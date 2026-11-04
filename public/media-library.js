// The image and video library tabs (one implementation, two configurations): browse in four sizes, open one large
// with its provenance, trash some, and (images only) add files by drag and drop. The folder is the source of truth;
// this tab lists it, re-rendering only when it changes, and adds or trashes files.
import { toast } from "/toast.js";
import { attachDropZone, uploadFiles } from "/upload.js";

const VIEWS = [["large", "大"], ["medium", "中"], ["small", "小"], ["list", "リスト"]];
const DEFAULT_VIEW = "medium";
const MAX_FILES_PER_DROP = 30;
const MAX_BYTES = 30 * 1024 * 1024;
const GEN_KIND_LABELS = { still: "静止画", cut: "カット", final: "完成" };
const INPUT_LABELS = { song: "曲", image: "画像", video: "動画" };

const KINDS = {
  image: {
    noun: "画像", api: "/api/images", serve: "/image", upload: true, accept: "image/png,image/jpeg,image/webp,image/gif",
    chips: [["all", "すべて"], ["user", "自分の素材"], ["claude", "Claude生成"]],
    chipTest: (chip, item) => chip === "all" || (chip === "claude") === Boolean(item.gen),
    empty: "画像はまだありません。ここへ画像をドラッグ&ドロップするか、「+ 画像を追加」を押してください。",
  },
  video: {
    noun: "動画", api: "/api/videos", serve: "/video", upload: false,
    chips: [["all", "すべて"], ["final", "完成"], ["cut", "カット"]],
    chipTest: (chip, item) => chip === "all" || item.gen?.kind === chip,
    empty: "動画はまだありません。左の Claude に動画の生成を頼むと、ここに並びます(Output/video/ に置いた mp4・webm も表示されます)。",
  },
};

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const formatDate = (ms) => new Date(ms).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });

/**
 * @param {{root: HTMLElement, getProject: () => string, kind: "image"|"video",
 *   openOther: (kind: "image"|"video", name: string) => void}} options
 *   `openOther` shows a file of the other library (used by the links in the provenance panel).
 */
export function createMediaLibrary({ root, getProject, kind, openOther }) {
  const cfg = KINDS[kind];
  const viewKey = `mv-studio:${kind}-view`;
  let items = [];
  let key = null;           // what is on screen; a re-render happens only when it changes
  let project = "";
  let filter = "";
  let chip = "all";
  let view = localStorage.getItem(viewKey) ?? DEFAULT_VIEW;
  if (!VIEWS.some(([id]) => id === view)) view = DEFAULT_VIEW;
  const selected = new Set();
  let lastPicked = -1;      // index in the shown list, for shift-click ranges
  let confirming = false;
  let opened = null;        // file name shown large
  let wantOpen = null;      // a file another library asked to show, opened once the list has loaded
  let uploading = 0;
  let detailToken = 0;      // drops the answer of an outdated provenance lookup
  let openedSnapshot = "";  // the opened file as drawn, so a list change elsewhere does not restart a playing video

  const filterInput = h("input", { placeholder: `ファイル名・番号(#3)で絞り込み`, autocomplete: "off", type: "search" });
  filterInput.setAttribute("aria-label", `${cfg.noun}を絞り込み`);
  const chipButtons = cfg.chips.map(([id, label]) => h("button", { type: "button", textContent: label, onclick: () => { chip = id; key = null; render(); } }));
  const viewButtons = VIEWS.map(([id, label]) => h("button", { type: "button", textContent: label, title: `${label}表示`, onclick: () => setView(id) }));
  const toolbar = h("div", { className: "img-toolbar" }, filterInput, h("span", { className: "img-views" }, ...chipButtons), h("span", { className: "img-views" }, ...viewButtons));
  let picker = null;
  if (cfg.upload) {
    picker = h("input", { type: "file", multiple: true, accept: cfg.accept, hidden: true });
    toolbar.append(h("button", { type: "button", textContent: `+ ${cfg.noun}を追加`, onclick: () => picker.click() }), picker);
  }
  const bar = h("div", { className: "img-bar" });
  const body = h("div", { className: "img-body" });
  const dropMask = h("div", { className: "img-drop", hidden: true, textContent: "ここにドロップして追加" });
  const viewer = h("div", { className: "img-viewer", hidden: true });
  root.append(toolbar, bar, body, dropMask, viewer);

  const post = (path, payload) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const urlOf = (type, name, mtime) => `${KINDS[type].serve}?pj=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}&v=${Math.round(mtime)}`;
  const src = (item) => urlOf(kind, item.name, item.mtime);
  // "3" or "#3" finds item #3; anything else matches file names.
  const shown = () => items.filter((item) => (item.name.toLowerCase().includes(filter) || String(item.id) === filter) && cfg.chipTest(chip, item));

  function setView(next) {
    view = next;
    localStorage.setItem(viewKey, next);
    key = null;
    render();
  }

  // ---- adding (images) ----
  async function upload(files) {
    const target = project;
    if (!target) return;
    await uploadFiles({
      files, unit: "枚", maxFiles: MAX_FILES_PER_DROP, maxBytes: MAX_BYTES, toastKey: "img",
      urlFor: (name) => `${cfg.api}/upload?pj=${encodeURIComponent(target)}&name=${encodeURIComponent(name)}`,
      onProgress: (remaining) => { uploading = remaining; renderBar(); },
    });
    if (project === target) await refresh(true);
  }

  if (cfg.upload) {
    picker.addEventListener("change", () => { upload(picker.files); picker.value = ""; });
    attachDropZone(root, dropMask, upload);
  }

  // ---- trash ----
  async function trash(names) {
    const res = await post(`${cfg.api}/trash`, { pj: project, names });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: `${kind}-trash`, kind: "error" });
    for (const name of answer.moved) selected.delete(name);
    confirming = false;
    if (answer.moved.length) toast(`${answer.moved.length} 件を workspace\\_Trash\\${kind}s へ移動しました(戻すときは Output\\${kind} へ戻します)`, { key: `${kind}-trash` });
    if (answer.failed.length) toast(`移動できませんでした: ${answer.failed.map((f) => `${f.name}(${f.error})`).join("、")}`, { key: `${kind}-trash-failed`, kind: "error" });
    await refresh(true);
  }

  // ---- rendering ----
  function renderBar() {
    chipButtons.forEach((button, i) => button.classList.toggle("on", cfg.chips[i][0] === chip));
    viewButtons.forEach((button, i) => button.classList.toggle("on", VIEWS[i][0] === view));
    const parts = [];
    if (uploading) parts.push(h("span", { className: "meta", textContent: `追加中… 残り ${uploading} 件` }));
    if (selected.size) {
      parts.push(h("span", { textContent: `${selected.size} 件を選択中` }));
      if (confirming) {
        parts.push(
          h("span", { textContent: "workspace\\_Trash へ移動します(完全には削除されません)。続けますか?" }),
          h("button", { type: "button", className: "danger", textContent: "ごみ箱へ移動", onclick: () => trash([...selected]) }),
          h("button", { type: "button", textContent: "やめる", onclick: () => { confirming = false; renderBar(); } }),
        );
      } else {
        parts.push(
          h("button", { type: "button", textContent: "ごみ箱へ…", onclick: () => { confirming = true; renderBar(); } }),
          h("button", { type: "button", textContent: "選択を解除", onclick: () => { selected.clear(); confirming = false; render(); } }),
        );
      }
    }
    bar.hidden = parts.length === 0;
    bar.replaceChildren(...parts);
  }

  function pick(item, index, event) {
    if (event.shiftKey && lastPicked >= 0) {
      const [from, to] = [Math.min(lastPicked, index), Math.max(lastPicked, index)];
      for (const other of shown().slice(from, to + 1)) selected.add(other.name);
    } else if (selected.has(item.name)) selected.delete(item.name);
    else selected.add(item.name);
    lastPicked = index;
    confirming = false;
    render();
  }

  /** A small mark on the card: where the file came from. */
  const originMark = (item) => {
    if (!item.gen) return null;
    const label = item.gen.error ? "出所エラー" : (GEN_KIND_LABELS[item.gen.kind] ?? "生成");
    return h("span", { className: `img-origin${item.gen.error ? " bad" : ""}`, textContent: item.gen.error ? "!" : "AI", title: `Claude 生成: ${label}` });
  };

  const thumbMedia = (item) => (kind === "video"
    ? h("video", { src: `${src(item)}#t=0.1`, preload: "metadata", muted: true, playsInline: true })
    : h("img", { src: src(item), alt: item.name, loading: "lazy" }));

  function card(item, index) {
    const check = h("input", { type: "checkbox", className: "pick", checked: selected.has(item.name), title: "選択(Shift で範囲選択)" });
    check.setAttribute("aria-label", `${item.name} を選択`);
    check.addEventListener("click", (event) => { event.stopPropagation(); pick(item, index, event); });
    const thumb = h("div", { className: "thumb" }, thumbMedia(item), check,
      h("span", { className: "img-id", textContent: `#${item.id}`, title: `Claude には「${cfg.noun}${item.id}」または「#${item.id}」で指示できます` }));
    const mark = originMark(item);
    if (mark) thumb.append(mark);
    const el = h("div", { className: "img-card", tabIndex: 0, role: "button" }, thumb,
      h("div", { className: "img-name", textContent: item.name, title: item.name }),
      h("div", { className: "meta", textContent: `${formatSize(item.size)} · ${formatDate(item.mtime)}` }));
    el.classList.toggle("on", selected.has(item.name));
    el.addEventListener("click", () => open(item.name));
    el.addEventListener("keydown", (event) => { if (event.key === "Enter") open(item.name); });
    return el;
  }

  function render() {
    renderBar();
    if (!items.length) return body.replaceChildren(h("p", { className: "empty", textContent: cfg.empty }));
    const list = shown();
    if (!list.length) return body.replaceChildren(h("p", { className: "empty", textContent: "該当するものがありません。" }));
    body.replaceChildren(h("div", { className: `img-grid ${view}` }, ...list.map(card)));
  }

  // ---- large view with the provenance panel ----
  function open(name) {
    opened = name;
    renderViewer();
  }

  function close() {
    opened = null;
    detailToken++;
    viewer.hidden = true;
    viewer.replaceChildren();
  }

  function step(delta) {
    const list = shown();
    const at = list.findIndex((item) => item.name === opened);
    if (at < 0 || !list.length) return;
    opened = list[(at + delta + list.length) % list.length].name;
    renderViewer();
  }

  const section = (title, ...children) => h("section", { className: "gen-section" }, h("h4", { textContent: title }), ...children);
  const dim = (textContent) => h("p", { className: "meta", textContent });

  /** A link to a file of either library; plain text when the file is not (or no longer) there. */
  function fileLink(type, name, all) {
    const found = all[type]?.find((other) => other.name === name);
    const label = `${INPUT_LABELS[type]}${found ? ` #${found.id}` : ""} · ${name}`;
    if (!found) return h("span", { className: "gen-missing", textContent: `${label}(見つかりません)` });
    const button = h("button", { type: "button", className: "gen-link", onclick: () => (type === kind ? open(name) : openOther(type, name)) });
    if (type === "image") button.append(h("img", { src: urlOf("image", name, found.mtime), alt: "" }));
    button.append(h("span", { textContent: label }));
    return button;
  }

  /** The provenance panel: what it was made from, how, and what was made from it. `all` = both libraries' lists. */
  function detailPanel(item, all) {
    const gen = item.gen;
    if (!gen) return [section("出所", dim("出所データがありません(アプリの外で作られた、または Claude が記録していない)。"))];
    if (gen.error) return [section("出所", h("p", { className: "bad", textContent: `出所データを読めません: ${gen.error}` }))];
    const sections = [section("出所", h("p", {}, "Claude 生成", gen.kind ? ` · ${GEN_KIND_LABELS[gen.kind]}` : ""))];
    if (gen.inputs.length) sections.push(section("元データ", ...gen.inputs.map((input) => h("div", {}, input.type === "song" ? h("span", { textContent: `曲 · ${input.name}` }) : fileLink(input.type, input.name, all)))));
    const m = gen.method;
    const rows = [["ツール", m.tool], ["モデル", m.model], ["日時", m.createdAt ? formatDate(Date.parse(m.createdAt)) : ""], ...m.params].filter(([, v]) => v);
    const method = [];
    if (rows.length) method.push(h("dl", { className: "info" }, ...rows.flatMap(([k, v]) => [h("dt", { textContent: k }), h("dd", { textContent: v })])));
    if (m.prompt) {
      method.push(h("pre", { className: "gen-prompt", textContent: m.prompt }),
        h("button", { type: "button", textContent: "プロンプトをコピー", onclick: async () => { await navigator.clipboard.writeText(m.prompt); toast("コピーしました", { key: "copied" }); } }));
    }
    if (method.length) sections.push(section("生成方法", ...method));
    if (gen.note) sections.push(section("メモ", h("p", { textContent: gen.note })));
    const lineage = [];
    if (gen.parent) lineage.push(h("div", {}, h("span", { className: "meta", textContent: "元の版: " }), fileLink(kind, gen.parent.name, all)));
    const children = ["image", "video"].flatMap((type) => (all[type] ?? [])
      .filter((other) => other.gen?.inputs?.some((i) => i.type === kind && i.name === item.name) || (type === kind && other.gen?.parent?.name === item.name))
      .map((other) => [type, other.name]));
    if (children.length) lineage.push(h("div", {}, h("span", { className: "meta", textContent: "この" + cfg.noun + "から作られたもの:" }), ...children.map(([type, name]) => h("div", {}, fileLink(type, name, all)))));
    if (lineage.length) sections.push(section("派生", ...lineage));
    return sections;
  }

  async function loadBoth() {
    const get = (api) => fetch(`${api}?pj=${encodeURIComponent(project)}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const [image, video] = await Promise.all([get("/api/images"), get("/api/videos")]);
    return { image, video };
  }

  function renderViewer() {
    const list = shown();
    const item = list.find((other) => other.name === opened);
    if (!item) return close();
    const info = h("span", { className: "meta", textContent: `${formatSize(item.size)} · ${formatDate(item.mtime)}` });
    let media;
    if (kind === "video") {
      media = h("video", { src: src(item), controls: true, playsInline: true });
      media.addEventListener("loadedmetadata", () => { info.textContent = `${media.videoWidth}×${media.videoHeight} · ${media.duration.toFixed(1)}秒 · ${formatSize(item.size)} · ${formatDate(item.mtime)}`; });
    } else {
      media = h("img", { src: src(item), alt: item.name });
      media.addEventListener("load", () => { info.textContent = `${media.naturalWidth}×${media.naturalHeight} · ${formatSize(item.size)} · ${formatDate(item.mtime)}`; });
    }
    openedSnapshot = JSON.stringify(item);
    const many = list.length > 1;
    const aside = h("aside", { className: "gen-detail" }, ...detailPanel(item, { [kind]: items }));
    const token = ++detailToken;
    // The links need the other library's list too; fill them in as soon as it arrives.
    loadBoth().then((all) => { if (token === detailToken && opened === item.name) aside.replaceChildren(...detailPanel(item, all)); });
    viewer.hidden = false;
    viewer.replaceChildren(
      h("header", {}, h("span", { className: "img-id inline", textContent: `#${item.id}` }), h("strong", { textContent: item.name }), info,
        h("span", { className: "spacer" }),
        h("button", { type: "button", textContent: "ごみ箱へ", onclick: async () => { close(); await trash([item.name]); } }),
        h("button", { type: "button", textContent: "✕", title: "閉じる(Esc)", onclick: close })),
      h("div", { className: "img-stage" },
        h("button", { type: "button", className: "nav", textContent: "‹", title: "前へ(←)", disabled: !many, onclick: () => step(-1) }),
        media,
        h("button", { type: "button", className: "nav", textContent: "›", title: "次へ(→)", disabled: !many, onclick: () => step(1) }),
        aside),
    );
  }

  viewer.addEventListener("click", (event) => { if (event.target === viewer) close(); });
  addEventListener("keydown", (event) => {
    if (!opened || viewer.hidden) return;
    if (event.key === "Escape") close();
    // A focused video uses the arrows to seek, so only step between files from anywhere else.
    else if (event.target.tagName !== "VIDEO" && event.key === "ArrowLeft") step(-1);
    else if (event.target.tagName !== "VIDEO" && event.key === "ArrowRight") step(1);
  });

  filterInput.addEventListener("input", () => {
    filter = filterInput.value.trim().toLowerCase().replace(/^#/, "");
    key = null;
    render();
  });

  // ---- data ----
  /** Leaving a project (or the tab) drops its selection and any open file. */
  function reset() {
    selected.clear();
    confirming = false;
    lastPicked = -1;
    items = [];
    key = null;
    wantOpen = null;
    close();
  }

  async function refresh(force = false) {
    const pj = getProject();
    if (!pj) return;
    if (pj !== project) { reset(); project = pj; }
    const res = await fetch(`${cfg.api}?pj=${encodeURIComponent(pj)}`).catch(() => null);
    if (!res?.ok || getProject() !== pj) return;
    items = await res.json();
    const names = new Set(items.map((item) => item.name));
    for (const name of selected) if (!names.has(name)) selected.delete(name);
    const next = JSON.stringify([pj, view, filter, chip, [...selected], items.map((i) => [i.id, i.name, i.mtime, i.size, i.gen ? JSON.stringify(i.gen) : null])]);
    if (!force && next === key) return;
    key = next;
    render();
    if (wantOpen && names.has(wantOpen)) { chip = "all"; filter = ""; filterInput.value = ""; render(); open(wantOpen); wantOpen = null; }
    else if (opened && JSON.stringify(items.find((i) => i.name === opened)) !== openedSnapshot) renderViewer();
  }

  /** Shows one file large once the list is loaded (used when another library links here). */
  function openByName(name) {
    wantOpen = name;
    refresh(true);
  }

  return { refresh, reset, openByName };
}

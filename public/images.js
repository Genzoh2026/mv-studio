// The image library tab: drop or pick images to add, browse them in four sizes, open one large, move some to the trash.
// The folder is the source of truth; this tab only lists it (re-rendering when it changes) and adds or trashes files.
import { toast } from "/toast.js";

const VIEW_KEY = "mv-studio:image-view";
const VIEWS = [["large", "大"], ["medium", "中"], ["small", "小"], ["list", "リスト"]];
const DEFAULT_VIEW = "medium";
const MAX_FILES_PER_DROP = 30;
const MAX_BYTES = 30 * 1024 * 1024;
const SHOWN_ERRORS = 3;

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const formatDate = (ms) => new Date(ms).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

export function createImagesTab({ root, getProject }) {
  let images = [];
  let key = null;           // what is on screen; a re-render happens only when it changes
  let project = "";
  let filter = "";
  let view = localStorage.getItem(VIEW_KEY) ?? DEFAULT_VIEW;
  if (!VIEWS.some(([id]) => id === view)) view = DEFAULT_VIEW;
  const selected = new Set();
  let lastPicked = -1;      // index in the shown list, for shift-click ranges
  let confirming = false;
  let opened = null;        // file name shown large
  let uploading = 0;

  const filterInput = h("input", { placeholder: "ファイル名・番号(#3)で絞り込み", autocomplete: "off", type: "search" });
  filterInput.setAttribute("aria-label", "画像を絞り込み");
  const picker = h("input", { type: "file", multiple: true, accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  const addButton = h("button", { type: "button", textContent: "+ 画像を追加", onclick: () => picker.click() });
  const viewButtons = VIEWS.map(([id, label]) => h("button", { type: "button", textContent: label, title: `${label}表示`, onclick: () => setView(id) }));
  const bar = h("div", { className: "img-bar" });
  const body = h("div", { className: "img-body" });
  const dropMask = h("div", { className: "img-drop", hidden: true, textContent: "ここにドロップして追加" });
  const viewer = h("div", { className: "img-viewer", hidden: true });
  const toolbar = h("div", { className: "img-toolbar" }, filterInput, h("span", { className: "img-views" }, ...viewButtons), addButton, picker);
  root.append(toolbar, bar, body, dropMask, viewer);

  const post = (path, payload) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const src = (image) => `/image?pj=${encodeURIComponent(project)}&name=${encodeURIComponent(image.name)}&v=${Math.round(image.mtime)}`;
  // "3" or "#3" finds image #3; anything else matches file names.
  const shown = () => images.filter((image) => image.name.toLowerCase().includes(filter) || String(image.id) === filter);

  function setView(next) {
    view = next;
    localStorage.setItem(VIEW_KEY, next);
    key = null;
    render();
  }

  // ---- adding ----
  async function upload(files) {
    const list = [...files];
    if (!list.length) return;
    if (!project) return;
    if (list.length > MAX_FILES_PER_DROP) {
      toast(`一度に追加できるのは ${MAX_FILES_PER_DROP} 枚までです(${list.length} 枚選ばれました)`, { key: "img-limit", kind: "warn" });
      list.length = MAX_FILES_PER_DROP;
    }
    const target = project;
    const failures = [];
    let added = 0;
    uploading += list.length;
    renderBar();
    for (const file of list) {
      if (file.size > MAX_BYTES) {
        failures.push(`${file.name}: 大きすぎます(上限 ${MAX_BYTES / 1024 / 1024} MB)`);
      } else {
        try {
          const res = await fetch(`/api/images/upload?pj=${encodeURIComponent(target)}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
          if (res.ok) added++;
          else failures.push(`${file.name}: ${(await res.json()).error}`);
        } catch (err) {
          failures.push(`${file.name}: ${err.message}`);
        }
      }
      uploading--;
      renderBar();
    }
    if (added) toast(`${added} 枚を追加しました`, { key: "img-added" });
    if (failures.length) {
      const more = failures.length > SHOWN_ERRORS ? ` ほか ${failures.length - SHOWN_ERRORS} 件` : "";
      toast(`追加できませんでした: ${failures.slice(0, SHOWN_ERRORS).join(" / ")}${more}`, { key: "img-failed", kind: "error" });
    }
    if (project === target) await refresh(true);
  }

  picker.addEventListener("change", () => { upload(picker.files); picker.value = ""; });

  // Without this, a file dropped slightly off the target would make the browser leave the app to show the image.
  addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
  addEventListener("drop", (event) => { if (hasFiles(event)) event.preventDefault(); });
  let dragDepth = 0;
  root.addEventListener("dragenter", (event) => { if (hasFiles(event)) { dragDepth++; dropMask.hidden = false; } });
  root.addEventListener("dragleave", (event) => { if (hasFiles(event) && --dragDepth <= 0) { dragDepth = 0; dropMask.hidden = true; } });
  root.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = 0;
    dropMask.hidden = true;
    upload(event.dataTransfer.files);
  });

  // ---- trash ----
  async function trash(names) {
    const res = await post("/api/images/trash", { pj: project, names });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: "img-trash", kind: "error" });
    for (const name of answer.moved) selected.delete(name);
    confirming = false;
    if (answer.moved.length) toast(`${answer.moved.length} 枚を workspace\\_Trash\\images へ移動しました(戻すときは Output\\image へ戻します)`, { key: "img-trash" });
    if (answer.failed.length) toast(`移動できませんでした: ${answer.failed.map((f) => `${f.name}(${f.error})`).join("、")}`, { key: "img-trash-failed", kind: "error" });
    await refresh(true);
  }

  // ---- rendering ----
  function renderBar() {
    viewButtons.forEach((button, i) => button.classList.toggle("on", VIEWS[i][0] === view));
    const parts = [];
    if (uploading) parts.push(h("span", { className: "meta", textContent: `追加中… 残り ${uploading} 枚` }));
    if (selected.size) {
      parts.push(h("span", { textContent: `${selected.size} 枚を選択中` }));
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

  function pick(image, index, event) {
    if (event.shiftKey && lastPicked >= 0) {
      const list = shown();
      const [from, to] = [Math.min(lastPicked, index), Math.max(lastPicked, index)];
      for (const item of list.slice(from, to + 1)) selected.add(item.name);
    } else if (selected.has(image.name)) selected.delete(image.name);
    else selected.add(image.name);
    lastPicked = index;
    confirming = false;
    render();
  }

  function card(image, index) {
    const check = h("input", { type: "checkbox", className: "pick", checked: selected.has(image.name), title: "選択(Shift で範囲選択)" });
    check.setAttribute("aria-label", `${image.name} を選択`);
    check.addEventListener("click", (event) => { event.stopPropagation(); pick(image, index, event); });
    const thumb = h("div", { className: "thumb" }, h("img", { src: src(image), alt: image.name, loading: "lazy" }), check,
      h("span", { className: "img-id", textContent: `#${image.id}`, title: `Claude には「画像${image.id}」または「#${image.id}」で指示できます` }));
    const el = h("div", { className: "img-card", tabIndex: 0, role: "button" }, thumb,
      h("div", { className: "img-name", textContent: image.name, title: image.name }),
      h("div", { className: "meta", textContent: `${formatSize(image.size)} · ${formatDate(image.mtime)}` }));
    el.classList.toggle("on", selected.has(image.name));
    el.addEventListener("click", () => open(image.name));
    el.addEventListener("keydown", (event) => { if (event.key === "Enter") open(image.name); });
    return el;
  }

  function render() {
    renderBar();
    if (!images.length) {
      body.replaceChildren(h("p", { className: "empty", textContent: "画像はまだありません。ここへ画像をドラッグ&ドロップするか、「+ 画像を追加」を押してください。" }));
      return;
    }
    const list = shown();
    if (!list.length) return body.replaceChildren(h("p", { className: "empty", textContent: "該当する画像がありません。" }));
    body.replaceChildren(h("div", { className: `img-grid ${view}` }, ...list.map(card)));
  }

  // ---- large view ----
  function open(name) {
    opened = name;
    renderViewer();
  }

  function close() {
    opened = null;
    viewer.hidden = true;
    viewer.replaceChildren();
  }

  function step(delta) {
    const list = shown();
    const at = list.findIndex((image) => image.name === opened);
    if (at < 0 || !list.length) return;
    opened = list[(at + delta + list.length) % list.length].name;
    renderViewer();
  }

  function renderViewer() {
    const list = shown();
    const image = list.find((item) => item.name === opened);
    if (!image) return close();
    const info = h("span", { className: "meta", textContent: `${formatSize(image.size)} · ${formatDate(image.mtime)}` });
    const img = h("img", { src: src(image), alt: image.name });
    img.addEventListener("load", () => { info.textContent = `${img.naturalWidth}×${img.naturalHeight} · ${formatSize(image.size)} · ${formatDate(image.mtime)}`; });
    const many = list.length > 1;
    viewer.hidden = false;
    viewer.replaceChildren(
      h("header", {}, h("span", { className: "img-id inline", textContent: `#${image.id}` }), h("strong", { textContent: image.name }), info,
        h("span", { className: "spacer" }),
        h("button", { type: "button", textContent: "ごみ箱へ", onclick: async () => { close(); await trash([image.name]); } }),
        h("button", { type: "button", textContent: "✕", title: "閉じる(Esc)", onclick: close })),
      h("div", { className: "img-stage" },
        h("button", { type: "button", className: "nav", textContent: "‹", title: "前へ(←)", disabled: !many, onclick: () => step(-1) }),
        img,
        h("button", { type: "button", className: "nav", textContent: "›", title: "次へ(→)", disabled: !many, onclick: () => step(1) })),
    );
  }

  viewer.addEventListener("click", (event) => { if (event.target === viewer) close(); });
  addEventListener("keydown", (event) => {
    if (!opened || viewer.hidden) return;
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
  });

  filterInput.addEventListener("input", () => {
    filter = filterInput.value.trim().toLowerCase().replace(/^#/, "");
    key = null;
    render();
  });

  // ---- data ----
  /** Leaving a project (or the tab) drops its selection and any open image. */
  function reset() {
    selected.clear();
    confirming = false;
    lastPicked = -1;
    images = [];
    key = null;
    close();
  }

  async function refresh(force = false) {
    const pj = getProject();
    if (!pj) return;
    if (pj !== project) { reset(); project = pj; }
    const res = await fetch(`/api/images?pj=${encodeURIComponent(pj)}`).catch(() => null);
    if (!res?.ok || getProject() !== pj) return;
    images = await res.json();
    const names = new Set(images.map((image) => image.name));
    for (const name of selected) if (!names.has(name)) selected.delete(name);
    const next = JSON.stringify([pj, view, filter, [...selected], images.map((i) => [i.id, i.name, i.mtime, i.size])]);
    if (!force && next === key) return;
    key = next;
    render();
    if (opened) renderViewer();
  }

  return { refresh, reset };
}

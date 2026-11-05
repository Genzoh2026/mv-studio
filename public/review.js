// Review pins on a video: click the picture to drop a pin (time + place), write what to change, and hand the open pins to
// Claude. The pins live in <video>.review.json (saved through the app); Claude marks them done when it has made a fixed
// new version, so what you see here follows the folder. Used by the video viewer of the video library.
import { toast } from "/toast.js";

const SAVE_DELAY_MS = 600;
const POLL_MS = 3000;
const NEAR_S = 0.6;        // a pin shows on the picture this long around its time
const CONTROLS_PX = 44;    // the bottom strip of the video stays free for the player's own controls

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

export const clock = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;

/**
 * @param {{project: string, name: string, video: HTMLVideoElement, typeToTerminal: (text: string) => Promise<void>,
 *   isClaudeReady?: () => boolean}} options
 * @returns {{overlay: HTMLElement, dock: HTMLElement, destroy: () => void}}
 *   `overlay` goes on top of the video (same box); `dock` goes below it.
 */
export function createReviewPanel({ project, name, video, typeToTerminal, isClaudeReady = () => true }) {
  const api = `/api/videos/review`;
  const query = `pj=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`;
  let pins = [];            // the stored pins plus this page's unsaved edits
  let nextId = 1;           // the number the next new pin gets
  let selected = null;
  let pinMode = false;
  let saveTimer = null;
  let unsaved = false;
  let shownKey = null;
  let loadError = null;
  let destroyed = false;

  const post = (path, payload) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pj: project, name, ...payload }) });

  const overlay = h("div", { className: "rv-overlay" });
  overlay.style.bottom = `${CONTROLS_PX}px`;
  const dock = h("div", { className: "rv-dock" });

  // ---- saving ----
  const open = () => pins.filter((pin) => pin.status !== "done");

  async function save() {
    clearTimeout(saveTimer);
    if (!unsaved || destroyed) return;
    unsaved = false;
    const payload = open().map(({ id, t, x, y, text }) => ({ id, t, x, y, text }));
    const res = await post("", { pins: payload }).catch(() => null);
    if (!res?.ok) {
      unsaved = true;
      return toast(res ? (await res.json()).error : "ピンを保存できませんでした", { key: "review-save", kind: "error" });
    }
    adopt(await res.json());
  }
  const saveSoon = () => { unsaved = true; clearTimeout(saveTimer); saveTimer = setTimeout(save, SAVE_DELAY_MS); };

  /** Takes the stored list as the truth (keeping the numbers of pins just made). */
  function adopt(review) {
    pins = review.pins;
    nextId = review.next;
    if (selected !== null && !pins.some((pin) => pin.id === selected)) selected = null;
    render();
  }

  async function load() {
    try {
      const res = await fetch(`${api}?${query}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      loadError = null;
      if (!unsaved && !dock.contains(document.activeElement?.closest?.("textarea") ?? null)) adopt(body);
    } catch (err) {
      loadError = err.message;
      render();
    }
  }

  // ---- pins on the picture ----
  function addPin(event) {
    const box = overlay.getBoundingClientRect();
    const pin = {
      id: nextId++, t: video.currentTime,
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / video.getBoundingClientRect().width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / video.getBoundingClientRect().height)),
      text: "", status: "open", sentAt: null,
    };
    video.pause();
    pins.push(pin);
    pins.sort((a, b) => a.t - b.t || a.id - b.id);
    selected = pin.id;
    saveSoon();
    render(true);
    dock.querySelector(`[data-pin="${pin.id}"] textarea`)?.focus();
  }
  overlay.addEventListener("click", (event) => { if (pinMode && event.target === overlay) addPin(event); });

  function addWholePicturePin() {
    const pin = { id: nextId++, t: video.currentTime, x: null, y: null, text: "", status: "open", sentAt: null };
    video.pause();
    pins.push(pin);
    pins.sort((a, b) => a.t - b.t || a.id - b.id);
    selected = pin.id;
    saveSoon();
    render(true);
    dock.querySelector(`[data-pin="${pin.id}"] textarea`)?.focus();
  }

  function drawMarks() {
    const now = video.currentTime;
    overlay.classList.toggle("on", pinMode);
    overlay.replaceChildren(...open()
      .filter((pin) => pin.x !== null && (pin.id === selected || Math.abs(pin.t - now) <= NEAR_S))
      .map((pin) => {
        const mark = h("button", { type: "button", className: `rv-pin${pin.id === selected ? " sel" : ""}`, textContent: String(pin.id), title: pin.text || "(コメントなし)" });
        mark.style.left = `${pin.x * 100}%`;
        mark.style.top = `${pin.y * 100}%`;
        mark.addEventListener("click", (event) => { event.stopPropagation(); selected = pin.id; render(true); dock.querySelector(`[data-pin="${pin.id}"] textarea`)?.focus(); });
        return mark;
      }));
  }

  // ---- the dock under the video ----
  function pinCard(pin) {
    const sent = pin.sentAt && !unsaved;
    const area = h("textarea", { value: pin.text, placeholder: "どう直したいか(例: 口元を隠す / 色を明るく / この拍で切る)", rows: 2 });
    area.addEventListener("input", () => { pin.text = area.value; pin.sentAt = null; saveSoon(); updateActions(); });
    area.addEventListener("focus", () => { selected = pin.id; drawMarks(); });
    area.addEventListener("blur", save);
    const el = h("div", { className: `rv-item${pin.id === selected ? " sel" : ""}` },
      h("div", { className: "rv-meta" },
        h("span", {}, h("b", { className: "rv-num", textContent: String(pin.id) }), ` ${clock(pin.t)}${pin.x === null ? " · 全体" : ""}`),
        h("span", { className: sent ? "rv-sent" : "rv-unsent", textContent: sent ? "送信済み" : "未送信" })),
      area,
      h("div", { className: "rv-acts" },
        h("button", { type: "button", textContent: "ここへ移動", onclick: () => { video.pause(); video.currentTime = pin.t; selected = pin.id; render(true); } }),
        h("button", { type: "button", textContent: "削除", onclick: async () => { pins = pins.filter((other) => other.id !== pin.id); unsaved = true; render(true); await save(); } })));
    el.dataset.pin = pin.id;
    return el;
  }

  const sendable = () => open().filter((pin) => pin.text.trim());
  let sendButton;
  let copyButton;
  function updateActions() {
    if (!sendButton) return;
    const count = sendable().length;
    sendButton.disabled = !count || !isClaudeReady();
    sendButton.textContent = count ? `Claudeに修正を依頼(${count}件)` : "Claudeに修正を依頼";
    sendButton.title = isClaudeReady() ? "ピンの内容を Claude の入力欄に入れます(Enter で送信)" : "Claude が見つかりません(設定を確認してください)";
    copyButton.disabled = !count;
  }

  /** Writes <video>.review.md and returns what to tell Claude. */
  async function prepare() {
    await save();
    const res = await post("/request", {});
    const body = await res.json();
    if (!res.ok) { toast(body.error, { key: "review-request", kind: "error" }); return null; }
    return body;
  }

  async function sendToClaude() {
    const request = await prepare();
    if (!request) return;
    try {
      await typeToTerminal(request.line);
    } catch (err) {
      return toast(`Claude の入力欄に入れられませんでした: ${err.message}(Markdown のコピーを使えます)`, { key: "review-request", kind: "error" });
    }
    await post("/sent", { ids: request.ids });
    toast(`${request.ids.length} 件のピンを Claude の入力欄に入れました。Enter で送信してください`, { key: "review-request" });
    await load();
  }

  async function copyMarkdown() {
    const request = await prepare();
    if (!request) return;
    await navigator.clipboard.writeText(request.markdown);
    toast("Markdown をコピーしました", { key: "review-copy" });
  }

  const timeline = h("div", { className: "rv-tl", title: "クリックでその時刻へ" });
  timeline.addEventListener("click", (event) => {
    if (!video.duration) return;
    const box = timeline.getBoundingClientRect();
    video.currentTime = ((event.clientX - box.left) / box.width) * video.duration;
  });

  function drawTimeline() {
    const d = video.duration || 0;
    timeline.replaceChildren(...(d ? open().map((pin) => {
      const tick = h("div", { className: `rv-tick${pin.id === selected ? " sel" : ""}`, title: `${pin.id}: ${pin.text.slice(0, 30)}` });
      tick.style.left = `${(pin.t / d) * 100}%`;
      tick.addEventListener("click", (event) => { event.stopPropagation(); video.currentTime = pin.t; selected = pin.id; render(true); });
      return tick;
    }) : []));
  }

  function render(force = false) {
    if (destroyed) return;
    const key = JSON.stringify([pins, selected, pinMode, loadError, unsaved]);
    if (!force && key === shownKey) return;
    shownKey = key;
    drawMarks();
    drawTimeline();
    const done = pins.filter((pin) => pin.status === "done");
    const typing = dock.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
    if (typing && !force) return updateActions(); // never rebuild the box someone is typing in
    const toggle = h("button", { type: "button", className: pinMode ? "on" : "", textContent: pinMode ? "📍 ピンを打つ(動画をクリック)" : "📍 ピンを打つ", title: "オンにして、動画の気になる場所をクリックします", onclick: () => { pinMode = !pinMode; render(true); } });
    sendButton = h("button", { type: "button", className: "danger", onclick: sendToClaude });
    copyButton = h("button", { type: "button", textContent: "Markdownをコピー", onclick: copyMarkdown });
    const list = open();
    dock.replaceChildren(
      h("div", { className: "rv-bar" }, toggle, h("button", { type: "button", textContent: "＋ 全体コメント", title: "場所を指さない指示(今の時刻に付きます)", onclick: addWholePicturePin }), h("span", { className: "spacer" }), copyButton, sendButton),
      timeline,
      ...(loadError ? [h("p", { className: "bad", textContent: `ピンを読めません: ${loadError}` })] : []),
      ...(list.length ? list.map(pinCard) : [h("p", { className: "meta", textContent: "ピンはまだありません。「ピンを打つ」をオンにして、直したい場所をクリックしてください。" })]),
      ...(done.length ? [h("details", { className: "rv-done" }, h("summary", { textContent: `修正済みのピン(${done.length})` }),
        ...done.map((pin) => h("div", { className: "rv-donepin" },
          h("span", { textContent: `${pin.id} · ${clock(pin.t)} · ${pin.text || "(コメントなし)"} → ${pin.fixedIn ?? ""}` }),
          h("button", { type: "button", textContent: "削除", onclick: async () => { await post("/delete", { ids: [pin.id] }); await load(); } }))))] : []),
    );
    drawTimeline();
    updateActions();
  }

  // The marks follow the playhead.
  const onTime = () => drawMarks();
  video.addEventListener("timeupdate", onTime);
  video.addEventListener("seeked", onTime);
  video.addEventListener("loadedmetadata", drawTimeline);
  const poll = setInterval(load, POLL_MS);
  load().then(() => render(true));
  render(true);

  return {
    overlay,
    dock,
    destroy() {
      destroyed = true;
      clearInterval(poll);
      clearTimeout(saveTimer);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("seeked", onTime);
      video.removeEventListener("loadedmetadata", drawTimeline);
      if (unsaved) {
        // A last save on the way out, so a pin typed just before closing is not lost.
        navigator.sendBeacon?.(`${api}`, new Blob([JSON.stringify({ pj: project, name, pins: open().map(({ id, t, x, y, text }) => ({ id, t, x, y, text })) })], { type: "application/json" }));
      }
    },
  };
}

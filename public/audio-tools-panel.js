// The "Audio tools" section of the settings panel: what this computer has for separating songs and finding beats, and a
// one-button setup for what is missing. The setup is shown and confirmed first, runs on the server inside the workspace's
// own Python environment (no other Python is touched), streams its log here, and can be cancelled.
// The calm state is one line of chips and a sentence; everything else (commands, Python path, model) is folded away.
import { toast } from "/toast.js";

const POLL_MS = 1000;
const SHOWN_LOG_LINES = 8;
const DOWNLOAD_CPU = "約 0.7 GB";
const DOWNLOAD_GPU = "+ 約 3 GB";
const STEP_ICON = { waiting: "○", running: "⏳", done: "✓", error: "✗", cancelled: "—" };

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const post = (path, payload = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const get = async (path) => { const res = await fetch(path, { cache: "no-store" }); return res.ok ? res.json() : null; };

/**
 * @param {HTMLElement} box where the section body is drawn
 * @param {{setSummary: (text: string, level?: "ok"|"warn"|"bad"|"neutral") => void}} section the header's one-line status
 */
export function createAudioToolsPanel(box, { setSummary = () => {} } = {}) {
  let audio = null;      // /api/audio-tools
  let install = null;    // /api/audio-install (the running or last setup)
  let plan = null;       // /api/audio-install/plan while the confirmation is open
  let confirming = false;
  let wantGpu = false;
  let shownKey = null;
  let timer = null;
  let destroyed = false;

  const changed = () => document.dispatchEvent(new CustomEvent("audio-tools-changed"));

  async function load() {
    try {
      [audio, install] = await Promise.all([get("/api/audio-tools"), get("/api/audio-install")]);
    } catch { /* the server may be restarting */ }
    render();
    schedule();
  }

  /** Polls only while a setup is running, so an idle panel costs nothing. */
  function schedule() {
    clearTimeout(timer);
    if (destroyed || install?.state !== "running") return;
    timer = setTimeout(async () => {
      const before = install?.state;
      install = (await get("/api/audio-install").catch(() => null)) ?? install;
      if (before === "running" && install?.state !== "running") {
        audio = (await get("/api/audio-tools").catch(() => null)) ?? audio;
        changed();
        announce();
      }
      render();
      schedule();
    }, POLL_MS);
  }

  function announce() {
    if (install.state === "done") toast(audio?.ready.separate ? "導入できました。分離とビート解析が使えます" : "導入は終わりました。まだ足りないものがあります", { key: "audio-setup", kind: audio?.ready.separate ? "info" : "warn" });
    else if (install.state === "error") toast("導入に失敗しました。ログを確認してください", { key: "audio-setup", kind: "error" });
  }

  async function openConfirm(gpu) {
    wantGpu = gpu;
    confirming = true;
    plan = null;
    render();
    plan = await get(`/api/audio-install/plan?gpu=${wantGpu ? 1 : 0}`).catch(() => null);
    render();
  }

  async function start() {
    const res = await post("/api/audio-install/start", { confirmed: true, gpu: wantGpu });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: "audio-setup", kind: "error" });
    confirming = false;
    install = answer;
    render();
    schedule();
  }

  async function savePython(path) {
    const res = await post("/api/audio-tools/python", { path });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: "audio-tools", kind: "error" });
    audio = answer;
    render(true);
    changed();
    toast(path ? "Python のパスを保存しました" : "自動検出に戻しました", { key: "audio-tools" });
  }

  async function saveModel(model) {
    const res = await post("/api/audio-tools/model", { model });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: "audio-tools", kind: "error" });
    audio = answer;
    render(true);
    changed();
    toast(`分離のモデルを ${model} にしました`, { key: "audio-tools" });
  }

  async function recheck() {
    audio = null;
    render(true);
    audio = await get("/api/audio-tools?refresh=1").catch(() => null);
    render(true);
    changed();
    toast(audio?.ready.separate ? "分離とビート解析が使えます" : audio?.ready.beats ? "ビート解析が使えます(分離には Demucs が必要です)" : "まだ足りないものがあります", { key: "audio-tools", kind: audio?.ready.beats ? "info" : "warn" });
  }

  const copyButton = (text) => h("button", { type: "button", textContent: "コピー", onclick: async () => { await navigator.clipboard.writeText(text); toast("コピーしました", { key: "copied" }); } });
  const button = (textContent, onclick, className = "") => h("button", { type: "button", textContent, onclick, className });
  const chip = (state, text, title) => h("span", { className: `chip ${state}`, textContent: text, title });

  /** One row of chips instead of five paragraphs. The hover text carries the versions and the reason. */
  function chips() {
    const demucsOk = Boolean(audio.demucs) && !audio.demucsError;
    return h("div", { className: "chips" },
      chip(audio.python.found ? "ok" : "bad", `${audio.python.found ? "✓" : "✗"} Python`, audio.python.found ? `Python ${audio.python.version}\n${audio.python.where}` : "Python が見つかりません"),
      chip(audio.numpy ? "ok" : "bad", `${audio.numpy ? "✓" : "✗"} numpy`, audio.numpy ? `numpy ${audio.numpy}(ビート解析)` : "numpy がありません(ビート解析に必要)"),
      chip(demucsOk ? "ok" : "bad", `${demucsOk ? "✓" : "✗"} Demucs`, !audio.demucs ? "Demucs がありません(曲の分離に必要)" : audio.demucsError ? `入っていますが、動きません: ${audio.demucsError}` : `Demucs ${audio.demucs}(曲の分離)`),
      chip(audio.ffmpeg.found ? "ok" : "bad", `${audio.ffmpeg.found ? "✓" : "✗"} ffmpeg`, audio.ffmpeg.found ? `ffmpeg ${audio.ffmpeg.version}` : "ffmpeg が見つかりません"),
      // The GPU chip describes separation, so it only means something once Demucs works (another Python may have a GPU build).
      ...(!demucsOk ? [] : [audio.cuda ? chip("ok", "✓ GPU", `PyTorch ${audio.torch ?? ""} / CUDA で分離します`)
        : audio.gpu ? chip("warn", "GPU 未使用", `NVIDIA GPU(${audio.gpu})がありますが、PyTorch が GPU 非対応の版です。CPU で動きます`)
          : chip("neutral", "CPU", "GPU は使いません(曲 1 分で数十秒〜数分)")]),
    );
  }

  /** Steps only the user can do (they install software for the whole computer). */
  function systemSteps() {
    return audio.install.filter((step) => step.kind === "system").flatMap((step) => [
      h("p", { className: "sec-note", textContent: step.label }),
      h("div", { className: "cmd" }, h("pre", { textContent: step.command }), copyButton(step.command)),
    ]);
  }

  function runningView() {
    const log = h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") });
    queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
    return [
      h("p", { textContent: "導入しています…(画面を閉じても続きます)" }),
      ...install.steps.map((step) => h("p", { className: step.state === "error" ? "bad" : "sec-note", textContent: `${STEP_ICON[step.state]} ${step.label}` })),
      log,
      button("取り消し", async () => { await post("/api/audio-install/cancel"); await load(); }),
    ];
  }

  function confirmView() {
    if (!plan) return [h("p", { className: "sec-note", textContent: "確認中…" })];
    if (!plan.ok) return [h("p", { className: "bad", textContent: plan.reason }), ...systemSteps(), button("閉じる", () => { confirming = false; render(); })];
    return [
      h("p", { textContent: "専用環境に、次を入れます(他の Python には触れません)。" }),
      h("p", { className: "sec-note", textContent: plan.venvDir }),
      ...(plan.warning ? [h("p", { className: "bad", textContent: plan.warning })] : []),
      ...plan.steps.map((step) => h("pre", { className: "setup-cmd", textContent: step.display })),
      h("p", { className: "sec-note", textContent: `ダウンロード ${DOWNLOAD_CPU}${plan.gpuStep ? ` ${DOWNLOAD_GPU}` : ""} · 数分〜十数分` }),
      ...(plan.gpuAvailable ? [h("label", { className: "setup-gpu" }, Object.assign(h("input", { type: "checkbox" }), { checked: wantGpu, onchange: (event) => openConfirm(event.target.checked) }), ` GPU 版を使う(${plan.gpuName}。${DOWNLOAD_GPU})`)] : []),
      h("div", { className: "panel-actions" }, button("導入する", start, "danger"), button("やめる", () => { confirming = false; render(); })),
    ];
  }

  function resultView() {
    if (!install || install.state === "idle" || install.state === "running") return [];
    const log = h("details", { className: "sec-more" }, h("summary", { textContent: "ログ" }), h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") }));
    if (install.state === "error") return [h("p", { className: "bad", textContent: `導入に失敗しました: ${install.error}` }), log];
    if (install.state === "cancelled") return [h("p", { className: "sec-note", textContent: "導入を取り消しました。もう一度押すと、途中から続けます。" })];
    return [];
  }

  function primaryView() {
    if (install?.state === "running") return runningView();
    if (confirming) return confirmView();
    const view = [...resultView()];
    if (!audio.ready.separate) {
      view.push(button(audio.demucsError ? "音声ツールを直す" : "音声ツールを導入する", () => openConfirm(false), "primary"), ...systemSteps());
    } else {
      view.push(h("p", { className: "ok", textContent: "✓ 分離とビート解析が使えます" }));
      // Swapping to the GPU build is only offered for the app's own environment: no other Python is ever changed.
      if (audio.gpu && audio.python.where?.includes(".mv-studio")) view.push(button("GPU 版に入れ替える(任意)", () => openConfirm(true)));
    }
    return view;
  }

  function moreView() {
    const pythonInput = h("input", { type: "text", placeholder: "Python のパス(空欄 = 自動)", value: audio.pythonPath ?? "" });
    const model = h("select", {}, ...["htdemucs", "htdemucs_ft"].map((m) => h("option", { value: m, selected: m === audio.model, textContent: m === "htdemucs" ? "htdemucs(標準・速い)" : "htdemucs_ft(高精度・約4倍遅い)" })));
    model.addEventListener("change", () => saveModel(model.value));
    return h("details", { className: "sec-more" },
      h("summary", { textContent: "詳しい設定" }),
      h("div", { className: "sec-more-body" },
        button("再確認", recheck),
        h("p", { className: "sec-note", textContent: "Python のパス(Demucs を入れた別の環境を使う場合)" }),
        pythonInput,
        h("div", { className: "panel-actions" }, button("使う", () => savePython(pythonInput.value.trim() || null)), button("自動に戻す", () => savePython(null))),
        h("label", { className: "sec-note", textContent: "分離のモデル: " }, model),
        ...audio.install.filter((step) => step.kind !== "system").flatMap((step) => [
          h("p", { className: "sec-note", textContent: `手動で入れる場合: ${step.label}` }),
          h("div", { className: "cmd" }, h("pre", { textContent: step.command }), copyButton(step.command)),
        ]),
      ),
    );
  }

  function updateSummary() {
    if (!audio) return setSummary("確認中…", "neutral");
    if (install?.state === "running") return setSummary("導入中…", "neutral");
    if (audio.ready.separate) return setSummary(audio.cuda ? "✓ 使えます · GPU" : "✓ 使えます", "ok");
    return setSummary(audio.ready.beats ? "△ ビート解析のみ" : "⚠ 導入が必要", "warn");
  }

  function render(force = false) {
    if (destroyed) return;
    const key = JSON.stringify([audio, install, plan, confirming, wantGpu]);
    if (!force && key === shownKey) return;
    shownKey = key;
    updateSummary();
    if (!audio) return box.replaceChildren(h("p", { className: "sec-note", textContent: "確認中…(初回は数秒かかります)" }));
    box.replaceChildren(chips(), ...primaryView(), moreView());
  }

  render(true);
  load();
  return { destroy() { destroyed = true; clearTimeout(timer); } };
}

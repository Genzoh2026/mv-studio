// The "Audio tools" section of the settings panel: what this computer has for separating songs and finding beats, and a
// one-button setup for what is missing. The setup is shown and confirmed first, runs on the server inside the workspace's
// own Python environment (no other Python is touched), streams its log here, and can be cancelled.
// The calm state is one line of chips and a sentence; everything else (commands, Python path, model) is folded away.
import { toast } from "/toast.js";
import { t } from "/i18n.js";

const POLL_MS = 1000;
const SHOWN_LOG_LINES = 8;
const DOWNLOAD_CPU = t("約 0.7 GB");
const DOWNLOAD_GPU = t("+ 約 3 GB");
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
    if (install.state === "done") toast(audio?.ready.separate ? t("導入できました。分離とビート解析が使えます") : t("導入は終わりました。まだ足りないものがあります"), { key: "audio-setup", kind: audio?.ready.separate ? "info" : "warn" });
    else if (install.state === "error") toast(t("導入に失敗しました。ログを確認してください"), { key: "audio-setup", kind: "error" });
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
    toast(path ? t("Python のパスを保存しました") : t("自動検出に戻しました"), { key: "audio-tools" });
  }

  async function saveModel(model) {
    const res = await post("/api/audio-tools/model", { model });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: "audio-tools", kind: "error" });
    audio = answer;
    render(true);
    changed();
    toast(t("分離のモデルを {model} にしました", { model }), { key: "audio-tools" });
  }

  async function recheck() {
    audio = null;
    render(true);
    audio = await get("/api/audio-tools?refresh=1").catch(() => null);
    render(true);
    changed();
    toast(audio?.ready.separate ? t("分離とビート解析が使えます") : audio?.ready.beats ? t("ビート解析が使えます(分離には Demucs が必要です)") : t("まだ足りないものがあります"), { key: "audio-tools", kind: audio?.ready.beats ? "info" : "warn" });
  }

  const copyButton = (text) => h("button", { type: "button", textContent: t("コピー"), onclick: async () => { await navigator.clipboard.writeText(text); toast(t("コピーしました"), { key: "copied" }); } });
  const button = (textContent, onclick, className = "") => h("button", { type: "button", textContent, onclick, className });
  const chip = (state, text, title) => h("span", { className: `chip ${state}`, textContent: text, title });

  /** One row of chips instead of five paragraphs. The hover text carries the versions and the reason. */
  function chips() {
    const demucsOk = Boolean(audio.demucs) && !audio.demucsError;
    return h("div", { className: "chips" },
      chip(audio.python.found ? "ok" : "bad", `${audio.python.found ? "✓" : "✗"} Python`, audio.python.found ? `Python ${audio.python.version}\n${audio.python.where}` : t("Python が見つかりません")),
      chip(audio.numpy ? "ok" : "bad", `${audio.numpy ? "✓" : "✗"} numpy`, audio.numpy ? t("numpy {v}(ビート解析)", { v: audio.numpy }) : t("numpy がありません(ビート解析に必要)")),
      chip(demucsOk ? "ok" : "bad", `${demucsOk ? "✓" : "✗"} Demucs`, !audio.demucs ? t("Demucs がありません(曲の分離に必要)") : audio.demucsError ? t("入っていますが、動きません: {error}", { error: audio.demucsError }) : t("Demucs {v}(曲の分離)", { v: audio.demucs })),
      chip(audio.ffmpeg.found ? "ok" : "bad", `${audio.ffmpeg.found ? "✓" : "✗"} ffmpeg`, audio.ffmpeg.found ? `ffmpeg ${audio.ffmpeg.version}` : t("ffmpeg が見つかりません")),
      // The GPU chip describes separation, so it only means something once Demucs works (another Python may have a GPU build).
      ...(!demucsOk ? [] : [audio.cuda ? chip("ok", "✓ GPU", t("PyTorch {v} / CUDA で分離します", { v: audio.torch ?? "" }))
        : audio.gpu ? chip("warn", t("GPU 未使用"), t("NVIDIA GPU({gpu})がありますが、PyTorch が GPU 非対応の版です。CPU で動きます", { gpu: audio.gpu }))
          : chip("neutral", "CPU", t("GPU は使いません(曲 1 分で数十秒〜数分)"))]),
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
      h("p", { textContent: t("導入しています…(画面を閉じても続きます)") }),
      ...install.steps.map((step) => h("p", { className: step.state === "error" ? "bad" : "sec-note", textContent: `${STEP_ICON[step.state]} ${step.label}` })),
      log,
      button(t("取り消し"), async () => { await post("/api/audio-install/cancel"); await load(); }),
    ];
  }

  function confirmView() {
    if (!plan) return [h("p", { className: "sec-note", textContent: t("確認中…") })];
    if (!plan.ok) return [h("p", { className: "bad", textContent: plan.reason }), ...systemSteps(), button(t("閉じる"), () => { confirming = false; render(); })];
    return [
      h("p", { textContent: t("専用環境に、次を入れます(他の Python には触れません)。") }),
      h("p", { className: "sec-note", textContent: plan.venvDir }),
      ...(plan.warning ? [h("p", { className: "bad", textContent: plan.warning })] : []),
      ...plan.steps.map((step) => h("pre", { className: "setup-cmd", textContent: step.display })),
      h("p", { className: "sec-note", textContent: t("ダウンロード {size} · 数分〜十数分", { size: `${DOWNLOAD_CPU}${plan.gpuStep ? ` ${DOWNLOAD_GPU}` : ""}` }) }),
      ...(plan.gpuAvailable ? [h("label", { className: "setup-gpu" }, Object.assign(h("input", { type: "checkbox" }), { checked: wantGpu, onchange: (event) => openConfirm(event.target.checked) }), ` ${t("GPU 版を使う({name}。{size})", { name: plan.gpuName, size: DOWNLOAD_GPU })}`)] : []),
      h("div", { className: "panel-actions" }, button(t("導入する"), start, "danger"), button(t("やめる"), () => { confirming = false; render(); })),
    ];
  }

  function resultView() {
    if (!install || install.state === "idle" || install.state === "running") return [];
    const log = h("details", { className: "sec-more" }, h("summary", { textContent: t("ログ") }), h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") }));
    if (install.state === "error") return [h("p", { className: "bad", textContent: t("導入に失敗しました: {error}", { error: install.error }) }), log];
    if (install.state === "cancelled") return [h("p", { className: "sec-note", textContent: t("導入を取り消しました。もう一度押すと、途中から続けます。") })];
    return [];
  }

  function primaryView() {
    if (install?.state === "running") return runningView();
    if (confirming) return confirmView();
    const view = [...resultView()];
    if (!audio.ready.separate) {
      view.push(button(audio.demucsError ? t("音声ツールを直す") : t("音声ツールを導入する"), () => openConfirm(false), "primary"), ...systemSteps());
    } else {
      view.push(h("p", { className: "ok", textContent: t("✓ 分離とビート解析が使えます") }));
      // Swapping to the GPU build is only offered for the app's own environment: no other Python is ever changed.
      if (audio.gpu && audio.python.where?.includes(".mv-studio")) view.push(button(t("GPU 版に入れ替える(任意)"), () => openConfirm(true)));
    }
    return view;
  }

  function moreView() {
    const pythonInput = h("input", { type: "text", placeholder: t("Python のパス(空欄 = 自動)"), value: audio.pythonPath ?? "" });
    const model = h("select", {}, ...["htdemucs", "htdemucs_ft"].map((m) => h("option", { value: m, selected: m === audio.model, textContent: m === "htdemucs" ? t("htdemucs(標準・速い)") : t("htdemucs_ft(高精度・約4倍遅い)") })));
    model.addEventListener("change", () => saveModel(model.value));
    return h("details", { className: "sec-more" },
      h("summary", { textContent: t("詳しい設定") }),
      h("div", { className: "sec-more-body" },
        button(t("再確認"), recheck),
        h("p", { className: "sec-note", textContent: t("Python のパス(Demucs を入れた別の環境を使う場合)") }),
        pythonInput,
        h("div", { className: "panel-actions" }, button(t("使う"), () => savePython(pythonInput.value.trim() || null)), button(t("自動に戻す"), () => savePython(null))),
        h("label", { className: "sec-note", textContent: t("分離のモデル: ") }, model),
        ...audio.install.filter((step) => step.kind !== "system").flatMap((step) => [
          h("p", { className: "sec-note", textContent: t("手動で入れる場合: {label}", { label: step.label }) }),
          h("div", { className: "cmd" }, h("pre", { textContent: step.command }), copyButton(step.command)),
        ]),
      ),
    );
  }

  function updateSummary() {
    if (!audio) return setSummary(t("確認中…"), "neutral");
    if (install?.state === "running") return setSummary(t("導入中…"), "neutral");
    if (audio.ready.separate) return setSummary(audio.cuda ? t("✓ 使えます · GPU") : t("✓ 使えます"), "ok");
    return setSummary(audio.ready.beats ? t("△ ビート解析のみ") : t("⚠ 導入が必要"), "warn");
  }

  function render(force = false) {
    if (destroyed) return;
    const key = JSON.stringify([audio, install, plan, confirming, wantGpu]);
    if (!force && key === shownKey) return;
    shownKey = key;
    updateSummary();
    if (!audio) return box.replaceChildren(h("p", { className: "sec-note", textContent: t("確認中…(初回は数秒かかります)") }));
    box.replaceChildren(chips(), ...primaryView(), moreView());
  }

  render(true);
  load();
  return { destroy() { destroyed = true; clearTimeout(timer); } };
}

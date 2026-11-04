// The "Video tools" part of the settings panel: the curated list of skills, plugins and tools for making videos, with
// what is installed in the chosen project and a button that installs one. Every install shows the exact commands first,
// runs on the server (only the catalog's own checked commands), streams its log here and can be cancelled.
import { toast } from "/toast.js";

const POLL_MS = 1000;
const SHOWN_LOG_LINES = 12;
const STEP_ICON = { waiting: "○", running: "⏳", done: "✓", error: "✗", cancelled: "—" };
const KIND_LABELS = { skills: "スキル", plugin: "プラグイン", mcp: "MCP", connector: "コネクタ", builtin: "アプリ内蔵", system: "PC にインストール" };
const STATE_LABELS = { installed: "✓ 導入済み", partial: "△ 一部だけ導入", "not-installed": "未導入", unknown: "状態不明", builtin: "✓ アプリが提供", manual: "手動で設定" };
const COST_LABELS = { none: null, "account-required": "アカウントが必要", "paid-accounts": "料金がかかります" };
const COMMAND_KINDS = new Set(["skills", "plugin", "mcp"]);
// What to do after an install so that a Claude that is already running notices it.
const AFTER_INSTALL = {
  skills: "動いている Claude には、まもなく自動で反映されます。反映されないときは、その Claude で /reload-skills と入力してください。",
  plugin: "動いている Claude に反映するには、その Claude で /reload-plugins と入力するか、プロジェクトの Claude を終了して開き直してください。",
  mcp: "プロジェクトの Claude を終了して開き直してください(最初に使うとき、Claude Code が承認を求めます)。",
};

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const get = async (path) => { const res = await fetch(path, { cache: "no-store" }); return res.ok ? res.json() : null; };
const post = (path, payload = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

/** @param {HTMLElement} box where the panel is drawn */
export function createVideoToolsPanel(box) {
  let catalog = null;       // /api/video-tools for the chosen project
  let projects = [];        // names for the project chooser
  let pj = document.body.dataset.pj || "";
  let install = null;       // the running or last install
  let confirming = null;    // { id, scope, plan }
  let timer = null;
  let destroyed = false;
  let shownKey = null;

  async function load() {
    try {
      if (!projects.length) projects = (await get("/api/pjs"))?.map((p) => p.name) ?? [];
      if (!pj || !projects.includes(pj)) pj = projects[0] ?? "";
      [catalog, install] = await Promise.all([get(`/api/video-tools?pj=${encodeURIComponent(pj)}`), get("/api/video-tools/install")]);
    } catch { /* the server may be restarting */ }
    render();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (destroyed || install?.state !== "running") return;
    timer = setTimeout(async () => {
      const before = install?.state;
      install = (await get("/api/video-tools/install").catch(() => null)) ?? install;
      if (before === "running" && install?.state !== "running") {
        catalog = (await get(`/api/video-tools?pj=${encodeURIComponent(pj)}`).catch(() => null)) ?? catalog;
        announce();
      }
      render();
      schedule();
    }, POLL_MS);
  }

  const entryName = (id) => catalog?.entries.find((e) => e.id === id)?.name ?? id;

  function announce() {
    if (install.state === "done") toast(`${entryName(install.entryId)} を導入しました`, { key: "video-tools" });
    else if (install.state === "error") toast(`${entryName(install.entryId)} の導入に失敗しました。下のログを確認してください`, { key: "video-tools", kind: "error" });
  }

  async function openConfirm(id, scope) {
    confirming = { id, scope, plan: null };
    render();
    const plan = await get(`/api/video-tools/plan?id=${encodeURIComponent(id)}&scope=${scope}&pj=${encodeURIComponent(pj)}`).catch(() => null);
    if (confirming?.id === id && confirming.scope === scope) confirming.plan = plan ?? { ok: false, reason: "確認できませんでした", steps: [] };
    render();
  }

  async function start() {
    const { id, scope } = confirming;
    const res = await post("/api/video-tools/install", { id, scope, pj, confirmed: true });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: "video-tools", kind: "error" });
    confirming = null;
    install = answer;
    render();
    schedule();
  }

  const button = (textContent, onclick, className = "") => h("button", { type: "button", textContent, onclick, className });
  const copyButton = (text) => button("コピー", async () => { await navigator.clipboard.writeText(text); toast("コピーしました", { key: "copied" }); });
  const list = (items) => h("ul", { className: "vt-list" }, ...items.map((text) => h("li", { textContent: text })));

  function badges(entry) {
    const items = [
      entry.maker === "official" ? "公式" : "コミュニティ製",
      KIND_LABELS[entry.kind],
      entry.status === "recommended" ? "おすすめ" : null,
      COST_LABELS[entry.costs],
      entry.signin ? "サインインが必要" : null,
    ].filter(Boolean);
    return h("div", { className: "vt-badges" }, ...items.map((text) => h("span", { className: `vt-badge${text === "料金がかかります" ? " warn" : ""}`, textContent: text })));
  }

  function details(entry) {
    const parts = [h("p", { textContent: entry.use_when_ja })];
    if (entry.requires?.length) parts.push(h("p", { className: "meta", textContent: "必要なもの:" }), list(entry.requires));
    if (entry.notes_ja?.length) parts.push(h("p", { className: "meta", textContent: "注意:" }), list(entry.notes_ja));
    parts.push(h("p", { className: "meta" }, `ライセンス: ${entry.license} · 確認日: ${entry.verified} · `, h("a", { href: entry.source, target: "_blank", rel: "noopener noreferrer", textContent: "配布元 ↗" })));
    if (entry.manual_steps_ja) {
      parts.push(h("p", { className: "meta", textContent: "手順(自分で行います):" }), ...entry.manual_steps_ja.map((step) => (/^(winget|brew|sudo|npx|claude) /.test(step) || /: (winget|brew|sudo) /.test(step)
        ? h("div", { className: "cmd" }, h("pre", { textContent: step.replace(/^[A-Za-z ]+: /, "") }), copyButton(step.replace(/^[A-Za-z ]+: /, "")))
        : h("p", { className: "meta", textContent: step }))));
    }
    return h("details", { className: "vt-details" }, h("summary", { textContent: "くわしく" }), ...parts);
  }

  function card(entry) {
    const state = entry.installed.state;
    const canInstall = COMMAND_KINDS.has(entry.kind) && state !== "installed";
    const busy = install?.state === "running";
    return h("div", { className: "vt-card" },
      h("div", { className: "vt-head" }, h("strong", { textContent: entry.name }), h("span", { className: `vt-state ${state}`, textContent: `${STATE_LABELS[state] ?? state}${entry.installed.detail ? `(${entry.installed.detail})` : ""}` })),
      badges(entry),
      h("p", { textContent: entry.summary_ja }),
      canInstall ? button(state === "partial" ? "続きを導入する" : "導入する", () => openConfirm(entry.id, "project"), "primary") : h("span"),
      ...(canInstall && busy ? [h("span", { className: "meta", textContent: " (別の導入が実行中です)" })] : []),
      details(entry),
    );
  }

  function confirmView() {
    const entry = catalog.entries.find((e) => e.id === confirming.id);
    const { plan, scope } = confirming;
    const scopeChoice = h("div", { className: "vt-scope" },
      h("label", {}, Object.assign(h("input", { type: "radio", name: "vt-scope" }), { checked: scope === "project", onchange: () => openConfirm(entry.id, "project") }), ` このプロジェクトだけ(${pj || "未選択"})。おすすめ`),
      h("label", {}, Object.assign(h("input", { type: "radio", name: "vt-scope" }), { checked: scope === "user", onchange: () => openConfirm(entry.id, "user") }), " すべてのプロジェクトで使う(あなたの Claude 全体の設定に入ります)"));
    const cost = COST_LABELS[entry.costs];
    return h("div", { className: "vt-confirm" },
      h("h4", { textContent: `${entry.name} を導入しますか?` }),
      h("p", { className: "meta", textContent: `${entry.maker === "official" ? "公式" : "コミュニティ製"} · ライセンス ${entry.license}` }),
      scopeChoice,
      ...(entry.requires?.length ? [h("p", { className: "meta", textContent: "必要なもの(入っていないと、動きません):" }), list(entry.requires)] : []),
      ...(cost || entry.signin ? [h("p", { className: "bad", textContent: [cost, entry.signin ? "初回にサインインします(あなたが行います)" : null].filter(Boolean).join("。") })] : []),
      ...(entry.notes_ja?.length ? [h("p", { className: "meta", textContent: "注意:" }), list(entry.notes_ja)] : []),
      !plan ? h("p", { className: "meta", textContent: "確認中…" })
        : !plan.ok ? h("p", { className: "bad", textContent: plan.reason })
          : h("div", {}, h("p", { className: "meta", textContent: "次のコマンドを実行します(この内容だけです):" }), ...plan.steps.flatMap((step) => [h("pre", { className: "setup-cmd", textContent: step.display }), h("p", { className: "meta", textContent: `実行する場所: ${step.cwd}` })])),
      h("div", { className: "panel-actions" }, ...(plan?.ok ? [button("導入する", start, "danger")] : []), button("やめる", () => { confirming = null; render(); })),
    );
  }

  function runningView() {
    const log = h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") });
    queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
    return h("div", { className: "vt-confirm" },
      h("p", { textContent: `${entryName(install.entryId)} を導入しています…${install.scope === "user" ? "(すべてのプロジェクト)" : `(${install.pj})`}` }),
      ...install.steps.map((step) => h("p", { className: step.state === "error" ? "bad" : "meta", textContent: `${STEP_ICON[step.state]} ${step.display}` })),
      log,
      button("取り消し", async () => { await post("/api/video-tools/cancel"); await load(); }));
  }

  function resultView() {
    if (!install || install.state === "idle" || install.state === "running") return null;
    const kind = catalog?.entries.find((e) => e.id === install.entryId)?.kind;
    const log = h("details", {}, h("summary", { textContent: "ログ" }), h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") }));
    if (install.state === "error") return h("div", { className: "vt-result" }, h("p", { className: "bad", textContent: `${entryName(install.entryId)} の導入に失敗しました: ${install.error}` }), log);
    if (install.state === "cancelled") return h("div", { className: "vt-result" }, h("p", { className: "meta", textContent: "導入を取り消しました。" }));
    return h("div", { className: "vt-result" }, h("p", { className: "ok", textContent: `✓ ${entryName(install.entryId)} を導入しました` }), h("p", { className: "meta", textContent: AFTER_INSTALL[kind] ?? "" }), log);
  }

  function render(force = false) {
    if (destroyed) return;
    const key = JSON.stringify([catalog, install, confirming, pj, projects]);
    if (!force && key === shownKey) return;
    shownKey = key;
    if (!catalog) return box.replaceChildren(h("p", { className: "meta", textContent: "確認中…" }));
    if (!catalog.available) return box.replaceChildren(h("p", { className: "bad", textContent: "ツール一覧(catalog/video-tools.json)を読み込めませんでした。アプリのログを確認してください。" }));
    if (install?.state === "running") return box.replaceChildren(runningView());
    if (confirming) return box.replaceChildren(confirmView());
    const chooser = h("select", {}, ...projects.map((name) => h("option", { value: name, selected: name === pj, textContent: name })));
    chooser.addEventListener("change", async () => { pj = chooser.value; catalog = await get(`/api/video-tools?pj=${encodeURIComponent(pj)}`); render(true); });
    box.replaceChildren(
      h("p", { className: "meta", textContent: "動画づくりに使えるスキル・プラグインの、確認済みの一覧です。載っているものだけを、ボタンで導入できます。導入の前に、実行する内容を確認できます。" }),
      ...(projects.length ? [h("label", { className: "meta", textContent: "導入先のプロジェクト: " }, chooser)] : [h("p", { className: "meta", textContent: "プロジェクトを作ると、導入できます。" })]),
      ...(resultView() ? [resultView()] : []),
      ...catalog.entries.map(card),
    );
  }

  render(true);
  load();
  return { destroy() { destroyed = true; clearTimeout(timer); } };
}

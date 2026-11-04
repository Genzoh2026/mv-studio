// The "Library" panel (🧩 in the left rail): the curated list of skills, plugins and tools for making videos, with
// what is installed in the chosen project and a button that installs one. Every install shows the exact commands first,
// runs on the server (only the catalog's own checked commands), streams its log here and can be cancelled.
// The list is one line per entry (name, state, a small button); the explanation opens only when a row is clicked.
import { toast } from "/toast.js";

const POLL_MS = 1000;
const SHOWN_LOG_LINES = 8;
const STEP_ICON = { waiting: "○", running: "⏳", done: "✓", error: "✗", cancelled: "—" };
const KIND_LABELS = { skills: "スキル", plugin: "プラグイン", mcp: "MCP", connector: "コネクタ", builtin: "アプリ内蔵", system: "PC に導入" };
const STATE_LABELS = { installed: "導入済み", partial: "一部のみ", "not-installed": "未導入", unknown: "不明", builtin: "内蔵", manual: "手動" };
const COST_LABELS = { none: null, "account-required": "アカウントが必要", "paid-accounts": "料金がかかります" };
const COMMAND_KINDS = new Set(["skills", "plugin", "mcp"]);
const CATEGORY_FILTERS = [
  ["all", "すべて"],
  ["render", "描画"],
  ["music-video", "MV"],
  ["animation", "アニメ"],
  ["generation", "生成"],
  ["captions", "字幕"],
  ["editing", "編集"],
  ["audio", "音声"],
];
const STATE_FILTERS = [
  ["all", "すべて"],
  ["installed", "導入済み"],
  ["not-installed", "未導入"],
];
// What to do after an install so that a Claude that is already running notices it.
const AFTER_INSTALL = {
  skills: "動いている Claude には、まもなく自動で反映されます。されないときは、その Claude で /reload-skills と入力してください。",
  plugin: "動いている Claude に反映するには、その Claude で /reload-plugins と入力するか、開き直してください。",
  mcp: "プロジェクトの Claude を終了して開き直してください(最初に使うとき、承認が求められます)。",
};
const GROUPS = [
  ["おすすめ", (e) => e.status === "recommended" && COMMAND_KINDS.has(e.kind)],
  ["そのほか", (e) => e.status !== "recommended" && COMMAND_KINDS.has(e.kind)],
  ["アプリ内蔵・手動で設定", (e) => !COMMAND_KINDS.has(e.kind)],
];

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const get = async (path) => { const res = await fetch(path, { cache: "no-store" }); return res.ok ? res.json() : null; };
const post = (path, payload = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
/** The part of a name before its parenthesis ("Remotion(React で…)" -> "Remotion"): short enough for one line. */
const shortName = (name) => name.replace(/[(（].*$/, "").trim() || name;

/**
 * @param {HTMLElement} box where the section body is drawn
 * @param {{setSummary: (text: string, level?: "ok"|"warn"|"bad"|"neutral") => void}} section the header's one-line status
 */
export function createVideoToolsPanel(box, { setSummary = () => {} } = {}) {
  let catalog = null;       // /api/video-tools for the chosen project
  let projects = [];        // names for the project chooser
  let pj = document.body.dataset.pj || "";
  let install = null;       // the running or last install
  let confirming = null;    // { id, scope, plan }
  const open = new Set();   // entries whose explanation is shown
  let query = "";
  let category = "all";
  let stateFilter = "all";
  let timer = null;
  let destroyed = false;
  let shownKey = null;

  const listBox = h("div", { className: "vt-entries" });
  const searchInput = h("input", {
    type: "search",
    className: "vt-search",
    placeholder: "名前・説明で絞り込み",
    ariaLabel: "名前・説明で絞り込み",
    oninput: () => { query = searchInput.value; renderList(); },
  });
  const catButtons = new Map();
  const stateButtons = new Map();
  const catRow = h("div", { className: "chips vt-chips", role: "group", ariaLabel: "用途で絞り込み" },
    ...CATEGORY_FILTERS.map(([id, label]) => {
      const btn = h("button", {
        type: "button",
        className: "chip vt-chip",
        textContent: label,
        onclick: () => { category = category === id && id !== "all" ? "all" : id; updateChips(); renderList(); },
      });
      catButtons.set(id, btn);
      return btn;
    }),
  );
  const stateRow = h("div", { className: "chips vt-chips", role: "group", ariaLabel: "状態で絞り込み" },
    ...STATE_FILTERS.map(([id, label]) => {
      const btn = h("button", {
        type: "button",
        className: "chip vt-chip",
        textContent: label,
        onclick: () => { stateFilter = stateFilter === id && id !== "all" ? "all" : id; updateChips(); renderList(); },
      });
      stateButtons.set(id, btn);
      return btn;
    }),
  );
  const filterBar = h("div", { className: "vt-filters" }, searchInput, catRow, stateRow);

  function updateChips() {
    for (const [id, btn] of catButtons) btn.classList.toggle("on", id === category);
    for (const [id, btn] of stateButtons) btn.classList.toggle("on", id === stateFilter);
  }
  updateChips();

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

  const entryName = (id) => shortName(catalog?.entries.find((e) => e.id === id)?.name ?? id);

  function announce() {
    if (install.state === "done") toast(`${entryName(install.entryId)} を導入しました`, { key: "video-tools" });
    else if (install.state === "error") toast(`${entryName(install.entryId)} の導入に失敗しました。ログを確認してください`, { key: "video-tools", kind: "error" });
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

  const button = (textContent, onclick, className = "", title = "") => h("button", { type: "button", textContent, onclick, className, title });
  const copyButton = (text) => button("コピー", async () => { await navigator.clipboard.writeText(text); toast("コピーしました", { key: "copied" }); });
  const list = (items) => h("ul", { className: "vt-list" }, ...items.map((text) => h("li", { textContent: text })));

  /** What the row says in small print: who made it, what kind, and the warnings that matter before pressing the button. */
  function metaLine(entry) {
    const parts = [entry.maker === "official" ? "公式" : "コミュニティ製", KIND_LABELS[entry.kind], COST_LABELS[entry.costs], entry.signin ? "サインイン" : null].filter(Boolean);
    return parts.join(" · ");
  }

  function details(entry) {
    const parts = [h("p", { textContent: entry.summary_ja }), h("p", { className: "sec-note", textContent: entry.use_when_ja })];
    if (entry.requires?.length) parts.push(h("p", { className: "sec-note", textContent: "必要なもの" }), list(entry.requires));
    if (entry.notes_ja?.length) parts.push(h("p", { className: "sec-note", textContent: "注意" }), list(entry.notes_ja));
    parts.push(h("p", { className: "sec-note" }, `ライセンス ${entry.license} · 確認日 ${entry.verified} · `, h("a", { href: entry.source, target: "_blank", rel: "noopener noreferrer", textContent: "配布元 ↗" })));
    if (entry.manual_steps_ja) {
      parts.push(h("p", { className: "sec-note", textContent: "手順(自分で行います)" }), ...entry.manual_steps_ja.map((step) => {
        const command = /(winget|brew|sudo) /.test(step) ? step.replace(/^[A-Za-z ]+: /, "") : null;
        return command ? h("div", { className: "cmd" }, h("pre", { textContent: command }), copyButton(command)) : h("p", { className: "sec-note", textContent: step });
      }));
    }
    return h("div", { className: "vt-more" }, ...parts);
  }

  function row(entry) {
    const state = entry.installed.state;
    const expanded = open.has(entry.id);
    const canInstall = COMMAND_KINDS.has(entry.kind) && state !== "installed";
    const stateText = h("span", { className: `vt-state ${state}`, textContent: STATE_LABELS[state] ?? state, title: entry.installed.detail ?? "" });
    const toggle = h("button", { type: "button", className: "vt-toggle", onclick: () => { if (expanded) open.delete(entry.id); else open.add(entry.id); render(true); } },
      h("span", { className: "vt-name", textContent: shortName(entry.name), title: entry.name }),
      h("span", { className: "vt-meta", textContent: metaLine(entry) }));
    return h("div", { className: `vt-row${expanded ? " open" : ""}` },
      h("div", { className: "vt-line" },
        toggle,
        COMMAND_KINDS.has(entry.kind) ? (canInstall ? button(state === "partial" ? "続き" : "導入", () => openConfirm(entry.id, "project"), "vt-install", "導入の内容を確認します") : stateText) : stateText),
      ...(expanded ? [details(entry)] : []),
    );
  }

  function confirmView() {
    const entry = catalog.entries.find((e) => e.id === confirming.id);
    const { plan, scope } = confirming;
    const radio = (value, label) => h("label", {}, Object.assign(h("input", { type: "radio", name: "vt-scope" }), { checked: scope === value, onchange: () => openConfirm(entry.id, value) }), ` ${label}`);
    const cost = COST_LABELS[entry.costs];
    return h("div", { className: "vt-confirm" },
      h("h4", { textContent: `${shortName(entry.name)} を導入しますか?` }),
      h("p", { className: "sec-note", textContent: `${metaLine(entry)} · ライセンス ${entry.license}` }),
      h("div", { className: "vt-scope" }, radio("project", `このプロジェクトだけ(${pj || "未選択"})`), radio("user", "すべてのプロジェクト(Claude 全体の設定に入ります)")),
      ...(entry.requires?.length ? [h("p", { className: "sec-note", textContent: "必要なもの(入っていないと動きません)" }), list(entry.requires)] : []),
      ...(cost || entry.signin ? [h("p", { className: "bad", textContent: [cost, entry.signin ? "初回にサインインします(あなたが行います)" : null].filter(Boolean).join("。") })] : []),
      ...(entry.notes_ja?.length ? [h("p", { className: "sec-note", textContent: "注意" }), list(entry.notes_ja)] : []),
      !plan ? h("p", { className: "sec-note", textContent: "確認中…" })
        : !plan.ok ? h("p", { className: "bad", textContent: plan.reason })
          : h("div", {}, h("p", { className: "sec-note", textContent: "実行するコマンド(この内容だけです)" }), ...plan.steps.flatMap((step) => [h("pre", { className: "setup-cmd", textContent: step.display }), h("p", { className: "sec-note", textContent: `場所: ${step.cwd}` })])),
      h("div", { className: "panel-actions" }, ...(plan?.ok ? [button("導入する", start, "danger")] : []), button("やめる", () => { confirming = null; render(); })),
    );
  }

  function runningView() {
    const log = h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") });
    queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
    return h("div", { className: "vt-confirm" },
      h("p", { textContent: `${entryName(install.entryId)} を導入しています…${install.scope === "user" ? "(すべてのプロジェクト)" : `(${install.pj})`}` }),
      ...install.steps.map((step) => h("p", { className: step.state === "error" ? "bad" : "sec-note", textContent: `${STEP_ICON[step.state]} ${step.display}` })),
      log,
      button("取り消し", async () => { await post("/api/video-tools/cancel"); await load(); }));
  }

  function resultView() {
    if (!install || install.state === "idle" || install.state === "running") return null;
    const kind = catalog?.entries.find((e) => e.id === install.entryId)?.kind;
    const log = h("details", { className: "sec-more" }, h("summary", { textContent: "ログ" }), h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") }));
    if (install.state === "error") return h("div", { className: "vt-result" }, h("p", { className: "bad", textContent: `${entryName(install.entryId)} の導入に失敗しました: ${install.error}` }), log);
    if (install.state === "cancelled") return h("div", { className: "vt-result" }, h("p", { className: "sec-note", textContent: "導入を取り消しました。" }));
    return h("div", { className: "vt-result" }, h("p", { className: "ok", textContent: `✓ ${entryName(install.entryId)} を導入しました` }), h("p", { className: "sec-note", textContent: AFTER_INSTALL[kind] ?? "" }), log);
  }

  function updateSummary() {
    if (!catalog?.available) return setSummary(catalog ? "⚠ 読み込めません" : "確認中…", catalog ? "bad" : "neutral");
    if (install?.state === "running") return setSummary("導入中…", "neutral");
    const installable = catalog.entries.filter((e) => COMMAND_KINDS.has(e.kind));
    const done = installable.filter((e) => e.installed.state === "installed").length;
    setSummary(`導入済み ${done} / ${installable.length}`, "neutral");
  }

  function matchesFilter(entry) {
    if (category !== "all" && !entry.category?.includes(category)) return false;
    const isInstalled = entry.installed.state === "installed" || entry.installed.state === "builtin";
    if (stateFilter === "installed" && !isInstalled) return false;
    if (stateFilter === "not-installed" && isInstalled) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [entry.name, entry.id, entry.summary_ja, entry.use_when_ja].filter(Boolean).join("\n").toLowerCase();
    return hay.includes(q);
  }

  function renderList() {
    if (!catalog?.available) return;
    const filtered = catalog.entries.filter(matchesFilter);
    if (!filtered.length) {
      listBox.replaceChildren(h("p", { className: "sec-note", textContent: "該当するツールがありません。" }));
      return;
    }
    listBox.replaceChildren(
      ...GROUPS.flatMap(([title, test]) => {
        const entries = filtered.filter(test);
        return entries.length ? [h("h5", { className: "vt-group", textContent: title }), ...entries.map(row)] : [];
      }),
    );
  }

  function render(force = false) {
    if (destroyed) return;
    const key = JSON.stringify([catalog, install, confirming, pj, projects, [...open]]);
    if (!force && key === shownKey) return;
    shownKey = key;
    updateSummary();
    if (!catalog) return box.replaceChildren(h("p", { className: "sec-note", textContent: "確認中…" }));
    if (!catalog.available) return box.replaceChildren(h("p", { className: "bad", textContent: "ツール一覧(catalog/video-tools.json)を読み込めませんでした。アプリのログを確認してください。" }));
    if (install?.state === "running") return box.replaceChildren(runningView());
    if (confirming) return box.replaceChildren(confirmView());
    const chooser = h("select", { title: "導入先のプロジェクト" }, ...projects.map((name) => h("option", { value: name, selected: name === pj, textContent: name })));
    chooser.addEventListener("change", async () => { pj = chooser.value; catalog = await get(`/api/video-tools?pj=${encodeURIComponent(pj)}`); render(true); });
    const installable = catalog.entries.filter((e) => COMMAND_KINDS.has(e.kind));
    const done = installable.filter((e) => e.installed.state === "installed").length;
    const result = resultView();
    updateChips();
    renderList();
    box.replaceChildren(
      h("div", { className: "vt-target" },
        h("span", { className: "sec-note", textContent: "導入先" }),
        projects.length ? chooser : h("span", { className: "sec-note", textContent: "プロジェクトを作ると導入できます" }),
        h("span", { className: "sec-sum", textContent: `導入済み ${done} / ${installable.length}` }),
      ),
      ...(result ? [result] : []),
      filterBar,
      listBox,
    );
  }

  render(true);
  load();
  return { destroy() { destroyed = true; clearTimeout(timer); } };
}

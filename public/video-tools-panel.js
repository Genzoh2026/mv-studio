// The "Library" panel (🧩 in the left rail): the curated list of skills, plugins and tools for making videos, with
// what is installed in the chosen project and a button that installs one. Every install shows the exact commands first,
// runs on the server (only the catalog's own checked commands), streams its log here and can be cancelled.
// The list is one line per entry (name, state, a small button); the explanation opens only when a row is clicked.
import { toast } from "/toast.js";
import { lang, t } from "/i18n.js";

const POLL_MS = 1000;
const SHOWN_LOG_LINES = 8;
const STEP_ICON = { waiting: "○", running: "⏳", done: "✓", error: "✗", cancelled: "—", skipped: "−" };
const KIND_LABELS = { skills: t("スキル"), plugin: t("プラグイン"), mcp: "MCP", connector: t("コネクタ"), builtin: t("アプリ内蔵"), system: t("PC に導入") };
const STATE_LABELS = { installed: t("導入済み"), partial: t("一部のみ"), "not-installed": t("未導入"), unknown: t("不明"), builtin: t("内蔵"), manual: t("手動") };
const COST_LABELS = { none: null, "account-required": t("アカウントが必要"), "paid-accounts": t("料金がかかります") };
const COMMAND_KINDS = new Set(["skills", "plugin", "mcp"]);
const CATEGORY_FILTERS = [
  ["all", t("すべて")],
  ["render", t("描画")],
  ["music-video", "MV"],
  ["animation", t("アニメ")],
  ["generation", t("生成")],
  ["captions", t("字幕")],
  ["editing", t("編集")],
  ["audio", t("音声")],
];
const STATE_FILTERS = [
  ["all", t("すべて")],
  ["installed", t("導入済み")],
  ["not-installed", t("未導入")],
];
// What to do after an install so that a Claude that is already running notices it.
const AFTER_INSTALL = {
  skills: t("動いている Claude には、まもなく自動で反映されます。されないときは、その Claude で /reload-skills と入力してください。"),
  plugin: t("動いている Claude に反映するには、その Claude で /reload-plugins と入力するか、開き直してください。"),
  mcp: t("プロジェクトの Claude を終了して開き直してください(最初に使うとき、承認が求められます)。"),
};
const GROUPS = [
  [t("おすすめ"), (e) => e.status === "recommended" && COMMAND_KINDS.has(e.kind)],
  [t("そのほか"), (e) => e.status !== "recommended" && COMMAND_KINDS.has(e.kind)],
  [t("アプリ内蔵・手動で設定"), (e) => !COMMAND_KINDS.has(e.kind)],
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
  let bulk = null;          // { picked: Set<id>, plan } while the "install many" screen is open
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
    placeholder: t("名前・説明で絞り込み"),
    ariaLabel: t("名前・説明で絞り込み"),
    oninput: () => { query = searchInput.value; renderList(); },
  });
  const catButtons = new Map();
  const stateButtons = new Map();
  const catRow = h("div", { className: "chips vt-chips", role: "group", ariaLabel: t("用途で絞り込み") },
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
  const stateRow = h("div", { className: "chips vt-chips", role: "group", ariaLabel: t("状態で絞り込み") },
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

  /** An entry's text in the screen's language (the English texts come with the entry as `en`; Japanese is the fallback). */
  const say = (entry, key, japanese) => (lang === "en" ? entry.en?.[key] : undefined) ?? japanese;
  const nameOf = (entry) => shortName(say(entry, "name", entry.name));
  const entryName = (id) => (id ? shortName((() => { const found = catalog?.entries.find((e) => e.id === id); return found ? say(found, "name", found.name) : id; })()) : t("{n} 個のツール", { n: install?.count ?? 0 }));

  function announce() {
    if (install.state === "done") toast(t("{name} を導入しました", { name: entryName(install.entryId) }), { key: "video-tools" });
    else if (install.state === "error") toast(t("{name} の導入に失敗しました。ログを確認してください", { name: entryName(install.entryId) }), { key: "video-tools", kind: "error" });
  }

  async function openConfirm(id, scope) {
    confirming = { id, scope, plan: null };
    render();
    const plan = await get(`/api/video-tools/plan?id=${encodeURIComponent(id)}&scope=${scope}&pj=${encodeURIComponent(pj)}`).catch(() => null);
    if (confirming?.id === id && confirming.scope === scope) confirming.plan = plan ?? { ok: false, reason: t("確認できませんでした"), steps: [] };
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
  const copyButton = (text) => button(t("コピー"), async () => { await navigator.clipboard.writeText(text); toast(t("コピーしました"), { key: "copied" }); });
  const list = (items) => h("ul", { className: "vt-list" }, ...items.map((text) => h("li", { textContent: text })));

  /** What the row says in small print: who made it, what kind, and the warnings that matter before pressing the button. */
  function metaLine(entry) {
    const parts = [entry.maker === "official" ? t("公式") : t("コミュニティ製"), KIND_LABELS[entry.kind], COST_LABELS[entry.costs], entry.signin ? t("サインイン") : null].filter(Boolean);
    return parts.join(" · ");
  }

  function details(entry) {
    const parts = [h("p", { textContent: say(entry, "summary", entry.summary_ja) }), h("p", { className: "sec-note", textContent: say(entry, "use_when", entry.use_when_ja) })];
    const requires = say(entry, "requires", entry.requires);
    const notes = say(entry, "notes", entry.notes_ja);
    if (requires?.length) parts.push(h("p", { className: "sec-note", textContent: t("必要なもの") }), list(requires));
    if (notes?.length) parts.push(h("p", { className: "sec-note", textContent: t("注意") }), list(notes));
    parts.push(h("p", { className: "sec-note" }, t("ライセンス {license} · 確認日 {date} · ", { license: say(entry, "license", entry.license), date: entry.verified }), h("a", { href: entry.source, target: "_blank", rel: "noopener noreferrer", textContent: t("配布元 ↗") })));
    const manualSteps = say(entry, "manual_steps", entry.manual_steps_ja);
    if (manualSteps) {
      parts.push(h("p", { className: "sec-note", textContent: t("手順(自分で行います)") }), ...manualSteps.map((step) => {
        const command = /(winget|brew|sudo) /.test(step) ? step.replace(/^[A-Za-z ]+: /, "") : null;
        return command ? h("div", { className: "cmd" }, h("pre", { textContent: command }), copyButton(command)) : h("p", { className: "sec-note", textContent: step });
      }));
    }
    if (COMMAND_KINDS.has(entry.kind)) {
      const on = (catalog.auto ?? []).includes(entry.id);
      parts.push(h("label", { className: "sec-note" },
        Object.assign(h("input", { type: "checkbox" }), { checked: on, onchange: async (ev) => {
          const res = await post("/api/video-tools/auto", { id: entry.id, enabled: ev.target.checked });
          if (res.ok) catalog = { ...catalog, auto: (await res.json()).auto };
          else toast(t("切り替えに失敗しました"), { key: "video-tools", kind: "error" });
          render(true);
        } }),
        t(" 新しく作るプロジェクトに自動で入れる")));
    }
    return h("div", { className: "vt-more" }, ...parts);
  }

  function row(entry) {
    const state = entry.installed.state;
    const expanded = open.has(entry.id);
    const canInstall = COMMAND_KINDS.has(entry.kind) && state !== "installed";
    const stateText = h("span", { className: `vt-state ${state}`, textContent: STATE_LABELS[state] ?? state, title: entry.installed.detail ?? "" });
    const toggle = h("button", { type: "button", className: "vt-toggle", onclick: () => { if (expanded) open.delete(entry.id); else open.add(entry.id); render(true); } },
      h("span", { className: "vt-name", textContent: nameOf(entry), title: say(entry, "name", entry.name) }),
      h("span", { className: "vt-meta", textContent: metaLine(entry) }));
    return h("div", { className: `vt-row${expanded ? " open" : ""}` },
      h("div", { className: "vt-line" },
        toggle,
        COMMAND_KINDS.has(entry.kind) ? (canInstall ? button(state === "partial" ? t("続き") : t("導入"), () => openConfirm(entry.id, "workspace"), "vt-install", t("導入の内容を確認します")) : stateText) : stateText),
      ...(expanded ? [details(entry)] : []),
    );
  }

  function confirmView() {
    const entry = catalog.entries.find((e) => e.id === confirming.id);
    const { plan, scope } = confirming;
    const radio = (value, label) => h("label", {}, Object.assign(h("input", { type: "radio", name: "vt-scope" }), { checked: scope === value, onchange: () => openConfirm(entry.id, value) }), ` ${label}`);
    const cost = COST_LABELS[entry.costs];
    return h("div", { className: "vt-confirm" },
      h("h4", { textContent: t("{name} を導入しますか?", { name: nameOf(entry) }) }),
      h("p", { className: "sec-note", textContent: t("{meta} · ライセンス {license}", { meta: metaLine(entry), license: say(entry, "license", entry.license) }) }),
      h("div", { className: "vt-scope" },
        radio("workspace", t("このワークスペースのすべてのプロジェクト(今ある {n} 個と、これから作る新しいプロジェクト)", { n: projects.length })),
        radio("project", t("このプロジェクトだけ({pj})", { pj: pj || t("未選択") })),
        radio("user", t("自分の Claude 全体(MV 以外の作業にも入ります)"))),
      ...(scope === "workspace" && plan?.ok ? [h("p", { className: "sec-note", textContent: t("入れる先: {targets}。新しく作るプロジェクトにも自動で入ります(あとで各ツールの詳細から切り替えられます)。", { targets: plan.targets.length ? plan.targets.join(t("、")) : t("(まだプロジェクトはありません)") }) })] : []),
      ...(say(entry, "requires", entry.requires)?.length ? [h("p", { className: "sec-note", textContent: t("必要なもの(入っていないと動きません)") }), list(say(entry, "requires", entry.requires))] : []),
      ...(cost || entry.signin ? [h("p", { className: "bad", textContent: [cost, entry.signin ? t("初回にサインインします(あなたが行います)") : null].filter(Boolean).join("。") })] : []),
      ...(say(entry, "notes", entry.notes_ja)?.length ? [h("p", { className: "sec-note", textContent: t("注意") }), list(say(entry, "notes", entry.notes_ja))] : []),
      !plan ? h("p", { className: "sec-note", textContent: t("確認中…") })
        : !plan.ok ? h("p", { className: "bad", textContent: plan.reason })
          : h("div", {}, h("p", { className: "sec-note", textContent: t("実行するコマンド(この内容だけです)") }), ...plan.steps.flatMap((step) => [h("pre", { className: "setup-cmd", textContent: step.display }), h("p", { className: "sec-note", textContent: t("場所: {cwd}", { cwd: step.cwd }) })])),
      h("div", { className: "panel-actions" }, ...(plan?.ok ? [button(t("導入する"), start, "danger")] : []), button(t("やめる"), () => { confirming = null; render(); })),
    );
  }

  /** Entries the "install many" screen offers: everything the app can install that is not complete in this project yet. */
  const bulkCandidates = () => catalog.entries.filter((e) => COMMAND_KINDS.has(e.kind) && e.installed.state !== "installed");
  /** Paid or sign-in entries start unticked: the user opts in to those one by one. */
  const bulkDefault = (e) => (!COST_LABELS[e.costs] && !e.signin);

  async function refreshBulkPlan() {
    const mine = bulk;
    const ids = [...bulk.picked];
    mine.plan = ids.length ? null : { ok: false, reason: t("導入するツールを選んでください"), steps: [] };
    render();
    if (!ids.length) return;
    const plan = await get(`/api/video-tools/plan?scope=workspace&ids=${ids.map(encodeURIComponent).join(",")}`).catch(() => null);
    if (bulk === mine && [...mine.picked].join() === ids.join()) mine.plan = plan ?? { ok: false, reason: t("確認できませんでした"), steps: [] };
    render();
  }

  function openBulk() {
    bulk = { picked: new Set(bulkCandidates().filter(bulkDefault).map((e) => e.id)), plan: null };
    refreshBulkPlan();
  }

  async function startBulk() {
    const res = await post("/api/video-tools/install", { ids: [...bulk.picked], scope: "workspace", confirmed: true });
    const answer = await res.json();
    if (!res.ok) return toast(answer.error, { key: "video-tools", kind: "error" });
    bulk = null;
    install = answer;
    render();
    schedule();
  }

  function bulkView() {
    const { picked, plan } = bulk;
    const rows = bulkCandidates().map((entry) => {
      const warn = [COST_LABELS[entry.costs], entry.signin ? t("サインインあり") : null].filter(Boolean).join(t("・"));
      const box = Object.assign(h("input", { type: "checkbox" }), { checked: picked.has(entry.id), onchange: () => { if (box.checked) picked.add(entry.id); else picked.delete(entry.id); refreshBulkPlan(); } });
      return h("label", { className: "vt-bulk-row" }, box, ` ${nameOf(entry)}`, ...(warn ? [h("span", { className: "bad", textContent: ` (${warn})` })] : []));
    });
    return h("div", { className: "vt-confirm" },
      h("h4", { textContent: t("未導入のツールをまとめて導入しますか?") }),
      h("p", { className: "sec-note", textContent: t("このワークスペースのすべてのプロジェクト(今ある {n} 個と、これから作る新しいプロジェクト)に入れます。有料・サインインが必要なものは、最初は選ばれていません。入れるほどセッションごとの読み込み量(トークン)が増えるので、使うものだけを選んでください。", { n: projects.length }) }),
      ...(rows.length ? rows : [h("p", { className: "sec-note", textContent: t("未導入のツールはありません。") })]),
      !plan ? h("p", { className: "sec-note", textContent: t("確認中…") })
        : !plan.ok ? h("p", { className: "bad", textContent: plan.reason })
          : h("div", {}, h("p", { className: "sec-note", textContent: t("入れる先: {targets}", { targets: plan.targets.length ? plan.targets.join(t("、")) : t("(まだプロジェクトはありません)") }) }), h("p", { className: "sec-note", textContent: t("実行するコマンド(この内容だけです。プロジェクトごとに1回ずつ実行します)") }), ...plan.steps.map((step) => h("pre", { className: "setup-cmd", textContent: step.display }))),
      h("div", { className: "panel-actions" }, ...(plan?.ok ? [button(t("導入する({n} 個)", { n: picked.size }), startBulk, "danger")] : []), button(t("やめる"), () => { bulk = null; render(); })));
  }

  const SCOPE_LABEL = (run) => (run.scope === "user" ? t("(自分の Claude 全体)") : run.scope === "workspace" ? t("(全プロジェクト)") : run.scope === "auto" ? t("(新しいプロジェクト {pj})", { pj: run.pj }) : `(${run.pj})`);

  /** Few steps are listed one by one; many (a whole workspace) as a count plus the step that is running now. */
  function stepLines(steps) {
    if (steps.length <= 4) return steps.map((step) => h("p", { className: step.state === "error" ? "bad" : "sec-note", textContent: `${STEP_ICON[step.state]} ${step.group && step.group !== "project" && step.group !== "user" ? `[${step.group}] ` : ""}${step.display}` }));
    const finished = steps.filter((s) => s.state === "done" || s.state === "skipped" || s.state === "error").length;
    const current = steps.find((s) => s.state === "running");
    const failed = steps.filter((s) => s.state === "error");
    return [
      h("p", { className: "sec-note", textContent: t("{done} / {total} 手順", { done: finished, total: steps.length }) }),
      ...(current ? [h("p", { className: "sec-note", textContent: `${STEP_ICON.running} [${current.group}] ${current.display}` })] : []),
      ...failed.map((s) => h("p", { className: "bad", textContent: `${STEP_ICON.error} [${s.group}] ${s.display}` })),
    ];
  }

  function runningView() {
    const log = h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") });
    queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
    return h("div", { className: "vt-confirm" },
      h("p", { textContent: `${t("{name} を導入しています…", { name: entryName(install.entryId) })}${SCOPE_LABEL(install)}` }),
      ...stepLines(install.steps),
      log,
      button(t("取り消し"), async () => { await post("/api/video-tools/cancel"); await load(); }));
  }

  function resultView() {
    if (!install || install.state === "idle" || install.state === "running") return null;
    const kind = catalog?.entries.find((e) => e.id === install.entryId)?.kind;
    const log = h("details", { className: "sec-more" }, h("summary", { textContent: t("ログ") }), h("pre", { className: "setup-log", textContent: install.log.slice(-SHOWN_LOG_LINES).join("\n") }));
    if (install.state === "error") return h("div", { className: "vt-result" }, h("p", { className: "bad", textContent: t("{name} の導入に失敗しました: {error}", { name: entryName(install.entryId), error: install.error }) }), log);
    if (install.state === "cancelled") return h("div", { className: "vt-result" }, h("p", { className: "sec-note", textContent: t("導入を取り消しました。") }));
    return h("div", { className: "vt-result" }, h("p", { className: "ok", textContent: `✓ ${t("{name} を導入しました", { name: entryName(install.entryId) })}` }), h("p", { className: "sec-note", textContent: AFTER_INSTALL[kind] ?? "" }), log);
  }

  function updateSummary() {
    if (!catalog?.available) return setSummary(catalog ? t("⚠ 読み込めません") : t("確認中…"), catalog ? "bad" : "neutral");
    if (install?.state === "running") return setSummary(t("導入中…"), "neutral");
    const installable = catalog.entries.filter((e) => COMMAND_KINDS.has(e.kind));
    const done = installable.filter((e) => e.installed.state === "installed").length;
    setSummary(t("導入済み {done} / {total}", { done, total: installable.length }), "neutral");
  }

  function matchesFilter(entry) {
    if (category !== "all" && !entry.category?.includes(category)) return false;
    const isInstalled = entry.installed.state === "installed" || entry.installed.state === "builtin";
    if (stateFilter === "installed" && !isInstalled) return false;
    if (stateFilter === "not-installed" && isInstalled) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [entry.name, entry.en?.name, entry.id, entry.summary_ja, entry.en?.summary, entry.use_when_ja, entry.en?.use_when].filter(Boolean).join("\n").toLowerCase();
    return hay.includes(q);
  }

  function renderList() {
    if (!catalog?.available) return;
    const filtered = catalog.entries.filter(matchesFilter);
    if (!filtered.length) {
      listBox.replaceChildren(h("p", { className: "sec-note", textContent: t("該当するツールがありません。") }));
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
    const key = JSON.stringify([catalog, install, confirming, pj, projects, [...open], bulk && [[...bulk.picked], bulk.plan]]);
    if (!force && key === shownKey) return;
    shownKey = key;
    updateSummary();
    if (!catalog) return box.replaceChildren(h("p", { className: "sec-note", textContent: t("確認中…") }));
    if (!catalog.available) return box.replaceChildren(h("p", { className: "bad", textContent: t("ツール一覧(catalog/video-tools.json)を読み込めませんでした。アプリのログを確認してください。") }));
    if (install?.state === "running") return box.replaceChildren(runningView());
    if (confirming) return box.replaceChildren(confirmView());
    if (bulk) return box.replaceChildren(bulkView());
    const chooser = h("select", { title: t("導入先のプロジェクト") }, ...projects.map((name) => h("option", { value: name, selected: name === pj, textContent: name })));
    chooser.addEventListener("change", async () => { pj = chooser.value; catalog = await get(`/api/video-tools?pj=${encodeURIComponent(pj)}`); render(true); });
    const installable = catalog.entries.filter((e) => COMMAND_KINDS.has(e.kind));
    const done = installable.filter((e) => e.installed.state === "installed").length;
    const result = resultView();
    updateChips();
    renderList();
    box.replaceChildren(
      h("div", { className: "vt-target" },
        h("span", { className: "sec-note", textContent: t("導入先") }),
        projects.length ? chooser : h("span", { className: "sec-note", textContent: t("プロジェクトを作ると導入できます") }),
        h("span", { className: "sec-sum", textContent: t("導入済み {done} / {total}", { done, total: installable.length }) }),
        ...(done < installable.length && projects.length ? [button(t("まとめて導入"), openBulk, "vt-install", t("未導入のツールを選んで、すべてのプロジェクトに入れます"))] : []),
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

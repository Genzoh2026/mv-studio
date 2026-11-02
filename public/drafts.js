// "Lyrics / style / settings" tab: the user's draft on the left (editable), Claude's suggestion on the right
// (read-only; only Claude writes that file). All text goes through textContent, never innerHTML.
import { dismiss, toast } from "/toast.js";

const DEFAULT_DRAFT = "案1";
const HISTORY_LIMIT = 200;
const HISTORY_DEBOUNCE_MS = 500;

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const jsonHeaders = { "content-type": "application/json" };

/**
 * @param {{root: HTMLElement, getProject: () => string, typeToTerminal: (text: string) => Promise<void>}} options
 *   typeToTerminal puts one line into the project's Claude input; it never presses Enter.
 */
export function createDraftsTab({ root, getProject, typeToTerminal }) {
  let pj = "";
  let drafts = [];
  let current = "";
  let baseMtime = null; // mtime of the human file as loaded; sent back on save to detect outside changes
  let savedJson = "";
  let claudeKey = null;
  let stale = false; // the file changed outside while the form has unsaved edits: saving is blocked until reloaded

  // ---- lyrics undo/redo: our own history, because setting the textarea's value from code wipes the native one ----
  const history = { stack: [""], index: 0, timer: null };
  const resetHistory = (value) => { clearTimeout(history.timer); history.stack = [value]; history.index = 0; };
  function record(value) {
    if (value === history.stack[history.index]) return;
    history.stack.length = history.index + 1;
    history.stack.push(value);
    if (history.stack.length > HISTORY_LIMIT) history.stack.shift();
    history.index = history.stack.length - 1;
  }
  function flushHistory() { clearTimeout(history.timer); record(fields.lyrics.value); }
  function step(delta) {
    flushHistory();
    const next = history.index + delta;
    if (next < 0 || next >= history.stack.length) return;
    history.index = next;
    fields.lyrics.value = history.stack[next];
    updateUi();
  }

  // ---- layout ----
  const fields = {
    title: h("input", { maxLength: 200, placeholder: "曲名" }),
    style: h("textarea", { rows: 3, maxLength: 2000, placeholder: "例: fast electro pop, female vocal, 170 BPM" }),
    lyrics: h("textarea", { className: "lyrics-input", maxLength: 20000, placeholder: "[Verse 1]\n…" }),
    vocal: h("select", {}, ...[["", "指定なし"], ["female", "女性"], ["male", "男性"]].map(([v, t]) => new Option(t, v))),
    weirdness: h("input", { type: "number", min: 0, max: 1, step: 0.05 }),
    influence: h("input", { type: "number", min: 0, max: 1, step: 0.05 }),
    instrumental: h("input", { type: "checkbox" }),
    duration: h("input", { type: "number", min: 15, max: 360, step: 1 }),
  };
  const undoBtn = h("button", { type: "button", textContent: "↶ 元に戻す", title: "Ctrl+Z" });
  const redoBtn = h("button", { type: "button", textContent: "↷ やり直す", title: "Ctrl+Shift+Z / Ctrl+Y" });
  const saveBtn = h("button", { type: "button", className: "primary", textContent: "保存" });
  const askBtn = h("button", { type: "button", textContent: "Claude に確認を頼む", title: "歌詞などを完成させて右に出します。Suno にはまだ投げません" });
  const autoBtn = h("button", { type: "button", textContent: "完成させて生成まで任せる", title: "Claude が完成させ、その内容で Suno に生成を依頼します" });
  const genBtn = h("button", { type: "button", textContent: "この案で生成", title: "左の案をそのまま Suno に投げます" });
  const askButtons = [askBtn, autoBtn, genBtn];
  const status = h("span", { className: "meta" });
  const bar = h("div", { className: "draft-bar" });
  const claudeBox = h("section", { className: "col claude" });
  const field = (label, control) => h("label", { className: "field" }, h("span", { className: "meta", textContent: label }), control);
  const humanBox = h("section", { className: "col human" },
    h("h3", { textContent: "人の案(あなたが編集)" }),
    field("曲名", fields.title),
    field("スタイル", fields.style),
    h("div", { className: "lyrics-head" }, h("span", { className: "meta", textContent: "歌詞" }), undoBtn, redoBtn),
    fields.lyrics,
    h("div", { className: "settings" },
      field("ボーカル", fields.vocal),
      field("weirdness (0-1)", fields.weirdness),
      field("style influence (0-1)", fields.influence),
      field("長さ(秒)", fields.duration),
      h("label", { className: "field check" }, fields.instrumental, h("span", { textContent: "インスト(歌なし)" })),
    ),
    h("div", { className: "save-row" }, saveBtn, status),
    h("div", { className: "ask-row" }, ...askButtons),
  );
  root.append(bar, h("div", { className: "draft-cols" }, humanBox, claudeBox));

  // ---- form <-> draft ----
  const numberOrNull = (input) => (input.value === "" ? null : Number(input.value));

  function readForm() {
    return {
      title: fields.title.value,
      style: fields.style.value,
      lyrics: fields.lyrics.value,
      settings: {
        vocal_gender: fields.vocal.value,
        weirdness: numberOrNull(fields.weirdness),
        style_influence: numberOrNull(fields.influence),
        instrumental: fields.instrumental.checked,
        duration: numberOrNull(fields.duration),
      },
    };
  }

  function writeForm(draft) {
    fields.title.value = draft.title;
    fields.style.value = draft.style;
    fields.lyrics.value = draft.lyrics;
    fields.vocal.value = draft.settings.vocal_gender;
    fields.weirdness.value = draft.settings.weirdness ?? "";
    fields.influence.value = draft.settings.style_influence ?? "";
    fields.instrumental.checked = draft.settings.instrumental;
    fields.duration.value = draft.settings.duration ?? "";
  }

  const isDirty = () => JSON.stringify(readForm()) !== savedJson;

  function updateUi() {
    const enabled = Boolean(current);
    for (const control of [...Object.values(fields), saveBtn]) control.disabled = !enabled;
    undoBtn.disabled = !enabled || history.index === 0;
    redoBtn.disabled = !enabled || history.index >= history.stack.length - 1;
    saveBtn.disabled = !enabled || !isDirty() || stale;
    // Claude reads the saved file, so asking only makes sense when the form matches it.
    const askable = enabled && baseMtime !== null && !isDirty() && !stale;
    for (const button of askButtons) {
      button.disabled = !askable;
      button.dataset.why = askable ? "" : "先に保存してください";
    }
    if (enabled && isDirty()) status.textContent = "未保存の変更があります";
  }

  /** Load the human file's content into the form (used on selection and on outside changes). */
  function load(side) {
    flushHistory();
    writeForm(side.draft);
    record(fields.lyrics.value);
    baseMtime = side.mtime;
    savedJson = JSON.stringify(readForm());
    stale = false;
    status.textContent = "";
    showMessage("");
    updateUi();
  }

  const MESSAGE_KEY = "draft";
  /** Messages float over the page (toast.js), one at a time. An empty text clears it. */
  function showMessage(text, action = null, kind = action ? "warn" : "info") {
    if (text) toast(text, { key: MESSAGE_KEY, kind, action });
    else dismiss(MESSAGE_KEY);
  }

  // ---- drafts list ----
  function renderBar() {
    // The current draft is listed even before its file exists (a fresh project's "案1").
    const names = drafts.map((d) => d.name);
    if (current && !names.includes(current)) names.push(current);
    const pills = names.map((name) => h("button", {
      type: "button",
      className: "pill" + (name === current ? " on" : ""),
      textContent: name,
      onclick: () => select(name),
    }));
    const input = h("input", { placeholder: "新しい案の名前", maxLength: 64, autocomplete: "off" });
    const form = h("form", { className: "new-draft" }, input, h("button", { textContent: "+ 新しい案" }));
    form.addEventListener("submit", (event) => { event.preventDefault(); create(input.value.trim()); });
    bar.replaceChildren(...pills, form);
  }

  function select(name) {
    current = name;
    stale = false;
    const side = drafts.find((d) => d.name === name)?.human;
    if (side?.draft) load(side);
    else {
      writeForm({ title: "", style: "", lyrics: "", settings: { vocal_gender: "", instrumental: false } });
      baseMtime = side?.mtime ?? null;
      savedJson = "";
      showMessage(side?.error ? `この案のファイルを読み込めませんでした: ${side.error}` : "", null, "error");
      updateUi();
    }
    // A different draft starts a fresh history (load() above would otherwise carry the old draft's text over).
    resetHistory(fields.lyrics.value);
    updateUi();
    claudeKey = null;
    renderBar();
    renderClaude();
  }

  async function create(name) {
    if (!name) return;
    const res = await fetch("/api/drafts/save", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        pj, name, baseMtime: null,
        data: { title: name, style: "", lyrics: "", settings: { vocal_gender: "", instrumental: false } },
      }),
    });
    const body = await res.json();
    if (!res.ok) return showMessage(body.error, null, "error");
    await refresh();
    select(name);
  }

  async function save() {
    const res = await fetch("/api/drafts/save", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ pj, name: current, baseMtime, data: readForm() }),
    });
    const body = await res.json();
    if (res.status === 409) {
      return showMessage(`${body.error} 保存しませんでした。`, { label: "読み込み直す", run: reloadFromFile });
    }
    if (!res.ok) return showMessage(body.error, null, "error");
    baseMtime = body.mtime;
    savedJson = JSON.stringify(readForm());
    status.textContent = `保存しました ${new Date().toLocaleTimeString("ja-JP")}`;
    showMessage("");
    updateUi();
    await refresh();
  }

  async function reloadFromFile() {
    await refresh(true);
  }

// ---- requests to Claude: one typed line each, tagged so the app's rules know which procedure to follow ----
  const requestTexts = {
    ask: (n) => `【確認】下書き「${n}」(Drafts/${n}.human.json)を読んで、歌詞・スタイル・設定を完成させ、修正案を Drafts/${n}.claude.json に書いてください。Suno にはまだ投げないでください。`,
    auto: (n) => `【完成して生成】下書き「${n}」(Drafts/${n}.human.json)を読んで、歌詞・スタイル・設定を完成させて Drafts/${n}.claude.json に書き、その内容で Suno に生成を依頼してください。`,
    generate: (n) => `【この案で生成】下書き「${n}」(Drafts/${n}.human.json)の内容をそのまま使って、Suno に生成を依頼してください。`,
  };

  async function ask(kind) {
    try {
      await typeToTerminal(requestTexts[kind](current));
      showMessage("ターミナルに依頼を入力しました。内容を確認して、左の Enter キーで送信してください。");
    } catch (err) {
      showMessage(`ターミナルに入力できませんでした: ${err.message}`, null, "error");
    }
  }

  // ---- Claude's side (read-only) ----
  function renderClaude() {
    const item = drafts.find((d) => d.name === current);
    const side = item?.claude;
    // Re-render when either file changes: the "based on your latest draft?" line compares their times.
    const key = side ? `${side.mtime}:${item.human?.mtime}` : "none";
    if (key === claudeKey) return;
    claudeKey = key;
    const title = h("h3", { textContent: "Claude の修正案(読み取り専用)" });
    if (!current) return claudeBox.replaceChildren(title, h("p", { className: "empty", textContent: "左で案を選ぶか、新しく作ってください。" }));
    if (!side) {
      return claudeBox.replaceChildren(title, h("p", { className: "empty" },
        "まだありません。左の案を保存して「Claude に確認を頼む」を押すと、Claude が歌詞などを完成させて、ここに出します。"));
    }
    if (side.error) {
      return claudeBox.replaceChildren(title, h("p", { className: "warn", textContent: `読み込めませんでした(ファイルは変更していません): ${side.error}` }));
    }
    const d = side.draft;
    const settings = [
      d.settings.vocal_gender && `ボーカル: ${d.settings.vocal_gender}`,
      d.settings.weirdness !== null && `weirdness: ${d.settings.weirdness}`,
      d.settings.style_influence !== null && `style influence: ${d.settings.style_influence}`,
      d.settings.instrumental && "インスト",
      d.settings.duration !== null && `長さ: ${d.settings.duration}秒`,
    ].filter(Boolean).join(" / ");
    const block = (label, value, cls = "") => h("div", { className: "field" },
      h("span", { className: "meta", textContent: label }), h("div", { className: `ro ${cls}`, textContent: value || "(なし)" }));
    const outdated = item.human && item.human.mtime > side.mtime;
    const takeBtn = h("button", { type: "button", className: "primary", textContent: "この案を左に取り込む", onclick: () => takeClaudesDraft(d) });
    claudeBox.replaceChildren(
      title,
      h("div", { className: "meta" }, outdated ? "あなたの案が、この修正案のあとに更新されています(古い案をもとにしています)" : "最新のあなたの案をもとにした修正案です"),
      ...(d.note ? [h("div", { className: "note", textContent: d.note })] : []),
      block("曲名", d.title), block("スタイル", d.style), block("歌詞", d.lyrics, "lyrics-ro"), block("設定", settings),
      h("div", { className: "save-row" }, takeBtn),
    );
  }

  /** Copy Claude's version into the user's form (not saved yet). The app never writes Claude's file. */
  function takeClaudesDraft(claudeDraft) {
    const apply = () => {
      flushHistory();
      writeForm(claudeDraft);
      record(fields.lyrics.value); // the lyrics can be undone back to what was there
      status.textContent = "Claude の案を取り込みました。保存すると、あなたの案になります";
      showMessage("");
      updateUi();
    };
    if (isDirty()) {
      showMessage("未保存の変更があります。取り込むと上書きされます(歌詞は「元に戻す」で戻せます)。",
        { label: "取り込む", run: apply });
    } else apply();
  }

  // ---- sync with the folder ----
  async function refresh(force = false) {
    const project = getProject();
    if (project !== pj) {
      pj = project; drafts = []; current = ""; claudeKey = null; baseMtime = null; savedJson = ""; stale = false;
      showMessage("");
      resetHistory("");
      writeForm({ title: "", style: "", lyrics: "", settings: { vocal_gender: "", instrumental: false } });
    }
    if (!pj) return;
    const res = await fetch(`/api/drafts?pj=${encodeURIComponent(pj)}`);
    if (!res.ok || pj !== getProject()) return;
    const next = await res.json();
    const listChanged = JSON.stringify(next.map((d) => d.name)) !== JSON.stringify(drafts.map((d) => d.name));
    drafts = next;
    if (listChanged || !bar.children.length) renderBar();
    const item = drafts.find((d) => d.name === current);
    if (!current && drafts.length) return select(drafts[0].name);
    // A fresh project has no drafts: offer an empty "案1" right away; its file is only created on the first save.
    if (!current) return select(DEFAULT_DRAFT);
    if (item?.human && item.human.mtime !== baseMtime) {
      if (force || !isDirty()) {
        if (item.human.draft) load(item.human);
        else showMessage(`この案のファイルを読み込めませんでした: ${item.human.error}`, null, "error");
      } else {
        stale = true;
        showMessage("このファイルが、外で更新されました。保存すると上書きされるため、保存はできません。", { label: "読み込み直す(編集中の内容は消えます)", run: reloadFromFile });
      }
    }
    renderClaude();
    updateUi();
  }

  // ---- events ----
  fields.lyrics.addEventListener("input", () => {
    clearTimeout(history.timer);
    history.timer = setTimeout(() => record(fields.lyrics.value), HISTORY_DEBOUNCE_MS);
  });
  for (const control of Object.values(fields)) control.addEventListener("input", updateUi);
  fields.lyrics.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) { event.preventDefault(); step(-1); }
    else if ((key === "z" && event.shiftKey) || key === "y") { event.preventDefault(); step(1); }
  });
  humanBox.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!saveBtn.disabled) save();
    }
  });
  undoBtn.addEventListener("click", () => step(-1));
  redoBtn.addEventListener("click", () => step(1));
  saveBtn.addEventListener("click", save);
  askBtn.addEventListener("click", () => ask("ask"));
  autoBtn.addEventListener("click", () => ask("auto"));
  genBtn.addEventListener("click", () => ask("generate"));
  updateUi();

  return { refresh };
}

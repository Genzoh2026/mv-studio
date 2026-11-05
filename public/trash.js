// The trash tool: what was moved to workspace\_Trash, with restore and (after a confirmation) deleting for good.
// This is the only screen that deletes anything permanently.
import { toast } from "/toast.js";
import { locale, t } from "/i18n.js";

const REFRESH_MS = 5000;
const KIND_LABELS = { song: t("曲"), image: t("画像"), video: t("動画"), pj: t("プロジェクト") };

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const post = (path, payload = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const keyOf = (id, index) => `${id}\u0000${index}`;
const formatDate = (iso) => new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });

export const trashTool = {
  id: "trash",
  icon: "🗑",
  title: t("ゴミ箱"),
  open(body) {
    let entries = [];
    let loaded = false;
    let shownKey = null;
    let confirming = null; // "delete" | "empty" | null
    const selected = new Map(); // keyOf -> {id, index}

    const note = h("p", { className: "meta", textContent: t("削除した曲・画像・動画・プロジェクトはここに移動します。戻すか、ここから完全に削除できます。") });
    const bar = h("div", { className: "panel-actions trash-bar" });
    const list = h("div", { className: "trash-list" });
    body.append(note, bar, list);

    const total = () => entries.reduce((n, e) => n + e.items.length, 0);

    function renderBar() {
      const count = selected.size;
      const button = (textContent, onclick, className = "") => h("button", { type: "button", textContent, onclick, className });
      if (confirming === "delete") {
        return bar.replaceChildren(
          h("p", { className: "bad", textContent: t("選んだ {n} 件を完全に削除します。元に戻せません。続けますか?", { n: count }) }),
          button(t("完全に削除する"), () => run("delete"), "danger"),
          button(t("やめる"), () => { confirming = null; renderBar(); }),
        );
      }
      if (confirming === "empty") {
        return bar.replaceChildren(
          h("p", { className: "bad", textContent: t("ゴミ箱の {n} 件をすべて完全に削除します。元に戻せません。続けますか?", { n: total() }) }),
          button(t("ゴミ箱を空にする"), () => run("empty"), "danger"),
          button(t("やめる"), () => { confirming = null; renderBar(); }),
        );
      }
      bar.replaceChildren(
        ...(count ? [h("span", { textContent: t("{n} 件を選択中", { n: count }) }), button(t("元に戻す"), () => run("restore")), button(t("完全に削除…"), () => { confirming = "delete"; renderBar(); }), button(t("選択を解除"), () => { selected.clear(); render(true); })] : []),
        button(t("ゴミ箱を空にする…"), () => { confirming = "empty"; renderBar(); }),
      );
      bar.lastChild.disabled = total() === 0;
    }

    function itemRow(entry, item) {
      const key = keyOf(entry.id, item.index);
      const pick = h("input", { type: "checkbox", checked: selected.has(key) });
      pick.setAttribute("aria-label", t("{name} を選択", { name: item.label }));
      pick.addEventListener("change", () => {
        if (pick.checked) selected.set(key, { id: entry.id, index: item.index }); else selected.delete(key);
        confirming = null;
        renderBar();
      });
      return h("label", { className: "trash-item" }, pick, h("span", { className: "trash-label", textContent: item.label }),
        h("span", { className: "meta", textContent: entry.kind === "pj" ? "" : t("{n} ファイル", { n: item.count }) }));
    }

    function render(force = false) {
      const key = JSON.stringify([entries, [...selected.keys()]]);
      if (!force && key === shownKey) return;
      shownKey = key;
      renderBar();
      if (!loaded) return list.replaceChildren(h("p", { className: "meta", textContent: t("読み込み中…") }));
      if (!entries.length) return list.replaceChildren(h("p", { className: "empty", textContent: t("ゴミ箱は空です。") }));
      list.replaceChildren(...entries.map((entry) => h("section", { className: "trash-entry" },
        h("h4", { textContent: `${KIND_LABELS[entry.kind] ?? entry.kind} · ${entry.kind === "pj" ? "" : `${entry.pj} · `}${formatDate(entry.at)}` }),
        ...entry.items.map((item) => itemRow(entry, item)))));
    }

    async function load() {
      try {
        const res = await fetch("/api/trash", { cache: "no-store" });
        if (res.ok) {
          entries = await res.json();
          loaded = true;
          // Items that left the trash (restored elsewhere, deleted) cannot stay selected.
          const live = new Set(entries.flatMap((e) => e.items.map((i) => keyOf(e.id, i.index))));
          for (const key of [...selected.keys()]) if (!live.has(key)) selected.delete(key);
        }
      } catch { /* the server may be restarting; keep what is shown */ }
      render();
    }

    async function run(action) {
      const items = [...selected.values()];
      const res = action === "empty" ? await post("/api/trash/empty") : await post(`/api/trash/${action}`, { items });
      const answer = await res.json();
      confirming = null;
      if (!res.ok) toast(answer.error, { key: "trash", kind: "error" });
      else if (action === "restore") {
        const names = answer.restored.map((r) => r.as ?? r.name).join("、");
        if (answer.restored.length) toast(t("{n} 件を元に戻しました: {names}", { n: answer.restored.length, names }), { key: "trash" });
      } else if (action === "delete") toast(t("{n} 件を完全に削除しました", { n: answer.deleted }), { key: "trash" });
      else toast(t("{n} 件を完全に削除しました", { n: answer.deleted }) + (answer.left ? t("(認識できないもの {n} 件は、そのまま残しています)", { n: answer.left }) : ""), { key: "trash" });
      for (const failure of answer.failed ?? []) toast(t("できませんでした: {error}", { error: failure.error }), { key: `trash-${failure.id}-${failure.index}`, kind: "error" });
      selected.clear();
      await load();
      render(true);
    }

    render(true);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  },
};

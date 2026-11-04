// The trash tool: what was moved to workspace\_Trash, with restore and (after a confirmation) deleting for good.
// This is the only screen that deletes anything permanently.
import { toast } from "/toast.js";

const REFRESH_MS = 5000;
const KIND_LABELS = { song: "曲", image: "画像", video: "動画", pj: "プロジェクト" };

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const post = (path, payload = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const keyOf = (id, index) => `${id}\u0000${index}`;
const formatDate = (iso) => new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });

export const trashTool = {
  id: "trash",
  icon: "🗑",
  title: "ゴミ箱",
  open(body) {
    let entries = [];
    let loaded = false;
    let shownKey = null;
    let confirming = null; // "delete" | "empty" | null
    const selected = new Map(); // keyOf -> {id, index}

    const note = h("p", { className: "meta", textContent: "削除した曲・画像・動画・プロジェクトはここに移動します。戻すか、ここから完全に削除できます。" });
    const bar = h("div", { className: "panel-actions trash-bar" });
    const list = h("div", { className: "trash-list" });
    body.append(note, bar, list);

    const total = () => entries.reduce((n, e) => n + e.items.length, 0);

    function renderBar() {
      const count = selected.size;
      const button = (textContent, onclick, className = "") => h("button", { type: "button", textContent, onclick, className });
      if (confirming === "delete") {
        return bar.replaceChildren(
          h("p", { className: "bad", textContent: `選んだ ${count} 件を完全に削除します。元に戻せません。続けますか?` }),
          button("完全に削除する", () => run("delete"), "danger"),
          button("やめる", () => { confirming = null; renderBar(); }),
        );
      }
      if (confirming === "empty") {
        return bar.replaceChildren(
          h("p", { className: "bad", textContent: `ゴミ箱の ${total()} 件をすべて完全に削除します。元に戻せません。続けますか?` }),
          button("ゴミ箱を空にする", () => run("empty"), "danger"),
          button("やめる", () => { confirming = null; renderBar(); }),
        );
      }
      bar.replaceChildren(
        ...(count ? [h("span", { textContent: `${count} 件を選択中` }), button("元に戻す", () => run("restore")), button("完全に削除…", () => { confirming = "delete"; renderBar(); }), button("選択を解除", () => { selected.clear(); render(true); })] : []),
        button("ゴミ箱を空にする…", () => { confirming = "empty"; renderBar(); }),
      );
      bar.lastChild.disabled = total() === 0;
    }

    function itemRow(entry, item) {
      const key = keyOf(entry.id, item.index);
      const pick = h("input", { type: "checkbox", checked: selected.has(key) });
      pick.setAttribute("aria-label", `${item.label} を選択`);
      pick.addEventListener("change", () => {
        if (pick.checked) selected.set(key, { id: entry.id, index: item.index }); else selected.delete(key);
        confirming = null;
        renderBar();
      });
      return h("label", { className: "trash-item" }, pick, h("span", { className: "trash-label", textContent: item.label }),
        h("span", { className: "meta", textContent: entry.kind === "pj" ? "" : `${item.count} ファイル` }));
    }

    function render(force = false) {
      const key = JSON.stringify([entries, [...selected.keys()]]);
      if (!force && key === shownKey) return;
      shownKey = key;
      renderBar();
      if (!loaded) return list.replaceChildren(h("p", { className: "meta", textContent: "読み込み中…" }));
      if (!entries.length) return list.replaceChildren(h("p", { className: "empty", textContent: "ゴミ箱は空です。" }));
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
        if (answer.restored.length) toast(`${answer.restored.length} 件を元に戻しました: ${names}`, { key: "trash" });
      } else if (action === "delete") toast(`${answer.deleted} 件を完全に削除しました`, { key: "trash" });
      else toast(`${answer.deleted} 件を完全に削除しました${answer.left ? `(認識できないもの ${answer.left} 件は、そのまま残しています)` : ""}`, { key: "trash" });
      for (const failure of answer.failed ?? []) toast(`できませんでした: ${failure.error}`, { key: `trash-${failure.id}-${failure.index}`, kind: "error" });
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

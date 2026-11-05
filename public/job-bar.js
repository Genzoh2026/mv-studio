// A slim status strip along the bottom edge of the right pane: shows the separation / analysis / setup that is running,
// whatever tab or project is open, and announces when one finishes or fails. It takes a line of height only while there
// is something to show, and never covers the content (it is part of the layout, not an overlay).
import { toast } from "/toast.js";
import { t } from "/i18n.js";

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 3500;
const KIND_LABELS = { separate: t("分離"), beats: t("ビート解析") };
const KIND_ICONS = { separate: "🎚", beats: "🥁" };

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

const get = async (path) => { const res = await fetch(path, { cache: "no-store" }); return res.ok ? res.json() : null; };
const post = (path, payload = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const cancelJob = (id) => post("/api/jobs/cancel", { id });
const titleOf = (base) => base.split("/").pop();
const isActive = (job) => job.state === "running" || job.state === "queued";
// A finished job stays in the strip a few seconds: some take less than a second and would never be seen.
const RECENT_DONE_MS = 6000;
const isRecent = (job) => job.state === "done" && Boolean(job.finishedAt) && Date.now() - job.finishedAt < RECENT_DONE_MS;
const tookText = (job) => (job.startedAt && job.finishedAt ? t("({s} 秒)", { s: ((job.finishedAt - job.startedAt) / 1000).toFixed(1) }) : "");

/** @param {{root: HTMLElement}} options */
export function createJobBar({ root }) {
  const lastState = new Map(); // job id -> state seen last time, so a change is announced once
  let lastInstall = null;
  let first = true;            // the first answer only fills the memory: jobs finished before the page opened are not news

  /** Says once when a job finished or failed (the user may be looking at something else). */
  function announce(jobs, install) {
    for (const job of jobs) {
      const before = lastState.get(job.id);
      lastState.set(job.id, job.state);
      if (first || before === job.state) continue;
      const name = t("「{title}」の{kind}", { title: titleOf(job.base), kind: KIND_LABELS[job.kind] }) + (job.requestedBy === "claude" ? t("(Claude の依頼)") : "");
      if (job.state === "done") toast(t("{name}が終わりました", { name }) + (job.then ? t("(続けてビート解析します)") : ""), { key: `job-${job.id}` });
      else if (job.state === "error") toast(t("{name}に失敗しました: {error}", { name, error: job.error }), { key: `job-${job.id}`, kind: "error" });
    }
    if (!first && lastInstall === "running" && install && install.state !== "running") {
      if (install.state === "done") toast(t("音声ツールの導入が終わりました"), { key: "audio-setup" });
      else if (install.state === "error") toast(t("音声ツールの導入に失敗しました: {error}", { error: install.error }), { key: "audio-setup", kind: "error" });
    }
    lastInstall = install?.state ?? null;
    first = false;
  }

  function render(jobs, install) {
    const active = jobs.filter(isActive);
    const installing = install?.state === "running";
    const recent = jobs.filter(isRecent).sort((a, b) => b.finishedAt - a.finishedAt)[0];
    if (!active.length && !installing && recent) {
      root.hidden = false;
      return root.replaceChildren(h("div", { className: "job-item done" },
        h("span", { className: "job-text", textContent: `✓ ${KIND_ICONS[recent.kind]} ${t("{kind}が終わりました 「{title}」", { kind: KIND_LABELS[recent.kind], title: titleOf(recent.base) })} ${tookText(recent)}${recent.then ? t(" → 続けてビート解析") : ""}` })));
    }
    if (!active.length && !installing) {
      root.hidden = true;
      return root.replaceChildren();
    }
    root.hidden = false;
    const items = [];
    if (installing) {
      const step = install.steps.findIndex((s) => s.state === "running") + 1;
      items.push(h("div", { className: "job-item" },
        h("progress", { max: 100 }),
        h("span", { className: "job-text", textContent: t("🔧 音声ツールを導入中({step}/{total}: {label})", { step, total: install.steps.length, label: install.steps[step - 1]?.label ?? "" }) }),
        h("button", { type: "button", textContent: t("取り消し"), onclick: () => post("/api/audio-install/cancel") })));
    }
    // The running job first, then the ones waiting (shown as a count, so the strip stays one line).
    const running = active.find((job) => job.state === "running") ?? active[0];
    if (running) {
      const waiting = active.length - 1;
      items.push(h("div", { className: "job-item" },
        h("progress", { max: 100, value: running.state === "running" ? running.progress : 0 }),
        h("span", { className: "job-text", textContent: `${KIND_ICONS[running.kind]} ${KIND_LABELS[running.kind]}${running.state === "running" ? t("{kind}中 {progress}%", { kind: KIND_LABELS[running.kind], progress: running.progress }) : t("{kind}: 順番待ち", { kind: KIND_LABELS[running.kind] })} 「${titleOf(running.base)}」${running.then ? t("→ ビート解析") : ""}${running.requestedBy === "claude" ? t("  [Claude の依頼]") : ""}${waiting ? t("  ほか {n} 件待機", { n: waiting }) : ""}` }),
        h("button", { type: "button", textContent: t("取り消し"), onclick: async () => { await cancelJob(running.id); tick(); } })));
    }
    root.replaceChildren(...items);
  }

  let timer = null;
  async function tick() {
    clearTimeout(timer);
    let jobs = [];
    let install = null;
    try {
      [jobs, install] = await Promise.all([get("/api/jobs"), get("/api/audio-install")]);
      jobs ??= [];
      announce(jobs, install);
      render(jobs, install);
    } catch { /* the server may be restarting: keep what is shown and try again */ }
    timer = setTimeout(tick, jobs.some((job) => isActive(job) || isRecent(job)) || install?.state === "running" ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  document.addEventListener("jobs-changed", () => tick());
  tick();
  return { refresh: tick };
}

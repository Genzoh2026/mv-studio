// Adding files to a library: a drop zone over a tab, and one-by-one upload with a summary toast.
// Used by the image library and the song library.
import { toast } from "/toast.js";
import { t } from "/i18n.js";

const SHOWN_ERRORS = 3;

export const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

// Without this, a file dropped slightly off a drop zone would make the browser leave the app to show it.
let pageGuarded = false;
function guardPage() {
  if (pageGuarded) return;
  pageGuarded = true;
  addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
  addEventListener("drop", (event) => { if (hasFiles(event)) event.preventDefault(); });
}

/** Shows `mask` while files are dragged over `root` and calls `onFiles(FileList)` when they are dropped. */
export function attachDropZone(root, mask, onFiles) {
  guardPage();
  let depth = 0; // dragenter/dragleave fire for every child element, so count instead of toggling
  root.addEventListener("dragenter", (event) => { if (hasFiles(event)) { depth++; mask.hidden = false; } });
  root.addEventListener("dragleave", (event) => { if (hasFiles(event) && --depth <= 0) { depth = 0; mask.hidden = true; } });
  root.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    depth = 0;
    mask.hidden = true;
    onFiles(event.dataTransfer.files);
  });
}

/**
 * Uploads files one request each (the body is the file itself) and reports the result in toasts.
 * @param {{files: Iterable<File>, urlFor: (name: string) => string, unit: string, maxFiles: number, maxBytes: number,
 *   toastKey: string, onProgress?: (remaining: number) => void}} options
 * @returns {Promise<number>} how many files were added
 */
export async function uploadFiles({ files, urlFor, unit, maxFiles, maxBytes, toastKey, onProgress = () => {} }) {
  const list = [...files];
  if (!list.length) return 0;
  if (list.length > maxFiles) {
    toast(t("一度に追加できるのは {max} {unit}までです({n} {unit}選ばれました)", { max: maxFiles, n: list.length, unit }), { key: `${toastKey}-limit`, kind: "warn" });
    list.length = maxFiles;
  }
  const failures = [];
  let added = 0;
  let remaining = list.length;
  onProgress(remaining);
  for (const file of list) {
    if (file.size > maxBytes) {
      failures.push(t("{name}: 大きすぎます(上限 {mb} MB)", { name: file.name, mb: maxBytes / 1024 / 1024 }));
    } else {
      try {
        const res = await fetch(urlFor(file.name), { method: "POST", body: file });
        if (res.ok) added++;
        else failures.push(`${file.name}: ${(await res.json()).error}`);
      } catch (err) {
        failures.push(`${file.name}: ${err.message}`);
      }
    }
    onProgress(--remaining);
  }
  if (added) toast(t("{n} {unit}を追加しました", { n: added, unit }), { key: `${toastKey}-added` });
  if (failures.length) {
    const more = failures.length > SHOWN_ERRORS ? t(" ほか {n} 件", { n: failures.length - SHOWN_ERRORS }) : "";
    toast(t("追加できませんでした: {list}", { list: failures.slice(0, SHOWN_ERRORS).join(" / ") }) + more, { key: `${toastKey}-failed`, kind: "error" });
  }
  return added;
}

// The library tool: the curated catalog of skills, plugins and tools for making videos, opened from the left rail.
import { createVideoToolsPanel } from "/video-tools-panel.js";
import { t } from "/i18n.js";

export const libraryTool = {
  id: "library",
  icon: "🧩",
  title: t("ライブラリ"),
  wide: true,
  open(body) {
    const panel = createVideoToolsPanel(body, { setSummary() {} });
    return () => panel.destroy();
  },
};

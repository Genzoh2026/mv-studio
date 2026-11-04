// The library tool: the curated catalog of skills, plugins and tools for making videos, opened from the left rail.
import { createVideoToolsPanel } from "/video-tools-panel.js";

export const libraryTool = {
  id: "library",
  icon: "🧩",
  title: "ライブラリ",
  wide: true,
  open(body) {
    const panel = createVideoToolsPanel(body, { setSummary() {} });
    return () => panel.destroy();
  },
};

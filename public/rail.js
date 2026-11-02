// The slim tool bar on the far left. Each tool is one icon that opens a panel beside the bar; the bar itself can be
// folded away (a small handle stays at the edge). To add a tool, add an entry to `tools` in app.js:
//   { id, icon, title, open(body): (() => void) | void }   // open() fills `body`; its return value is a cleanup
const STORAGE_KEY = "mv-studio:rail-collapsed";

/**
 * @param {{rail: HTMLElement, panel: HTMLElement, handle: HTMLElement, tools: Array<{id: string, icon: string, title: string, open: (body: HTMLElement) => (() => void) | void}>, onLayout: () => void}} options
 *   onLayout runs after the bar is folded or unfolded, so the terminal can refit.
 */
export function createRail({ rail, panel, handle, tools, onLayout }) {
  const buttons = new Map();
  const body = panel.querySelector(".panel-body");
  const heading = panel.querySelector(".panel-title");
  let openId = null;
  let cleanup = null;

  function closePanel() {
    cleanup?.();
    cleanup = null;
    openId = null;
    panel.hidden = true;
    for (const button of buttons.values()) button.classList.remove("on");
  }

  function openPanel(tool) {
    closePanel();
    openId = tool.id;
    heading.textContent = tool.title;
    body.replaceChildren();
    cleanup = tool.open(body) ?? null;
    panel.hidden = false;
    buttons.get(tool.id).classList.add("on");
  }

  for (const tool of tools) {
    const button = Object.assign(document.createElement("button"), {
      type: "button", className: "rail-btn", textContent: tool.icon, title: tool.title,
    });
    button.setAttribute("aria-label", tool.title);
    button.addEventListener("click", () => (openId === tool.id ? closePanel() : openPanel(tool)));
    buttons.set(tool.id, button);
    rail.querySelector(".rail-tools").append(button);
  }

  function setCollapsed(collapsed) {
    closePanel();
    document.body.classList.toggle("rail-collapsed", collapsed);
    localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    // The grid column changes width on the next frame; refit after that.
    requestAnimationFrame(() => onLayout());
  }

  rail.querySelector(".rail-collapse").addEventListener("click", () => setCollapsed(true));
  handle.addEventListener("click", () => setCollapsed(false));
  panel.querySelector(".panel-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && openId) closePanel(); });

  if (localStorage.getItem(STORAGE_KEY) === "1") document.body.classList.add("rail-collapsed");
}

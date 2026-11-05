// The curated list of skills, plugins and tools for making videos (catalog/video-tools.json), and the checks that keep it safe.
// Claude may only propose what is in this file, and only with the commands written here, so a command is accepted into the
// list only if it has one of a few exact forms: project scope, no piping, no chaining, nothing that touches the whole computer.
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const KINDS = ["skills", "plugin", "mcp", "connector", "builtin", "system"];
export const STATUSES = ["recommended", "optional", "installed-by-app"];
export const CATEGORIES = ["render", "music-video", "animation", "generation", "captions", "editing", "audio"];
export const COSTS = ["none", "account-required", "paid-accounts"];
const MAKERS = ["official", "community"];
const COMMAND_KINDS = new Set(["skills", "plugin", "mcp"]);
const MANUAL_KINDS = new Set(["connector", "builtin", "system"]);
// Letters, digits and a few separators: no quotes, pipes, ampersands, semicolons, redirects, backticks or $().
const SAFE_COMMAND = /^[A-Za-z0-9 _./:@=,+-]+$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why a command is not allowed, or null when it is. Exported for tests. The catalog itself only ever holds `project` commands;
 * `scope: "user"` is for the command the app derives from one when the user chooses "all projects" in the install dialog.
 */
export function commandProblem(kind, command, { scope = "project" } = {}) {
  if (typeof command !== "string" || !command.trim()) return "empty command";
  if (!SAFE_COMMAND.test(command)) return "contains a character that is not allowed (quotes, pipes, &, ;, <, >, $, backtick)";
  const words = command.split(" ");
  if (kind === "skills") {
    if (!command.startsWith("npx skills add ")) return "must start with `npx skills add `";
    if (words.includes("--global")) return "write -g, not --global";
    if (scope === "project" && words.includes("-g")) return "global install is not allowed (project scope only)";
    if (scope === "user" && !words.includes("-g")) return "a user-scope install must include -g";
    if (words.includes("--all")) return "--all is not allowed (name what is installed)";
    for (const flag of ["-a", "--copy", "-y"]) if (!words.includes(flag)) return `must include ${flag}`;
    if (words[words.indexOf("-a") + 1] !== "claude-code") return "-a must be claude-code";
    return null;
  }
  if (kind === "plugin") {
    const form = command.startsWith("claude plugin marketplace add ") || command.startsWith("claude plugin install ");
    if (!form) return "must start with `claude plugin marketplace add ` or `claude plugin install `";
    if (words[words.indexOf("--scope") + 1] !== scope) return `must include \`--scope ${scope}\``;
    return null;
  }
  if (kind === "mcp") {
    if (!command.startsWith("claude mcp add ")) return "must start with `claude mcp add `";
    if (words[words.indexOf("--scope") + 1] !== scope) return `must include \`--scope ${scope}\``;
    return null;
  }
  return "this kind has no commands";
}

const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isTextList = (value, { min = 0 } = {}) => Array.isArray(value) && value.length >= min && value.every(isText);

/** Everything wrong with a catalog, as readable lines (empty when it is fine). */
export function validateCatalog(catalog) {
  const problems = [];
  if (!catalog || typeof catalog !== "object") return ["the catalog is not an object"];
  if (catalog.version !== 1) problems.push("version must be 1");
  if (!DATE.test(catalog.updated ?? "")) problems.push("updated must be YYYY-MM-DD");
  if (!isTextList(catalog.policy_ja, { min: 1 })) problems.push("policy_ja must list the rules");
  if (!Array.isArray(catalog.entries) || !catalog.entries.length) return [...problems, "entries must be a non-empty list"];
  const ids = new Set();
  for (const [index, entry] of catalog.entries.entries()) {
    const at = `entries[${index}]${isText(entry?.id) ? ` (${entry.id})` : ""}`;
    const problem = (text) => problems.push(`${at}: ${text}`);
    if (!entry || typeof entry !== "object") { problem("not an object"); continue; }
    if (!ID.test(entry.id ?? "")) problem("id must be lowercase words joined by -");
    else if (ids.has(entry.id)) problem("duplicate id");
    else ids.add(entry.id);
    for (const key of ["name", "summary_ja", "use_when_ja", "license"]) if (!isText(entry[key])) problem(`${key} is required`);
    if (!KINDS.includes(entry.kind)) problem(`kind must be one of ${KINDS.join(", ")}`);
    if (!STATUSES.includes(entry.status)) problem(`status must be one of ${STATUSES.join(", ")}`);
    if (!MAKERS.includes(entry.maker)) problem(`maker must be one of ${MAKERS.join(", ")}`);
    if (!COSTS.includes(entry.costs)) problem(`costs must be one of ${COSTS.join(", ")}`);
    if (typeof entry.signin !== "boolean") problem("signin must be true or false");
    if (!Array.isArray(entry.category) || !entry.category.length || !entry.category.every((c) => CATEGORIES.includes(c))) problem(`category must be a non-empty list from ${CATEGORIES.join(", ")}`);
    if (typeof entry.source !== "string" || !entry.source.startsWith("https://")) problem("source must be an https URL");
    if (!DATE.test(entry.verified ?? "")) problem("verified must be YYYY-MM-DD (the day the facts here were checked)");
    if (!isTextList(entry.evidence, { min: 1 })) problem("evidence must list at least one place the facts come from");
    if (!isTextList(entry.requires ?? [])) problem("requires must be a list of text");
    if (COMMAND_KINDS.has(entry.kind)) {
      if (!isTextList(entry.install?.commands, { min: 1 })) problem("install.commands is required for this kind");
      else for (const command of entry.install.commands) { const why = commandProblem(entry.kind, command); if (why) problem(`command "${command}": ${why}`); }
      if (entry.manual_steps_ja) problem("manual_steps_ja is only for connector, builtin and system");
      if (entry.kind === "plugin" && !PLUGIN_ID.test(entry.provides?.plugin ?? "")) problem("provides.plugin must be name@marketplace");
      if (entry.kind === "mcp" && !SKILL_NAME.test(entry.provides?.mcp ?? "")) problem("provides.mcp must be the server name");
      if (entry.provides?.skills && !(Array.isArray(entry.provides.skills) && entry.provides.skills.every((s) => SKILL_NAME.test(s)))) problem("provides.skills must be skill folder names");
      if (entry.kind === "skills" && !entry.provides?.skills?.length) problem("provides.skills is required (it is how the install is detected)");
    } else if (MANUAL_KINDS.has(entry.kind)) {
      if (!isTextList(entry.manual_steps_ja, { min: 1 })) problem("manual_steps_ja is required for this kind");
      if (entry.install) problem("install.commands is not allowed for this kind (the user does it)");
    }
    if (entry.status === "installed-by-app" && entry.kind !== "builtin") problem("installed-by-app only fits builtin");
    if (entry.notes_ja !== undefined && !isTextList(entry.notes_ja)) problem("notes_ja must be a list of text");
  }
  for (const [index, item] of (catalog.watchlist ?? []).entries()) {
    if (!isText(item?.name) || !isText(item?.reason_ja) || !String(item?.source).startsWith("https://")) problems.push(`watchlist[${index}]: name, source (https) and reason_ja are required`);
  }
  return problems;
}

export async function loadCatalog(path) {
  const catalog = JSON.parse(await readFile(path, "utf8"));
  const problems = validateCatalog(catalog);
  if (problems.length) throw new Error(`the catalog is invalid:\n${problems.join("\n")}`);
  // The English texts live beside it (video-tools.en.json) and are merged in; without that file the catalog stays Japanese only.
  const english = await readFile(path.replace(/\.json$/, ".en.json"), "utf8").then((text) => JSON.parse(text), (err) => { if (err.code === "ENOENT") return null; throw err; });
  if (english) {
    const englishProblems = mergeEnglish(catalog, english);
    if (englishProblems.length) throw new Error(`the English catalog is incomplete:\n${englishProblems.join("\n")}`);
  }
  return catalog;
}

const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const hasJapanese = (value) => JAPANESE.test(JSON.stringify(value ?? ""));

/**
 * Adds the English texts to the catalog (entry.en, watchlist[].name_en / reason_en, policy_en, sources_to_watch[].name_en) and
 * returns what is missing or does not line up: every Japanese text needs an English one, lists with the same number of items.
 */
export function mergeEnglish(catalog, english) {
  const problems = [];
  const need = (where, ja, en, isList = false) => {
    if (!hasJapanese(ja)) return;
    if (en === undefined || en === null || en === "") problems.push(`${where}: no English text`);
    else if (isList && (!Array.isArray(en) || en.length !== ja.length)) problems.push(`${where}: the English list must have ${ja.length} items`);
    else if (hasJapanese(en)) problems.push(`${where}: Japanese left in the English text`);
  };
  need("policy", catalog.policy_ja, english.policy, true);
  catalog.policy_en = english.policy;
  for (const entry of catalog.entries) {
    const en = english.entries?.[entry.id];
    if (!en) { problems.push(`entry ${entry.id}: no English texts`); continue; }
    need(`${entry.id}.name`, entry.name, en.name);
    need(`${entry.id}.license`, entry.license, en.license);
    need(`${entry.id}.summary`, entry.summary_ja, en.summary);
    need(`${entry.id}.use_when`, entry.use_when_ja, en.use_when);
    need(`${entry.id}.requires`, entry.requires, en.requires, true);
    need(`${entry.id}.notes`, entry.notes_ja, en.notes, true);
    need(`${entry.id}.manual_steps`, entry.manual_steps_ja, en.manual_steps, true);
    entry.en = en;
  }
  for (const item of catalog.watchlist ?? []) {
    const en = english.watchlist?.[item.name];
    if (!en) { problems.push(`watchlist "${item.name}": no English texts`); continue; }
    need(`watchlist "${item.name}".reason`, item.reason_ja, en.reason);
    need(`watchlist "${item.name}".name`, item.name, en.name ?? (hasJapanese(item.name) ? undefined : item.name));
    item.reason_en = en.reason;
    item.name_en = en.name ?? item.name;
  }
  for (const item of catalog.sources_to_watch ?? []) {
    const en = english.sources?.[item.source];
    need(`source ${item.source}`, item.name, en);
    item.name_en = en ?? item.name;
  }
  return problems;
}

const exists = (path) => access(path).then(() => true, () => false);

/** Same folder, whatever the spelling (case on Windows, trailing separators, relative parts). */
const samePath = (a, b) => {
  const norm = (p) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};
const PROJECT_BOUND = new Set(["project", "local"]);

/**
 * Whether an entry is installed for a project, as far as it can be told without asking the services.
 * @param {object} entry
 * @param {{pjDir: string, home?: string, plugins: {id: string, scope?: string, enabled?: boolean}[]|null}} context
 *   `plugins` is the output of `claude plugin list --json` (null when it could not be read)
 * @returns {Promise<{state: "installed"|"partial"|"not-installed"|"builtin"|"manual"|"unknown", detail?: string}>}
 */
export async function installState(entry, { pjDir, home = homedir(), plugins }) {
  if (entry.kind === "builtin") return { state: "builtin" };
  if (MANUAL_KINDS.has(entry.kind)) return { state: "manual" };
  if (entry.kind === "plugin") {
    if (!plugins) return { state: "unknown", detail: "claude plugin list could not be read" };
    const sameId = plugins.filter((plugin) => plugin.id === entry.provides.plugin);
    // A project-scope install belongs to the project it was made in (projectPath); in any other project it is not installed,
    // and `claude plugin list` reports it there as disabled, which must not read as "partly installed".
    const here = sameId.find((plugin) => !PROJECT_BOUND.has(plugin.scope) || !plugin.projectPath || samePath(plugin.projectPath, pjDir));
    if (here) return { state: here.enabled === false ? "partial" : "installed", detail: `${here.scope ?? "?"} scope${here.enabled === false ? ", disabled" : ""}` };
    return sameId.length ? { state: "not-installed", detail: `installed in another project: ${basename(sameId[0].projectPath ?? "")}` } : { state: "not-installed" };
  }
  if (entry.kind === "mcp") {
    try {
      const config = JSON.parse(await readFile(join(pjDir, ".mcp.json"), "utf8"));
      return config?.mcpServers?.[entry.provides.mcp] ? { state: "installed", detail: "project .mcp.json" } : { state: "not-installed" };
    } catch {
      return { state: "not-installed" };
    }
  }
  // skills: each skill is a folder with a SKILL.md, in the project or (installed earlier by the user) in the home folder
  const names = entry.provides.skills;
  let present = 0;
  let where = null;
  for (const name of names) {
    const inProject = await exists(join(pjDir, ".claude", "skills", name, "SKILL.md"));
    const inHome = !inProject && (await exists(join(home, ".claude", "skills", name, "SKILL.md")));
    if (inProject || inHome) { present++; where ??= inProject ? "project" : "user"; }
  }
  if (present === names.length) return { state: "installed", detail: `${where} skills` };
  return present ? { state: "partial", detail: `${present}/${names.length} skills found` } : { state: "not-installed" };
}

/** The catalog for Claude: each entry with where it stands, filtered by category when asked. */
export async function describeCatalog(catalog, { pjDir, plugins, category, home, english = true }) {
  const entries = catalog.entries.filter((entry) => !category || entry.category.includes(category));
  const described = [];
  for (const entry of entries) {
    const { evidence, en, ...shown } = entry;
    // The English texts are for the screen; Claude reads the catalog in Japanese and is not sent them (they would only cost tokens).
    described.push({ ...shown, ...(english && en ? { en } : {}), installed: await installState(entry, { pjDir, home, plugins }) });
  }
  const watchlist = category ? undefined : (english ? catalog.watchlist : catalog.watchlist?.map(({ name_en, reason_en, ...item }) => item));
  return { policy_ja: catalog.policy_ja, ...(english && catalog.policy_en ? { policy_en: catalog.policy_en } : {}), updated: catalog.updated, entries: described, watchlist };
}

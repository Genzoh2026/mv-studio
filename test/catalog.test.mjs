import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandProblem, describeCatalog, installState, loadCatalog, validateCatalog } from "../catalog.mjs";

const CATALOG_FILE = fileURLToPath(new URL("../catalog/video-tools.json", import.meta.url));

test("the shipped catalog is valid, and every installable entry uses only the allowed command forms", async () => {
  const catalog = await loadCatalog(CATALOG_FILE);
  assert.ok(catalog.entries.length >= 8);
  const ids = catalog.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of catalog.entries.filter((e) => e.install)) {
    for (const command of entry.install.commands) assert.equal(commandProblem(entry.kind, command), null, `${entry.id}: ${command}`);
  }
  // things that touch the whole computer are never run by Claude
  assert.ok(catalog.entries.filter((e) => e.kind === "system").every((e) => !e.install));
});

test("commands: project scope only, no piping or chaining, no global installs", () => {
  const ok = [
    ["skills", "npx skills add owner/repo -a claude-code --copy -y"],
    ["skills", "npx skills add https://github.com/owner/repo -a claude-code --copy -y"],
    ["plugin", "claude plugin marketplace add owner/repo --scope project"],
    ["plugin", "claude plugin marketplace add https://github.com/o/p --scope project --sparse .claude-plugin plugins"],
    ["plugin", "claude plugin install name@market --scope project"],
    ["mcp", "claude mcp add comfyui --scope project -- npx -y comfyui-mcp"],
  ];
  for (const [kind, command] of ok) assert.equal(commandProblem(kind, command), null, command);
  const bad = [
    ["skills", "npx skills add owner/repo -g -a claude-code --copy -y", /global/],
    ["skills", "npx skills add owner/repo --global -a claude-code --copy -y", /global/],
    ["skills", "npx skills add owner/repo --all -a claude-code --copy -y", /--all/],
    ["skills", "npx skills add owner/repo -a claude-code -y", /--copy/],
    ["skills", "npx skills add owner/repo -a codex --copy -y", /claude-code/],
    ["skills", "npx skills add owner/repo -a claude-code --copy -y | sh", /not allowed/],
    ["skills", "npx skills add owner/repo -a claude-code --copy -y && curl x", /not allowed/],
    ["skills", "curl https://x | sh", /not allowed|must start/],
    ["plugin", "claude plugin install name@market --scope user", /project/],
    ["plugin", "claude plugin install name@market", /project/],
    ["plugin", "claude plugin marketplace add owner/repo --scope project; rm -rf x", /not allowed/],
    ["plugin", "claude plugin uninstall name@market --scope project", /must start/],
    ["mcp", "claude mcp add x --scope user -- npx -y x", /project/],
    ["mcp", "claude mcp add x --scope project -- sh -c `id`", /not allowed/],
    ["mcp", "claude mcp add x --scope project -- $(id)", /not allowed/],
    ["skills", "", /empty/],
    ["connector", "anything", /no commands/],
  ];
  for (const [kind, command, why] of bad) assert.match(commandProblem(kind, command) ?? "ok", why, command);
});

const entry = (over = {}) => ({
  id: "x-tool", name: "X", kind: "skills", category: ["render"], maker: "community", status: "optional", summary_ja: "s", use_when_ja: "u",
  source: "https://example.com", license: "MIT", requires: [], costs: "none", signin: false, verified: "2026-11-05", evidence: ["https://example.com"],
  provides: { skills: ["x-skill"] }, install: { commands: ["npx skills add o/r -a claude-code --copy -y"] }, ...over,
});
const catalogOf = (...entries) => ({ version: 1, updated: "2026-11-05", policy_ja: ["rule"], entries });

test("validateCatalog names what is wrong", () => {
  assert.deepEqual(validateCatalog(catalogOf(entry())), []);
  const cases = [
    [entry({ id: "Bad_Id" }), /id must be/],
    [entry({ kind: "magic" }), /kind must be/],
    [entry({ source: "http://example.com" }), /source must be an https/],
    [entry({ verified: "yesterday" }), /verified must be/],
    [entry({ evidence: [] }), /evidence must list/],
    [entry({ category: ["nonsense"] }), /category must be/],
    [entry({ costs: "free" }), /costs must be/],
    [entry({ signin: "no" }), /signin must be/],
    [entry({ install: { commands: ["npx skills add o/r -g -a claude-code --copy -y"] } }), /global/],
    [entry({ install: undefined }), /install.commands is required/],
    [entry({ provides: undefined }), /provides.skills is required/],
    [entry({ kind: "plugin", provides: { plugin: "no-marketplace" }, install: { commands: ["claude plugin install a@b --scope project"] } }), /name@marketplace/],
    [entry({ kind: "connector", install: { commands: ["x"] }, manual_steps_ja: ["do it"] }), /not allowed for this kind/],
    [entry({ kind: "connector", install: undefined, provides: undefined, manual_steps_ja: undefined }), /manual_steps_ja is required/],
    [entry({ status: "installed-by-app" }), /only fits builtin/],
  ];
  for (const [bad, why] of cases) assert.match(validateCatalog(catalogOf(bad)).join("\n"), why);
  assert.match(validateCatalog(catalogOf(entry(), entry())).join("\n"), /duplicate id/);
  assert.match(validateCatalog({ ...catalogOf(entry()), version: 2 }).join("\n"), /version must be 1/);
  assert.match(validateCatalog({ ...catalogOf(entry()), watchlist: [{ name: "n" }] }).join("\n"), /watchlist\[0\]/);
  assert.deepEqual(validateCatalog(null), ["the catalog is not an object"]);
});

async function scratch(run) {
  const root = await mkdtemp(join(tmpdir(), "mvs-catalog-"));
  const pjDir = join(root, "pj");
  const home = join(root, "home");
  await mkdir(pjDir, { recursive: true });
  await mkdir(home, { recursive: true });
  try { await run({ pjDir, home }); } finally { await rm(root, { recursive: true, force: true }); }
}
const skill = async (base, name) => { await mkdir(join(base, ".claude", "skills", name), { recursive: true }); await writeFile(join(base, ".claude", "skills", name, "SKILL.md"), "---\nname: x\n---\n"); };

test("skills: installed in the project or in the user's home, partly, or not at all", async () => {
  await scratch(async ({ pjDir, home }) => {
    const two = entry({ provides: { skills: ["a-skill", "b-skill"] } });
    assert.equal((await installState(two, { pjDir, home, plugins: null })).state, "not-installed");
    await skill(pjDir, "a-skill");
    assert.deepEqual(await installState(two, { pjDir, home, plugins: null }), { state: "partial", detail: "1/2 skills found" });
    await skill(home, "b-skill");
    assert.equal((await installState(two, { pjDir, home, plugins: null })).state, "installed");
  });
});

test("plugins come from `claude plugin list`; an unreadable list is unknown, not a guess", async () => {
  const plugin = entry({ kind: "plugin", provides: { plugin: "hyperframes@hyperframes" }, install: { commands: ["claude plugin install hyperframes@hyperframes --scope project"] } });
  await scratch(async ({ pjDir, home }) => {
    assert.equal((await installState(plugin, { pjDir, home, plugins: null })).state, "unknown");
    assert.equal((await installState(plugin, { pjDir, home, plugins: [{ id: "other@x" }] })).state, "not-installed");
    assert.deepEqual(await installState(plugin, { pjDir, home, plugins: [{ id: "hyperframes@hyperframes", scope: "project", enabled: true }] }), { state: "installed", detail: "project scope" });
    assert.equal((await installState(plugin, { pjDir, home, plugins: [{ id: "hyperframes@hyperframes", scope: "user", enabled: false }] })).state, "partial");
  });
});

test("MCP servers are found in the project's .mcp.json; builtin and manual kinds say so", async () => {
  const mcp = entry({ kind: "mcp", provides: { mcp: "comfyui" }, install: { commands: ["claude mcp add comfyui --scope project -- npx -y comfyui-mcp"] } });
  await scratch(async ({ pjDir, home }) => {
    assert.equal((await installState(mcp, { pjDir, home, plugins: null })).state, "not-installed");
    await writeFile(join(pjDir, ".mcp.json"), JSON.stringify({ mcpServers: { comfyui: { command: "npx" } } }));
    assert.equal((await installState(mcp, { pjDir, home, plugins: null })).state, "installed");
    assert.equal((await installState(entry({ kind: "builtin", status: "installed-by-app", install: undefined, provides: undefined, manual_steps_ja: ["x"] }), { pjDir, home, plugins: null })).state, "builtin");
    assert.equal((await installState(entry({ kind: "system", install: undefined, provides: undefined, manual_steps_ja: ["x"] }), { pjDir, home, plugins: null })).state, "manual");
  });
});

test("describeCatalog adds the install state, hides the evidence list, and filters by category", async () => {
  await scratch(async ({ pjDir, home }) => {
    const catalog = catalogOf(entry({ id: "a-tool", category: ["render"] }), entry({ id: "b-tool", category: ["generation"], provides: { skills: ["b-skill"] } }));
    const all = await describeCatalog(catalog, { pjDir, home, plugins: null });
    assert.deepEqual(all.entries.map((e) => [e.id, e.installed.state]), [["a-tool", "not-installed"], ["b-tool", "not-installed"]]);
    assert.ok(all.entries.every((e) => !("evidence" in e)));
    const only = await describeCatalog(catalog, { pjDir, home, plugins: null, category: "generation" });
    assert.deepEqual(only.entries.map((e) => e.id), ["b-tool"]);
    assert.equal(only.watchlist, undefined);
  });
});

test("a project-scope plugin counts only in the project it was installed in; user scope counts everywhere", async () => {
  const plugin = entry({ kind: "plugin", provides: { plugin: "hyper@hyper" }, install: { commands: ["claude plugin install hyper@hyper --scope project"] } });
  await scratch(async ({ pjDir, home }) => {
    const other = join(pjDir, "..", "other-pj");
    // listed from here, the install made in another project shows up disabled: that is "not installed here", not "partly"
    const elsewhere = [{ id: "hyper@hyper", scope: "project", enabled: false, projectPath: other }];
    assert.deepEqual(await installState(plugin, { pjDir, home, plugins: elsewhere }), { state: "not-installed", detail: "installed in another project: other-pj" });
    const here = [{ id: "hyper@hyper", scope: "project", enabled: true, projectPath: pjDir }];
    assert.deepEqual(await installState(plugin, { pjDir, home, plugins: here }), { state: "installed", detail: "project scope" });
    // the same folder written differently (trailing separator, mixed case on Windows) is still the same project
    const respelled = [{ id: "hyper@hyper", scope: "project", enabled: true, projectPath: `${process.platform === "win32" ? pjDir.toUpperCase() : pjDir}/` }];
    assert.equal((await installState(plugin, { pjDir, home, plugins: respelled })).state, "installed");
    // installed here and also in another project: the one here wins
    assert.equal((await installState(plugin, { pjDir, home, plugins: [...elsewhere, ...here] })).state, "installed");
    // user scope applies to every project; a disabled one is only partly there
    assert.equal((await installState(plugin, { pjDir, home, plugins: [{ id: "hyper@hyper", scope: "user", enabled: true }] })).state, "installed");
    assert.equal((await installState(plugin, { pjDir, home, plugins: [{ id: "hyper@hyper", scope: "user", enabled: false }] })).state, "partial");
  });
});

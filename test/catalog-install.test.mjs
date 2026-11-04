import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { commandProblem, loadCatalog } from "../catalog.mjs";
import { createCatalogInstaller, forScope, planInstall } from "../catalog-install.mjs";

const CATALOG_FILE = fileURLToPath(new URL("../catalog/video-tools.json", import.meta.url));
const catalog = await loadCatalog(CATALOG_FILE);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = { catalog, pjDir: "/w/PJs/p1", userDir: "/w", claudeCommand: "claude" };

test("the user-scope twin of a command is derived mechanically, and both forms pass the checks", () => {
  assert.equal(forScope("skills", "npx skills add o/r -a claude-code --copy -y", "user"), "npx skills add o/r -g -a claude-code --copy -y");
  assert.equal(forScope("plugin", "claude plugin install a@b --scope project", "user"), "claude plugin install a@b --scope user");
  assert.equal(forScope("mcp", "claude mcp add x --scope project -- npx -y x", "user"), "claude mcp add x --scope user -- npx -y x");
  assert.equal(forScope("plugin", "claude plugin install a@b --scope project", "project"), "claude plugin install a@b --scope project");
  for (const entry of catalog.entries.filter((e) => e.install)) {
    for (const command of entry.install.commands) {
      assert.equal(commandProblem(entry.kind, command), null, command);
      assert.equal(commandProblem(entry.kind, forScope(entry.kind, command, "user"), { scope: "user" }), null, `${entry.id}: ${command}`);
      assert.match(commandProblem(entry.kind, forScope(entry.kind, command, "user")) ?? "ok", /global|project/, "a user-scope command is not valid as a project one");
    }
  }
});

test("plan: project scope runs the catalog's commands in the project folder; user scope runs the twins elsewhere", () => {
  const project = planInstall({ ...base, id: "gsap-skills", scope: "project" });
  assert.equal(project.ok, true);
  assert.deepEqual(project.steps.map((s) => [s.command, s.cwd]), [["npx skills add https://github.com/greensock/gsap-skills -a claude-code --copy -y", "/w/PJs/p1"]]);
  const user = planInstall({ ...base, id: "hyperframes", scope: "user" });
  assert.deepEqual(user.steps.map((s) => s.command), ["claude plugin marketplace add heygen-com/hyperframes --scope user", "claude plugin install hyperframes@hyperframes --scope user"]);
  assert.ok(user.steps.every((s) => s.cwd === "/w"));
});

test("plan: a native claude path is quoted, other commands are untouched", () => {
  const plan = planInstall({ ...base, id: "hyperframes", scope: "project", claudeCommand: "C:\\Users\\me\\.local\\bin\\claude.exe" });
  assert.ok(plan.steps[0].run.startsWith('"C:\\Users\\me\\.local\\bin\\claude.exe" plugin marketplace add'));
  assert.equal(plan.steps[0].display.startsWith("claude plugin"), true, "the user sees the plain command");
  assert.ok(planInstall({ ...base, id: "gsap-skills", scope: "project", claudeCommand: "C:\\x\\claude.exe" }).steps[0].run.startsWith("npx skills add"));
});

test("plan: refuses what the button must not do", () => {
  const cases = [
    [{ id: "nope", scope: "project" }, /no catalog entry/],
    [{ id: "ffmpeg", scope: "project" }, /not installed by the app/],
    [{ id: "kling", scope: "project" }, /not installed by the app/],
    [{ id: "suno", scope: "project" }, /not installed by the app/],
    [{ id: "gsap-skills", scope: "machine" }, /scope must be one of/],
    [{ id: "gsap-skills", scope: "project", pjDir: null }, /choose a project/],
  ];
  for (const [input, why] of cases) {
    const plan = planInstall({ ...base, ...input });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, why);
    assert.deepEqual(plan.steps, []);
  }
  // an entry that slipped a bad command in is refused at install time too
  const tampered = { entries: [{ id: "bad", kind: "skills", install: { commands: ["npx skills add o/r -g -a claude-code --copy -y"] } }] };
  assert.match(planInstall({ ...base, catalog: tampered, id: "bad", scope: "project" }).reason, /not allowed/);
  const piped = { entries: [{ id: "bad", kind: "skills", install: { commands: ["npx skills add o/r -a claude-code --copy -y | sh"] } }] };
  assert.match(planInstall({ ...base, catalog: piped, id: "bad", scope: "project" }).reason, /not allowed/);
});

const installer = (over = {}) => createCatalogInstaller({
  getCatalog: () => catalog, pjDirOf: async (pj) => (pj === "p1" ? "/w/PJs/p1" : null), userDir: "/w", claudeCommand: () => "claude", ...over,
});
const until = async (inst, states) => { for (let i = 0; i < 400 && !states.includes(inst.snapshot().state); i++) await wait(5); return inst.snapshot(); };

test("installer: runs the steps in order in the right folder, logs clean lines, and reports when finished", async () => {
  const ran = [];
  let finished = 0;
  const inst = installer({
    onFinished: () => finished++,
    run: async (line, { cwd, onData }) => { ran.push([line, cwd]); onData("\u001b[32m✓\u001b[39m │ Installed 8 skills\n"); return 0; },
  });
  await inst.start({ id: "hyperframes", scope: "project", pj: "p1" });
  const done = await until(inst, ["done", "error"]);
  assert.equal(done.state, "done");
  assert.deepEqual(ran.map(([line]) => line.split(" ").slice(0, 3).join(" ")), ["claude plugin marketplace", "claude plugin install"]);
  assert.ok(ran.every(([, cwd]) => cwd === "/w/PJs/p1"));
  assert.ok(done.log.includes("✓ Installed 8 skills"), "colour codes and box lines are removed");
  assert.equal(done.pj, "p1");
  assert.equal(finished, 1);
});

test("installer: a failing step stops the install and shows the last lines of its output", async () => {
  let calls = 0;
  const inst = installer({ run: async (line, { onData }) => { calls++; onData("fetching\nERROR: repository not found\n"); return 1; } });
  await inst.start({ id: "hyperframes", scope: "project", pj: "p1" });
  const result = await until(inst, ["done", "error"]);
  assert.equal(result.state, "error");
  assert.equal(calls, 1);
  assert.match(result.error, /repository not found/);
  assert.deepEqual(result.steps.map((s) => s.state), ["error", "skipped"]);
});

test("installer: cancel stops it; it will not start twice, while the tools setup runs, or for a missing project", async () => {
  const slow = installer({ run: (line, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(1))) });
  await slow.start({ id: "gsap-skills", scope: "project", pj: "p1" });
  await assert.rejects(slow.start({ id: "gsap-skills", scope: "project", pj: "p1" }), /another install is running/);
  assert.equal(slow.cancel(), true);
  const cancelled = await until(slow, ["cancelled", "error", "done"]);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.error, null);
  await assert.rejects(installer({ isBusy: () => true }).start({ id: "gsap-skills", scope: "project", pj: "p1" }), /tools setup is running/);
  await assert.rejects(installer().start({ id: "gsap-skills", scope: "project", pj: "ghost" }), /project does not exist/);
  await assert.rejects(installer().start({ id: "ffmpeg", scope: "project", pj: "p1" }), /not installed by the app/);
});

test("installer: preview shows exactly what start would run", async () => {
  const inst = installer();
  const preview = await inst.preview({ id: "topview", scope: "user" });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.steps.map((s) => s.display), [
    "claude plugin marketplace add https://github.com/topviewai/plugins --scope user --sparse .claude-plugin plugins",
    "claude plugin install topview-browser@topview --scope user",
  ]);
  assert.equal((await inst.preview({ id: "kling", scope: "project", pj: "p1" })).ok, false);
});

// ---- the workspace scope and the automatic install into new projects ----
const pjs = [{ name: "p1", dir: "/w/PJs/p1" }, { name: "p2", dir: "/w/PJs/p2" }];
const memoryStore = (initial = []) => { const store = { ids: [...initial], read: async () => [...store.ids], write: async (ids) => { store.ids = [...ids]; } }; return store; };
const workspaceInstaller = (over = {}) => installer({ pjDirsOf: async () => pjs, autoStore: memoryStore(), pjDirOf: async (pj) => pjs.find((p) => p.name === pj)?.dir ?? null, ...over });

test("workspace plan: the catalog's project commands, once per project, each in its own folder", () => {
  const plan = planInstall({ ...base, id: "hyperframes", scope: "workspace", pjDirs: pjs });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((s) => [s.group, s.cwd, s.command.split(" ").slice(0, 3).join(" ")]), [
    ["p1", "/w/PJs/p1", "claude plugin marketplace"], ["p1", "/w/PJs/p1", "claude plugin install"],
    ["p2", "/w/PJs/p2", "claude plugin marketplace"], ["p2", "/w/PJs/p2", "claude plugin install"],
  ]);
  assert.ok(plan.steps.every((s) => s.command.includes("--scope project")), "never global");
  assert.equal(planInstall({ ...base, id: "hyperframes", scope: "workspace", pjDirs: [] }).steps.length, 0, "no project yet: only the automatic part remains");
});

test("workspace preview shows each command once and names the projects, and says new projects are covered", async () => {
  const preview = await workspaceInstaller().preview({ id: "hyperframes", scope: "workspace" });
  assert.equal(preview.ok, true);
  assert.equal(preview.steps.length, 2);
  assert.deepEqual(preview.targets, ["p1", "p2"]);
  assert.equal(preview.auto, true);
  assert.equal((await workspaceInstaller().preview({ id: "hyperframes", scope: "project", pj: "p1" })).auto, false);
});

test("workspace install: every project is served, one failing project does not stop the others, and only a full success turns on the automatic install", async () => {
  const store = memoryStore();
  const ran = [];
  const inst = workspaceInstaller({
    autoStore: store,
    run: async (line, { cwd, onData }) => { ran.push(cwd); if (cwd.endsWith("p1")) { onData("ERROR: network down\n"); return 1; } return 0; },
  });
  await inst.start({ id: "hyperframes", scope: "workspace" });
  const result = await until(inst, ["done", "error"]);
  assert.equal(result.state, "error");
  assert.match(result.error, /p1: .*network down/);
  assert.deepEqual(ran, ["/w/PJs/p1", "/w/PJs/p2", "/w/PJs/p2"], "p1's second step is skipped, p2 runs both");
  assert.deepEqual(result.steps.map((s) => s.state), ["error", "skipped", "done", "done"]);
  assert.deepEqual(store.ids, [], "not registered after a partial failure");

  const ok = workspaceInstaller({ autoStore: store, run: async () => 0 });
  await ok.start({ id: "hyperframes", scope: "workspace" });
  assert.equal((await until(ok, ["done", "error"])).state, "done");
  assert.deepEqual(store.ids, ["hyperframes"]);
  await ok.start({ id: "hyperframes", scope: "workspace" });
  await until(ok, ["done", "error"]);
  assert.deepEqual(store.ids, ["hyperframes"], "registered once, not twice");
});

test("workspace install with no project yet still turns on the automatic install", async () => {
  const store = memoryStore();
  const inst = workspaceInstaller({ pjDirsOf: async () => [], autoStore: store, run: async () => { throw new Error("nothing should run"); } });
  await inst.start({ id: "gsap-skills", scope: "workspace" });
  assert.equal((await until(inst, ["done", "error"])).state, "done");
  assert.deepEqual(store.ids, ["gsap-skills"]);
});

test("a new project gets the automatic entries in its own folder, one after the other, as project-scope installs", async () => {
  const ran = [];
  const inst = workspaceInstaller({ autoStore: memoryStore(["hyperframes", "gsap-skills"]), run: async (line, { cwd }) => { ran.push([line.split(" ").slice(0, 3).join(" "), cwd]); await wait(5); return 0; } });
  inst.queueAuto("p2");
  for (let i = 0; i < 400 && ran.length < 3; i++) await wait(5);
  await wait(30);
  assert.deepEqual(ran, [["claude plugin marketplace", "/w/PJs/p2"], ["claude plugin install", "/w/PJs/p2"], ["npx skills add", "/w/PJs/p2"]]);
  assert.ok(ran.every(([, cwd]) => cwd === "/w/PJs/p2"));
});

test("automatic installs wait behind a manual install, never overlap it, and skip a project that is gone", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  let concurrent = 0;
  let peak = 0;
  const inst = workspaceInstaller({
    autoStore: memoryStore(["gsap-skills"]),
    run: async (line, { cwd }) => { concurrent++; peak = Math.max(peak, concurrent); order.push(cwd); if (order.length === 1) await gate; concurrent--; return 0; },
  });
  await inst.start({ id: "hyperframes", scope: "project", pj: "p1" }); // holds the gate on its first step
  inst.queueAuto("p2");
  inst.queueAuto("ghost");
  await wait(30);
  assert.deepEqual(order, ["/w/PJs/p1"], "the automatic install waits");
  release();
  for (let i = 0; i < 400 && order.length < 3; i++) await wait(5);
  await wait(30);
  assert.deepEqual(order, ["/w/PJs/p1", "/w/PJs/p1", "/w/PJs/p2"], "after the manual one, p2 gets its entry; the missing project gets nothing");
  assert.equal(peak, 1, "never two commands at once");
});

test("the automatic install can be switched off and on per entry, and only for entries the app can install", async () => {
  const store = memoryStore();
  const inst = workspaceInstaller({ autoStore: store });
  assert.deepEqual(await inst.setAuto("hyperframes", true), ["hyperframes"]);
  assert.deepEqual(await inst.setAuto("gsap-skills", true), ["hyperframes", "gsap-skills"]);
  assert.deepEqual(await inst.setAuto("hyperframes", false), ["gsap-skills"]);
  assert.deepEqual(await inst.auto(), ["gsap-skills"]);
  await assert.rejects(inst.setAuto("ffmpeg", true), /cannot be installed by the app/);
  await assert.rejects(inst.setAuto("nope", true), /cannot be installed by the app/);
});

test("batch install: several entries in every project, a failure skips only that entry in that project, and fully installed entries become automatic", async () => {
  const store = memoryStore();
  const ran = [];
  const inst = workspaceInstaller({
    autoStore: store,
    run: async (line, { cwd, onData }) => { ran.push(`${line.split(" ").slice(0, 3).join(" ")}@${cwd.split("/").pop()}`); if (line.startsWith("claude plugin marketplace") && cwd.endsWith("p2")) { onData("ERROR: boom\n"); return 1; } return 0; },
  });
  const preview = await inst.preview({ ids: ["hyperframes", "gsap-skills"], scope: "workspace" });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.targets, ["p1", "p2"]);
  assert.equal(preview.steps.length, 3, "each distinct command once");
  await inst.start({ ids: ["hyperframes", "gsap-skills"], scope: "workspace" });
  const result = await until(inst, ["done", "error"]);
  assert.equal(result.state, "error");
  assert.equal(result.count, 2);
  assert.match(result.error, /hyperframes @ p2/);
  assert.ok(ran.includes("npx skills add@p2"), "the other entry still runs in the project where the first failed");
  assert.ok(!ran.includes("claude plugin install@p2"), "the failed entry's later step is skipped");
  assert.deepEqual(store.ids, ["gsap-skills"], "only the entry that fully succeeded is automatic");
  assert.equal((await workspaceInstaller().preview({ ids: [], scope: "workspace" })).ok, false);
  assert.equal((await workspaceInstaller().preview({ ids: ["hyperframes", "ffmpeg"], scope: "workspace" })).ok, false, "one non-installable entry refuses the whole batch");
});

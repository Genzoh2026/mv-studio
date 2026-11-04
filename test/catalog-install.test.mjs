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
  assert.deepEqual(result.steps.map((s) => s.state), ["error", "waiting"]);
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

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-features-"));
process.env.AGY_CONFIG_DIR = path.join(tmp, "config");
process.env.CODEX_BRIDGE_STATE_DIR = path.join(tmp, "state");
process.env.CODEX_HOME = path.join(tmp, "codex");
const { writeJson, saveSettings, readSettings, applyDefaults, boundThread, bindThread, desktopOpener, stateDir } = await import("../lib/preferences.mjs");
const { usageReader } = await import("../lib/usage.mjs");
const { projectSync, pendingProjects } = await import("../lib/projects.mjs");
const { handle } = await import("../mcp/server.mjs");
const { readPanelState } = await import("../sidecars/codex_panel/main.mjs");
const { available, compareVersions, updater } = await import("../lib/update.mjs");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("共享设置支持跟随、覆盖和显式参数", () => {
  assert.deepEqual(readSettings(), { model: "", effort: "", openDesktop: true });
  saveSettings({ model: "worker", effort: "high", openDesktop: false });
  assert.equal(readSettings().openDesktop, false);
  assert.deepEqual(applyDefaults({ model: "explicit" }, readSettings()), { model: "explicit", effort: "high" });
  assert.equal(applyDefaults({ effort: "low" }, readSettings()).effort, "low");
  assert.throws(() => saveSettings({ openDesktop: "no" }), /设置格式/);
});

test("同线程重复跳转合并，切换线程或超过间隔立即打开", () => {
  let time = 100;
  const calls = [], open = desktopOpener(url => calls.push(url), () => time);
  open("A", false); open("A", true); open("A", true); open("B", true);
  time += 1501; open("B", true);
  assert.deepEqual(calls, ["codex://threads/A", "codex://threads/B", "codex://threads/B"]);
});

test("两个对话的绑定独立，磁盘恢复后仍可定位，手动选择优先直至绑定变化", async () => {
  const logs = path.join(stateDir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  for (const id of ["alpha", "beta"]) fs.writeFileSync(path.join(logs, id + ".jsonl"), JSON.stringify({
    ts: new Date().toISOString(), kind: "thread_meta", action: "start", name: id }) + "\n");
  bindThread(stateDir, "a", "alpha"); bindThread(stateDir, "b", "beta");
  assert.equal(boundThread(stateDir, "a"), "alpha");
  assert.equal((await readPanelState({ conversationId: "a", threadId: "beta" })).activeThreadId, "alpha");
  assert.equal((await readPanelState({ conversationId: "a", knownBinding: "alpha", threadId: "beta" })).activeThreadId, "beta");
  const data = await handle("tools/call", { name: "read_thread", arguments: { threadId: "alpha" } });
  assert.equal(data.structuredContent.title, "alpha");
  assert.equal((await handle("tools/call", { name: "read_thread", arguments: { threadId: "unknown" } })).isError, true);
});

test("监管用量按本地日期计数，重复快照、接管前历史、缓存子项均不重复累加", async () => {
  const logs = path.join(tmp, "usage");
  fs.mkdirSync(logs);
  const counts = (i, cached, out) => ({ inputTokens: i, cachedInputTokens: cached, outputTokens: out,
    reasoningOutputTokens: Math.floor(out / 2), totalTokens: i + out });
  const snapshot = (day, turn, total, last, legacy = false) => ({
    ts: new Date(2026, 5, day, 12).toISOString(), turnId: turn,
    ...(legacy ? { kind: "event:turn_completed", data: { tokenUsage: { tokenUsage: { total, last } } } } :
      { kind: "token_usage", tokenUsage: { total, last } }) });
  const first = counts(100, 80, 20), second = counts(50, 5, 10), sum = counts(150, 85, 30);
  const a = snapshot(15, "t", first, first);
  const rows = [{ kind: "thread_meta", action: "start" }, a, a, snapshot(16, "t", sum, second), a, snapshot(16, "t", sum, second, true)];
  fs.writeFileSync(path.join(logs, "a.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"));
  const legacy = [{ kind: "thread_meta", action: "resume" }, snapshot(14, "r1", counts(900, 800, 100), second, true),
    snapshot(16, "r2", counts(920, 810, 105), counts(5, 2, 1), true)];
  fs.writeFileSync(path.join(logs, "b.jsonl"), legacy.map(r => JSON.stringify(r)).join("\n"));
  fs.writeFileSync(path.join(tmp, "unrelated.jsonl"), JSON.stringify(snapshot(16, "foreign", sum, sum)));
  const read = usageReader(logs);
  const { periods, days } = await read(new Date(2026, 5, 16, 12));
  assert.deepEqual(periods.map(p => p.totalTokens), [85, 205, 265, 265]);
  assert.equal(periods[0].hitRate, 15 / 70);
  assert.equal(days["2026-06-16"].reasoningOutputTokens, 7);
  assert.deepEqual((await read(new Date(2028, 5, 16))).periods.map(p => p.hitRate), [null, null, null, null]);
});

test("项目基线、延迟出现的目录、多根匹配、并发重试和重启", async () => {
  const base = path.join(tmp, "projects-test"), files = path.join(base, "projects");
  const roots = ["one", "two"].map(v => path.join(base, v));
  const ledger = path.join(base, "ledger.json");
  const project = (id, dirs, extra = {}) => writeJson(path.join(files, id + ".json"), { id, name: id, ...extra,
    projectResources: { resources: dirs.map((r, i) => i ? { gitFolder: { folderUri: pathToFileURL(r).href } } : { folderUri: pathToFileURL(r).href }) } });
  fs.mkdirSync(roots[0], { recursive: true }); project("old", [roots[0]]);
  const created = [], registered = [{ id: "existing", roots: [{ path: roots[0] }] }];
  const rpc = async (method, args) => {
    if (method === "project/list") return { data: registered, nextCursor: null };
    assert.equal(method, "project/create"); created.push(args);
    const target = { id: "new-id", roots: args.roots }; registered.push(target); return { project: target };
  };
  const sync = projectSync(files, ledger, rpc);
  await sync(); assert.equal(created.length, 0);
  assert.equal(await sync("old", roots[0]), "existing");
  project("plugin", [roots[0]], { sidecar: {} }); project("new", roots);
  assert.equal(pendingProjects(files, JSON.parse(fs.readFileSync(ledger))), false);
  fs.mkdirSync(roots[1]);
  assert.equal(pendingProjects(files, JSON.parse(fs.readFileSync(ledger))), true);
  await Promise.all([sync(), sync("new", roots[1])]);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].roots.map(r => r.path), roots);
  assert.equal(created[0].idempotencyKey, "antigravity:new");
  assert.equal(await projectSync(files, ledger, rpc)("new", roots[1]), "new-id");
  assert.equal(created.length, 1);
});

test("版本优先级、预发布、同版前进与落后提交", async () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0-rc.11", "1.0.0-rc.2"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0);
  assert.throws(() => compareVersions("01.0.0", "1.0.0"));
  const local = { version: "1.5.0", commitSha: "a" };
  for (const [remote, ahead, expected] of [
    [{ ...local }, true, false], [{ ...local, commitSha: "b" }, true, true],
    [{ ...local, commitSha: "b" }, false, false], [{ version: "1.4.0" }, true, false],
    [{ version: "1.6.0" }, false, true],
  ]) assert.equal(await available(local, remote, () => ahead), expected);
});

test("Fork 检查使用发布清单，自动检查缓存、手动刷新、损坏清单报错", async () => {
  const pkg = path.join(tmp, "package");
  const current = { version: "1.5.0", commitSha: "a".repeat(40) };
  writeJson(path.join(pkg, "install-info.json"), current);
  const remote = { ...current, commitSha: "b".repeat(40), releaseTag: "latest", builtAt: new Date().toISOString(),
    sha256: "c".repeat(64), assetName: "codex-supervisor.zip" };
  let calls = 0;
  const service = updater(pkg, async url => {
    calls++;
    if (url.includes("/compare/")) return { status: "ahead" };
    if (url.includes("/commits/")) return { commit: { message: "支持暗色面板\n\n详细说明" } };
    if (url.endsWith("release-manifest.json")) return remote;
    return { tag_name: "latest", assets: [{ name: remote.assetName }, { name: "release-manifest.json" }] };
  });
  const update = await service.check();
  assert.equal(update.available, true);
  assert.equal(update.remote.summary, "支持暗色面板");
  const first = calls;
  await service.check(); assert.equal(calls, first);
  remote.commitSha = current.commitSha;
  assert.equal((await service.check(true)).available, false);
  remote.sha256 = "invalid"; await assert.rejects(service.check(true), /清单/);
  await assert.rejects(service.install("unknown"), /已安装插件/);
});

test("MCP stdio 握手、工具和可内联的侧栏资源", () => {
  const requests = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { method: "notifications/initialized" }, { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "open_thread", arguments: { threadId: "alpha" } } },
    { id: 4, method: "resources/read", params: { uri: "ui://codex-supervisor/thread.html" } },
  ];
  const raw = execFileSync(process.execPath, [path.join(root, "mcp/server.mjs")], { input: requests.map(r => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n", encoding: "utf8", maxBuffer: 4e6 });
  const [init, list, call, resource] = raw.trim().split("\n").map(s => JSON.parse(s).result);
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual(list.tools[0]._meta["com.google.antigravity/ui"].entrypoints[0].type, "aux_pane");
  assert.equal(call.structuredContent.threadId, "alpha");
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /app\.connect\(/);
  assert.doesNotMatch(resource.contents[0].text, /<script src=/);
});

test("MCP 待机页读写共享配置、最近三项，以及按提交忽略更新", async () => {
  const call = async (name, args = {}) => (await handle("tools/call", { name, arguments: args })).structuredContent;
  const prefs = await call("settings");
  await call("save_settings", { model: "ui-model", effort: "low" });
  assert.equal(readSettings().model, "ui-model");
  await call("save_settings", prefs);
  const logs = path.join(stateDir, "logs");
  for (let i = 0; i < 4; i++) {
    const f = path.join(logs, "recent-" + i + ".jsonl");
    fs.writeFileSync(f, JSON.stringify({ kind: "thread_meta", name: "监管任务" + i, cwd: root }));
    fs.utimesSync(f, new Date(), new Date(Date.now() + (i + 1) * 2000));
  }
  const home = await call("home");
  assert.deepEqual(home.recent.map(r => r.name), ["监管任务3", "监管任务2", "监管任务1"]);
  assert.equal(home.recent[0].project, path.basename(root));
  const sha = "d".repeat(40);
  const cached = { local: { version: home.version }, available: true, remote: { commitSha: sha, summary: "待机页更新" } };
  const cache = path.join(process.env.AGY_CONFIG_DIR, "codex-supervisor/update-check.json");
  writeJson(cache, { at: Date.now(), result: cached });
  assert.equal((await call("check_update")).ignored, false);
  await call("ignore_update", { commitSha: sha });
  saveSettings({ openDesktop: false });
  assert.equal((await call("settings")).ignoredUpdateSha, sha);
  assert.equal((await call("check_update")).ignored, true);
  cached.remote.commitSha = "e".repeat(40);
  writeJson(cache, { at: Date.now(), result: cached });
  assert.equal((await call("check_update")).ignored, false);
  await assert.rejects(call("ignore_update", { commitSha: "bad" }), /提交号/);
});

test("真实 CLI → bridge → 模拟 app-server 的模型、派单、项目与更新互斥", async () => {
  const fixture = path.join(root, "tests/fixtures");
  const trace = path.join(tmp, "calls");
  const daemon = path.join(root, "skills/codex-supervisor/scripts/bridge-daemon.mjs");
  const config = path.join(process.env.AGY_CONFIG_DIR, "projects");
  const env = { ...process.env, CODEX_BIN: process.execPath, SUPERVISOR_TEST_CALLS: trace,
    ANTIGRAVITY_PROJECT_ID: "new-project", ANTIGRAVITY_CONVERSATION_ID: "conv-integration" };
  const proc = spawn(process.execPath, [daemon], { cwd: fixture, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const done = once(proc, "exit");
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(path.dirname(daemon), "codex-ctl.mjs"), ...args], { env, encoding: "utf8", timeout: 15000 }));
  try {
    const ready = await Promise.race([once(proc.stdout, "data"), done.then(() => { throw new Error("bridge 启动失败"); })]);
    assert.equal(JSON.parse(ready[0]).ready, true);
    writeJson(path.join(config, "new-project.json"), { id: "new-project", name: "多目录项目",
      projectResources: { resources: [{ folderUri: pathToFileURL(fixture).href }] } });
    const models = cli("models", "--settings");
    assert.deepEqual(models.models[0].supportedReasoningEfforts, ["high", "low"]);
    assert.equal(models.configuredModel, "mock-model");
    const catalog = await handle("tools/call", { name: "models" });
    assert.deepEqual(catalog.structuredContent, models);
    const a = cli("start", "--cwd", fixture, "--prompt", "stay_running");
    assert.equal(boundThread(stateDir, env.ANTIGRAVITY_CONVERSATION_ID), a.threadId);
    cli("steer", a.threadId, "--prompt", "keep going");
    cli("start", "--model", "explicit", "--effort", "low", "--cwd", fixture, "--prompt", "stay_running");
    const calls = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter(c => c.method === "project/create").length, 1);
    const starts = calls.filter(c => c.method === "thread/start").map(c => c.params);
    assert.deepEqual(starts.map(p => [p.projectId, p.model, p.config.model_reasoning_effort]), [
      ["codex-project", "worker", "high"], ["codex-project", "explicit", "low"] ]);
    assert.deepEqual(calls.filter(c => c.method === "turn/start").map(c => c.params.effort), ["high", "low"]);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "daemon.json")));
    const post = route => fetch("http://127.0.0.1:" + state.port + route, { method: "POST", headers: { Authorization: "Bearer " + state.token } });
    assert.equal((await post("/update-idle")).status, 409);
    writeJson(path.join(process.env.AGY_CONFIG_DIR, "codex-supervisor/install-" + process.pid + ".lock"), process.pid);
    assert.equal((await post("/start")).status, 409);
  } finally {
    fs.rmSync(path.join(process.env.AGY_CONFIG_DIR, "codex-supervisor/install-" + process.pid + ".lock"), { force: true });
    if (proc.exitCode === null && fs.existsSync(path.join(stateDir, "daemon.json"))) cli("stop");
    else if (proc.exitCode === null) proc.kill();
    await done;
  }
});

test("手动更新通过真实 ZIP 完成安装，外部偏好保留，同一包不重复安装", async () => {
  const target = path.join(process.env.AGY_CONFIG_DIR, "plugins/codex-supervisor");
  const build = path.join(tmp, "build"), commit = "c".repeat(40);
  const python = process.platform === "win32" ? "python.exe" : "python3";
  fs.mkdirSync(path.join(target, "lib"), { recursive: true });
  fs.copyFileSync(path.join(root, "lib/release.py"), path.join(target, "lib/release.py"));
  writeJson(path.join(target, "plugin.json"), { name: "codex-supervisor", version: "1.4.0" });
  execFileSync(python, [path.join(root, "lib/release.py"), "pack", root, build, commit, "latest"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(build, "release-manifest.json")));
  const releases = async url => url.endsWith("release-manifest.json") ? manifest : {
    tag_name: "latest", assets: [{ name: "release-manifest.json" }, { name: manifest.assetName }] };
  const service = updater(target, releases, (_, zip) => fs.copyFileSync(path.join(build, manifest.assetName), zip));
  assert.equal((await service.check(true)).available, true);
  await assert.rejects(service.install("old-check"), /重新检查/);
  const before = readSettings();
  const result = await service.install(commit);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, "plugin.json"))).version, "1.4.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "install-info.json"))).commitSha, commit);
  assert.equal((await service.check(true)).available, false);
  assert.deepEqual(readSettings(), before);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stateDir, readJson, readSettings, saveSettings, boundThread, sessionSettings } from "../../lib/preferences.mjs";
import { usageReader } from "../../lib/usage.mjs";
import { updater } from "../../lib/update.mjs";

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const ctl = path.join(root, "skills/codex-supervisor/scripts/codex-ctl.mjs");
export async function control(...args) {
  const { stdout } = await execute(process.execPath, [ctl, ...args], { windowsHide: true, cwd: os.homedir(), timeout: 45000 });
  return JSON.parse(stdout);
}

const version = readJson(path.join(root, "plugin.json")).version;
const styles = ["styles.css", "view.css"];
const scripts = ["app.js", "controls.js", "view.js"];
export const panelFiles = Object.fromEntries([...styles, ...scripts, "settings.js"].map(name =>
  [name, name.startsWith("view.") ? path.join(root, "mcp", name) : path.join(directory, name)]));

// MCP 要求单文件资源；Sidecar 通过同一组文件提供 HTTP 页面。
export function panelHtml(sdk) {
  const read = name => fs.readFileSync(panelFiles[name], "utf8");
  let head, js;
  if (sdk) {
    head = "<style>" + styles.map(read).join("\n") + "</style>";
    const adapter = fs.readFileSync(path.join(root, "mcp/transport.js"), "utf8");
    const code = [sdk, ...scripts.map(read), adapter].join("\n").replace(/<\/script/gi, "<\\/script");
    js = "<script>" + code + "</script>";
  } else {
    head = '<script src="/preload.js"></script>' + styles.map(name => '<link rel="stylesheet" href="./' + name + '">').join("");
    js = [...scripts, "settings.js"].map(name => '<script src="./' + name + '"></script>').join("");
  }
  const body = fs.readFileSync(path.join(root, "mcp/view.html"), "utf8").replace("<!-- VERSION -->", "v" + version);
  return fs.readFileSync(path.join(directory, "index.html"), "utf8")
    .replace("<!-- HEAD -->", () => head).replace("<!-- PANEL -->", () => body).replace("<!-- SCRIPTS -->", () => js);
}

export function panelActions(readPanelState) {
  const update = updater(root);
  const usage = usageReader(path.join(stateDir, "logs"));
  const syncReady = () => fs.existsSync(path.join(stateDir, "projects.json"));
  const binding = id => boundThread(stateDir, id);
  const sha = { type: "string", pattern: "^[a-f0-9]{40}$" };
  return {
    home: ["读取当前对话和最近监管会话", async ({ conversationId, threadId, sessionKey }) => {
      const bound = binding(conversationId);
      const id = conversationId ? bound : threadId || (sessionKey && sessionSettings(stateDir, { sessionKey }).bound);
      const { daemonOnline, sessions } = await readPanelState({ threadId: id });
      const item = sessions.find(row => row.threadId === id);
      const current = id ? { threadId: id, name: item?.name || id, project: item?.cwd && path.basename(item.cwd),
        model: item?.model, effort: item?.effort, status: item?.status } : undefined;
      const recent = sessions.filter(row => row.threadId !== id).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5)
        .map(({ threadId, name, cwd, status }) => ({ threadId, name, project: cwd ? path.basename(cwd) : "", status }));
      const selection = id || conversationId || sessionKey ? sessionSettings(stateDir, { threadId: id, conversationId, sessionKey }) : {};
      return { binding: bound, current, selection, defaults: readSettings(), daemonOnline, recent, version, syncReady: syncReady() };
    }, { conversationId: { type: "string" }, threadId: { type: "string" }, sessionKey: { type: "string" } }],
    save_session: ["保存当前会话下一轮的模型和强度", ({ conversationId, threadId, sessionKey, model, effort }) => {
      const flags = [];
      for (const [key, value] of Object.entries({ "conversation-id": conversationId, "thread-id": threadId, "session-key": sessionKey, model, effort })) {
        if (typeof value === "string") flags.push("--" + key + "=" + value);
      }
      return control("session-settings", ...flags);
    }, { conversationId: { type: "string" }, threadId: { type: "string" }, sessionKey: { type: "string" },
      model: { type: "string" }, effort: { type: "string" } }],
    read_thread: ["读取监管线程", async ({ threadId, conversationId, etag }) => {
      const data = await readPanelState({ threadId, etag });
      const owner = binding(conversationId);
      if (data.unchanged) return { unchanged: true, binding: owner };
      if (!data.active || data.active.meta.threadId !== threadId) throw new Error("找不到这条监管会话");
      return { ...data, binding: owner, title: data.active.meta.name, syncReady: syncReady() };
    }, { threadId: { type: "string" }, conversationId: {type: "string"}, etag: { type: "string" } }],
    settings: ["读取默认配置", () => readSettings()],
    models: ["读取模型及支持的思考强度", () => control("models", "--settings")],
    save_settings: ["保存默认配置", ({ model, effort, openDesktop }) =>
      saveSettings(Object.fromEntries(Object.entries({ model, effort, openDesktop }).filter(([, v]) => v !== undefined))),
      { model: { type: "string" }, effort: { type: "string" }, openDesktop: { type: "boolean" } }],
    usage: ["读取监管用量", () => usage()],
    check_update: ["检查插件更新", ({ manual }) => update.check(manual === true), { manual: { type: "boolean" } }],
    ignore_update: ["忽略此提交的更新", ({ commitSha }) => {
      if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("提交号无效");
      return saveSettings({ ignoredUpdateSha: commitSha });
    }, { commitSha: sha }],
    install_update: ["安装已确认的更新", ({ commitSha }) => update.install(commitSha), { commitSha: sha }],
  };
}

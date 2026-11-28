import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundThread, stateDir, readSettings, saveSettings } from "../lib/preferences.mjs";
import { readPanelState } from "../sidecars/codex_panel/main.mjs";

import { updater } from "../lib/update.mjs";
import { usageReader } from "../lib/usage.mjs";
import { control } from "../sidecars/codex_panel/server.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")).version;
const update = updater(root);
const usage = usageReader(path.join(stateDir, "logs"));

const uri = "ui://codex-supervisor/thread.html";
const mimeType = "text/html;profile=mcp-app";
const resource = { uri, name: "Codex 监管会话", mimeType };
const schema = { type: "object", properties: { threadId: { type: "string" } }, additionalProperties: false };
const tools = [
  { name: "open_thread", description: "首次派单成功后，传入真实 threadId 打开监管侧栏。", inputSchema: schema,
    _meta: { ui: { resourceUri: uri }, "com.google.antigravity/ui": { entrypoints: [{ type: "aux_pane", title: "Codex Supervisor" }] } } },
  { name: "read_thread", description: "读取当前监管线程的消息。", inputSchema: { ...schema, required: ["threadId"] },
    _meta: { ui: { visibility: ["app"] } } },
];

const sha = { type: "string", pattern: "^[a-f0-9]{40}$" };
const actions = {
  home: ["读取桥接状态和最近监管会话", async () => {
    const { daemonOnline, sessions } = await readPanelState({});
    const recent = sessions.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3)
      .map(({ threadId, name, cwd, status }) => ({ threadId, name, project: cwd ? path.basename(cwd) : "", status }));
    return { daemonOnline, recent, version, syncReady: fs.existsSync(path.join(stateDir, "projects.json")) };
  }],
  settings: ["读取默认配置", () => readSettings()],
  models: ["读取模型及支持的思考强度", () => control("models", "--settings")],
  save_settings: ["保存默认配置", ({ model, effort, openDesktop }) =>
    saveSettings(Object.fromEntries(Object.entries({ model, effort, openDesktop }).filter(([, v]) => v !== undefined))),
    { model: { type: "string" }, effort: { type: "string" }, openDesktop: { type: "boolean" } }],
  usage: ["读取监管用量", () => usage()],
  check_update: ["检查插件更新", () => update.check()],
  ignore_update: ["忽略此提交的更新", ({ commitSha }) => {
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("提交号无效");
    return saveSettings({ ignoredUpdateSha: commitSha });
  }, { commitSha: sha }],
  install_update: ["安装已确认的更新", ({ commitSha }) => update.install(commitSha), { commitSha: sha }],
};
for (const [name, [description, , properties = {}]] of Object.entries(actions)) {
  tools.push({ name, description, inputSchema: { type: "object", properties, additionalProperties: false,
    ...(properties.commitSha ? { required: ["commitSha"] } : {}) }, _meta: { ui: { visibility: ["app"] } } });
}

function html() {
  const script = gunzipSync(fs.readFileSync(path.join(directory, "vendor/ext-apps-2.0.4.js.gz"))).toString();
  const read = file => fs.readFileSync(path.join(directory, file), "utf8");
  const css = read("../sidecars/codex_panel/styles.css") + read("view.css");
  const js = [script, read("../sidecars/codex_panel/controls.js"), read("view.js")].join("\n").replace(/<\/script/gi, "<\\/script");
  return read("view.html").replace("<!-- VERSION -->", "v" + version).replace("/* STYLE */", () => css).replace("/* SCRIPT */", () => js);

}

export async function handle(method, params = {}) {
  if (method === "initialize") return { protocolVersion: ["2025-06-18", "2024-11-05", "2025-03-26", "2025-11-25"].includes(params.protocolVersion) ? params.protocolVersion : "2025-11-25",
    capabilities: { tools: {}, resources: {} }, serverInfo: { name: "codex-supervisor-panel", version: "1.0.0" } };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools };
  if (method === "resources/list") return { resources: [resource] };
  if (method === "resources/templates/list") return { resourceTemplates: [] };
  if (method === "resources/read" && params.uri === uri) return { contents: [{ uri, mimeType, text: html() }] };
  if (method === "tools/call") {
    if (Object.hasOwn(actions, params.name)) {
      return { content: [], structuredContent: await actions[params.name][1](params.arguments || {}) };
    }
    const threadId = params.arguments?.threadId || boundThread(stateDir, process.env.ANTIGRAVITY_CONVERSATION_ID);
    if (params.name === "open_thread") {
      const { model, effort } = readSettings();
      return { content: [{ type: "text", text: threadId ? "已选择监管线程 " + threadId : "当前对话尚未派单" }],
        structuredContent: { threadId, defaultModel: model, defaultEffort: effort } };
    }
    if (params.name === "read_thread" && threadId) {
      const { active, daemonOnline } = await readPanelState({ threadId });
      if (active?.meta.threadId === threadId) return { content: [], structuredContent: {
        daemonOnline, syncReady: fs.existsSync(path.join(stateDir, "projects.json")), title: active.meta.name, model: active.meta.model, status: active.meta.status,
        messages: active.messages.slice(-100).map(m => ({ side: m.side, text: m.text })), draft: active.inFlightDraft } };
      return { isError: true, content: [{ type: "text", text: "找不到这条监管会话" }] };
    }
  }
  throw Object.assign(new Error("不支持此请求：" + method), { code: -32601 });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.chdir(os.homedir());
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", async line => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = await handle(request.method, request.params);
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }));
    }
  });
}

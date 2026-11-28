import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundThread, stateDir } from "../lib/preferences.mjs";
import { readPanelState } from "../sidecars/codex_panel/main.mjs";

import { panelActions, panelHtml } from "../sidecars/codex_panel/api.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const uri = "ui://codex-supervisor/thread.html";
const mimeType = "text/html;profile=mcp-app";
const resource = { uri, name: "Codex 监管会话", mimeType };
const schema = { type: "object", properties: { threadId: { type: "string" }, conversationId: { type: "string" } }, additionalProperties: false };
const tools = [
  { name: "open_thread", description: "首次派单成功后，传入真实 threadId 打开监管侧栏。", inputSchema: schema,
    _meta: { ui: { resourceUri: uri }, "com.google.antigravity/ui": { entrypoints: [{ type: "aux_pane", title: "Codex Supervisor" }] } } },
];
const actions = panelActions(readPanelState);
// toolInfo.id 标识发起这个视图的 tools/call。同一服务可同时服务多个对话。
const opened = new Map();
const home = actions.home[1];
actions.home[1] = async args => {
  const openedThread = opened.get(args.callId);
  return { ...await home({ ...args, threadId: args.threadId || openedThread }), openedThread };
};
actions.home[2].callId = { type: ["string", "integer"] };
for (const [name, [description, , properties = {}]] of Object.entries(actions)) {
  tools.push({ name, description, inputSchema: { type: "object", properties, additionalProperties: false,
    ...(properties.commitSha ? { required: ["commitSha"] } : name === "read_thread" ? { required: ["threadId"] } : {}) }, _meta: { ui: { visibility: ["app"] } } });
}

function html() {
  const vendor = path.join(directory, "vendor");
  const bundle = fs.readdirSync(vendor).find(name => /^ext-apps-[\w.-]+\.js\.gz$/.test(name));
  const script = gunzipSync(fs.readFileSync(path.join(vendor, bundle))).toString();
  return panelHtml(script);
}

export async function handle(method, params = {}, id) {
  if (method === "initialize") return { protocolVersion: ["2025-06-18", "2024-11-05", "2025-03-26", "2025-11-25"].includes(params.protocolVersion) ? params.protocolVersion : "2025-11-25",
    capabilities: { tools: {}, resources: {} }, serverInfo: { name: "codex-supervisor-panel", version: "1.0.0" } };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools };
  if (method === "resources/list") return { resources: [resource] };
  if (method === "resources/templates/list") return { resourceTemplates: [] };
  if (method === "resources/read" && params.uri === uri) return { contents: [{ uri, mimeType, text: html() }] };
  if (method === "tools/call") {
    if (Object.hasOwn(actions, params.name)) {
      try {
        return { content: [], structuredContent: await actions[params.name][1](params.arguments || {}) };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
    }
    if (params.name === "open_thread") {
      const conversationId = params.arguments?.conversationId;
      const threadId = params.arguments?.threadId || boundThread(stateDir, conversationId);
      if (id != null) {
        opened.delete(id);
        if (threadId) opened.set(id, threadId);
        if (opened.size > 128) opened.delete(opened.keys().next().value);
      }
      return { content: [{ type: "text", text: threadId ? "已选择监管线程 " + threadId : "当前对话尚未派单" }],
        structuredContent: { threadId, conversationId } };
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
      const result = await handle(request.method, request.params, request.id);
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }));
    }
  });
}

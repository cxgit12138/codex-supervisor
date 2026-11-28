import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundThread, stateDir, readSettings } from "../lib/preferences.mjs";
import { readPanelState } from "../sidecars/codex_panel/main.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
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

function html() {
  const script = gunzipSync(fs.readFileSync(path.join(directory, "vendor/ext-apps-2.0.4.js.gz"))).toString();
  const css = fs.readFileSync(path.join(directory, "../sidecars/codex_panel/styles.css"), "utf8");
  const view = fs.readFileSync(path.join(directory, "view.js"), "utf8");
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>' + css +
    '</style><main class="chat-scroll"><h2 id="title">监管会话</h2><p id="status">等待派单</p><div id="messages" class="chat-list"></div></main><script>' +
    script.replace(/<\/script/gi, "<\\/script") + '\n' + view + '</script></html>';
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
    const threadId = params.arguments?.threadId || boundThread(stateDir, process.env.ANTIGRAVITY_CONVERSATION_ID);
    if (params.name === "open_thread") {
      const { model, effort } = readSettings();
      return { content: [{ type: "text", text: threadId ? "已选择监管线程 " + threadId : "当前对话尚未派单" }],
        structuredContent: { threadId, defaultModel: model, defaultEffort: effort } };
    }
    if (params.name === "read_thread" && threadId) {
      const { active } = await readPanelState({ threadId });
      if (active?.meta.threadId === threadId) return { content: [], structuredContent: {
        title: active.meta.name, model: active.meta.model, status: active.meta.status,
        messages: active.messages.slice(-100).map(m => ({ side: m.side, text: m.text })), draft: active.inFlightDraft } };
      return { isError: true, content: [{ type: "text", text: "找不到这条监管会话" }] };
    }
  }
  throw Object.assign(new Error("不支持此请求：" + method), { code: -32601 });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.chdir(os.homedir());
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id === undefined) continue;
      const result = await handle(request.method, request.params);
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }));
    }
  }
}

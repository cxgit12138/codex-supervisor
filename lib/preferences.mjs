import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";

export const configRoot = process.env.AGY_CONFIG_DIR || path.join(os.homedir(), ".gemini", "config");
export const stateDir = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), ".gemini", "cache", "codex-supervisor");
export const settingsFile = path.join(configRoot, "codex-supervisor", "settings.json");
export const defaults = { model: "", effort: "", openDesktop: true };

export function readJson(file, missing) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return missing;
    throw error;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function readSettings(file = settingsFile) {
  return { ...defaults, ...readJson(file, {}) };
}

export function saveSettings(patch, file = settingsFile) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, "settings-" + process.pid + ".lock");
  fs.writeFileSync(marker, "");
  try {
    if (liveOwners(dir, /^settings-(\d+)\.lock$/).some(pid => pid !== process.pid)) throw new Error("另一个面板正在保存设置，请重试");
    const { model, effort, openDesktop, ignoredUpdateSha = "" } = { ...readSettings(file), ...patch };
    if (typeof model !== "string" || typeof effort !== "string" || typeof openDesktop !== "boolean") throw new Error("设置格式无效");
    const settings = { model, effort, openDesktop };
    if (ignoredUpdateSha) {
      if (!/^[a-f0-9]{40}$/.test(ignoredUpdateSha)) throw new Error("提交号无效");
      settings.ignoredUpdateSha = ignoredUpdateSha;
    }
    writeJson(file, settings);
    return settings;
  } finally { fs.unlinkSync(marker); }
}

// 每个安装进程登记自己的 PID，意外退出后不会一直挡住派单。
export function activeInstallers() {
  return liveOwners(path.dirname(settingsFile), /^install-(\d+)\.lock$/);
}

function liveOwners(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const active = [];
  for (const name of fs.readdirSync(dir)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    try { process.kill(pid, 0); active.push(pid); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  return active;
}

export function applyDefaults(body, settings) {
  return { ...body, model: body.model || settings.model, effort: body.effort || settings.effort };
}

function bindingFile(dir, conversationId) {
  const key = createHash("sha256").update(conversationId).digest("hex");
  return path.join(dir, "bindings", key + ".json");
}

export function bindThread(dir, conversationId, threadId) {
  if (conversationId) writeJson(bindingFile(dir, conversationId), threadId);
}

export function boundThread(dir, conversationId) {
  return conversationId ? readJson(bindingFile(dir, conversationId), null) : null;
}

export function desktopOpener(launch, now = Date.now) {
  let previous = "", lastOpened = 0;
  return (threadId, enabled) => {
    if (!enabled || (threadId === previous && now() - lastOpened < 1500)) return;
    launch("codex://threads/" + encodeURIComponent(threadId));
    previous = threadId;
    lastOpened = now();
  };
}

export const openDesktop = desktopOpener(url => {
  const command = { win32: "explorer.exe", darwin: "open", linux: "xdg-open" }[process.platform];
  if (!command) return;
  const child = spawn(command, [url], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", err => console.error("无法打开 Codex 桌面", err.message));
  child.unref();
});

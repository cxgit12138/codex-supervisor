import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configRoot, stateDir, readJson, readSettings, saveSettings } from "../../lib/preferences.mjs";
import { usageReader } from "../../lib/usage.mjs";
import { updater } from "../../lib/update.mjs";
import { pendingProjects } from "../../lib/projects.mjs";

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const ctl = path.join(root, "skills/codex-supervisor/scripts/codex-ctl.mjs");
export async function control(...args) {
  const { stdout } = await execute(process.execPath, [ctl, ...args], { windowsHide: true, cwd: os.homedir(), timeout: 45000 });
  return JSON.parse(stdout);
}

function watchProjects() {
  const projects = path.join(configRoot, "projects");
  const ledger = path.join(stateDir, "projects.json");
  let checking = false, timer;
  async function check() {
    if (checking || !fs.existsSync(projects)) return;
    checking = true;
    try {
      if (pendingProjects(projects, readJson(ledger, null))) await control("sync-projects");
    } catch (err) { console.error("项目同步未完成", err.message); }
    finally { checking = false; }
  }
  if (fs.existsSync(projects)) {
    fs.watch(projects, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(check, 400);
    }).on("error", err => console.error("项目目录监听中断", err.message));
  }
  check();
  setInterval(check, 30000).unref();
}

export async function serve(readPanelState) {
  const fallback = path.join(os.homedir(), ".gemini/antigravity/lib/node_modules/sidecar_sdk/index.mjs");
  const sdk = await import("sidecar_sdk").catch(error => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return import(pathToFileURL(fallback).href);
  });
  const app = new sdk.SidecarApp();
  const usage = usageReader(path.join(stateDir, "logs"));
  const update = updater(root);
  const files = { "index.html": "text/html", "styles.css": "text/css", "app.js": "text/javascript", "settings.js": "text/javascript", "controls.js": "text/javascript" };
  for (const [name, type] of Object.entries(files)) {
    const response = () => new sdk.Response(fs.readFileSync(path.join(directory, name)), {
      contentType: type + "; charset=utf-8", headers: { "Cache-Control": "no-store" } });
    if (name === "index.html") app.page("/", response);
    else app.api("/" + name, response, "GET");
  }
  app.api("/api/state", readPanelState);
  app.api("/api/settings", () => readSettings());
  app.api("/api/models", () => control("models", "--settings"));
  app.api("/api/save-settings", data => saveSettings(data));
  app.api("/api/usage", () => usage());
  app.api("/api/update-check", data => update.check(data.manual === true));
  app.api("/api/update-install", async data => {
    const result = await update.install(data.commitSha);
    setTimeout(() => process.exit(0), 1000);
    return result;
  });
  // Windows 会锁住当前工作目录。安装目录必须能在更新时改名。
  process.chdir(os.homedir());
  await app.run();
  watchProjects();
}

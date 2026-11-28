import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configRoot, stateDir, readJson } from "../../lib/preferences.mjs";
import { pendingProjects } from "../../lib/projects.mjs";
import { control, panelActions, panelFiles, panelHtml } from "./api.mjs";

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
  setInterval(check, 30000);
}

export async function serve(readPanelState) {
  // Windows 会锁住当前工作目录。安装目录必须能在更新时改名。
  process.chdir(os.homedir());
  watchProjects();
  if (!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) return;
  const fallback = path.join(os.homedir(), ".gemini/antigravity/lib/node_modules/sidecar_sdk/index.mjs");
  const sdk = await import("sidecar_sdk").catch(error => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return import(pathToFileURL(fallback).href);
  });
  const app = new sdk.SidecarApp();
  const actions = panelActions(readPanelState);
  const install = actions.install_update[1];
  actions.install_update[1] = async args => {
    const result = await install(args);
    setTimeout(() => process.exit(0), 1000);
    return result;
  };
  const html = panelHtml();
  app.page("/", () => new sdk.Response(html, { contentType: "text/html; charset=utf-8", headers: { "Cache-Control": "no-store" } }));
  for (const [name, file] of Object.entries(panelFiles)) {
    app.api("/" + name, () => new sdk.Response(fs.readFileSync(file), {
      contentType: name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      headers: { "Cache-Control": "no-store" },
    }), "GET");
  }
  app.api("/api/state", readPanelState);
  for (const [name, [, run]] of Object.entries(actions)) app.api("/api/" + name, run);
  for (const [old, name] of Object.entries({ "save-settings": "save_settings", "update-check": "check_update", "update-install": "install_update" })) {
    app.api("/api/" + old, actions[name][1]);
  }
  await app.run();
}

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJson, writeJson, readSettings, activeInstallers, configRoot, stateDir } from "./preferences.mjs";

const exec = promisify(execFile);
const repo = "https://api.github.com/repos/MaLinYu/codex-supervisor";
const asset = "codex-supervisor.zip";
const metaName = "release-manifest.json";
const dataDir = path.join(configRoot, "codex-supervisor");

function semver(value) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!m || m[4]?.split(".").some(s => /^0\d+$/.test(s))) throw new Error("无效版本号：" + value);
  return m;
}

export function compareVersions(a, b) {
  const x = semver(a), y = semver(b);
  const cmp = (u, v) => u < v ? -1 : u > v ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const difference = cmp(BigInt(x[i]), BigInt(y[i]));
    if (difference) return difference;
  }
  if (!x[4] || !y[4]) return cmp(Boolean(y[4]), Boolean(x[4]));
  const left = x[4].split("."), right = y[4].split(".");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const ln = /^\d+$/.test(left[i]), rn = /^\d+$/.test(right[i]);
    if (ln && rn) return cmp(BigInt(left[i]), BigInt(right[i]));
    return ln === rn ? cmp(left[i], right[i]) : ln ? -1 : 1;
  }
  return cmp(left.length, right.length);
}

// curl 支持环境代理；Windows 还读取用户为系统配置的静态代理。
async function curl(url, args) {
  const env = process.env;
  let proxy = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (!proxy && process.platform === "win32") {
    const script = "$p=Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings'; if($p.ProxyEnable){$p.ProxyServer}";
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const entries = stdout.trim().split(";");
    proxy = entries.find(s => s.startsWith("https="))?.slice(6) || entries.find(s => s.startsWith("http="))?.slice(5) || entries.find(s => !s.includes("="));
  }
  const run = via => exec(process.platform === "win32" ? "curl.exe" : "curl", ["-sS", "-L", "--proto", "=https", "--proto-redir", "=https",
    "--connect-timeout", "8", "--max-time", "90", ...(via ? ["--proxy", via] : []), ...args, url], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  try { return await run(proxy); }
  catch (err) {
    if (!proxy && process.platform === "win32" && [6, 7, 28].includes(err.code)) return run("socks5h://127.0.0.1:10808");
    throw new Error("下载失败：" + (err.stderr?.trim() || "curl " + err.code));
  }
}

async function jsonUrl(url, optional = false) {
  const { stdout } = await curl(url, ["-w", "\n%{http_code}"]);
  const split = stdout.lastIndexOf("\n");
  const code = Number(stdout.slice(split + 1));
  if (optional && code === 404) return null;
  if (code !== 200) throw new Error("GitHub 返回 HTTP " + code);
  return JSON.parse(stdout.slice(0, split));
}

export async function available(local, remote, ahead) {
  const order = compareVersions(remote.version, local.version);
  if (order) return order > 0;
  if (!local.commitSha) return true;
  if (local.commitSha === remote.commitSha) return false;
  return ahead(local.commitSha, remote.commitSha);
}

function validateManifest(m, tag) {
  semver(m.version);
  if (!/^[a-f0-9]{40}$/.test(m.commitSha) || !/^[a-f0-9]{64}$/.test(m.sha256) || m.releaseTag !== tag ||
      m.assetName !== asset || !Number.isFinite(Date.parse(m.builtAt))) throw new Error("GitHub 发布清单无效");
  return m;
}

export function updater(root, get = jsonUrl, download = (url, file) => curl(url, ["--fail", "-o", file])) {
  const installed = () => readJson(path.join(root, "install-info.json"), null) || { version: readJson(path.join(root, "plugin.json")).version };
  let runningCheck, installInProgress = false;
  async function inspect() {
    const local = installed();
    const candidates = [];
    for (const endpoint of ["/releases/tags/latest", "/releases/latest"]) {
      const release = await get(repo + endpoint, true);
      if (!release || release.draft || release.prerelease || candidates.some(c => c.releaseTag === release.tag_name)) continue;
      const tag = release.tag_name;
      if (tag !== "latest" && !/^v[0-9]/.test(tag)) continue;
      const base = "https://github.com/MaLinYu/codex-supervisor/releases/download/" + encodeURIComponent(tag) + "/";
      if (!release.assets?.some(a => a.name === metaName) || !release.assets.some(a => a.name === asset)) continue;
      candidates.push({ ...validateManifest(await get(base + metaName), tag), url: base + asset });
    }
    candidates.sort((a, b) => compareVersions(b.version, a.version) || Date.parse(b.builtAt) - Date.parse(a.builtAt));
    const ahead = async (from, to) => (await get(repo + "/compare/" + from + "..." + to)).status === "ahead";
    for (const candidate of candidates) {
      if (await available(local, candidate, ahead)) {
        const commit = await get(repo + "/commits/" + candidate.commitSha, true);
        candidate.summary = commit?.commit?.message?.split("\n")[0] || "";
        return { local, remote: candidate, available: true };
      }
    }
    return { local, available: false, published: candidates.length > 0 };
  }
  const cacheFile = path.join(dataDir, "update-check.json");
  function withIgnored(result) {
    return { ...result, ignored: Boolean(result.available && result.remote.commitSha === readSettings().ignoredUpdateSha) };
  }
  async function check(force = false) {
    const cached = readJson(cacheFile, null);
    if (!force && cached && Date.now() - cached.at < 86400000 && cached.result.local.version === installed().version &&
        cached.result.local.commitSha === installed().commitSha && (!cached.result.available || typeof cached.result.remote.summary === "string")) {
      return withIgnored(cached.result);
    }
    if (!runningCheck) runningCheck = inspect().then(result => {
      writeJson(cacheFile, { at: Date.now(), result });
      return result;
    }).finally(() => { runningCheck = null; });
    return withIgnored(await runningCheck);
  }
  async function install(expectedSha) {
    const target = path.join(configRoot, "plugins", "codex-supervisor");
    if (path.resolve(root) !== path.resolve(target)) throw new Error("请在已安装插件的设置页执行更新");
    if (installInProgress) throw new Error("更新正在进行");
    installInProgress = true;
    try {
      const result = await check(true);
      if (!result.available || result.remote.commitSha !== expectedSha) throw new Error("发布版本已变化，请重新检查");
      const work = await fs.mkdtemp(path.join(dataDir, "download-"));
      try {
        const zip = path.join(work, asset);
        await download(result.remote.url, zip);
        const manifest = path.join(work, metaName), stage = path.join(work, "next");
        writeJson(manifest, result.remote);
        const python = process.platform === "win32" ? "python.exe" : "python3";
        const helper = (action, ...args) => exec(python, [path.join(root, "lib", "release.py"), action, ...args],
          { cwd: dataDir, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
        await helper("stage", zip, manifest, stage);
        const lock = path.join(dataDir, "install-" + process.pid + ".lock");
        await fs.writeFile(lock, "");
        try {
          if (activeInstallers().some(pid => pid !== process.pid)) throw new Error("另一个进程正在更新");
          await stopIdleBridge();
          const { stdout } = await helper("activate", root, stage, dataDir);
          return { backup: stdout.trim(), version: result.remote.version };
        } finally { await fs.unlink(lock); }
      } finally { await fs.rm(work, { recursive: true, force: true }); }
    } finally { installInProgress = false; }
  }
  return { check, install };
}

async function stopIdleBridge() {
  const file = path.join(stateDir, "daemon.json");
  const state = readJson(file, null);
  if (!state) {
    if (readJson(path.join(stateDir, "daemon.lock"), null)) throw new Error("桥接进程正在启动，请稍后更新");
    return;
  }
  for (const route of ["/update-idle", "/stop"]) {
    const res = await fetch("http://127.0.0.1:" + state.port + route, { method: "POST",
      headers: { Authorization: "Bearer " + state.token }, signal: AbortSignal.timeout(3000) });
    if (res.status === 404) throw new Error("旧版 bridge 未支持空闲检查，请先结束监管任务并停止旧进程");
    if (!res.ok) throw new Error((await res.json()).error || "请等待监管任务结束后再更新");
  }
  for (let n = 0; n < 60; n++) {
    if (!readJson(file, null)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("桥接进程尚未退出，请稍后更新");
}

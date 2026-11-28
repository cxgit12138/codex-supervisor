import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./preferences.mjs";

function localProject(file) {
  let project;
  try { project = readJson(file, null); }
  catch (err) {
    if (err instanceof SyntaxError) return null; // 等宿主写完整后重读。
    throw err;
  }
  if (!project || project.sidecar || !project.name) return null;
  const roots = [];
  for (const resource of project.projectResources?.resources || []) {
    const uri = resource.folderUri || resource.gitFolder?.folderUri;
    if (!uri?.startsWith("file:") || !URL.canParse(uri)) return null;
    const url = new URL(uri);
    if (url.hostname && url.hostname !== "localhost") return null;
    let root;
    try { root = fileURLToPath(url); }
    catch (err) {
      if (err.code === "ERR_INVALID_FILE_URL_PATH" || err instanceof URIError) return null;
      throw err;
    }
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return null;
    roots.push({ path: root });
  }
  return roots.length ? { id: project.id, name: project.name, roots } : null;
}

function rootKey(root) {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rootSet(roots) {
  return JSON.stringify(roots.map(root => rootKey(root.path)).sort());
}

export function pendingProjects(directory, ledger) {
  if (!ledger) return true;
  return fs.readdirSync(directory).some(name => name.endsWith(".json") && !ledger.baseline.includes(name) &&
    !ledger.mapped[name.slice(0, -5)] && localProject(path.join(directory, name)));
}

export function projectSync(directory, ledgerFile, rpc) {
  let queue = Promise.resolve();
  function filenames() {
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(".json")) : [];
  }
  let ledger = readJson(ledgerFile, null);
  if (!ledger) {
    ledger = { baseline: filenames(), mapped: {} };
    writeJson(ledgerFile, ledger);
  }

  async function sync(projectId, cwd) {
    const names = filenames();
    let selected;
    let catalog;
    async function resolveProject(project, create) {
      if (ledger.mapped[project.id]) return ledger.mapped[project.id];
      if (!catalog) {
        catalog = [];
        let cursor;
        do {
          const page = await rpc("project/list", { limit: 100, cursor });
          catalog.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
      }
      const matches = catalog.filter(row => rootSet(row.roots) === rootSet(project.roots));
      if (matches.length > 1) throw new Error("Codex 中有多个目录相同的项目：" + project.name);
      let target = matches[0];
      if (!target && create) {
        const result = await rpc("project/create", { name: project.name, roots: project.roots, idempotencyKey: "antigravity:" + project.id });
        target = result.project;
        catalog.push(target);
      }
      if (target) {
        ledger.mapped[project.id] = target.id;
        writeJson(ledgerFile, ledger);
        return target.id;
      }
    }
    const forDispatch = Boolean(projectId || cwd);
    const candidates = [];
    for (const name of names) {
      const isNew = !ledger.baseline.includes(name);
      if (!forDispatch && (!isNew || ledger.mapped[name.slice(0, -5)])) continue;
      const project = localProject(path.join(directory, name));
      if (!project) continue;
      if (!forDispatch) {
        await resolveProject(project, true);
        continue;
      }
      const inProject = cwd && project.roots.some(root => {
        const relative = path.relative(rootKey(root.path), rootKey(cwd));
        return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
      });
      if (project.id === projectId && (!cwd || inProject)) return resolveProject(project, isNew);
      if (inProject) candidates.push({ project, isNew });
    }
    if (candidates.length === 1) {
      const { project, isNew } = candidates[0];
      selected = await resolveProject(project, isNew);
    }
    return selected;
  }
  return (id, cwd) => {
    const run = () => sync(id, cwd);
    queue = queue.then(run, run);
    return queue;
  };
}

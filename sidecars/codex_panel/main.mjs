/**
 * Codex Supervisor Sidecar Panel Backend.
 * Read-only HTTP server using Antigravity's built-in SidecarApp SDK.
 * Reads persisted JSONL logs from ~/.gemini/cache/codex-supervisor/logs/,
 * enriches titles from ~/.codex/session_index.jsonl, and merges live status
 * from the running bridge daemon (if active) at zero LLM token cost.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fallbackSdk = pathToFileURL(
  path.join(os.homedir(), ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "index.mjs")
).href;
const { SidecarApp, Response } = await import("sidecar_sdk").catch(() => import(fallbackSdk));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), ".gemini", "cache", "codex-supervisor");
const LOGS_DIR = path.join(STATE_DIR, "logs");
const STATE_FILE = path.join(STATE_DIR, "daemon.json");
const CODEX_SESSION_INDEX = path.join(os.homedir(), ".codex", "session_index.jsonl");
const CODEX_STATE_DB = path.join(os.homedir(), ".codex", "state_5.sqlite");
const NO_STORE = { "Cache-Control": "no-store" };

let sqliteMod = null;
try {
  sqliteMod = await import("node:sqlite");
} catch {}

function cleanWinPath(p) {
  if (!p) return null;
  return String(p).replace(/^\\\\\?\\/, "");
}

// Read-only fallback for older logs that predate `thread_meta` logging (with negative cache)
let dbMetaCache = { ts: 0, map: new Map() };
function getCodexDbMetaMap(threadIds) {
  if (!sqliteMod?.DatabaseSync || !threadIds.length) return dbMetaCache.map;
  const now = Date.now();
  const idSet = new Set(threadIds);
  const missing = threadIds.some((id) => !dbMetaCache.map.has(id));
  if (!missing && now - dbMetaCache.ts < 15_000) return dbMetaCache.map;
  try {
    if (!fs.existsSync(CODEX_STATE_DB)) return dbMetaCache.map;
    const db = new sqliteMod.DatabaseSync(CODEX_STATE_DB, { readOnly: true });
    try {
      const placeholders = threadIds.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id, cwd, model FROM threads WHERE id IN (${placeholders})`)
        .all(...threadIds);
      const nextMap = new Map();
      for (const id of idSet) nextMap.set(id, null);
      for (const r of rows) {
        nextMap.set(r.id, {
          cwd: cleanWinPath(r.cwd),
          model: r.model || null,
        });
      }
      dbMetaCache = { ts: now, map: nextMap };
    } finally {
      db.close();
    }
  } catch {}
  return dbMetaCache.map;
}

const STATIC = {
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
};

// ---------- Session Title Index (cached by mtime) ----------
let indexCache = { mtimeMs: 0, size: 0, titles: new Map() };
function getSessionTitleMap() {
  try {
    const st = fs.statSync(CODEX_SESSION_INDEX);
    if (st.mtimeMs === indexCache.mtimeMs && st.size === indexCache.size) {
      return indexCache.titles;
    }
    const titles = new Map();
    const raw = fs.readFileSync(CODEX_SESSION_INDEX, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.id && j.thread_name) titles.set(j.id, j.thread_name);
      } catch {}
    }
    indexCache = { mtimeMs: st.mtimeMs, size: st.size, titles };
    return titles;
  } catch {
    return indexCache.titles;
  }
}

// ---------- Live Daemon Status (non-blocking, bounded full lifecycle) ----------
function fetchLiveDaemonStatus() {
  return new Promise((resolve) => {
    let state;
    try {
      if (!fs.existsSync(STATE_FILE)) return resolve(null);
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      return resolve(null);
    }
    const validPort = Number.isInteger(state?.port) && state.port > 0 && state.port <= 65535;
    const validToken = typeof state?.token === "string" && state.token.length > 0;
    if (!validPort || !validToken) return resolve(null);

    let settled = false;
    let req;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(val);
    };
    const deadline = setTimeout(() => {
      try {
        req?.destroy();
      } catch {}
      done(null);
    }, 500);

    try {
      req = http.request(
        {
          host: "127.0.0.1",
          port: state.port,
          method: "GET",
          path: "/status",
          headers: { Authorization: `Bearer ${state.token}` },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("aborted", () => done(null));
          res.on("error", () => done(null));
          res.on("close", () => {
            if (!res.complete) done(null);
          });
          res.on("end", () => {
            if (res.statusCode !== 200) return done(null);
            try {
              done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              done(null);
            }
          });
        }
      );
      req.on("error", () => done(null));
      req.end();
    } catch {
      done(null);
    }
  });
}

// ---------- Human-friendly Log Parser ----------
function shortCmd(cmd) {
  const s = String(cmd || "").trim();
  const pwshMatch = s.match(/pwsh(?:\.exe)?["']?\s+-Command\s+['"]?([\s\S]*)$/i);
  const cleaned = pwshMatch ? pwshMatch[1].replace(/['"]$/, "") : s;
  return cleaned.length > 260 ? cleaned.slice(0, 260) + "…" : cleaned;
}

function formatDecisionResponse(method, result) {
  if (!result || typeof result !== "object") return { badge: "监工回复", tone: "blue", text: "已提交回复" };

  if (method === "item/tool/call") {
    const txt = (result.contentItems || []).map((x) => x.text || "").filter(Boolean).join("\n");
    return { badge: "回复请示", tone: "blue", text: txt || "已回复" };
  }

  if (method === "item/tool/requestUserInput") {
    const ans = result.answers || {};
    const lines = Object.entries(ans).map(([k, v]) => {
      const vals = Array.isArray(v?.answers) ? v.answers.join(", ") : String(v ?? "");
      return Object.keys(ans).length === 1 ? vals : `${k}: ${vals}`;
    });
    return { badge: "回答提问", tone: "blue", text: lines.join("\n") || "已提交回答" };
  }

  if (method === "item/permissions/requestApproval") {
    const granted = result.permissions && Object.keys(result.permissions).length > 0;
    const scopeLabel = result.scope === "session" ? "本会话" : "当前回合";
    return granted
      ? { badge: "已授予权限", tone: "green", text: `同意权限申请（范围：${scopeLabel}）` }
      : { badge: "已拒绝授权", tone: "red", text: "拒绝额外权限申请" };
  }

  const d = result.decision;
  if (d === "accept" || d === "approved") return { badge: "已批准", tone: "green", text: "允许执行该操作" };
  if (d === "acceptForSession" || d === "approved_for_session") {
    return { badge: "本会话放行", tone: "green", text: "批准执行，本会话同类操作自动放行" };
  }
  if (d === "decline") return { badge: "已拒绝", tone: "red", text: "拒绝执行该操作，继续尝试其他方案" };
  if (d && typeof d === "object" && d.denied) {
    return { badge: "已拒绝", tone: "red", text: d.denied.rejection || "拒绝执行该操作" };
  }
  if (d === "cancel" || d === "abort") return { badge: "已拒绝并中断", tone: "red", text: "拒绝操作并立即中断当前回合" };

  return { badge: "审批响应", tone: "blue", text: String(d ?? "已提交") };
}

function formatApprovalRequest(data) {
  const parts = [];
  if (data.reason) parts.push(data.reason);
  if (data.command) parts.push(`命令：\n\`\`\`\n${shortCmd(data.command)}\n\`\`\``);
  if (data.cwd) parts.push(`目录：\`${data.cwd}\``);
  if (data.grantRoot) parts.push(`写权限范围：\`${data.grantRoot}\``);
  if (data.fileChangesPreview) {
    const items = Array.isArray(data.fileChangesPreview) ? data.fileChangesPreview : data.fileChangesPreview.items || [];
    if (items.length > 0) {
      const files = items.map((f) => (typeof f === "string" ? f : f.path || "(file)")).slice(0, 8);
      parts.push(`拟修改文件：${files.map((f) => `\`${f}\``).join("、")}`);
    }
  }
  if (data.permissions && typeof data.permissions === "object") {
    const keys = Object.keys(data.permissions);
    if (keys.length) parts.push(`申请权限：${keys.join("、")}`);
  }
  return parts.join("\n\n") || "请求执行受限操作";
}

function formatUserInputRequest(data) {
  const qs = Array.isArray(data.questions) ? data.questions : [];
  if (!qs.length) return "请求监工提供额外信息";
  return qs
    .map((q) => {
      const opts = Array.isArray(q.options) && q.options.length
        ? "\n选项：" + q.options.map((o) => `「${o.label}」`).join(" / ")
        : "";
      return `${q.header ? `**${q.header}**：` : ""}${q.question || ""}${opts}`;
    })
    .join("\n\n");
}

function formatModelSub(model, effort) {
  return [model, effort ? `effort:${effort}` : null].filter(Boolean).join(" · ") || null;
}

function resolveLiveModelSub(live, fallbackModel, fallbackEffort) {
  const isRunningLive = live.status === "running" || live.status === "waiting_input";
  if (isRunningLive && "activeTurnModel" in live && "activeTurnEffort" in live) {
    return formatModelSub(live.activeTurnModel || null, live.activeTurnEffort || null);
  }
  return formatModelSub(fallbackModel, fallbackEffort);
}

// Per-file parse cache keyed by threadId + file version + fallback meta
const parsedLogCache = new Map();

function parseThreadLogCached(filePath, threadId, titleMap, liveMap, dbMetaMap) {
  const st = fs.statSync(filePath);
  const titleHint = titleMap.get(threadId) || null;
  const dbFallback = dbMetaMap?.get(threadId) || null;
  const cacheKey = `${st.mtimeMs}|${st.size}|${titleHint || ""}|${dbFallback?.cwd || ""}|${dbFallback?.model || ""}`;

  let base = parsedLogCache.get(threadId);
  if (!base || base.cacheKey !== cacheKey) {
    base = {
      cacheKey,
      parsed: parseThreadLogDisk(filePath, st, threadId, titleHint, dbFallback),
    };
    parsedLogCache.set(threadId, base);
    if (parsedLogCache.size > 100) {
      const oldest = parsedLogCache.keys().next().value;
      parsedLogCache.delete(oldest);
    }
  }

  // Overlay live daemon fields without mutating cached disk result
  const live = liveMap.get(threadId);
  const meta = { ...base.parsed.meta, isLive: Boolean(live), pendingRequestsCount: 0 };
  let inFlightDraft = "";
  if (live) {
    meta.status = live.status || meta.status;
    if (live.name) meta.name = live.name;
    if (live.cwd) meta.cwd = cleanWinPath(live.cwd);
    const prevMetaModel = meta.model;
    const liveModel = live.model || meta.model || null;
    const modelChanged = Boolean(live.model && prevMetaModel && live.model !== prevMetaModel);
    let liveEffort;
    if ("effort" in live) {
      liveEffort = live.effort || null;
    } else if (modelChanged) {
      liveEffort = null;
    } else {
      liveEffort = meta.effort || null;
    }
    meta.model = liveModel;
    meta.effort = liveEffort;
    meta.lastModelSub = resolveLiveModelSub(live, liveModel, liveEffort);
    if (live.sandbox) meta.sandbox = live.sandbox;
    inFlightDraft = live.inFlightDraft || "";
    meta.pendingRequestsCount = live.pendingRequestsCount || 0;
  }
  return {
    meta,
    inFlightDraft,
    lastErrorText: base.parsed.lastErrorText,
    messages: base.parsed.messages,
  };
}

function parseThreadLogDisk(filePath, st, threadId, titleHint, dbFallback) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);

  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && !Array.isArray(rec)) records.push(rec);
    } catch {
      continue;
    }
  }

  const meta = {
    threadId,
    name: titleHint || null,
    cwd: dbFallback?.cwd || null,
    model: dbFallback?.model || null,
    effort: null,
    sandbox: null,
    approvalPolicy: null,
    status: "idle",
    updatedAt: st.mtime.toISOString(),
    mtimeMs: st.mtimeMs,
    size: st.size,
  };

  // Pass 1: build authoritative per-turn (model, effort) map before rendering messages
  // so out-of-order notifications written before supervisor_prompt never inherit another turn's tag.
  const turnModelSub = new Map();
  let currentModel = meta.model;
  let currentEffort = null;
  let hasExplicitEffortMeta = false;
  let hasPromptRecords = false;
  let lastModelSub = formatModelSub(meta.model, null);

  for (const rec of records) {
    if (rec.kind === "thread_meta") {
      const prevModel = currentModel;
      if (rec.name) meta.name = rec.name;
      if (rec.cwd) meta.cwd = rec.cwd;
      if (rec.model) {
        meta.model = rec.model;
        currentModel = rec.model;
      }
      if ("effort" in rec) {
        hasExplicitEffortMeta = true;
        meta.effort = rec.effort || null;
        currentEffort = meta.effort;
      } else if (rec.model && prevModel && rec.model !== prevModel) {
        meta.effort = null;
        currentEffort = null;
      }
      if (rec.sandbox) meta.sandbox = rec.sandbox;
      if (rec.approvalPolicy) meta.approvalPolicy = rec.approvalPolicy;
      if (currentModel) {
        lastModelSub = formatModelSub(currentModel, currentEffort);
      }
    } else if (rec.kind === "supervisor_prompt") {
      hasPromptRecords = true;
      // Rejected/missing-turnId requests are still shown as user messages in Pass 2,
      // but must NEVER mutate effective thread/turn model or effort state.
      if (rec.committed === false) continue;
      const prevModel = currentModel;
      const effModel = rec.model || currentModel || meta.model || null;
      const modelChanged = Boolean(rec.model && prevModel && rec.model !== prevModel);
      let effEffort;
      if (rec.effort) {
        effEffort = rec.effort;
      } else if (rec.effortExplicit === true) {
        effEffort = null;
      } else if (hasExplicitEffortMeta && "effort" in rec) {
        effEffort = null;
      } else if (modelChanged) {
        effEffort = null;
      } else {
        effEffort = currentEffort;
      }
      currentModel = effModel;
      currentEffort = effEffort || null;
      if (effModel) meta.model = effModel;
      meta.effort = currentEffort;
      const subStr = formatModelSub(effModel, effEffort);
      if (rec.turnConfigApplied !== false) {
        if (subStr) lastModelSub = subStr;
        if (rec.turnId && !turnModelSub.has(rec.turnId)) {
          turnModelSub.set(rec.turnId, subStr);
        }
      }
    }
  }

  const promptlessFallbackSub = hasPromptRecords ? null : formatModelSub(meta.model, meta.effort);
  const messages = [];
  let seq = 0;
  let lastFinalTextByTurn = new Map();
  let lastErrorText = null;
  let sawFileChangeDetail = false;

  // Never attribute unmapped/unknown turns in prompted logs to the latest turn's model/effort
  const resolveModelSub = (turnId) => {
    if (turnId && turnModelSub.has(turnId)) return turnModelSub.get(turnId);
    return promptlessFallbackSub;
  };
  const joinSub = (...parts) => parts.filter(Boolean).join(" · ") || null;

  // Pass 2: render timeline messages using the pre-built turn index
  for (const rec of records) {
    const kind = rec.kind;
    const ts = rec.ts || null;

    if (kind === "thread_meta") {
      continue;
    }

    if (kind === "supervisor_prompt") {
      const actionMap = {
        start: "派发任务",
        send: "继续指令",
        resume: "接管续聊",
        fork: "分叉续聊",
        fallback_send: "插队转新轮",
      };
      const baseBadge = actionMap[rec.action] || "发送指令";
      messages.push({
        id: ++seq,
        side: "supervisor",
        badge: rec.mode === "plan" ? `${baseBadge} · Plan` : baseBadge,
        tone: "blue",
        ts,
        text: String(rec.prompt || ""),
      });
      continue;
    }

    if (kind === "steer_sent") {
      messages.push({
        id: ++seq,
        side: "supervisor",
        badge: "中途插队 steer",
        tone: "amber",
        ts,
        text: String(rec.prompt || ""),
      });
      continue;
    }

    if (kind === "supervisor_interrupt") {
      messages.push({
        id: ++seq,
        side: "supervisor",
        badge: "喊停 interrupt",
        tone: "red",
        ts,
        text: "请求立即中断当前回合",
      });
      continue;
    }

    if (kind === "server_request_responded") {
      const formatted = formatDecisionResponse(rec.method, rec.result);
      messages.push({
        id: ++seq,
        side: "supervisor",
        badge: formatted.badge,
        tone: formatted.tone,
        ts,
        text: formatted.text,
      });
      continue;
    }

    if (kind === "message_supervisor_call") {
      messages.push({
        id: ++seq,
        side: "codex",
        badge: rec.waitForReply ? "阻塞请示 · 等我拍板" : "主动阶段汇报",
        tone: rec.waitForReply ? "amber" : "teal",
        sub: resolveModelSub(rec.turnId),
        ts,
        text: String(rec.message || ""),
      });
      continue;
    }

    if (kind === "agentMessage_full") {
      const isCommentary = rec.phase === "commentary";
      const txt = String(rec.text || "").trim();
      if (!txt) continue;
      if (!isCommentary && rec.turnId) lastFinalTextByTurn.set(rec.turnId, txt);
      messages.push({
        id: ++seq,
        side: "codex",
        tier: isCommentary ? "narration" : "core",
        badge: isCommentary ? "过程说明" : "Codex 回复",
        tone: isCommentary ? "muted" : "indigo",
        sub: resolveModelSub(rec.turnId),
        ts,
        text: txt,
      });
      continue;
    }

    if (kind === "event:approval_request") {
      messages.push({
        id: ++seq,
        side: "codex",
        tier: "core",
        badge: "请求审批",
        tone: "amber",
        sub: resolveModelSub(rec.turnId),
        ts,
        text: formatApprovalRequest(rec.data || {}),
      });
      continue;
    }

    if (kind === "event:user_input_request") {
      messages.push({
        id: ++seq,
        side: "codex",
        tier: "core",
        badge: "向监工提问",
        tone: "amber",
        sub: resolveModelSub(rec.turnId),
        ts,
        text: formatUserInputRequest(rec.data || {}),
      });
      continue;
    }

    if (kind === "event:plan_updated") {
      const steps = Array.isArray(rec.data?.plan) ? rec.data.plan : [];
      const linesTxt = steps.map((s) => `- [${s.status === "completed" ? "x" : " "}] ${s.step || s.title || ""}`).join("\n");
      const txt = [rec.data?.explanation, linesTxt].filter(Boolean).join("\n");
      if (txt) {
        messages.push({
          id: ++seq,
          side: "codex",
          tier: "narration",
          badge: "更新计划",
          tone: "muted",
          sub: resolveModelSub(rec.turnId),
          ts,
          text: txt,
        });
      }
      continue;
    }

    if (kind === "fileChange_detail") {
      sawFileChangeDetail = true;
      const items = rec.changes?.items || (Array.isArray(rec.changes) ? rec.changes : []);
      const total = rec.changes?.total || items.length;
      const fileLines = items.map((ch) => `- \`${ch.path || "(file)"}\`${ch.kind ? ` (${typeof ch.kind === "string" ? ch.kind : ch.kind.type || ""})` : ""}`).join("\n");
      const diffDetail = items.map((ch) => (ch.diffPreview ? `--- ${ch.path}\n${ch.diffPreview}` : "")).filter(Boolean).join("\n\n");
      messages.push({
        id: ++seq,
        side: "codex",
        tier: "tool",
        badge: "修改文件",
        tone: rec.status === "failed" ? "red" : "muted",
        sub: joinSub(resolveModelSub(rec.turnId), total ? `${total} 个文件` : rec.status || null),
        ts,
        text: fileLines || "应用文件补丁",
        detail: diffDetail || null,
      });
      continue;
    }

    if (kind === "event:file_changed") {
      if (sawFileChangeDetail) continue; // Avoid duplicating fileChange_detail in new logs
      const files = Array.isArray(rec.data?.files) ? rec.data.files : [];
      if (files.length > 0) {
        messages.push({
          id: ++seq,
          side: "codex",
          tier: "tool",
          badge: "修改文件",
          tone: rec.data?.status === "failed" ? "red" : "muted",
          sub: joinSub(resolveModelSub(rec.turnId), `${files.length} 个文件`),
          ts,
          text: files.map((f) => `- \`${f}\``).join("\n"),
        });
      }
      continue;
    }

    if (kind === "commandExecution") {
      const exitStr = rec.exitCode !== null && rec.exitCode !== undefined ? `exit ${rec.exitCode}` : rec.status || "";
      const durStr = rec.durationMs ? `${rec.durationMs}ms` : "";
      const actions = Array.isArray(rec.actions) ? rec.actions : [];
      const cmdShort = shortCmd(rec.command);
      const rawOut = rec.outputTail ? String(rec.outputTail).trim() : "";

      let badge = "执行命令";
      let bodyText = `\`\`\`\n${cmdShort}\n\`\`\``;
      let detailText = rawOut || null;

      if (actions.length > 0 && actions.every((a) => a.type === "read")) {
        badge = "读取文件";
        const files = [...new Set(actions.map((a) => a.name || a.path).filter(Boolean))];
        bodyText = files.length === 1
          ? `\`${files[0]}\``
          : files.length > 1
            ? files.map((f) => `- \`${f}\``).join("\n")
            : bodyText;
        detailText = [cmdShort ? `$ ${cmdShort}` : "", rawOut].filter(Boolean).join("\n\n") || null;
      } else if (actions.length > 0 && actions.every((a) => a.type === "listFiles")) {
        badge = "列出目录";
        const dirs = [...new Set(actions.map((a) => a.path).filter(Boolean))];
        bodyText = dirs.length ? dirs.map((d) => `\`${d}\``).join("、") : "当前工作区目录";
        detailText = [cmdShort ? `$ ${cmdShort}` : "", rawOut].filter(Boolean).join("\n\n") || null;
      } else if (actions.length > 0 && actions.every((a) => a.type === "search")) {
        badge = "搜索代码";
        const linesSearch = actions.map((a) => {
          const q = a.query ? `\`${a.query}\`` : "";
          const p = a.path ? `（\`${a.path}\`）` : "";
          return q || p ? `- ${q}${p}` : "";
        }).filter(Boolean);
        bodyText = linesSearch.length ? linesSearch.join("\n") : bodyText;
        detailText = [cmdShort ? `$ ${cmdShort}` : "", rawOut].filter(Boolean).join("\n\n") || null;
      }

      messages.push({
        id: ++seq,
        side: "codex",
        tier: "tool",
        badge,
        tone: rec.exitCode && rec.exitCode !== 0 ? "red" : "muted",
        sub: joinSub(resolveModelSub(rec.turnId), exitStr, durStr),
        ts,
        text: bodyText,
        detail: detailText,
      });
      continue;
    }

    if (kind === "toolExecution") {
      const labelMap = {
        mcpToolCall: "MCP 工具",
        webSearch: "网页搜索",
        imageView: "查看图片",
        collabAgentToolCall: "协作子代理",
        subAgentActivity: "子代理动态",
        imageGeneration: "生成图片",
        dynamicToolCall: "动态工具",
      };
      const badge = labelMap[rec.toolType] || "工具调用";
      const title = rec.server ? `${rec.server} / ${rec.name}` : rec.name || badge;
      const bodyText = rec.summary ? `**${title}**\n\n${rec.summary}` : `**${title}**`;
      messages.push({
        id: ++seq,
        side: "codex",
        tier: "tool",
        badge,
        tone: rec.status === "failed" ? "red" : "muted",
        sub: joinSub(resolveModelSub(rec.turnId), rec.status, rec.durationMs ? `${rec.durationMs}ms` : ""),
        ts,
        text: bodyText,
        detail: rec.outputTail ? String(rec.outputTail).trim() : null,
      });
      continue;
    }

    if (kind === "plan_item") {
      const txt = String(rec.text || "").trim();
      if (txt) {
        if (rec.turnId) lastFinalTextByTurn.set(rec.turnId, txt);
        messages.push({
          id: ++seq,
          side: "codex",
          tier: "core",
          badge: "方案计划",
          tone: "indigo",
          sub: resolveModelSub(rec.turnId),
          ts,
          text: txt,
        });
      }
      continue;
    }

    if (kind === "context_compaction") {
      messages.push({
        id: ++seq,
        side: "system",
        tier: "narration",
        ts,
        text: "Codex 已自动压缩上下文",
      });
      continue;
    }

    if (kind === "review_mode") {
      const label = rec.phase === "entered" ? "进入代码审查模式" : "退出代码审查模式";
      const suffix = rec.review && rec.review.length <= 60 ? ` · ${rec.review}` : "";
      messages.push({
        id: ++seq,
        side: "system",
        tier: "narration",
        ts,
        text: `${label}${suffix}`,
      });
      continue;
    }

    if (kind === "event:turn_error" || kind === "event:daemon_error") {
      const errMsg = rec.data?.error?.message || (typeof rec.data?.error === "string" ? rec.data.error : JSON.stringify(rec.data?.error || "未知错误"));
      meta.status = "error";
      lastErrorText = errMsg;
      messages.push({
        id: ++seq,
        side: "codex",
        badge: "执行出错",
        tone: "red",
        sub: resolveModelSub(rec.turnId),
        ts,
        text: errMsg,
      });
      continue;
    }

    if (kind === "event:turn_completed") {
      meta.status = "idle";
      if (rec.data?.status === "interrupted") {
        messages.push({
          id: ++seq,
          side: "system",
          ts,
          text: "当前回合已中断",
        });
      } else if (rec.data?.lastMessage && !lastFinalTextByTurn.has(rec.turnId)) {
        messages.push({
          id: ++seq,
          side: "codex",
          badge: "Codex 回复",
          tone: "indigo",
          sub: resolveModelSub(rec.turnId),
          ts,
          text: String(rec.data.lastMessage),
        });
      }
      continue;
    }
  }

  // Normalize tier default to "core" for any message without explicit tier
  for (const m of messages) {
    if (!m.tier) m.tier = "core";
  }

  // Fallback display name if no title recorded
  if (!meta.name) {
    const firstMsg = messages.find((m) => m.tier === "core" && m.text)?.text || "";
    const snippet = firstMsg.replace(/\s+/g, " ").trim().slice(0, 28);
    meta.name = snippet ? `${snippet}${firstMsg.length > 28 ? "…" : ""}` : `会话 ${threadId.slice(0, 8)}`;
  }

  const coreCount = messages.filter((m) => m.tier === "core").length;
  const narrationCount = messages.filter((m) => m.tier === "narration").length;
  const toolCount = messages.filter((m) => m.tier === "tool").length;

  return {
    meta: {
      ...meta,
      lastModelSub: lastModelSub || formatModelSub(meta.model, meta.effort),
      visibleCount: coreCount,
      processCount: narrationCount + toolCount,
      counts: { core: coreCount, narration: narrationCount, tool: toolCount },
    },
    lastErrorText,
    messages,
  };
}

function listLogFiles() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(LOGS_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(LOGS_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.size === 0) continue;
      out.push({ threadId: name.slice(0, -6), filePath: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {}
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// ---------- Sidecar HTTP Server ----------
const app = new SidecarApp();

app.page("/", () =>
  new Response(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), {
    contentType: "text/html; charset=utf-8",
    headers: NO_STORE,
  })
);

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () =>
      new Response(fs.readFileSync(path.join(__dirname, file), "utf8"), {
        contentType,
        headers: NO_STORE,
      }),
    "GET"
  );
}

// Use POST so SidecarApp's X-Sidecar-Token validation is strictly enforced on session data
app.api(
  "/api/state",
  async (data) => {
    const requestedThread = typeof data.threadId === "string" ? data.threadId.trim() : "";
    const liveStatus = await fetchLiveDaemonStatus();
    const liveMap = new Map();
    if (liveStatus && Array.isArray(liveStatus.threads)) {
      const pendingByThread = new Map();
      for (const r of liveStatus.pendingRequests || []) {
        pendingByThread.set(r.threadId, (pendingByThread.get(r.threadId) || 0) + 1);
      }
      for (const t of liveStatus.threads) {
        liveMap.set(t.threadId, { ...t, pendingRequestsCount: pendingByThread.get(t.threadId) || 0 });
      }
    }

    const titleMap = getSessionTitleMap();
    const logFiles = listLogFiles().slice(0, 40);
    const dbMetaMap = getCodexDbMetaMap(logFiles.map((f) => f.threadId));

    const seen = new Set();
    const parsedById = new Map();
    const sessions = [];
    for (const f of logFiles) {
      seen.add(f.threadId);
      try {
        const parsed = parseThreadLogCached(f.filePath, f.threadId, titleMap, liveMap, dbMetaMap);
        parsedById.set(f.threadId, parsed);
        sessions.push(parsed.meta);
      } catch {
        // Isolate per-file deletion/rotation or parse error so one bad file never breaks the panel
      }
    }
    for (const [tid, live] of liveMap.entries()) {
      if (seen.has(tid)) continue;
      const liveEffort = "effort" in live ? (live.effort || null) : null;
      sessions.unshift({
        threadId: tid,
        name: live.name || titleMap.get(tid) || `会话 ${tid.slice(0, 8)}`,
        cwd: cleanWinPath(live.cwd),
        model: live.model,
        effort: liveEffort,
        lastModelSub: resolveLiveModelSub(live, live.model || null, liveEffort),
        sandbox: live.sandbox,
        status: live.status || "running",
        updatedAt: new Date().toISOString(),
        mtimeMs: Date.now(),
        size: 0,
        visibleCount: 0,
        processCount: 0,
        pendingRequestsCount: live.pendingRequestsCount || 0,
        isLive: true,
      });
    }

    // Sort active/waiting live threads first, then most recently updated
    sessions.sort((a, b) => {
      const aActive = a.status === "running" || a.status === "waiting_input" ? 1 : 0;
      const bActive = b.status === "running" || b.status === "waiting_input" ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });

    const activeId =
      requestedThread && sessions.some((s) => s.threadId === requestedThread)
        ? requestedThread
        : sessions[0]?.threadId || null;

    let active = null;
    if (activeId) {
      if (parsedById.has(activeId)) {
        active = parsedById.get(activeId);
      } else {
        const sMeta = sessions.find((s) => s.threadId === activeId);
        active = {
          meta: sMeta,
          inFlightDraft: liveMap.get(activeId)?.inFlightDraft || "",
          messages: [],
        };
      }
    }

    const sessionSig = sessions
      .map((s) => `${s.threadId}:${s.status}:${s.size}:${s.name}:${s.cwd || ""}:${s.model || ""}:${s.effort || ""}:${s.lastModelSub || ""}:${s.sandbox || ""}:${s.visibleCount}`)
      .join(",");
    const draftSig = active?.inFlightDraft || "";
    const etag = [
      Boolean(liveStatus),
      sessionSig,
      activeId || "",
      active?.meta?.status || "",
      active?.meta?.lastModelSub || "",
      active?.meta?.pendingRequestsCount || 0,
      draftSig,
    ].join("|");

    if (data.etag && data.etag === etag) {
      return { unchanged: true, etag };
    }

    return {
      etag,
      daemonOnline: Boolean(liveStatus),
      sessions,
      activeThreadId: activeId,
      active,
    };
  },
  "POST"
);

app.run();

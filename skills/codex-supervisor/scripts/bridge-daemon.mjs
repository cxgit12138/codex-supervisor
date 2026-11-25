#!/usr/bin/env node
/**
 * Codex Supervisor Bridge Daemon
 * Holds a persistent `codex app-server --stdio` process and exposes a local
 * authenticated HTTP control API for zero-polling event-driven supervision.
 * Zero external dependencies (Node.js >= 20 built-ins only).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const STATE_DIR = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), ".gemini", "cache", "codex-supervisor");
const LOGS_DIR = path.join(STATE_DIR, "logs");
const STATE_FILE = path.join(STATE_DIR, "daemon.json");
const LOCK_FILE = path.join(STATE_DIR, "daemon.lock");
const DAEMON_LOG = path.join(STATE_DIR, "daemon.log");
const IDLE_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_IDLE_MS ?? 60 * 60 * 1000);
const MAX_MEM_EVENTS = 500;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const COALESCE_MS = 300;
const MAX_INLINE_TEXT = 2500;
const INSTANCE_ID = `${process.pid}-${Date.now()}`;

fs.mkdirSync(LOGS_DIR, { recursive: true });

function logDaemon(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(DAEMON_LOG, line, "utf8");
  } catch {}
}

/**
 * On Windows, Node's `0o600` does NOT restrict NTFS DACLs, and `%USERPROFILE%`
 * often inherits read access for `CodexSandboxUsers`. Strip inheritance and
 * grant full control ONLY to current user SID + SYSTEM before writing secrets.
 */
function hardenStateDirPermissions() {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(STATE_DIR, 0o700);
      fs.chmodSync(LOGS_DIR, 0o700);
    } catch {}
    return;
  }

  const whoami = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (whoami.status !== 0) {
    throw new Error(`Failed to resolve current user SID via whoami: ${whoami.stderr || whoami.stdout}`);
  }
  const match = (whoami.stdout || "").match(/(S-1-[0-9-]+)/);
  if (!match) {
    throw new Error(`Could not parse user SID from whoami output: ${whoami.stdout}`);
  }
  const userSid = match[1];

  // 1. Strip inheritance on STATE_DIR itself and grant (OI)(CI)F ONLY to current user + SYSTEM.
  //    Do NOT pass /T with (OI)(CI) because inheritance flags fail on existing files and leave empty DACLs.
  const ic = spawnSync(
    "icacls",
    [
      STATE_DIR,
      "/inheritance:r",
      "/grant:r",
      `*${userSid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F", // NT AUTHORITY\SYSTEM
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10000 }
  );
  if (ic.status !== 0) {
    throw new Error(`Failed to harden NTFS DACL on ${STATE_DIR}: ${ic.stderr || ic.stdout}`);
  }

  // 2. Reset children so any pre-existing files/subdirs cleanly inherit STATE_DIR's private DACL
  for (const entry of fs.readdirSync(STATE_DIR)) {
    const childPath = path.join(STATE_DIR, entry);
    const resetRes = spawnSync("icacls", [childPath, "/reset", "/T", "/C"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    if (resetRes.status !== 0) {
      throw new Error(`Failed to reset NTFS DACL on ${childPath}: ${resetRes.stderr || resetRes.stdout}`);
    }
  }

  // 3. Verify ONLY current user and SYSTEM appear on STATE_DIR (no CodexSandboxUsers or extra principals)
  const verify = spawnSync("icacls", [STATE_DIR], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (verify.status !== 0 || /CodexSandboxUsers|Everyone|Users:/i.test(verify.stdout || "")) {
    throw new Error(`NTFS DACL verification failed on ${STATE_DIR}: ${verify.stdout || verify.stderr}`);
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

let ownsLock = false;
function acquireStartupLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, instanceId: INSTANCE_ID, startedAt: new Date().toISOString() }), "utf8");
      fs.closeSync(fd);
      ownsLock = true;
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let stale = false;
      try {
        const info = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        if (isPidAlive(info.pid)) {
          return false; // Another healthy daemon owns the lock
        }
        stale = true;
      } catch {
        // Corrupt or mid-write lock; treat as stale only if older than 5s
        try {
          const st = fs.statSync(LOCK_FILE);
          if (Date.now() - st.mtimeMs >= 5000) stale = true;
          else return false;
        } catch {
          // Lock vanished in the meantime; retry wx
          continue;
        }
      }
      if (stale) {
        // Atomically claim stale lock via rename so two contenders cannot unlink a fresh holder's lock
        const claimPath = `${LOCK_FILE}.stale.${process.pid}.${Date.now()}`;
        try {
          fs.renameSync(LOCK_FILE, claimPath);
          try {
            fs.unlinkSync(claimPath);
          } catch {}
        } catch {
          // Another contender already reclaimed/replaced it; retry once
        }
      }
    }
  }
  return false;
}

if (!acquireStartupLock()) {
  console.log(JSON.stringify({ alreadyRunning: true }));
  process.exit(0);
}

// Harden NTFS DACL ONLY after owning the startup lock, and BEFORE writing daemon.json secrets
hardenStateDirPermissions();

function findCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
    if (fs.existsSync(binRoot)) {
      const candidates = [];
      for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const exe = path.join(binRoot, entry.name, "codex.exe");
        if (fs.existsSync(exe)) {
          try {
            const st = fs.statSync(exe);
            candidates.push({ exe, mtimeMs: st.mtimeMs });
          } catch {}
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (candidates.length > 0) return candidates[0].exe;
    }
    return "codex.exe";
  }
  if (process.platform === "darwin") {
    const macCandidates = [
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
    ];
    for (const exe of macCandidates) {
      if (fs.existsSync(exe)) return exe;
    }
  }
  return "codex";
}

function truncateText(text, max = MAX_INLINE_TEXT) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n...[truncated ${omitted} chars; see thread log file for full text]`;
}

function normalizeSandboxPolicy(val) {
  if (!val) return null;
  const raw = typeof val === "string" ? val : val.type;
  if (!raw) return null;
  const map = {
    "read-only": "read-only",
    readOnly: "read-only",
    "workspace-write": "workspace-write",
    workspaceWrite: "workspace-write",
    "danger-full-access": "danger-full-access",
    dangerFullAccess: "danger-full-access",
    externalSandbox: "external-sandbox",
  };
  return map[raw] || String(raw);
}

function normalizeApprovalPolicy(val) {
  if (!val) return null;
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

function normalizeCwd(p) {
  if (!p) return null;
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// ---------- State ----------
const codexBin = findCodexBin();
const authToken = crypto.randomBytes(24).toString("hex");
let lastActivityMs = Date.now();
let shuttingDown = false;

let codexProc = null;
let codexReady = false;
let codexInitInfo = null;
let rpcNextId = 1;
const pendingRpc = new Map();

let serverReqNextSeq = 1;
const pendingServerRequests = new Map(); // reqId (string `${INSTANCE_ID}:${seq}`) -> entry
const threads = new Map(); // threadId -> ThreadState
const evictedThreadSeq = new Map(); // threadId -> last nextSeq before idle eviction
const threadLocks = new Map(); // threadId -> Promise chain

function withThreadLock(threadId, fn) {
  const prev = threadLocks.get(threadId) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep a never-rejecting tail promise for lock chaining & cleanup so rejected `next` never triggers UnhandledPromiseRejection
  const tail = next.then(
    () => {},
    () => {}
  ).finally(() => {
    if (threadLocks.get(threadId) === tail) threadLocks.delete(threadId);
  });
  threadLocks.set(threadId, tail);
  return next;
}

function getThreadState(threadId) {
  let st = threads.get(threadId);
  if (!st) {
    const logPath = path.join(LOGS_DIR, `${threadId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
    st = {
      threadId,
      name: null,
      cwd: null,
      model: null,
      sandbox: null,
      approvalPolicy: null,
      status: "idle", // idle | running | waiting_input | error
      activeTurnId: null,
      lastTurnId: null,
      completedTurnIds: new Set(),
      lastError: null,
      lastMessage: "",
      lastMessageTurnId: null,
      lastPhase: null,
      deltaBuffers: new Map(), // itemId -> string
      pendingFileChanges: new Map(), // itemId -> { changes }
      recentCommands: [],
      recentFiles: new Set(),
      turnFiles: new Set(),
      turnCommands: [],
      turnTokenUsage: null,
      lastPlan: null,
      lastDiffStats: null,
      lastTokenUsage: null,
      nextSeq: evictedThreadSeq.get(threadId) || 1,
      evictedBefore: evictedThreadSeq.has(threadId),
      events: [],
      waiters: new Set(),
      logPath,
      updatedAt: Date.now(),
    };
    threads.set(threadId, st);
  }
  return st;
}

function appendThreadLog(st, record) {
  try {
    fs.appendFileSync(st.logPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
  } catch {}
}

function levelMatches(eventLevel, filter) {
  if (filter === "all") return true;
  if (filter === "critical") return eventLevel === "critical";
  return eventLevel === "critical" || eventLevel === "milestone";
}

function parseCursor(afterRaw) {
  if (afterRaw === undefined || afterRaw === null || afterRaw === "") {
    return { seq: 0, provided: false, instanceMismatch: false };
  }
  const s = String(afterRaw);
  const colon = s.lastIndexOf(":");
  if (colon !== -1) {
    const inst = s.slice(0, colon);
    const seqStr = s.slice(colon + 1);
    if (!/^\d+$/.test(seqStr)) {
      const err = new Error(`Invalid cursor sequence in "${s}"`);
      err.statusCode = 400;
      throw err;
    }
    return {
      seq: Number(seqStr),
      provided: true,
      instanceMismatch: inst !== INSTANCE_ID,
    };
  }
  if (!/^\d+$/.test(s)) {
    const err = new Error(`Invalid cursor "${s}"`);
    err.statusCode = 400;
    throw err;
  }
  return { seq: Number(s), provided: true, instanceMismatch: false };
}

function formatCursor(seq) {
  return `${INSTANCE_ID}:${seq}`;
}

function detectCursorGap(st, afterSeq, provided, instanceMismatch) {
  if (instanceMismatch) {
    return { cursorGap: true, cursorGapReason: "daemon_restarted" };
  }
  const earliest = st.events.length > 0 ? st.events[0].seq : st.nextSeq;
  if (provided && afterSeq < earliest - 1) {
    return { cursorGap: true, cursorGapReason: st.evictedBefore ? "thread_evicted" : "buffer_truncated" };
  }
  return { cursorGap: false, cursorGapReason: null };
}

function cleanupWaiter(st, waiter) {
  if (!st.waiters.has(waiter)) return false;
  st.waiters.delete(waiter);
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.coalesceTimer) clearTimeout(waiter.coalesceTimer);
  if (waiter.onClose) {
    waiter.res.off("close", waiter.onClose);
  }
  return true;
}

function compactRequest(r) {
  const p = r.params || {};
  if (r.method === "item/tool/call" && p.tool === "message_supervisor") {
    return {
      reqId: r.reqId,
      tool: "message_supervisor",
      message: truncateText(String(r.supervisorMessage || ""), MAX_INLINE_TEXT),
    };
  }
  const out = { reqId: r.reqId, method: r.method };
  if (p.reason) out.reason = p.reason;
  if (p.command) {
    const cmdStr = String(p.command);
    out.command = truncateText(cmdStr, 500);
    if (cmdStr.length > 500) out.commandTruncated = true;
  }
  if (p.cwd) out.cwd = p.cwd;
  if (p.grantRoot) out.grantRoot = p.grantRoot;
  if (p.networkApprovalContext) out.networkApprovalContext = p.networkApprovalContext;
  if (p.additionalPermissions) out.additionalPermissions = p.additionalPermissions;
  if (p.permissions) out.permissions = p.permissions;
  if (r.preview) {
    out.fileChangesPreview = r.preview.items || r.preview;
    if (r.preview.total && r.preview.total > (r.preview.items?.length || 0)) {
      out.fileChangesTotal = r.preview.total;
    }
  }
  if (p.questions) out.questions = p.questions;
  return out;
}

function buildWaitPayload(st, { timedOut, matched, gap, eventsFilter }) {
  const latestSeq = st.nextSeq - 1;
  const pending = listPendingRequests(st.threadId).map(compactRequest);
  const actualTimedOut = matched.length > 0 ? false : Boolean(timedOut);

  const terminalEvs = matched.filter((e) => e.kind === "turn_completed" || e.kind === "turn_error" || e.kind === "daemon_error");
  const terminalEv = terminalEvs[terminalEvs.length - 1] || null;
  const supMsgEvs = matched.filter((e) => e.kind === "supervisor_message");
  const msgEvs = matched.filter((e) => e.kind === "agent_message");
  const planEv = [...matched].reverse().find((e) => e.kind === "plan_updated");

  const summarizeTerminal = (ev) => ({
    kind: ev.kind === "turn_completed" && ev.data?.status === "interrupted" ? "turn_interrupted" : ev.kind,
    turnId: ev.turnId || undefined,
    ...(ev.data?.lastMessage ? { message: ev.data.lastMessage } : {}),
    ...(ev.data?.error ? { error: ev.data.error?.message || ev.data.error } : {}),
  });

  let wakeup = "idle";
  if (gap.cursorGap) {
    wakeup = "cursor_gap";
  } else if (pending.length > 0) {
    if (pending.some((r) => r.tool === "message_supervisor")) {
      wakeup = "supervisor_question";
    } else if (pending.some((r) => r.method === "item/tool/requestUserInput")) {
      wakeup = "user_input_request";
    } else {
      wakeup = "approval_request";
    }
  } else if (actualTimedOut) {
    wakeup = "timeout";
  } else if (terminalEv) {
    if (terminalEv.kind === "turn_completed" && terminalEv.data?.status === "interrupted") {
      wakeup = "turn_interrupted";
    } else {
      wakeup = terminalEv.kind;
    }
  } else if (supMsgEvs.length > 0) {
    wakeup = "supervisor_message";
  } else if (matched.length > 0) {
    wakeup = matched[matched.length - 1].kind;
  } else if (st.status === "error") {
    wakeup = "turn_error";
  }

  const out = {
    wakeup,
    nextCursor: formatCursor(latestSeq),
  };

  if (wakeup === "approval_request" || wakeup === "user_input_request" || wakeup === "supervisor_question") {
    out.requests = pending;
    // Never silently drop supervisor_message events that arrived in the same batch before a pending request
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
    }
    // If any terminal event coexists with a pending request, include full message/error summary so nothing is lost
    if (terminalEvs.length > 0) {
      out.terminalEvents = terminalEvs.map(summarizeTerminal);
    }
  } else if (wakeup === "supervisor_message" && supMsgEvs.length > 0) {
    out.message = supMsgEvs.length === 1 ? supMsgEvs[0].data.message : supMsgEvs.map((e) => e.data.message).join("\n---\n");
    if (supMsgEvs.some((e) => e.data.truncated)) {
      out.truncated = true;
      out.logPath = st.logPath;
    }
  } else if (wakeup === "turn_completed" && terminalEv) {
    const msg = terminalEv.data?.lastMessage || "";
    if (msg) out.message = msg;
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
    }
    if (terminalEvs.length > 1) {
      out.earlierTerminalEvents = terminalEvs.slice(0, -1).map(summarizeTerminal);
    }
    if (terminalEv.data?.turnFiles?.length) out.files = terminalEv.data.turnFiles;
    if (msg.includes("...[truncated ")) {
      out.truncated = true;
      out.logPath = st.logPath;
    }
  } else if (wakeup === "turn_interrupted") {
    const msg = terminalEv?.data?.lastMessage || "";
    if (msg) out.message = msg;
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
    }
    if (terminalEvs.length > 1) {
      out.earlierTerminalEvents = terminalEvs.slice(0, -1).map(summarizeTerminal);
    }
  } else if ((wakeup === "turn_error" || wakeup === "daemon_error") && terminalEv) {
    out.error = terminalEv.data?.error?.message || terminalEv.data?.error || st.lastError;
    if (terminalEv.data?.lastMessage) out.message = terminalEv.data.lastMessage;
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
    }
    if (terminalEvs.length > 1) {
      out.earlierTerminalEvents = terminalEvs.slice(0, -1).map(summarizeTerminal);
    }
    out.logPath = st.logPath;
  } else if (wakeup === "agent_message" && msgEvs.length > 0) {
    const lastMsg = msgEvs[msgEvs.length - 1];
    out.message = msgEvs.length === 1 ? lastMsg.data.text : msgEvs.map((e) => e.data.text).join("\n---\n");
    if (lastMsg.data?.questions) out.questions = lastMsg.data.questions;
    if (lastMsg.data?.truncated) {
      out.truncated = true;
      out.logPath = st.logPath;
    }
  } else if (wakeup === "plan_updated" && planEv) {
    out.plan = planEv.data;
  } else if (wakeup === "timeout") {
    const draft = st.deltaBuffers.size > 0 ? truncateText(Array.from(st.deltaBuffers.values()).join("\n"), 500) : "";
    if (draft) out.inFlightDraft = draft;
  } else if (wakeup === "cursor_gap") {
    out.reason = gap.cursorGapReason;
    out.status = st.status;
    if (pending.length > 0) out.requests = pending;
    if (st.lastMessage) out.message = truncateText(st.lastMessage, 600);
    if (st.lastError) out.error = st.lastError?.message || st.lastError;
  } else if (wakeup === "idle" && st.lastMessage) {
    out.message = truncateText(st.lastMessage, 800);
  }

  // Only include granular timeline when caller explicitly requests `--events all`
  if (eventsFilter === "all" && matched.length > 0) {
    out.events = matched.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      ...(e.kind === "command_completed" ? { cmd: truncateText(e.data?.command || "", 120), exit: e.data?.exitCode } : {}),
      ...(e.kind === "file_changed" ? { files: e.data?.files } : {}),
      ...(e.kind === "agent_message" ? { text: truncateText(e.data?.text || "", 400) } : {}),
      ...(e.kind === "turn_completed" ? { status: e.data?.status } : {}),
    }));
  }

  return out;
}

function resolveWaiter(st, waiter, timedOut = false) {
  if (!cleanupWaiter(st, waiter)) return;
  const matched = st.events.filter((e) => e.seq > waiter.afterSeq && levelMatches(e.level, waiter.eventsFilter));
  const gap = detectCursorGap(st, waiter.afterSeq, waiter.afterProvided, waiter.instanceMismatch);
  waiter.resolve(buildWaitPayload(st, { timedOut, matched, gap, eventsFilter: waiter.eventsFilter }));
}

function pushEvent(threadId, level, kind, turnId, data) {
  const st = getThreadState(threadId);
  st.updatedAt = Date.now();
  const ev = {
    seq: st.nextSeq++,
    ts: new Date().toISOString(),
    tsMs: Date.now(),
    level,
    kind,
    turnId: turnId || st.activeTurnId || st.lastTurnId || null,
    data,
  };
  st.events.push(ev);
  if (st.events.length > MAX_MEM_EVENTS) {
    st.events.splice(0, st.events.length - MAX_MEM_EVENTS);
  }
  appendThreadLog(st, { kind: `event:${kind}`, level, turnId: ev.turnId, data });

  for (const waiter of Array.from(st.waiters)) {
    if (ev.seq <= waiter.afterSeq) continue;
    if (!levelMatches(ev.level, waiter.eventsFilter)) continue;

    if (ev.level === "critical") {
      resolveWaiter(st, waiter, false);
    } else if (!waiter.coalesceTimer) {
      waiter.coalesceTimer = setTimeout(() => resolveWaiter(st, waiter, false), COALESCE_MS);
    }
  }
  return ev;
}

function prunePendingRequestsForThread(threadId, turnId = null) {
  for (const [reqId, r] of pendingServerRequests.entries()) {
    if (r.threadId !== threadId) continue;
    if (turnId && r.turnId && r.turnId !== turnId) continue;
    pendingServerRequests.delete(reqId);
  }
}

function listPendingRequests(threadId = null) {
  const out = [];
  for (const r of pendingServerRequests.values()) {
    if (threadId && r.threadId !== threadId) continue;
    out.push({
      reqId: r.reqId,
      method: r.method,
      threadId: r.threadId,
      turnId: r.turnId,
      createdAt: r.createdAt,
      params: r.params,
      preview: r.preview || undefined,
      supervisorMessage: r.supervisorMessage || undefined,
    });
  }
  return out;
}

function buildCompactSummary(st) {
  return {
    threadId: st.threadId,
    name: st.name,
    cwd: st.cwd,
    model: st.model,
    sandbox: st.sandbox,
    approvalPolicy: st.approvalPolicy,
    status: st.status,
    activeTurnId: st.activeTurnId,
    lastTurnId: st.lastTurnId,
    lastError: st.lastError,
    lastMessage: truncateText(st.lastMessage, 800),
    inFlightDraft: st.deltaBuffers.size > 0
      ? truncateText(Array.from(st.deltaBuffers.values()).join("\n"), 500)
      : "",
    turnFiles: Array.from(st.turnFiles),
    turnCommandsCount: st.turnCommands.length,
    recentCommands: st.turnCommands.slice(-5),
    lastPlan: st.lastPlan,
    lastDiffStats: st.lastDiffStats,
    lastTokenUsage: st.turnTokenUsage || st.lastTokenUsage,
    nextCursor: formatCursor(st.nextSeq - 1),
    logPath: st.logPath,
  };
}

// ---------- Codex App-Server Connection ----------
function sendJsonRpcAsync(obj) {
  return new Promise((resolve, reject) => {
    if (!codexProc || !codexProc.stdin || codexProc.killed || codexProc.stdin.destroyed || !codexProc.stdin.writable) {
      return reject(new Error("codex app-server stdin is not writable"));
    }
    try {
      codexProc.stdin.write(JSON.stringify(obj) + "\n", "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

function rpcCall(method, params, timeoutMs = 30000) {
  const id = rpcNextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      const err = new Error(`RPC timeout (${timeoutMs}ms) on ${method}`);
      err.code = "RPC_TIMEOUT";
      reject(err);
    }, timeoutMs);
    pendingRpc.set(id, {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    sendJsonRpcAsync({ jsonrpc: "2.0", id, method, params }).catch((e) => {
      clearTimeout(timer);
      if (pendingRpc.has(id)) {
        pendingRpc.delete(id);
        reject(e);
      }
    });
  });
}

function summarizeFileChanges(changes) {
  if (!Array.isArray(changes)) return { items: [], total: 0 };
  return {
    total: changes.length,
    items: changes.slice(0, 20).map((ch) => ({
      path: ch.path || ch.filePath || ch.newPath || ch.oldPath || null,
      kind: ch.kind || null,
      diffPreview: typeof ch.diff === "string" ? truncateText(ch.diff, 600) : undefined,
    })),
  };
}

function trackRecentFile(st, fp) {
  st.recentFiles.add(fp);
  if (st.recentFiles.size > 200) {
    const first = st.recentFiles.values().next().value;
    st.recentFiles.delete(first);
  }
}

function handleServerNotification(msg) {
  const method = msg.method;
  const p = msg.params || {};
  const threadId = p.threadId || p.thread?.id;

  if (method === "serverRequest/resolved") {
    const reqRpcId = p.requestId;
    let removedEntry = null;
    for (const [reqId, entry] of pendingServerRequests.entries()) {
      if (entry.rpcId === reqRpcId && (!p.threadId || entry.threadId === p.threadId)) {
        pendingServerRequests.delete(reqId);
        removedEntry = entry;
        break;
      }
    }
    if (removedEntry) {
      const st = getThreadState(removedEntry.threadId);
      if (listPendingRequests(removedEntry.threadId).length === 0 && st.activeTurnId) {
        st.status = "running";
      }
      appendThreadLog(st, { kind: "server_request_resolved_by_server", reqId: removedEntry.reqId, rpcId: reqRpcId });
    }
    return;
  }

  if (method === "turn/started" && threadId) {
    const st = getThreadState(threadId);
    const turnId = p.turn?.id || p.turnId || null;
    st.activeTurnId = turnId;
    st.lastTurnId = turnId || st.lastTurnId;
    st.status = "running";
    st.lastError = null;
    st.lastMessage = "";
    st.lastMessageTurnId = turnId;
    st.lastPhase = null;
    st.turnTokenUsage = null;
    st.deltaBuffers.clear();
    st.pendingFileChanges.clear();
    st.turnFiles.clear();
    st.turnCommands = [];
    pushEvent(threadId, "info", "turn_started", turnId, { turnId });
    return;
  }

  if (method === "item/started" && threadId) {
    const st = getThreadState(threadId);
    const item = p.item || {};
    if (item.type === "fileChange" && item.id) {
      st.pendingFileChanges.set(item.id, summarizeFileChanges(item.changes));
    }
    return;
  }

  if (method === "item/agentMessage/delta" && threadId) {
    const st = getThreadState(threadId);
    const itemId = p.itemId || "_default";
    st.deltaBuffers.set(itemId, (st.deltaBuffers.get(itemId) || "") + (p.delta || ""));
    st.updatedAt = Date.now();
    return;
  }

  if (method === "item/completed" && threadId) {
    const st = getThreadState(threadId);
    const item = p.item || {};
    const turnId = p.turnId || st.activeTurnId;

    if (item.type === "agentMessage") {
      const text = item.text || st.deltaBuffers.get(item.id) || "";
      st.deltaBuffers.delete(item.id);
      st.lastMessage = text;
      st.lastMessageTurnId = turnId || null;
      st.lastPhase = item.phase || null;
      appendThreadLog(st, { kind: "agentMessage_full", turnId, phase: item.phase || null, text, questions: item.questions || null });
      // `final_answer` is always immediately followed by `turn/completed` (which already carries `lastMessage`);
      // mark it `info` so we never double-wake the supervisor on final responses.
      const msgLevel = item.phase === "final_answer" ? "info" : "milestone";
      pushEvent(threadId, msgLevel, "agent_message", turnId, {
        phase: item.phase || null,
        text: truncateText(text, MAX_INLINE_TEXT),
        questions: Array.isArray(item.questions) && item.questions.length > 0 ? item.questions : undefined,
        truncated: text.length > MAX_INLINE_TEXT,
        logPath: st.logPath,
      });
    } else if (item.type === "fileChange") {
      if (item.id) st.pendingFileChanges.delete(item.id);
      const paths = [];
      for (const ch of item.changes || []) {
        const fp = ch.path || ch.filePath || ch.newPath || ch.oldPath;
        if (fp) {
          paths.push(fp);
          trackRecentFile(st, fp);
          st.turnFiles.add(fp);
        }
      }
      appendThreadLog(st, {
        kind: "fileChange_detail",
        turnId,
        status: item.status || null,
        changes: summarizeFileChanges(item.changes),
      });
      pushEvent(threadId, "info", "file_changed", turnId, {
        status: item.status || null,
        files: paths,
      });
    } else if (item.type === "commandExecution") {
      const actions = Array.isArray(item.commandActions)
        ? item.commandActions.slice(0, 12).map((a) => ({
            type: a?.type || "unknown",
            path: a?.path || null,
            name: a?.name || null,
            query: a?.query || null,
          }))
        : [];
      const rec = {
        command: truncateText(String(item.command || ""), 200),
        exitCode: item.exitCode ?? null,
        status: item.status || null,
        durationMs: item.durationMs ?? null,
      };
      st.recentCommands.push(rec);
      if (st.recentCommands.length > 30) st.recentCommands.shift();
      st.turnCommands.push(rec);
      appendThreadLog(st, {
        kind: "commandExecution",
        turnId,
        ...rec,
        actions,
        outputTail: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-2000) : "",
      });
      pushEvent(threadId, "info", "command_completed", turnId, rec);
    } else if (["mcpToolCall", "webSearch", "imageView", "collabAgentToolCall", "imageGeneration", "dynamicToolCall"].includes(item.type)) {
      if (item.type === "dynamicToolCall" && item.tool === "message_supervisor") {
        return; // Already logged as message_supervisor_call
      }
      const name = item.tool || item.serverTool || item.name || item.server || item.action || item.type;
      const summary =
        item.query ||
        item.path ||
        item.imagePath ||
        item.prompt ||
        (item.arguments ? truncateText(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments), 400) : "") ||
        "";
      const rawOut = item.result ?? item.output ?? item.error ?? null;
      const outText = rawOut === null ? "" : truncateText(typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut, null, 2), 1800);
      appendThreadLog(st, {
        kind: "toolExecution",
        turnId,
        toolType: item.type,
        server: item.server || null,
        name: String(name),
        status: item.status || null,
        durationMs: item.durationMs ?? null,
        summary: truncateText(String(summary), 400),
        outputTail: outText,
      });
    } else if (item.type === "plan") {
      const planText = String(item.text || "").trim();
      if (planText) {
        if (st.lastMessageTurnId !== turnId || st.lastPhase !== "final_answer") {
          st.lastMessage = planText;
          st.lastMessageTurnId = turnId || null;
          st.lastPhase = "plan";
        }
        appendThreadLog(st, { kind: "plan_item", turnId, text: planText });
      }
    } else if (item.type === "subAgentActivity") {
      const kindStr = typeof item.kind === "string" ? item.kind : item.kind?.type || null;
      const summary = [item.model, item.reasoningEffort ? `effort:${item.reasoningEffort}` : ""].filter(Boolean).join(" · ");
      appendThreadLog(st, {
        kind: "toolExecution",
        turnId,
        toolType: "subAgentActivity",
        server: null,
        name: String(item.agentPath || item.agentThreadId || "sub-agent"),
        status: kindStr,
        durationMs: null,
        summary,
        outputTail: "",
      });
    } else if (item.type === "contextCompaction") {
      appendThreadLog(st, { kind: "context_compaction", turnId });
    } else if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      appendThreadLog(st, {
        kind: "review_mode",
        turnId,
        phase: item.type === "enteredReviewMode" ? "entered" : "exited",
        review: truncateText(String(item.review || ""), 300),
      });
    }
    return;
  }

  if (method === "turn/plan/updated" && threadId) {
    const st = getThreadState(threadId);
    st.lastPlan = { explanation: p.explanation || null, plan: p.plan || [] };
    pushEvent(threadId, "milestone", "plan_updated", p.turnId, st.lastPlan);
    return;
  }

  if (method === "turn/diff/updated" && threadId) {
    const st = getThreadState(threadId);
    const diff = typeof p.diff === "string" ? p.diff : "";
    const files = [];
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("+++ b/")) files.push(line.slice(6));
    }
    for (const f of files) {
      st.turnFiles.add(f);
      trackRecentFile(st, f);
    }
    st.lastDiffStats = { files, bytes: diff.length };
    return;
  }

  if (method === "thread/tokenUsage/updated" && threadId) {
    const st = getThreadState(threadId);
    st.lastTokenUsage = p;
    st.turnTokenUsage = p;
    return;
  }

  if (method === "turn/completed" && threadId) {
    const st = getThreadState(threadId);
    const turn = p.turn || {};
    const turnId = turn.id || p.turnId || st.activeTurnId;
    const status = turn.status || "completed";
    if (turnId) {
      st.completedTurnIds.add(turnId);
      if (st.completedTurnIds.size > 100) {
        const first = st.completedTurnIds.values().next().value;
        st.completedTurnIds.delete(first);
      }
    }
    prunePendingRequestsForThread(threadId, turnId);
    st.activeTurnId = null;
    st.lastTurnId = turnId || st.lastTurnId;
    st.deltaBuffers.clear();
    st.pendingFileChanges.clear();

    // Only attach message/token usage belonging to THIS turn (avoid leaking prior turn on fast failure)
    const turnMessage = st.lastMessageTurnId === turnId ? st.lastMessage : "";
    if (status === "failed" || turn.error) {
      st.status = "error";
      st.lastError = turn.error || { message: `turn ${status}` };
      pushEvent(threadId, "critical", "turn_error", turnId, {
        status,
        error: st.lastError,
        lastMessage: truncateText(turnMessage, MAX_INLINE_TEXT),
        turnFiles: Array.from(st.turnFiles),
        turnCommandsCount: st.turnCommands.length,
        logPath: st.logPath,
      });
    } else {
      st.status = "idle";
      pushEvent(threadId, "critical", "turn_completed", turnId, {
        status,
        lastMessage: truncateText(turnMessage, MAX_INLINE_TEXT),
        turnFiles: Array.from(st.turnFiles),
        turnCommandsCount: st.turnCommands.length,
        recentCommands: st.turnCommands.slice(-5),
        tokenUsage: st.turnTokenUsage,
        logPath: st.logPath,
      });
    }
    return;
  }

  if (method === "thread/status/changed" && threadId) {
    const st = getThreadState(threadId);
    appendThreadLog(st, { kind: "thread_status_changed", params: p });
    return;
  }
}

const SUPERVISOR_DEV_INSTRUCTIONS =
  "This session was started and is actively supervised on the user's behalf by a local coordinator agent (Antigravity), which automatically provides the `message_supervisor` tool. " +
  "Your final answer is always delivered to the supervisor automatically, whereas routine mid-turn commentary is not forwarded. " +
  "Call `message_supervisor` with `wait_for_reply: false` ONLY for major mid-task milestones or risks worth alerting the supervisor while you keep working, " +
  "and with `wait_for_reply: true` when you are blocked and need a decision, clarification, or confirmation from the supervisor. " +
  "Do not call it for routine file reads, minor edits, or final completion (just return your final answer normally).";

const SUPERVISOR_DYNAMIC_TOOL = {
  type: "function",
  name: "message_supervisor",
  description:
    "Send a concise mid-task milestone/risk update (`wait_for_reply: false`) or blocking question (`wait_for_reply: true`) to the user's supervising coordinator agent (Antigravity). Not needed for routine narration or final completion.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Concise update or question for the supervisor." },
      wait_for_reply: {
        type: "boolean",
        description: "False (default) to notify without pausing; true to pause and wait for the supervisor's reply.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

const SUPPORTED_SERVER_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "item/tool/call",
  "applyPatchApproval",
  "execCommandApproval",
]);

function handleServerRequest(msg) {
  const method = msg.method;
  const p = msg.params || {};

  if (!SUPPORTED_SERVER_REQUESTS.has(method)) {
    logDaemon(`Rejecting unsupported server request method=${method} rpcId=${msg.id}`);
    sendJsonRpcAsync({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `codex-supervisor does not support server request method: ${method}` },
    }).catch((e) => logDaemon(`Failed to reject unsupported request: ${e.message}`));
    return;
  }

  // Handle native subagent->supervisor communication tool
  if (method === "item/tool/call") {
    if (p.namespace || p.tool !== "message_supervisor") {
      logDaemon(`Rejecting unknown dynamic tool=${p.namespace ? p.namespace + "." : ""}${p.tool} rpcId=${msg.id}`);
      sendJsonRpcAsync({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Unsupported dynamic tool: ${p.namespace ? p.namespace + "." : ""}${p.tool}` },
      }).catch((e) => logDaemon(`Failed to reject unknown dynamic tool: ${e.message}`));
      return;
    }

    let args = p.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    const isPlainObj = args && typeof args === "object" && !Array.isArray(args);
    const text = isPlainObj && typeof args.message === "string" ? args.message.trim() : "";
    const rawWait = isPlainObj ? args.wait_for_reply : undefined;
    const validWait = rawWait === undefined || typeof rawWait === "boolean";
    const waitForReply = rawWait === true;
    const threadId = p.threadId || "unknown";
    const turnId = p.turnId || null;

    if (!isPlainObj || !text || !validWait) {
      sendJsonRpcAsync({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          success: false,
          contentItems: [{ type: "inputText", text: "Error: arguments must be an object with non-empty string `message` and optional boolean `wait_for_reply`." }],
        },
      }).catch((e) => logDaemon(`Failed to reply invalid message_supervisor call: ${e.message}`));
      return;
    }

    const st = getThreadState(threadId);
    appendThreadLog(st, { kind: "message_supervisor_call", turnId, waitForReply, message: text });

    if (!waitForReply) {
      // Non-blocking milestone alert: immediately unblock Codex and wake supervisor!
      sendJsonRpcAsync({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: "Delivered to supervisor. Continue your work." }],
        },
      }).catch((e) => logDaemon(`Failed to ack non-blocking message_supervisor: ${e.message}`));

      pushEvent(threadId, "critical", "supervisor_message", turnId, {
        message: truncateText(text, MAX_INLINE_TEXT),
        truncated: text.length > MAX_INLINE_TEXT,
      });
      return;
    }

    // Blocking question: pause Codex tool call until supervisor calls `respond <reqId> --answer "..."`
    const reqId = `${INSTANCE_ID}:${serverReqNextSeq++}`;
    pendingServerRequests.set(reqId, {
      reqId,
      rpcId: msg.id,
      method,
      threadId,
      turnId,
      params: p,
      supervisorMessage: text,
      createdAt: new Date().toISOString(),
    });
    st.status = "waiting_input";
    pushEvent(threadId, "critical", "supervisor_question", turnId, {
      reqId,
      message: truncateText(text, MAX_INLINE_TEXT),
    });
    return;
  }

  const threadId = p.threadId || p.conversationId || "unknown";
  const turnId = p.turnId || null;
  const reqId = `${INSTANCE_ID}:${serverReqNextSeq++}`;

  const st = getThreadState(threadId);
  let preview = null;
  if (method === "item/fileChange/requestApproval" && p.itemId) {
    preview = st.pendingFileChanges.get(p.itemId) || null;
  } else if (method === "applyPatchApproval" && p.fileChanges) {
    preview = Object.keys(p.fileChanges).slice(0, 20);
  }

  const entry = {
    reqId,
    rpcId: msg.id,
    method,
    threadId,
    turnId,
    params: p,
    preview,
    createdAt: new Date().toISOString(),
  };
  pendingServerRequests.set(reqId, entry);
  st.status = "waiting_input";

  const isUserInput = method === "item/tool/requestUserInput";
  pushEvent(
    threadId,
    "critical",
    isUserInput ? "user_input_request" : "approval_request",
    turnId,
    {
      reqId,
      method,
      command: p.command || null,
      cwd: p.cwd || null,
      reason: p.reason || null,
      grantRoot: p.grantRoot || null,
      permissions: p.permissions || null,
      questions: p.questions || null,
      fileChangesPreview: preview,
    }
  );
}

function failAllPendingAndWaiters(reason) {
  codexReady = false;
  for (const { reject } of pendingRpc.values()) {
    reject(new Error(reason));
  }
  pendingRpc.clear();
  pendingServerRequests.clear();
  for (const st of threads.values()) {
    if (st.status === "running" || st.status === "waiting_input" || st.waiters.size > 0) {
      st.status = "error";
      st.activeTurnId = null;
      st.lastError = { message: reason };
      pushEvent(st.threadId, "critical", "daemon_error", st.lastTurnId, st.lastError);
    }
  }
}

async function startCodexProcess() {
  logDaemon(`Starting codex app-server: ${codexBin}`);
  codexProc = spawn(codexBin, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  codexProc.on("error", (err) => {
    logDaemon(`codex app-server spawn error: ${err.message}`);
    failAllPendingAndWaiters(`codex app-server spawn error: ${err.message}`);
    if (!shuttingDown) {
      setTimeout(() => cleanupAndExit(1), 150);
    }
  });

  codexProc.stdin.on("error", (err) => {
    logDaemon(`[codex stdin error] ${err.message}`);
    failAllPendingAndWaiters(`codex app-server stdin error: ${err.message}`);
    if (!shuttingDown) {
      setTimeout(() => cleanupAndExit(1), 150);
    }
  });

  codexProc.stderr.on("data", (chunk) => {
    const s = chunk.toString("utf8").trim();
    if (s) logDaemon(`[codex stderr] ${s.slice(0, 500)}`);
  });

  // Use `close` (after stdio streams finish draining) rather than `exit`
  codexProc.on("close", (code, signal) => {
    logDaemon(`codex app-server closed code=${code} signal=${signal}`);
    failAllPendingAndWaiters(`codex app-server closed (code=${code}, signal=${signal})`);
    if (!shuttingDown) {
      // Allow pending HTTP error responses a brief window to flush before exiting
      setTimeout(() => cleanupAndExit(1), 200);
    }
  });

  const rl = readline.createInterface({ input: codexProc.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logDaemon(`[codex raw stdout] ${line.slice(0, 300)}`);
      return;
    }

    if (msg.id !== undefined && msg.method !== undefined) {
      handleServerRequest(msg);
    } else if (msg.id !== undefined && pendingRpc.has(msg.id)) {
      const { resolve, reject } = pendingRpc.get(msg.id);
      pendingRpc.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message || JSON.stringify(msg.error));
        e.rpcError = msg.error;
        reject(e);
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      handleServerNotification(msg);
    }
  });

  codexInitInfo = await rpcCall("initialize", {
    clientInfo: { name: "agy-codex-supervisor", version: "1.2.0" },
    capabilities: { experimentalApi: true },
  });
  await sendJsonRpcAsync({ jsonrpc: "2.0", method: "initialized", params: {} });
  codexReady = true;
  logDaemon(`codex app-server initialized: ${JSON.stringify(codexInitInfo)}`);
}

// ---------- HTTP API ----------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        chunks.length = 0;
        const err = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
        err.statusCode = 413;
        req.pause();
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        const err = new Error(`Invalid JSON body: ${e.message}`);
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", (e) => {
      if (!aborted) reject(e);
    });
  });
}

function jsonResponse(res, code, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function makeTextInput(prompt) {
  return [{ type: "text", text: prompt }];
}

function markTurnStartedIfNotFinished(st, turnId) {
  if (!turnId) return;
  st.lastTurnId = turnId;
  if (!st.completedTurnIds.has(turnId)) {
    st.activeTurnId = turnId;
    if (st.status !== "waiting_input") st.status = "running";
  }
}

function isNoActiveTurnError(err) {
  if (!err || err.code === "RPC_TIMEOUT") return false;
  const msg = String(err.rpcError?.message || err.message || "").toLowerCase();
  return msg.includes("no active turn") || msg.includes("not running") || msg.includes("turn not active");
}

function buildServerRequestResponse(entry, body) {
  const V2_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

  if (entry.method === "item/commandExecution/requestApproval" || entry.method === "item/fileChange/requestApproval") {
    if (!body.decision || !V2_DECISIONS.has(body.decision)) {
      const err = new Error(`Explicit --decision required (${Array.from(V2_DECISIONS).join("|")}) for ${entry.method}`);
      err.statusCode = 400;
      throw err;
    }
    return { decision: body.decision };
  }

  if (entry.method === "applyPatchApproval" || entry.method === "execCommandApproval") {
    if (!body.decision || !V2_DECISIONS.has(body.decision)) {
      const err = new Error(`Explicit --decision required (${Array.from(V2_DECISIONS).join("|")}) for ${entry.method}`);
      err.statusCode = 400;
      throw err;
    }
    const map = {
      accept: "approved",
      acceptForSession: "approved_for_session",
      decline: { denied: { rejection: body.reason || "Declined by supervisor" } },
      cancel: "abort",
    };
    return { decision: map[body.decision] };
  }

  if (entry.method === "item/permissions/requestApproval") {
    const hasPermissions = Object.prototype.hasOwnProperty.call(body, "permissions") && body.permissions !== undefined;
    if (!body.decision && !hasPermissions) {
      const err = new Error("Explicit --decision (accept|acceptForSession|decline|cancel) or --permissions JSON required");
      err.statusCode = 400;
      throw err;
    }
    if (hasPermissions && (!body.permissions || typeof body.permissions !== "object" || Array.isArray(body.permissions))) {
      const err = new Error("Invalid --permissions value: must be a JSON object");
      err.statusCode = 400;
      throw err;
    }
    if (body.decision && !V2_DECISIONS.has(body.decision)) {
      const err = new Error(`Invalid --decision for permissions approval: ${body.decision}`);
      err.statusCode = 400;
      throw err;
    }
    const declined = body.decision === "decline" || body.decision === "cancel";
    const scope = body.scope || (body.decision === "acceptForSession" ? "session" : "turn");
    if (scope !== "turn" && scope !== "session") {
      const err = new Error("Invalid --scope (must be turn or session)");
      err.statusCode = 400;
      throw err;
    }
    return {
      permissions: declined ? {} : (hasPermissions ? body.permissions : (entry.params?.permissions || {})),
      scope,
    };
  }

  if (entry.method === "item/tool/call") {
    const replyText = body.answer !== undefined ? String(body.answer).trim() : "";
    if (!replyText) {
      const err = new Error("Explicit non-empty --answer is required to reply to message_supervisor");
      err.statusCode = 400;
      throw err;
    }
    return {
      success: true,
      contentItems: [{ type: "inputText", text: replyText }],
    };
  }

  if (entry.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(entry.params?.questions) ? entry.params.questions : [];
    const validIds = new Set(questions.map((q) => q.id));
    let answers = body.answers;

    if (!answers && body.answer !== undefined) {
      if (questions.length > 1) {
        const err = new Error(`Multiple questions (${questions.map((q) => q.id).join(", ")}); pass --answers JSON mapping each question id`);
        err.statusCode = 400;
        throw err;
      }
      const firstId = questions[0]?.id;
      if (!firstId) {
        const err = new Error("No question id found in requestUserInput params; pass --answers JSON");
        err.statusCode = 400;
        throw err;
      }
      answers = { [firstId]: { answers: Array.isArray(body.answer) ? body.answer.map(String) : [String(body.answer)] } };
    }

    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      const err = new Error("Explicit --answer or --answers JSON required for requestUserInput");
      err.statusCode = 400;
      throw err;
    }

    for (const [qId, val] of Object.entries(answers)) {
      if (validIds.size > 0 && !validIds.has(qId)) {
        const err = new Error(`Unknown question id "${qId}". Expected: ${Array.from(validIds).join(", ")}`);
        err.statusCode = 400;
        throw err;
      }
      if (!val || typeof val !== "object" || !Array.isArray(val.answers) || !val.answers.every((x) => typeof x === "string")) {
        const err = new Error(`Invalid answers format for "${qId}". Expected { "answers": ["..."] }`);
        err.statusCode = 400;
        throw err;
      }
    }
    return { answers };
  }

  const err = new Error(`Unsupported server request method: ${entry.method}`);
  err.statusCode = 400;
  throw err;
}

function validateMode(mode) {
  if (mode === undefined || mode === null || mode === "") return null;
  if (mode !== "plan" && mode !== "default") {
    const err = new Error(`Invalid mode "${mode}" (expected "plan" or "default")`);
    err.statusCode = 400;
    throw err;
  }
  return mode;
}

function applyCollaborationMode(turnParams, body, st) {
  const mode = validateMode(body.mode);
  if (!mode) return null;
  const effModel = body.model || st.model;
  if (!effModel) {
    const err = new Error("--mode requires a known model (pass --model or start/resume the thread first)");
    err.statusCode = 400;
    throw err;
  }
  turnParams.collaborationMode = {
    mode,
    settings: {
      model: effModel,
      ...(body.effort ? { reasoning_effort: body.effort } : {}),
    },
  };
  return mode;
}

async function handleApi(req, res) {
  lastActivityMs = Date.now();
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/health" && req.method === "GET") {
    return jsonResponse(res, 200, {
      ok: codexReady,
      pid: process.pid,
      instanceId: INSTANCE_ID,
      codexBin,
      codexInitInfo,
      activeThreads: Array.from(threads.values()).filter((t) => t.status === "running" || t.status === "waiting_input").length,
      pendingRequestsCount: pendingServerRequests.size,
    });
  }

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${authToken}`) {
    return jsonResponse(res, 401, { error: "Unauthorized" });
  }

  try {
    if (url.pathname === "/models" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 30);
      const data = await rpcCall("model/list", { limit });
      const items = (data.data || data.models || []).map((m) => ({
        id: m.id || m.model || m.slug,
        displayName: m.displayName || m.id,
        defaultReasoningEffort: m.defaultReasoningEffort || null,
        isDefault: Boolean(m.isDefault),
      }));
      return jsonResponse(res, 200, { models: items });
    }

    if (url.pathname === "/threads" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 15);
      const cwd = url.searchParams.get("cwd") || undefined;
      const params = { limit };
      if (cwd) params.cwd = cwd;
      const data = await rpcCall("thread/list", params);
      const items = (data.data || data.threads || []).map((t) => ({
        id: t.id,
        name: t.name || t.preview?.slice(0, 60) || "",
        cwd: t.cwd || null,
        updatedAt: t.updatedAt || null,
        localStatus: threads.get(t.id)?.status || null,
      }));
      return jsonResponse(res, 200, { threads: items });
    }

    if (url.pathname === "/start" && req.method === "POST") {
      const body = await readJsonBody(req);
      const reqMode = validateMode(body.mode);
      const startParams = {
        dynamicTools: [SUPERVISOR_DYNAMIC_TOOL],
        developerInstructions: body.developerInstructions
          ? `${SUPERVISOR_DEV_INSTRUCTIONS}\n\n${body.developerInstructions}`
          : SUPERVISOR_DEV_INSTRUCTIONS,
      };
      if (body.cwd) startParams.cwd = body.cwd;
      if (body.model) startParams.model = body.model;
      if (body.sandbox) startParams.sandbox = body.sandbox;
      if (body.approvalPolicy) startParams.approvalPolicy = body.approvalPolicy;
      if (body.ephemeral !== undefined) startParams.ephemeral = Boolean(body.ephemeral);
      if (body.baseInstructions) startParams.baseInstructions = body.baseInstructions;

      const thRes = await rpcCall("thread/start", startParams);
      const threadId = thRes.thread?.id || thRes.threadId || thRes.id;

      const result = await withThreadLock(threadId, async () => {
        const st = getThreadState(threadId);
        st.cwd = thRes.cwd || thRes.thread?.cwd || body.cwd || null;
        st.model = thRes.model || body.model || null;
        st.sandbox = normalizeSandboxPolicy(thRes.sandbox) || body.sandbox || null;
        st.approvalPolicy = normalizeApprovalPolicy(thRes.approvalPolicy) || body.approvalPolicy || null;

        if (body.name) {
          st.name = body.name;
          try {
            await rpcCall("thread/name/set", { threadId, name: body.name });
          } catch {}
        }

        appendThreadLog(st, {
          kind: "thread_meta",
          action: "start",
          name: st.name,
          cwd: st.cwd,
          model: st.model,
          sandbox: st.sandbox,
          approvalPolicy: st.approvalPolicy,
        });

        const cursorBefore = st.nextSeq - 1;
        let turnId = null;
        if (body.prompt) {
          const turnParams = {
            threadId,
            input: makeTextInput(body.prompt),
          };
          if (body.model) turnParams.model = body.model;
          if (body.effort) turnParams.effort = body.effort;
          if (body.cwd) turnParams.cwd = body.cwd;
          if (body.approvalPolicy) turnParams.approvalPolicy = body.approvalPolicy;
          applyCollaborationMode(turnParams, body, st);
          const tRes = await rpcCall("turn/start", turnParams);
          turnId = tRes.turn?.id || tRes.turnId || null;
          markTurnStartedIfNotFinished(st, turnId);
          appendThreadLog(st, {
            kind: "supervisor_prompt",
            action: "start",
            turnId,
            model: body.model || st.model,
            effort: body.effort || null,
            mode: reqMode,
            prompt: body.prompt,
          });
        }

        return {
          instanceId: INSTANCE_ID,
          threadId,
          turnId,
          cursor: formatCursor(cursorBefore),
          status: st.status,
          logPath: st.logPath,
        };
      });
      return jsonResponse(res, 200, result);
    }

    if (url.pathname === "/resume" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.threadId) return jsonResponse(res, 400, { error: "threadId required" });
      const reqMode = validateMode(body.mode);

      const out = await withThreadLock(body.threadId, async () => {
        const params = { threadId: body.threadId, excludeTurns: true };
        if (body.cwd) params.cwd = body.cwd;
        if (body.model) params.model = body.model;
        if (body.sandbox) params.sandbox = body.sandbox;
        if (body.approvalPolicy) params.approvalPolicy = body.approvalPolicy;

        const resData = await rpcCall("thread/resume", params);
        const effCwd = resData.cwd || resData.thread?.cwd || null;
        const effSandbox = normalizeSandboxPolicy(resData.sandbox);
        const effApproval = normalizeApprovalPolicy(resData.approvalPolicy);

        // Enforce explicit safety constraints if upstream ignored overrides on an already-loaded thread
        const mismatches = [];
        if (body.sandbox && effSandbox && normalizeSandboxPolicy(body.sandbox) !== effSandbox) {
          mismatches.push(`sandbox requested=${body.sandbox} effective=${effSandbox}`);
        }
        if (body.approvalPolicy && effApproval && normalizeApprovalPolicy(body.approvalPolicy) !== effApproval) {
          mismatches.push(`approvalPolicy requested=${body.approvalPolicy} effective=${effApproval}`);
        }
        if (body.cwd && effCwd && normalizeCwd(body.cwd) !== normalizeCwd(effCwd)) {
          mismatches.push(`cwd requested=${body.cwd} effective=${effCwd}`);
        }

        const st = getThreadState(body.threadId);
        st.cwd = effCwd || st.cwd;
        st.model = resData.model || st.model;
        st.sandbox = effSandbox || st.sandbox;
        st.approvalPolicy = effApproval || st.approvalPolicy;
        st.name = resData.thread?.name || st.name;

        if (mismatches.length > 0) {
          const err = new Error(`Resume constraint mismatch (upstream kept loaded thread settings): ${mismatches.join("; ")}`);
          err.statusCode = 409;
          throw err;
        }

        appendThreadLog(st, {
          kind: "thread_meta",
          action: "resume",
          name: st.name,
          cwd: st.cwd,
          model: st.model,
          sandbox: st.sandbox,
          approvalPolicy: st.approvalPolicy,
        });

        const cursorBefore = st.nextSeq - 1;
        let turnId = null;
        if (body.prompt) {
          const turnParams = { threadId: body.threadId, input: makeTextInput(body.prompt) };
          if (body.model) turnParams.model = body.model;
          if (body.effort) turnParams.effort = body.effort;
          applyCollaborationMode(turnParams, body, st);
          const tRes = await rpcCall("turn/start", turnParams);
          turnId = tRes.turn?.id || tRes.turnId || null;
          markTurnStartedIfNotFinished(st, turnId);
          appendThreadLog(st, {
            kind: "supervisor_prompt",
            action: "resume",
            turnId,
            model: body.model || st.model,
            effort: body.effort || null,
            mode: reqMode,
            prompt: body.prompt,
          });
        }

        return {
          instanceId: INSTANCE_ID,
          threadId: body.threadId,
          turnId,
          cursor: formatCursor(cursorBefore),
          status: st.status,
          effective: { cwd: st.cwd, sandbox: st.sandbox, approvalPolicy: st.approvalPolicy, model: st.model },
          logPath: st.logPath,
        };
      });
      return jsonResponse(res, 200, out);
    }

    if (url.pathname === "/fork" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.threadId) return jsonResponse(res, 400, { error: "threadId required" });
      const reqMode = validateMode(body.mode);

      const params = { threadId: body.threadId, excludeTurns: true };
      if (body.cwd) params.cwd = body.cwd;
      if (body.model) params.model = body.model;
      if (body.sandbox) params.sandbox = body.sandbox;
      if (body.approvalPolicy) params.approvalPolicy = body.approvalPolicy;
      if (body.ephemeral !== undefined) params.ephemeral = Boolean(body.ephemeral);

      const resData = await rpcCall("thread/fork", params);
      const newThreadId = resData.thread?.id || resData.threadId || resData.id;
      const effCwd = resData.cwd || resData.thread?.cwd || null;
      const effSandbox = normalizeSandboxPolicy(resData.sandbox);
      const effApproval = normalizeApprovalPolicy(resData.approvalPolicy);

      const mismatches = [];
      if (body.sandbox && effSandbox && normalizeSandboxPolicy(body.sandbox) !== effSandbox) {
        mismatches.push(`sandbox requested=${body.sandbox} effective=${effSandbox}`);
      }
      if (body.approvalPolicy && effApproval && normalizeApprovalPolicy(body.approvalPolicy) !== effApproval) {
        mismatches.push(`approvalPolicy requested=${body.approvalPolicy} effective=${effApproval}`);
      }
      if (body.cwd && effCwd && normalizeCwd(body.cwd) !== normalizeCwd(effCwd)) {
        mismatches.push(`cwd requested=${body.cwd} effective=${effCwd}`);
      }
      if (mismatches.length > 0) {
        const err = new Error(`Fork constraint mismatch: ${mismatches.join("; ")}`);
        err.statusCode = 409;
        err.extra = { threadId: newThreadId, stage: "constraint_check" };
        throw err;
      }

      const out = await withThreadLock(newThreadId, async () => {
        const st = getThreadState(newThreadId);
        st.cwd = effCwd || st.cwd;
        st.model = resData.model || st.model;
        st.sandbox = effSandbox || st.sandbox;
        st.approvalPolicy = effApproval || st.approvalPolicy;
        st.name = body.name || resData.thread?.name || st.name;

        if (body.name) {
          try {
            await rpcCall("thread/name/set", { threadId: newThreadId, name: body.name });
          } catch {}
        }

        appendThreadLog(st, {
          kind: "thread_meta",
          action: "fork",
          sourceThreadId: body.threadId,
          name: st.name,
          cwd: st.cwd,
          model: st.model,
          sandbox: st.sandbox,
          approvalPolicy: st.approvalPolicy,
        });

        const cursorBefore = st.nextSeq - 1;
        let turnId = null;
        if (body.prompt) {
          const turnParams = { threadId: newThreadId, input: makeTextInput(body.prompt) };
          if (body.model) turnParams.model = body.model;
          if (body.effort) turnParams.effort = body.effort;
          try {
            applyCollaborationMode(turnParams, body, st);
            const tRes = await rpcCall("turn/start", turnParams);
            turnId = tRes.turn?.id || tRes.turnId || null;
            markTurnStartedIfNotFinished(st, turnId);
            appendThreadLog(st, {
              kind: "supervisor_prompt",
              action: "fork",
              turnId,
              model: body.model || st.model,
              effort: body.effort || null,
              mode: reqMode,
              prompt: body.prompt,
            });
          } catch (e) {
            e.extra = { threadId: newThreadId, stage: "turn_start" };
            throw e;
          }
        }

        return {
          instanceId: INSTANCE_ID,
          sourceThreadId: body.threadId,
          threadId: newThreadId,
          turnId,
          cursor: formatCursor(cursorBefore),
          status: st.status,
          effective: { cwd: st.cwd, sandbox: st.sandbox, approvalPolicy: st.approvalPolicy, model: st.model },
          logPath: st.logPath,
        };
      });
      return jsonResponse(res, 200, out);
    }

    if (url.pathname === "/send" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.threadId || !body.prompt) {
        return jsonResponse(res, 400, { error: "threadId and prompt required" });
      }
      const reqMode = validateMode(body.mode);
      const out = await withThreadLock(body.threadId, async () => {
        const st = getThreadState(body.threadId);
        const cursorBefore = st.nextSeq - 1;
        const turnParams = {
          threadId: body.threadId,
          input: makeTextInput(body.prompt),
        };
        if (body.model) turnParams.model = body.model;
        if (body.effort) turnParams.effort = body.effort;
        if (body.cwd) turnParams.cwd = body.cwd;
        if (body.approvalPolicy) turnParams.approvalPolicy = body.approvalPolicy;
        applyCollaborationMode(turnParams, body, st);

        const tRes = await rpcCall("turn/start", turnParams);
        const turnId = tRes.turn?.id || tRes.turnId || null;
        markTurnStartedIfNotFinished(st, turnId);
        appendThreadLog(st, {
          kind: "supervisor_prompt",
          action: "send",
          turnId,
          model: body.model || st.model,
          effort: body.effort || null,
          mode: reqMode,
          prompt: body.prompt,
        });
        return {
          instanceId: INSTANCE_ID,
          threadId: body.threadId,
          turnId,
          cursor: formatCursor(cursorBefore),
          status: st.status,
        };
      });
      return jsonResponse(res, 200, out);
    }

    if (url.pathname === "/steer" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.threadId || !body.prompt) {
        return jsonResponse(res, 400, { error: "threadId and prompt required" });
      }
      const out = await withThreadLock(body.threadId, async () => {
        const st = getThreadState(body.threadId);
        const explicitTurnId = body.expectedTurnId !== undefined ? body.expectedTurnId : null;
        const expectedTurnId = explicitTurnId || st.activeTurnId;

        if (explicitTurnId && st.activeTurnId && explicitTurnId !== st.activeTurnId) {
          const err = new Error(`Expected turn ${explicitTurnId} does not match active turn ${st.activeTurnId}`);
          err.statusCode = 409;
          throw err;
        }

        if (!expectedTurnId) {
          if (body.fallbackSend && !explicitTurnId) {
            const cursorBefore = st.nextSeq - 1;
            const tRes = await rpcCall("turn/start", {
              threadId: body.threadId,
              input: makeTextInput(body.prompt),
            });
            const turnId = tRes.turn?.id || tRes.turnId || null;
            markTurnStartedIfNotFinished(st, turnId);
            appendThreadLog(st, {
              kind: "supervisor_prompt",
              action: "fallback_send",
              turnId,
              model: st.model,
              effort: null,
              prompt: body.prompt,
            });
            return {
              mode: "fallback_send",
              instanceId: INSTANCE_ID,
              threadId: body.threadId,
              turnId,
              cursor: formatCursor(cursorBefore),
            };
          }
          const err = new Error("No active turn to steer (thread is idle). Use `send` or pass --fallback-send (without --turn-id).");
          err.statusCode = 409;
          throw err;
        }

        const cursorBefore = st.nextSeq - 1;
        try {
          const sRes = await rpcCall("turn/steer", {
            threadId: body.threadId,
            expectedTurnId,
            input: makeTextInput(body.prompt),
          });
          appendThreadLog(st, { kind: "steer_sent", turnId: expectedTurnId, prompt: body.prompt });
          return {
            mode: "steered",
            instanceId: INSTANCE_ID,
            threadId: body.threadId,
            turnId: sRes.turnId || expectedTurnId,
            cursor: formatCursor(cursorBefore),
          };
        } catch (err) {
          // Only fall back when caller did NOT pin a specific turnId, no other turn is now active,
          // and the RPC error explicitly indicates no active turn (never on timeout or turn mismatch).
          if (body.fallbackSend && !explicitTurnId && !st.activeTurnId && isNoActiveTurnError(err)) {
            const fbCursorBefore = st.nextSeq - 1;
            const tRes = await rpcCall("turn/start", {
              threadId: body.threadId,
              input: makeTextInput(body.prompt),
            });
            const turnId = tRes.turn?.id || tRes.turnId || null;
            markTurnStartedIfNotFinished(st, turnId);
            appendThreadLog(st, {
              kind: "supervisor_prompt",
              action: "fallback_send",
              turnId,
              model: st.model,
              effort: null,
              prompt: body.prompt,
            });
            return {
              mode: "fallback_send",
              steerError: err.message,
              instanceId: INSTANCE_ID,
              threadId: body.threadId,
              turnId,
              cursor: formatCursor(fbCursorBefore),
            };
          }
          throw err;
        }
      });
      return jsonResponse(res, 200, out);
    }

    if (url.pathname === "/interrupt" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.threadId) return jsonResponse(res, 400, { error: "threadId required" });
      const st = getThreadState(body.threadId);
      const turnId = body.turnId !== undefined ? body.turnId : st.activeTurnId;
      if (turnId === null || turnId === undefined) {
        return jsonResponse(res, 200, { accepted: false, interrupted: false, reason: "no_active_turn", status: st.status });
      }
      await rpcCall("turn/interrupt", { threadId: body.threadId, turnId });
      appendThreadLog(st, { kind: "supervisor_interrupt", turnId });
      return jsonResponse(res, 200, {
        accepted: true,
        threadId: body.threadId,
        turnId,
        note: "Interrupt accepted by app-server; confirm final status via wait.",
      });
    }

    if (url.pathname === "/respond" && req.method === "POST") {
      const body = await readJsonBody(req);
      const reqId = String(body.reqId || "");
      const entry = pendingServerRequests.get(reqId);
      if (!entry) {
        return jsonResponse(res, 404, {
          error: `Pending request "${reqId}" not found (already resolved, expired, or from a previous daemon instance).`,
        });
      }
      if (entry.submitting) {
        return jsonResponse(res, 409, {
          error: `Pending request "${reqId}" is already being submitted by another client.`,
        });
      }

      const result = buildServerRequestResponse(entry, body);
      entry.submitting = true;
      try {
        await sendJsonRpcAsync({ jsonrpc: "2.0", id: entry.rpcId, result });
      } catch (err) {
        if (pendingServerRequests.get(reqId) === entry) {
          entry.submitting = false;
        }
        throw err;
      }
      pendingServerRequests.delete(reqId);

      const st = getThreadState(entry.threadId);
      if (listPendingRequests(entry.threadId).length === 0 && st.activeTurnId) {
        st.status = "running";
      }
      appendThreadLog(st, { kind: "server_request_responded", reqId, method: entry.method, result });
      return jsonResponse(res, 200, {
        ok: true,
        submitted: true,
        reqId,
        threadId: entry.threadId,
        method: entry.method,
        status: st.status,
      });
    }

    if (url.pathname === "/wait" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.threadId) return jsonResponse(res, 400, { error: "threadId required" });
      const st = getThreadState(body.threadId);
      const { seq: afterSeq, provided: afterProvided, instanceMismatch } = parseCursor(body.after);
      const timeoutSec = Math.max(1, Math.min(1800, Number(body.timeout ?? 600)));
      const eventsFilter = body.events || "critical";
      const gap = detectCursorGap(st, afterSeq, afterProvided, instanceMismatch);

      // If daemon restarted or buffer truncated, wake immediately so supervisor can resync
      if (gap.cursorGap) {
        const existingAll = st.events.filter((e) => levelMatches(e.level, eventsFilter));
        return jsonResponse(res, 200, buildWaitPayload(st, { timedOut: false, matched: existingAll.slice(-5), gap, eventsFilter }));
      }

      const existing = st.events.filter((e) => e.seq > afterSeq && levelMatches(e.level, eventsFilter));
      const hasCriticalExisting = existing.some((e) => e.level === "critical");
      const pend = listPendingRequests(st.threadId);

      if (hasCriticalExisting || pend.length > 0) {
        return jsonResponse(res, 200, buildWaitPayload(st, { timedOut: false, matched: existing, gap, eventsFilter }));
      }

      if (existing.length > 0 && !st.activeTurnId) {
        return jsonResponse(res, 200, buildWaitPayload(st, { timedOut: false, matched: existing, gap, eventsFilter }));
      }

      if (!st.activeTurnId && !body.forceWait && existing.length === 0) {
        return jsonResponse(res, 200, buildWaitPayload(st, { timedOut: false, matched: [], gap, eventsFilter }));
      }

      if (res.destroyed || res.writableEnded) return;

      const payload = await new Promise((resolve) => {
        const waiter = {
          afterSeq,
          afterProvided,
          instanceMismatch,
          eventsFilter,
          resolve,
          res,
          timer: null,
          coalesceTimer: null,
          onClose: null,
        };
        waiter.onClose = () => {
          if (!res.writableEnded && cleanupWaiter(st, waiter)) {
            resolve(null);
          }
        };
        res.on("close", waiter.onClose);

        waiter.timer = setTimeout(() => resolveWaiter(st, waiter, true), timeoutSec * 1000);

        // If buffered non-critical milestone exists while turn is active, honor remaining coalesce window
        if (existing.length > 0) {
          const newestTs = existing[existing.length - 1].tsMs || Date.now();
          const remaining = Math.max(0, COALESCE_MS - (Date.now() - newestTs));
          waiter.coalesceTimer = setTimeout(() => resolveWaiter(st, waiter, false), remaining);
        }

        st.waiters.add(waiter);
      });

      if (payload && !res.writableEnded && !res.destroyed) {
        return jsonResponse(res, 200, payload);
      }
      return;
    }

    if (url.pathname === "/status" && req.method === "GET") {
      const threadId = url.searchParams.get("threadId");
      if (threadId) {
        const st = getThreadState(threadId);
        return jsonResponse(res, 200, {
          instanceId: INSTANCE_ID,
          summary: buildCompactSummary(st),
          pendingRequests: listPendingRequests(threadId),
        });
      }
      const list = Array.from(threads.values()).map((st) => buildCompactSummary(st));
      return jsonResponse(res, 200, {
        instanceId: INSTANCE_ID,
        daemonPid: process.pid,
        codexBin,
        threads: list,
        pendingRequests: listPendingRequests(),
      });
    }

    if (url.pathname === "/history" && req.method === "GET") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) return jsonResponse(res, 400, { error: "threadId required" });
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 6)));

      let rawTurns = [];
      try {
        const paged = await rpcCall("thread/turns/list", { threadId, limit, sortDirection: "desc" });
        rawTurns = (paged.data || []).slice().reverse();
      } catch {
        const data = await rpcCall("thread/read", { threadId, includeTurns: true });
        rawTurns = (data.thread?.turns || data.turns || []).slice(-limit);
      }

      const compact = rawTurns.map((t) => {
        const msgs = [];
        for (const it of t.items || []) {
          if (it.type === "userMessage") {
            const txt = (it.content || []).map((c) => c.text || "").join(" ");
            msgs.push({ role: "user", text: truncateText(txt, 500) });
          } else if (it.type === "agentMessage") {
            msgs.push({ role: "assistant", phase: it.phase || null, text: truncateText(it.text || "", 800) });
          }
        }
        return { turnId: t.id, status: t.status, messages: msgs };
      });
      return jsonResponse(res, 200, { threadId, turns: compact });
    }

    if (url.pathname === "/stop" && req.method === "POST") {
      jsonResponse(res, 200, { stopping: true, instanceId: INSTANCE_ID });
      setTimeout(() => cleanupAndExit(0), 60);
      return;
    }

    return jsonResponse(res, 404, { error: `Unknown route: ${req.method} ${url.pathname}` });
  } catch (err) {
    const code = err.statusCode || 500;
    logDaemon(`API error (${code}) on ${req.method} ${url.pathname}: ${err.stack || err.message}`);
    if (!res.writableEnded && !res.destroyed) {
      return jsonResponse(res, code, { error: err.message || String(err), ...(err.extra || {}) });
    }
  }
}

const server = http.createServer(handleApi);
// Disable Node 22's default 300s requestTimeout so 10-30 minute `/wait` long-polls never drop at 5m
server.requestTimeout = 0;
server.headersTimeout = 60_000;

function killCodexTree() {
  if (!codexProc || codexProc.killed || !codexProc.pid) return;
  try {
    if (process.platform === "win32") {
      const tk = spawnSync("taskkill", ["/T", "/F", "/PID", String(codexProc.pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 4000,
      });
      if (tk.status !== 0 && isPidAlive(codexProc.pid)) {
        try {
          codexProc.kill("SIGKILL");
        } catch {}
      }
    } else {
      codexProc.kill("SIGTERM");
    }
  } catch {
    try {
      codexProc.kill();
    } catch {}
  }
}

function cleanupAndExit(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (st.pid === process.pid) fs.unlinkSync(STATE_FILE);
    }
  } catch {}
  try {
    server.close();
  } catch {}
  // Terminate child process BEFORE releasing startup lock
  killCodexTree();
  if (ownsLock) {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const info = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        if (info.pid === process.pid) fs.unlinkSync(LOCK_FILE);
      }
    } catch {}
  }
  process.exit(code);
}

process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

if (IDLE_TIMEOUT_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    // Evict long-idle threads from memory to keep daemon footprint bounded
    for (const [tid, st] of threads.entries()) {
      const hasPending = listPendingRequests(tid).length > 0;
      if (st.status !== "running" && st.status !== "waiting_input" && st.waiters.size === 0 && !hasPending && now - st.updatedAt > IDLE_TIMEOUT_MS) {
        evictedThreadSeq.set(tid, st.nextSeq);
        if (evictedThreadSeq.size > 500) {
          const oldest = evictedThreadSeq.keys().next().value;
          evictedThreadSeq.delete(oldest);
        }
        threads.delete(tid);
      }
    }
    const busy =
      pendingServerRequests.size > 0 ||
      Array.from(threads.values()).some((t) => t.status === "running" || t.status === "waiting_input" || t.waiters.size > 0);
    if (!busy && now - lastActivityMs > IDLE_TIMEOUT_MS) {
      logDaemon("Idle timeout reached; shutting down daemon cleanly.");
      cleanupAndExit(0);
    }
  }, 60_000).unref();
}

await startCodexProcess();

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const state = {
    pid: process.pid,
    instanceId: INSTANCE_ID,
    port,
    token: authToken,
    codexBin,
    startedAt: new Date().toISOString(),
  };
  const tmpFile = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpFile, STATE_FILE);
  logDaemon(`Bridge daemon listening on http://127.0.0.1:${port} (pid=${process.pid}, instanceId=${INSTANCE_ID})`);
  console.log(JSON.stringify({ ready: true, pid: process.pid, instanceId: INSTANCE_ID, port }));
});

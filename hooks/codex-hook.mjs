#!/usr/bin/env node
/**
 * Antigravity Lifecycle Hook for Codex Supervisor (PreInvocation + Stop).
 *
 * Design invariants:
 * - Zero external dependencies, strict fail-open (always prints a single JSON
 *   object on stdout and exits 0; never blocks or breaks normal conversations).
 * - Fast path: exits immediately with `{}` (0 HTTP) when no daemon is running,
 *   daemon PID is dead (avoiding Windows loopback TCP ECONNREFUSED retry), or
 *   this conversation has no matching flag file under hooks/<instanceId>/.
 * - Least privilege: reads ONLY `hook-daemon.json` (containing `hookToken`,
 *   never the full admin control token) and calls ONLY `POST /hook/poll`.
 * - Zero prompt-injection privilege escalation: emits ONLY fixed plugin
 *   templates + validated non-negative integer counts (zero Codex free text).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";

const STATE_DIR = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), ".gemini", "cache", "codex-supervisor");
const HOOK_STATE_FILE = path.join(STATE_DIR, "hook-daemon.json");
const HOOKS_DIR = path.join(STATE_DIR, "hooks");
const MAX_STDIN_BYTES = 256 * 1024;
const MAX_HTTP_RESP_BYTES = 16 * 1024;
const HTTP_TIMEOUT_MS = 1000;
const NORMAL_STOP_REASONS = new Set(["NO_TOOL_CALL"]);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const onData = (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > MAX_STDIN_BYTES) {
        finish(null);
        return;
      }
      chunks.push(buf);
    };
    const onErr = () => finish(null);
    const onEnd = () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return finish(null);
        const parsed = JSON.parse(raw);
        finish(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
      } catch {
        finish(null);
      }
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("error", onErr);
      process.stdin.off("end", onEnd);
      try {
        process.stdin.pause();
        process.stdin.destroy();
      } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 500);
    process.stdin.on("data", onData);
    process.stdin.on("error", onErr);
    process.stdin.on("end", onEnd);
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

function readHookDaemonState() {
  try {
    if (!fs.existsSync(HOOK_STATE_FILE)) return null;
    const raw = fs.readFileSync(HOOK_STATE_FILE, "utf8");
    const st = JSON.parse(raw);
    if (!st || typeof st !== "object" || Array.isArray(st)) return null;
    if (!Number.isInteger(st.protocolVersion) || st.protocolVersion < 2) return null;
    if (!Number.isInteger(st.pid) || st.pid <= 0) return null;
    if (!Number.isInteger(st.port) || st.port <= 0 || st.port > 65535) return null;
    if (typeof st.instanceId !== "string" || !/^\d+-\d+$/.test(st.instanceId)) return null;
    if (typeof st.hookToken !== "string" || st.hookToken.length < 16) return null;
    return st;
  } catch {
    return null;
  }
}

function convFlagKey(conversationId) {
  return crypto.createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 32);
}

function postHookPoll(state, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    let settled = false;
    let req;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(val);
    };
    const deadline = setTimeout(() => {
      try {
        req?.destroy();
      } catch {}
      finish(null);
    }, HTTP_TIMEOUT_MS);

    try {
      req = http.request(
        {
          host: "127.0.0.1",
          port: state.port,
          method: "POST",
          path: "/hook/poll",
          headers: {
            Authorization: `Bearer ${state.hookToken}`,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": payload.length,
          },
        },
        (res) => {
          const chunks = [];
          let totalBytes = 0;
          res.on("data", (c) => {
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
            totalBytes += buf.length;
            if (totalBytes > MAX_HTTP_RESP_BYTES) {
              try {
                req.destroy();
              } catch {}
              finish(null);
              return;
            }
            chunks.push(buf);
          });
          res.on("aborted", () => finish(null));
          res.on("error", () => finish(null));
          res.on("close", () => {
            if (!res.complete) finish(null);
          });
          res.on("end", () => {
            if (res.statusCode !== 200) return finish(null);
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!data || typeof data !== "object" || data.instanceId !== state.instanceId) {
                return finish(null);
              }
              finish(data);
            } catch {
              finish(null);
            }
          });
        }
      );
      req.on("error", () => finish(null));
      req.write(payload);
      req.end();
    } catch {
      finish(null);
    }
  });
}

function safeCount(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function main() {
  const input = await readStdinJson();
  if (!input) return emit({});

  const hookEventName = typeof input.hookEventName === "string" ? input.hookEventName : "";
  const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
  if (!conversationId || (hookEventName !== "PreInvocation" && hookEventName !== "Stop")) {
    return emit({});
  }

  // Immediate Stop short-circuit before any disk or network I/O
  if (hookEventName === "Stop") {
    if (!NORMAL_STOP_REASONS.has(input.terminationReason) || input.continuationActive !== false) {
      return emit({});
    }
  }

  const state = readHookDaemonState();
  if (!state) return emit({});

  // Avoid Windows loopback TCP ECONNREFUSED 1-2s retry when daemon died uncleanly
  if (!isPidAlive(state.pid)) return emit({});

  const key = convFlagKey(conversationId);
  const instDir = path.join(HOOKS_DIR, state.instanceId);
  const hasUnreadFlag = fs.existsSync(path.join(instDir, `unread-${key}.flag`));
  const hasActiveFlag = hookEventName === "Stop" ? fs.existsSync(path.join(instDir, `active-${key}.flag`)) : false;

  if (hookEventName === "PreInvocation" && !hasUnreadFlag) {
    return emit({});
  }
  if (hookEventName === "Stop" && !hasUnreadFlag && !hasActiveFlag) {
    return emit({});
  }

  const resp = await postHookPoll(state, {
    conversationId,
    hookEventName,
    terminationReason: typeof input.terminationReason === "string" ? input.terminationReason : "",
    continuationActive: input.continuationActive,
    fullyIdle: input.fullyIdle === true,
  });

  if (!resp || resp.action === "none") {
    return emit({});
  }

  if (hookEventName === "PreInvocation" && resp.action === "inject") {
    const threads = safeCount(resp.threads);
    const unread = safeCount(resp.unread);
    const pending = safeCount(resp.pending);
    return emit({
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              `[Codex Supervisor] Unread Codex notifications or blocking requests are waiting for this conversation ` +
              `(threads=${threads}, unread=${unread}, pending=${pending}). ` +
              `Run \`codex-ctl.mjs inbox\` to inspect the untrusted payload as tool output.`,
          },
        },
      ],
    });
  }

  if (hookEventName === "Stop" && resp.action === "stop_continue_inbox") {
    const threads = safeCount(resp.threads);
    const unread = safeCount(resp.unread);
    const pending = safeCount(resp.pending);
    return emit({
      decision: "continue",
      reason:
        `[Codex Supervisor] Unread Codex notifications or unresolved blocking requests remain for this conversation ` +
        `(threads=${threads}, unread=${unread}, pending=${pending}). ` +
        `Run \`codex-ctl.mjs inbox\` to inspect and handle them before stopping.`,
    });
  }

  if (hookEventName === "Stop" && resp.action === "stop_continue_wait") {
    const running = safeCount(resp.running);
    return emit({
      decision: "continue",
      reason:
        `[Codex Supervisor] One or more Codex threads for this conversation are still running without an active background wait ` +
        `(running=${running}). Run \`codex-ctl.mjs status\` and arm \`codex-ctl.mjs wait\` (WaitMsBeforeAsync=500) before ending this turn.`,
    });
  }

  return emit({});
}

main().catch(() => {
  try {
    emit({});
  } catch {}
});

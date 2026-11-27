/**
 * Pure, deterministic core helpers for Codex Supervisor's Activity-Aware Stall Watchdog.
 * Zero I/O, zero external dependencies; imported by bridge-daemon.mjs and unit-tested directly.
 */

import crypto from "node:crypto";

export const MAX_WAIT_SEC = 1800;
export const DEFAULT_HTTP_TIMEOUT_SEC = 600;
export const DEFAULT_STALL_TIMEOUT_SEC = 600;
export const DEFAULT_BG_STALL_SEC = 600;
export const DEFAULT_BG_MAX_RUN_SEC = 1800;
export const MAX_BG_ENV_SEC = 86400; // 24h cap (well below Node's 32-bit setTimeout overflow)
export const MAX_ACTIVE_ITEMS = 200;
export const MAX_ACTIVE_ITEMS_RETURNED = 5;

export const ALLOWED_ACTIVE_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "collabAgentToolCall",
  "imageView",
  "imageGeneration",
  "contextCompaction",
  "agentMessage",
  "plan",
  "autoApprovalReview",
  "subAgentActivity",
]);

export function parseJsonStrictInt(raw, min, max, fieldName = "value") {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    const desc = typeof raw === "number" || typeof raw === "boolean" || raw === null ? String(raw) : typeof raw;
    const err = new Error(`Invalid integer for ${fieldName}: ${desc} (expected integer in ${min}..${max})`);
    err.statusCode = 400;
    throw err;
  }
  return raw;
}

export function parseStrictInt(raw, min, max, fieldName = "value") {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < min || raw > max) {
      const err = new Error(`Invalid integer for ${fieldName}: ${raw} (expected ${min}..${max})`);
      err.statusCode = 400;
      throw err;
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      const err = new Error(`Invalid integer for ${fieldName}: "${raw}" (expected ${min}..${max})`);
      err.statusCode = 400;
      throw err;
    }
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      const err = new Error(`Out-of-range integer for ${fieldName}: ${raw} (expected ${min}..${max})`);
      err.statusCode = 400;
      throw err;
    }
    return n;
  }
  const err = new Error(`Invalid integer for ${fieldName}: expected integer in ${min}..${max}`);
  err.statusCode = 400;
  throw err;
}

export function parseWatchdogEnvSec(raw, fallback, envName = "CODEX_BRIDGE_BG_SEC") {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return parseStrictInt(String(raw), 0, MAX_BG_ENV_SEC, envName);
}

export function parseWaitRequestParams(body) {
  const hasTimeout = Object.prototype.hasOwnProperty.call(body, "timeout") && body.timeout !== undefined;
  const timeoutSec = hasTimeout
    ? parseJsonStrictInt(body.timeout, 1, MAX_WAIT_SEC, "timeout")
    : DEFAULT_HTTP_TIMEOUT_SEC;

  const hasStall = Object.prototype.hasOwnProperty.call(body, "stallTimeout") && body.stallTimeout !== undefined;
  let stallTimeoutSec = 0;
  if (hasStall) {
    stallTimeoutSec = parseJsonStrictInt(body.stallTimeout, 0, MAX_WAIT_SEC, "stallTimeout");
    if (stallTimeoutSec > timeoutSec) {
      const err = new Error(`stallTimeout (${stallTimeoutSec}) cannot exceed timeout (${timeoutSec})`);
      err.statusCode = 400;
      throw err;
    }
  }

  const hasReceiptMode =
    Object.prototype.hasOwnProperty.call(body, "timeoutReceiptMode") && body.timeoutReceiptMode !== undefined;
  let timeoutReceiptMode = "none";
  if (hasReceiptMode) {
    if (body.timeoutReceiptMode !== "auto" && body.timeoutReceiptMode !== "manual" && body.timeoutReceiptMode !== "none") {
      const desc =
        typeof body.timeoutReceiptMode === "string"
          ? JSON.stringify(body.timeoutReceiptMode.slice(0, 40))
          : typeof body.timeoutReceiptMode;
      const err = new Error(`Invalid timeoutReceiptMode: ${desc} (expected auto|manual|none)`);
      err.statusCode = 400;
      throw err;
    }
    timeoutReceiptMode = body.timeoutReceiptMode;
  }

  return { timeoutSec, stallTimeoutSec, hasStall, timeoutReceiptMode };
}

/**
 * O(min(size, maxBytes)) bounded incremental SHA-256 digest for arbitrary JSON-like values.
 * Stops traversing once maxBytes of serialized structure have been fed (never runs unbounded JSON.stringify).
 */
export function boundedDigest(value, maxBytes = 65536) {
  const hash = crypto.createHash("sha256");
  let budget = Math.max(1, maxBytes);
  const visited = new Set();

  const feed = (str) => {
    if (budget <= 0) return false;
    const buf = Buffer.from(str, "utf8");
    if (buf.length <= budget) {
      hash.update(buf);
      budget -= buf.length;
      return true;
    }
    hash.update(buf.subarray(0, budget));
    budget = 0;
    return false;
  };

  const walk = (v, depth) => {
    if (budget <= 0) return;
    if (v === null) {
      feed("n");
      return;
    }
    const t = typeof v;
    if (t === "undefined") {
      feed("u");
      return;
    }
    if (t === "boolean") {
      feed(v ? "T" : "F");
      return;
    }
    if (t === "number") {
      feed(`#${Number.isFinite(v) ? String(v) : "NaN"};`);
      return;
    }
    if (t === "string") {
      feed(`s${v.length}:`);
      if (budget > 0) {
        // Slice char-bounded prefix before UTF-8 conversion to guarantee O(budget) work even on huge strings
        const chunk = v.length > budget ? v.slice(0, budget) : v;
        feed(chunk);
        feed(";");
      }
      return;
    }
    if (t !== "object") {
      feed(`?${t};`);
      return;
    }
    if (depth > 16) {
      feed("D;");
      return;
    }
    if (visited.has(v)) {
      feed("C;");
      return;
    }
    visited.add(v);
    try {
      if (Array.isArray(v)) {
        if (!feed(`[${v.length}:`)) return;
        for (let i = 0; i < v.length && budget > 0; i++) {
          walk(v[i], depth + 1);
          if (!feed(",")) break;
        }
        feed("]");
        return;
      }
      // Bound key enumeration itself (never call unbounded Object.keys().sort() on huge wide objects)
      const maxKeys = Math.min(256, Math.max(16, Math.floor(budget / 8)));
      const keys = [];
      let truncatedKeys = false;
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (keys.length >= maxKeys) {
          truncatedKeys = true;
          break;
        }
        keys.push(k);
      }
      keys.sort();
      if (!feed(`{${keys.length}${truncatedKeys ? "+" : ""}:`)) return;
      for (let i = 0; i < keys.length && budget > 0; i++) {
        const k = keys[i];
        if (!feed(`k${k.length}:`)) break;
        if (!feed(k.length > budget ? k.slice(0, budget) : k)) break;
        if (!feed("=")) break;
        walk(v[k], depth + 1);
        if (!feed(";")) break;
      }
      feed("}");
    } finally {
      visited.delete(v);
    }
  };

  walk(value, 0);
  return hash.digest("hex");
}

/**
 * O(edgeBytes * 2) approximate change digest for large strings (e.g. turn/diff/updated).
 * Hashes exact string length + first edgeBytes + last edgeBytes.
 */
export function boundedStringEdgeDigest(str, edgeBytes = 32768) {
  const s = typeof str === "string" ? str : "";
  const hash = crypto.createHash("sha256");
  hash.update(`len:${s.length}:`);
  if (s.length <= edgeBytes * 2) {
    hash.update(s, "utf8");
  } else {
    hash.update(s.slice(0, edgeBytes), "utf8");
    hash.update("|", "utf8");
    hash.update(s.slice(-edgeBytes), "utf8");
  }
  return hash.digest("hex");
}

/**
 * Schema-targeted O(bounded) digest for turn/plan/updated (reads ONLY schema fields, zero arbitrary key enumeration).
 */
export function digestPlanUpdate(explanation, plan) {
  const hash = crypto.createHash("sha256");
  const exp = typeof explanation === "string" ? explanation : "";
  hash.update(`exp:${exp.length}:`);
  hash.update(exp.slice(0, 4096), "utf8");
  const list = Array.isArray(plan) ? plan : [];
  const cap = Math.min(list.length, 64);
  hash.update(`|plan:${list.length}:`);
  for (let i = 0; i < cap; i++) {
    const it = list[i];
    const step = typeof it?.step === "string" ? it.step : "";
    const status = typeof it?.status === "string" ? it.status : "";
    hash.update(`${step.length}:${step.slice(0, 512)}:${status.slice(0, 64)};`, "utf8");
  }
  return hash.digest("hex");
}

/**
 * Schema-targeted O(bounded) digest for item/fileChange/patchUpdated (reads ONLY schema fields, zero arbitrary key enumeration).
 */
export function digestPatchChanges(changes) {
  const hash = crypto.createHash("sha256");
  const list = Array.isArray(changes) ? changes : [];
  const cap = Math.min(list.length, 64);
  hash.update(`changes:${list.length}:`);
  for (let i = 0; i < cap; i++) {
    const ch = list[i];
    const p = typeof ch?.path === "string"
      ? ch.path
      : typeof ch?.filePath === "string"
        ? ch.filePath
        : typeof ch?.newPath === "string"
          ? ch.newPath
          : typeof ch?.oldPath === "string"
            ? ch.oldPath
            : "";
    const k = typeof ch?.kind === "string" ? ch.kind : typeof ch?.kind?.type === "string" ? ch.kind.type : "";
    const mp =
      typeof ch?.kind?.move_path === "string"
        ? ch.kind.move_path
        : typeof ch?.kind?.movePath === "string"
          ? ch.kind.movePath
          : "";
    const diff = typeof ch?.diff === "string" ? ch.diff : "";
    hash.update(`${p.length}:${p.slice(0, 512)}|${k.slice(0, 64)}|${mp.length}:${mp.slice(0, 512)}|${diff.length}:`, "utf8");
    if (diff.length <= 1024) {
      hash.update(diff, "utf8");
    } else {
      hash.update(diff.slice(0, 512), "utf8");
      hash.update(diff.slice(-512), "utf8");
    }
    hash.update(";", "utf8");
  }
  return hash.digest("hex");
}

export function normalizeActiveItemType(rawType) {
  if (typeof rawType === "string" && ALLOWED_ACTIVE_ITEM_TYPES.has(rawType)) {
    return rawType;
  }
  return "other";
}

export function classifyNonRetryableErrorCode(errorObj) {
  const rawCode = String(errorObj?.codexErrorInfo?.type || errorObj?.codexErrorInfo || errorObj?.code || "").toLowerCase();
  const rawMsg = String(errorObj?.message || (typeof errorObj === "string" ? errorObj : "")).toLowerCase();
  const hay = `${rawCode} ${rawMsg}`;

  if (/\b429\b|rate.?limit|quota|too many requests|usage.?limit/.test(hay)) return "rate_limit";
  if (/\b401\b|\b403\b|unauthoriz|auth|forbidden|invalid.?api.?key|token.?expired/.test(hay)) return "auth";
  if (/context.?length|context.?window|token.?limit|maximum context|too long/.test(hay)) return "context_limit";
  if (/network|econn|enotfound|etimedout|socket|dns|timeout|connection|reset|tls|ssl/.test(hay)) return "network";
  if (/\b5\d\d\b|server.?error|upstream|internal.?error|overloaded|bad gateway|service unavailable/.test(hay)) {
    return "upstream_error";
  }
  return "unknown";
}

export function formatActiveItemsSummary(activeItemsMap, activeItemsOverflowed, nowMono) {
  const total = activeItemsMap ? activeItemsMap.size : 0;
  if (total === 0 && !activeItemsOverflowed) {
    return {
      activeItems: [],
      activeItemsTotal: 0,
      activeItemsTruncated: false,
      activeItemsApproximate: false,
    };
  }
  const entries = [];
  for (const item of activeItemsMap.values()) {
    const runningForSec = Math.max(0, Math.floor((nowMono - item.startedMonoMs) / 1000));
    entries.push({
      type: item.type,
      runningForSec,
      _startedMonoMs: item.startedMonoMs,
    });
  }
  entries.sort((a, b) => {
    if (b.runningForSec !== a.runningForSec) return b.runningForSec - a.runningForSec;
    return a._startedMonoMs - b._startedMonoMs;
  });
  const top = entries.slice(0, MAX_ACTIVE_ITEMS_RETURNED).map(({ type, runningForSec }) => ({
    type,
    runningForSec,
  }));
  return {
    activeItems: top,
    activeItemsTotal: total,
    activeItemsTruncated: total > MAX_ACTIVE_ITEMS_RETURNED || Boolean(activeItemsOverflowed),
    activeItemsApproximate: Boolean(activeItemsOverflowed),
  };
}

/**
 * Pure foreground `/wait` deadline calculation (strictly zero early-fire: delayMs > 0 always re-arms).
 */
export function computeForegroundDeadline({
  nowMono,
  waitStartMonoMs,
  hardDeadlineMonoMs,
  stallTimeoutSec,
  isTurnRunning,
  slotOccupied,
  turnRunningSinceMonoMs,
  lastProgressMonoMs,
  lastDeliveredAlertMonoMs,
}) {
  let stallDeadlineMonoMs = Infinity;
  if (stallTimeoutSec > 0 && isTurnRunning && !slotOccupied) {
    const sharedStallAnchor = Math.max(
      turnRunningSinceMonoMs || 0,
      lastProgressMonoMs || 0,
      lastDeliveredAlertMonoMs || 0
    );
    const effectiveAnchor = Math.max(waitStartMonoMs, sharedStallAnchor);
    stallDeadlineMonoMs = effectiveAnchor + stallTimeoutSec * 1000;
  }

  const nextDeadlineMonoMs = Math.min(hardDeadlineMonoMs, stallDeadlineMonoMs);
  const delayMs = nextDeadlineMonoMs - nowMono;
  const timeoutReason =
    stallTimeoutSec > 0 && isTurnRunning && !slotOccupied && stallDeadlineMonoMs < hardDeadlineMonoMs
      ? "stall"
      : "max_wait";

  return {
    stallDeadlineMonoMs,
    nextDeadlineMonoMs,
    delayMs,
    shouldFire: delayMs <= 0,
    timeoutReason,
  };
}

/**
 * Pure background unwaited watchdog deadline calculation.
 */
export function computeBackgroundDeadline({
  nowMono,
  bgStallSec,
  bgMaxRunSec,
  turnRunningSinceMonoMs,
  lastProgressMonoMs,
  lastDeliveredContactMonoMs,
  lastDeliveredAlertMonoMs,
  lastBgEnqueueMonoMs,
}) {
  if (bgStallSec <= 0 && bgMaxRunSec <= 0) {
    return {
      enabled: false,
      stallDeadlineMonoMs: Infinity,
      maxRunDeadlineMonoMs: Infinity,
      nextDeadlineMonoMs: Infinity,
      delayMs: Infinity,
      shouldFire: false,
      timeoutReason: null,
    };
  }

  const stallAnchor = Math.max(
    turnRunningSinceMonoMs || 0,
    lastProgressMonoMs || 0,
    lastDeliveredAlertMonoMs || 0,
    lastBgEnqueueMonoMs || 0
  );
  const maxRunAnchor = Math.max(
    turnRunningSinceMonoMs || 0,
    lastDeliveredContactMonoMs || 0,
    lastDeliveredAlertMonoMs || 0,
    lastBgEnqueueMonoMs || 0
  );

  const stallDeadlineMonoMs = bgStallSec > 0 ? stallAnchor + bgStallSec * 1000 : Infinity;
  const maxRunDeadlineMonoMs = bgMaxRunSec > 0 ? maxRunAnchor + bgMaxRunSec * 1000 : Infinity;
  const nextDeadlineMonoMs = Math.min(stallDeadlineMonoMs, maxRunDeadlineMonoMs);
  const delayMs = nextDeadlineMonoMs - nowMono;
  const timeoutReason = stallDeadlineMonoMs < maxRunDeadlineMonoMs ? "stall" : "max_wait";

  return {
    enabled: true,
    stallDeadlineMonoMs,
    maxRunDeadlineMonoMs,
    nextDeadlineMonoMs,
    delayMs,
    shouldFire: delayMs <= 0,
    timeoutReason,
  };
}

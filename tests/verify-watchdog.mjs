#!/usr/bin/env node
/**
 * Portable unit + full-transport E2E verification suite for Codex Supervisor's
 * Activity-Aware Stall Watchdog (v1.5 / plan v4.2).
 *
 * Run: `node tests/verify-watchdog.mjs`
 * Zero external dependencies, uses isolated temp STATE_DIRs and tests/fixtures/app-server.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MAX_WAIT_SEC,
  boundedDigest,
  boundedStringEdgeDigest,
  classifyNonRetryableErrorCode,
  computeBackgroundDeadline,
  computeForegroundDeadline,
  digestPatchChanges,
  digestPlanUpdate,
  formatActiveItemsSummary,
  normalizeActiveItemType,
  parseStrictInt,
  parseWaitRequestParams,
  parseWatchdogEnvSec,
} from "../skills/codex-supervisor/scripts/watchdog-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DAEMON = path.join(REPO_ROOT, "skills", "codex-supervisor", "scripts", "bridge-daemon.mjs");
const CTL = path.join(REPO_ROOT, "skills", "codex-supervisor", "scripts", "codex-ctl.mjs");
const HOOK = path.join(REPO_ROOT, "hooks", "codex-hook.mjs");
const MOCK_CWD = path.join(REPO_ROOT, "tests", "fixtures");
const NODE_BIN = process.execPath;

const testConfig = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-watchdog-config-"));
process.env.AGY_CONFIG_DIR = testConfig;
fs.mkdirSync(path.join(testConfig, "codex-supervisor"));
fs.writeFileSync(path.join(testConfig, "codex-supervisor", "settings.json"), '{"openDesktop":false}');
process.on("exit", () => cleanupDir(testConfig));

const results = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeTempStateDir(tag) {
  const dir = path.join(os.tmpdir(), `codex-wd-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function rawHttp(port, method, route, { headers = {}, body = undefined, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    let buf = null;
    if (body !== undefined) {
      buf = Buffer.from(JSON.stringify(body), "utf8");
      reqHeaders["Content-Type"] = "application/json; charset=utf-8";
      reqHeaders["Content-Length"] = String(buf.length);
    }
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, text, data });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`rawHttp timeout (${timeoutMs}ms) on ${method} ${route}`));
    }, timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("close", () => clearTimeout(timer));
    if (buf) req.write(buf);
    req.end();
  });
}

function startDaemon(stateDir, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [DAEMON], {
      cwd: MOCK_CWD,
      env: {
        ...process.env,
        CODEX_BRIDGE_STATE_DIR: stateDir,
        CODEX_BIN: NODE_BIN,
        CODEX_BRIDGE_IDLE_MS: "0",
        CODEX_BRIDGE_NUDGE_COOLDOWN_MS: "50",
        CODEX_BRIDGE_FLAG_RETRY_MS: "100",
        CODEX_BRIDGE_LEASE_MS: "30000",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error(`Daemon start timeout: out=${out} err=${err}`));
    }, 10_000);
    child.stdout.on("data", (c) => {
      out += c.toString("utf8");
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.ready) {
            clearTimeout(timer);
            const state = JSON.parse(fs.readFileSync(path.join(stateDir, "daemon.json"), "utf8"));
            const hookState = JSON.parse(fs.readFileSync(path.join(stateDir, "hook-daemon.json"), "utf8"));
            resolve({ child, ready: j, state, hookState });
          }
        } catch {}
      }
    });
    child.stderr.on("data", (c) => {
      err += c.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Daemon exited early code=${code} out=${out} err=${err}`));
    });
  });
}

async function stopDaemon(d) {
  if (!d) return;
  try {
    await rawHttp(d.state.port, "POST", "/stop", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      timeoutMs: 3000,
    });
  } catch {}
  await new Promise((resolve) => {
    if (d.child.exitCode !== null) return resolve();
    const t = setTimeout(() => {
      try {
        d.child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 2000);
    d.child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function runCtl(stateDir, args, { convId = null, extraEnv = {}, timeoutMs = 15_000 } = {}) {
  const env = {
    ...process.env,
    CODEX_BRIDGE_STATE_DIR: stateDir,
    CODEX_BIN: NODE_BIN,
    ...extraEnv,
  };
  if (convId !== null) env.ANTIGRAVITY_CONVERSATION_ID = convId;
  else delete env.ANTIGRAVITY_CONVERSATION_ID;
  const r = spawnSync(NODE_BIN, [CTL, ...args], {
    cwd: MOCK_CWD,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim());
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function runCtlAsync(stateDir, args, { convId = null, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    CODEX_BRIDGE_STATE_DIR: stateDir,
    CODEX_BIN: NODE_BIN,
    ...extraEnv,
  };
  if (convId !== null) env.ANTIGRAVITY_CONVERSATION_ID = convId;
  else delete env.ANTIGRAVITY_CONVERSATION_ID;
  const child = spawn(NODE_BIN, [CTL, ...args], {
    cwd: MOCK_CWD,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
  const promise = new Promise((resolve) => {
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {}
      resolve({ status: code, stdout, stderr, json });
    });
  });
  return { child, promise };
}

function runHook(stateDir, payload, extraEnv = {}) {
  const r = spawnSync(NODE_BIN, [HOOK], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODEX_BRIDGE_STATE_DIR: stateDir,
      ...extraEnv,
    },
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim());
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

async function runTest(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const dt = Date.now() - t0;
    results.push({ name, ok: true, dt });
    console.log(`PASS [${dt}ms] ${name}`);
  } catch (err) {
    const dt = Date.now() - t0;
    results.push({ name, ok: false, dt, err });
    console.error(`FAIL [${dt}ms] ${name}\n  ${err.stack || err.message}`);
  }
}

// =========================================================================
// PART A: PURE DETERMINISTIC SCHEDULER & CORE UNIT TESTS
// =========================================================================

await runTest("U1. Foreground deadline: zero early-fire, exact tie -> max_wait, post-ACK dedup & slot occupied", () => {
  // 1ms remaining MUST NOT fire early
  const early = computeForegroundDeadline({
    nowMono: 599_999,
    waitStartMonoMs: 0,
    hardDeadlineMonoMs: 1_800_000,
    stallTimeoutSec: 600,
    isTurnRunning: true,
    slotOccupied: false,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredAlertMonoMs: 0,
  });
  assert.equal(early.shouldFire, false);
  assert.equal(early.delayMs, 1);

  // Exact expiry -> fires stall
  const exact = computeForegroundDeadline({
    nowMono: 600_000,
    waitStartMonoMs: 0,
    hardDeadlineMonoMs: 1_800_000,
    stallTimeoutSec: 600,
    isTurnRunning: true,
    slotOccupied: false,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredAlertMonoMs: 0,
  });
  assert.equal(exact.shouldFire, true);
  assert.equal(exact.timeoutReason, "stall");

  // Exact tie (stallDeadline === hardDeadline) -> max_wait
  const tie = computeForegroundDeadline({
    nowMono: 2_000,
    waitStartMonoMs: 0,
    hardDeadlineMonoMs: 2_000,
    stallTimeoutSec: 2,
    isTurnRunning: true,
    slotOccupied: false,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredAlertMonoMs: 0,
  });
  assert.equal(tie.shouldFire, true);
  assert.equal(tie.timeoutReason, "max_wait");

  // Re-arm after stall when still silent -> anchored at waitStartMonoMs (NO 0ms spin!)
  const rearm = computeForegroundDeadline({
    nowMono: 600_050,
    waitStartMonoMs: 600_050,
    hardDeadlineMonoMs: 2_400_050,
    stallTimeoutSec: 600,
    isTurnRunning: true,
    slotOccupied: false,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredAlertMonoMs: 600_010,
  });
  assert.equal(rearm.shouldFire, false);
  assert.equal(rearm.delayMs, 600_000);

  // Waiter 2 started at t=0; Waiter 1 ACKed at t=601_000 -> Waiter 2 pushed to 1_201_000!
  const w2PostAck = computeForegroundDeadline({
    nowMono: 602_000,
    waitStartMonoMs: 0,
    hardDeadlineMonoMs: 1_800_000,
    stallTimeoutSec: 600,
    isTurnRunning: true,
    slotOccupied: false,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredAlertMonoMs: 601_000,
  });
  assert.equal(w2PostAck.shouldFire, false);
  assert.equal(w2PostAck.stallDeadlineMonoMs, 1_201_000);

  // Slot occupied -> stallDeadline = Infinity, waits for hardDeadline -> max_wait
  const occ = computeForegroundDeadline({
    nowMono: 700_000,
    waitStartMonoMs: 0,
    hardDeadlineMonoMs: 1_800_000,
    stallTimeoutSec: 600,
    isTurnRunning: true,
    slotOccupied: true,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredAlertMonoMs: 0,
  });
  assert.equal(occ.shouldFire, false);
  assert.equal(occ.stallDeadlineMonoMs, Infinity);
  assert.equal(occ.nextDeadlineMonoMs, 1_800_000);
  assert.equal(occ.timeoutReason, "max_wait");

  // --force idle (isTurnRunning: false) -> NEVER stall, only hardDeadline
  const idleForce = computeForegroundDeadline({
    nowMono: 650_000,
    waitStartMonoMs: 0,
    hardDeadlineMonoMs: 1_800_000,
    stallTimeoutSec: 600,
    isTurnRunning: false,
    slotOccupied: false,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredAlertMonoMs: 0,
  });
  assert.equal(idleForce.shouldFire, false);
  assert.equal(idleForce.stallDeadlineMonoMs, Infinity);
  assert.equal(idleForce.timeoutReason, "max_wait");
});

await runTest("U2. Background deadline, env caps, param validation, boundedDigest & sanitization", () => {
  // Both disabled
  const off = computeBackgroundDeadline({
    nowMono: 10_000,
    bgStallSec: 0,
    bgMaxRunSec: 0,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 0,
    lastDeliveredContactMonoMs: 0,
    lastDeliveredAlertMonoMs: 0,
    lastBgEnqueueMonoMs: 0,
  });
  assert.equal(off.enabled, false);

  // Only maxRun enabled
  const maxOnly = computeBackgroundDeadline({
    nowMono: 1_800_000,
    bgStallSec: 0,
    bgMaxRunSec: 1800,
    turnRunningSinceMonoMs: 0,
    lastProgressMonoMs: 1_799_000,
    lastDeliveredContactMonoMs: 0,
    lastDeliveredAlertMonoMs: 0,
    lastBgEnqueueMonoMs: 0,
  });
  assert.equal(maxOnly.shouldFire, true);
  assert.equal(maxOnly.timeoutReason, "max_wait");

  // Env validation caps at 86400
  assert.equal(parseWatchdogEnvSec("0", 600), 0);
  assert.equal(parseWatchdogEnvSec("86400", 600), 86400);
  assert.throws(() => parseWatchdogEnvSec("86401", 600));
  assert.throws(() => parseWatchdogEnvSec("-1", 600));
  assert.throws(() => parseWatchdogEnvSec("abc", 600));
  assert.throws(() => parseStrictInt(NaN, 1, 1800));
  assert.throws(() => parseWaitRequestParams({ timeout: 10, stallTimeout: 20 }));
  assert.throws(() => parseWaitRequestParams({ timeout: "notanumber" }));
  assert.throws(() => parseWaitRequestParams({ timeout: 10, timeoutReceiptMode: "weird" }));
  assert.deepEqual(parseWaitRequestParams({}), {
    timeoutSec: 600,
    stallTimeoutSec: 0,
    hasStall: false,
    timeoutReceiptMode: "none",
  });
  assert.equal(MAX_WAIT_SEC, 1800);

  // Schema-targeted digests ignore arbitrary wide extra keys in O(1) time and detect real changes
  const wideExtra = { step: "build", status: "inProgress" };
  for (let i = 0; i < 50_000; i++) wideExtra[`extra_${i}`] = i;
  const tPlan = Date.now();
  const p1 = digestPlanUpdate("exp1", [wideExtra]);
  const p2 = digestPlanUpdate("exp1", [{ step: "build", status: "inProgress" }]);
  const p3 = digestPlanUpdate("exp1", [{ step: "test", status: "inProgress" }]);
  assert.equal(p1, p2, "digestPlanUpdate must read ONLY schema fields");
  assert.notEqual(p1, p3);
  assert.ok(Date.now() - tPlan < 50, "Schema-targeted digestPlanUpdate must be O(1) on wide objects");
  const c1 = digestPatchChanges([{ path: "a.js", kind: { type: "update", move_path: "b.js" }, diff: "+1", ...wideExtra }]);
  const c2 = digestPatchChanges([{ path: "a.js", kind: { type: "update", move_path: "c.js" }, diff: "+1" }]);
  assert.notEqual(c1, c2, "digestPatchChanges must detect kind.move_path rename target changes");
  // Bounded digest & non-coercing JSON integer validation
  const big1 = { a: "x".repeat(200_000), b: 1 };
  const big2 = { a: "y".repeat(200_000), b: 1 };
  assert.notEqual(boundedDigest(big1, 4096), boundedDigest(big2, 4096));
  assert.equal(boundedDigest(big1, 4096), boundedDigest({ a: "x".repeat(200_000), b: 1 }, 4096));
  assert.throws(() => parseWaitRequestParams({ timeout: "1" }));
  assert.throws(() => parseWaitRequestParams({ timeout: " 2 " }));
  assert.throws(() => parseWaitRequestParams({ timeout: 5, stallTimeout: "1" }));
  assert.throws(() => parseWaitRequestParams({ timeout: 5, timeoutReceiptMode: Object.create(null) }));
  assert.notEqual(boundedStringEdgeDigest("abc", 8), boundedStringEdgeDigest("abd", 8));

  // Enum normalization & error sanitization
  assert.equal(normalizeActiveItemType("commandExecution"), "commandExecution");
  assert.equal(normalizeActiveItemType("evil_secret_type"), "other");
  assert.equal(classifyNonRetryableErrorCode({ message: "HTTP 429 Bearer SECRET_XYZ" }), "rate_limit");
  assert.equal(classifyNonRetryableErrorCode({ message: "401 unauthorized token=abc" }), "auth");
  assert.equal(classifyNonRetryableErrorCode({ message: "context length exceeded" }), "context_limit");
  assert.equal(classifyNonRetryableErrorCode({ message: "ECONNRESET socket hangup" }), "network");
  assert.equal(classifyNonRetryableErrorCode({ message: "503 service unavailable" }), "upstream_error");

  // activeItems formatting: top-5 longest, overflow sets approximate + truncated
  const m = new Map();
  for (let i = 1; i <= 7; i++) {
    m.set(`id-${i}`, { type: "commandExecution", startedMonoMs: 10_000 - i * 1000 });
  }
  const sum = formatActiveItemsSummary(m, true, 20_000);
  assert.equal(sum.activeItems.length, 5);
  assert.equal(sum.activeItems[0].runningForSec, 17);
  assert.equal(sum.activeItemsTotal, 7);
  assert.equal(sum.activeItemsTruncated, true);
  assert.equal(sum.activeItemsApproximate, true);
  assert.deepEqual(Object.keys(sum.activeItems[0]).sort(), ["runningForSec", "type"]);
});

// =========================================================================
// PART B: FULL-TRANSPORT E2E SCENARIOS
// =========================================================================

await runTest("E1. Active streaming deltas suppress stallTimeout until turn_completed; livelock hits max_wait", async () => {
  const dir = makeTempStateDir("e1");
  let d;
  try {
    d = await startDaemon(dir, { CODEX_BRIDGE_BG_STALL_SEC: "0", CODEX_BRIDGE_BG_MAX_RUN_SEC: "0" });
    // Active stream: deltas every 300ms for 6 ticks (~1.8s) with stallTimeout=1s, timeout=8s -> must NOT stall!
    const s1 = runCtl(dir, ["start", "--prompt", "stream_active:300:6:100"], { convId: "conv-e1" });
    assert.equal(s1.status, 0);
    const w1 = runCtl(dir, ["wait", s1.json.threadId, "--after", s1.json.cursor, "--timeout", "8", "--stall-timeout", "1"], { convId: "conv-e1" });
    assert.equal(w1.status, 0);
    assert.equal(w1.json.wakeup, "turn_completed");

    // Livelock: continuous deltas every 200ms with stallTimeout=1s, timeout=2s -> hits max_wait!
    const s2 = runCtl(dir, ["start", "--prompt", "livelock_deltas:200:4000"], { convId: "conv-e1" });
    assert.equal(s2.status, 0);
    const w2 = runCtl(dir, ["wait", s2.json.threadId, "--after", s2.json.cursor, "--timeout", "2", "--stall-timeout", "1"], { convId: "conv-e1" });
    assert.equal(w2.status, 0);
    assert.equal(w2.json.wakeup, "timeout");
    assert.equal(w2.json.timeoutReason, "max_wait");
    assert.equal(w2.json.status, "running");
    assert.ok(w2.json.waitElapsedSec >= 2);
  } finally {
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E2. Silence -> stall with sanitized activeItems, passive noise excluded, error(willRetry:false) enum & 21-item active tracking", async () => {
  const dir = makeTempStateDir("e2");
  let d;
  try {
    d = await startDaemon(dir, { CODEX_BRIDGE_BG_STALL_SEC: "0", CODEX_BRIDGE_BG_MAX_RUN_SEC: "0" });

    // 2a: silent item with secrets -> sanitized activeItems (no command/server/tool strings!)
    const s1 = runCtl(dir, ["start", "--prompt", "silent_item:mcpToolCall"], { convId: "conv-e2" });
    const w1 = runCtl(dir, ["wait", s1.json.threadId, "--after", s1.json.cursor, "--timeout", "6", "--stall-timeout", "1"], { convId: "conv-e2" });
    assert.equal(w1.json.wakeup, "timeout");
    assert.equal(w1.json.timeoutReason, "stall");
    assert.ok(w1.json.silentSec >= 1);
    assert.equal(w1.json.activeItemsTotal, 1);
    assert.equal(w1.json.activeItems[0].type, "mcpToolCall");
    assert.deepEqual(Object.keys(w1.json.activeItems[0]).sort(), ["runningForSec", "type"]);
    assert.ok(!w1.stdout.includes("SECRET_TOKEN_12345"));
    assert.ok(!w1.stdout.includes("secret-mcp-server"));
    assert.ok(!w1.stdout.includes("secret_tool_name"));

    // 2b: immediate re-arm after stall MUST wait another full 1s (no 0ms spin) and report cumulative silentSec >= 2
    const t0 = Date.now();
    const w1b = runCtl(dir, ["wait", s1.json.threadId, "--after", w1.json.nextCursor, "--timeout", "6", "--stall-timeout", "1"], { convId: "conv-e2" });
    const dt = Date.now() - t0;
    assert.ok(dt >= 900, `Expected full stall re-wait >=900ms, got ${dt}ms`);
    assert.equal(w1b.json.timeoutReason, "stall");
    assert.ok(w1b.json.silentSec >= 2);

    // 2c: excluded passive noise must NOT prevent stall
    const s2 = runCtl(dir, ["start", "--prompt", "passive_noise:200:12"], { convId: "conv-e2" });
    const w2 = runCtl(dir, ["wait", s2.json.threadId, "--after", s2.json.cursor, "--timeout", "6", "--stall-timeout", "1"], { convId: "conv-e2" });
    assert.equal(w2.json.wakeup, "timeout");
    assert.equal(w2.json.timeoutReason, "stall");

    // 2d: error(willRetry:false) attaches sanitized enum code on stall AND max_wait (zero secret leakage!)
    const s3 = runCtl(dir, ["start", "--prompt", "non_retryable_error"], { convId: "conv-e2" });
    const w3 = runCtl(dir, ["wait", s3.json.threadId, "--after", s3.json.cursor, "--timeout", "6", "--stall-timeout", "1"], { convId: "conv-e2" });
    assert.equal(w3.json.timeoutReason, "stall");
    assert.equal(w3.json.lastNonRetryableError?.code, "rate_limit");
    assert.ok(!w3.stdout.includes("TOP_SECRET_KEY_999"));
    assert.ok(!w3.stdout.includes("C:\\secret\\path"));

    // 2e: 21 items started, first 20 finished -> item #21 (mcpToolCall) still visible, out-of-order & message_supervisor cleaned up
    const s4 = runCtl(dir, ["start", "--prompt", "items_21_drop_first_20"], { convId: "conv-e2" });
    await sleep(100);
    const st4 = runCtl(dir, ["status", s4.json.threadId], { convId: "conv-e2" });
    assert.equal(st4.json.summary.activeItemsTotal, 1);
    assert.equal(st4.json.summary.activeItems.length, 1);
    assert.equal(st4.json.summary.activeItems[0].type, "mcpToolCall");
    assert.equal(st4.json.summary.activeItemsTruncated, undefined);
  } finally {
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E3. P0-1/P0-2: EPIPE handoff (FG 1s -> BG 600s immediate), BG_STALL=0 disable, --timeout 1 --stall-timeout 0 no premature BG max_wait", async () => {
  const dir = makeTempStateDir("e3");
  let d;
  try {
    // 3a: FG stall=1s, BG stall=600s, FG receipt lease=350ms -> simulate CLI stdout EPIPE -> BG immediately enqueues to inbox!
    d = await startDaemon(dir, {
      CODEX_BRIDGE_BG_STALL_SEC: "600",
      CODEX_BRIDGE_BG_MAX_RUN_SEC: "600",
      CODEX_BRIDGE_FG_AUTO_RECEIPT_MS: "350",
    });
    const s1 = runCtl(dir, ["start", "--prompt", "silent_item:commandExecution"], { convId: "conv-e3" });

    // Raw HTTP call with timeoutReceiptMode="auto" that NEVER sends ACK (simulates HTTP finish + CLI stdout EPIPE!)
    const fgRes = await rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e3",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s1.json.threadId,
        after: s1.json.cursor,
        timeout: 10,
        stallTimeout: 1,
      },
    });
    assert.equal(fgRes.status, 200);
    assert.equal(fgRes.data.wakeup, "timeout");
    assert.equal(fgRes.data.timeoutReason, "stall");
    assert.ok(fgRes.data.ackBatchId, "Owner FG stall must issue ackBatchId");

    // Wait for 350ms receipt lease to expire (no ACK sent!) -> saved stall alert immediately handed off to inbox!
    await sleep(500);
    const inbox1 = runCtl(dir, ["inbox"], { convId: "conv-e3" });
    assert.equal(inbox1.json.items.length, 1);
    assert.equal(inbox1.json.items[0].kind, "turn_watchdog");
    assert.equal(inbox1.json.items[0].timeoutReason, "stall");
    assert.equal(inbox1.json.items[0].turnId, s1.json.turnId);
    assert.ok(inbox1.json.threadsMeta[s1.json.threadId].silentSec >= 1);

    // Late ACK on the already-expired FG receipt MUST NOT fail or disturb anything
    const lateAck = await rawHttp(d.state.port, "POST", "/inbox/ack", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: { batchId: fgRes.data.ackBatchId, conversationId: "conv-e3" },
    });
    assert.equal(lateAck.status, 200);
    assert.equal(lateAck.data.expired, true);
    assert.equal(lateAck.data.applied, 0);

    // 3b: Condition 2: short `--timeout 1 --stall-timeout 0` unacked -> MUST NOT prematurely push BG max_wait (BG_MAX_RUN_SEC=600)
    const s2 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e3b" });
    const fgMax = await rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e3b",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s2.json.threadId,
        after: s2.json.cursor,
        timeout: 1,
        stallTimeout: 0,
      },
    });
    assert.equal(fgMax.data.timeoutReason, "max_wait");
    await sleep(500);
    const inbox2 = runCtl(dir, ["inbox"], { convId: "conv-e3b" });
    assert.equal(inbox2.json.items.length, 0, "Short FG max_wait must NOT prematurely trigger 600s BG max_wait");

    // 3c: --no-ack uses manual receipt mode (30s) and explicit manual `inbox ack` confirms cleanly without BG duplicate!
    const s3 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e3c" });
    const wNoAck = runCtl(dir, ["wait", s3.json.threadId, "--after", s3.json.cursor, "--timeout", "10", "--stall-timeout", "1", "--no-ack"], { convId: "conv-e3c" });
    assert.equal(wNoAck.json.timeoutReason, "stall");
    assert.ok(wNoAck.json.ackBatchId);
    await sleep(500); // > 350ms auto lease, still within 30s manual lease!
    const inboxBeforeManualAck = runCtl(dir, ["inbox"], { convId: "conv-e3c" });
    assert.equal(inboxBeforeManualAck.json.items.length, 0, "Manual 30s lease must not expire at 350ms");
    const manualAck = runCtl(dir, ["inbox", "ack", wNoAck.json.ackBatchId], { convId: "conv-e3c" });
    assert.equal(manualAck.json.expired, false);
    assert.equal(manualAck.json.applied, 1);

    await stopDaemon(d);
    d = null;

    // 3d: BG_STALL_SEC=0 respects explicit disable on FG EPIPE handoff
    d = await startDaemon(dir, {
      CODEX_BRIDGE_BG_STALL_SEC: "0",
      CODEX_BRIDGE_BG_MAX_RUN_SEC: "0",
      CODEX_BRIDGE_FG_AUTO_RECEIPT_MS: "250",
    });
    const s4 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e3d" });
    await rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e3d",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s4.json.threadId,
        after: s4.json.cursor,
        timeout: 10,
        stallTimeout: 1,
      },
    });
    await sleep(400);
    const inbox4 = runCtl(dir, ["inbox"], { convId: "conv-e3d" });
    assert.equal(inbox4.json.items.length, 0, "BG_STALL_SEC=0 must suppress handoff to inbox");
  } finally {
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E4. P0-1/Condition 1: Multi-waiter slot contention (W2 max_wait never clobbers W1), post-ACK dedup & slot-release reschedule", async () => {
  const dir = makeTempStateDir("e4");
  let d;
  try {
    d = await startDaemon(dir, {
      CODEX_BRIDGE_BG_STALL_SEC: "0",
      CODEX_BRIDGE_BG_MAX_RUN_SEC: "0",
      CODEX_BRIDGE_FG_AUTO_RECEIPT_MS: "1200",
    });

    // 4a: W1 claims stall slot (no ACK yet), W2 hits hardDeadline=2s -> W2 gets plain max_wait (NO ackBatchId), W1 ACK still succeeds!
    const s1 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e4a" });
    const w1P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e4a",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s1.json.threadId,
        after: s1.json.cursor,
        timeout: 10,
        stallTimeout: 1,
      },
    });
    const w2P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e4a",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s1.json.threadId,
        after: s1.json.cursor,
        timeout: 2,
        stallTimeout: 1,
      },
    });
    const w1 = await w1P;
    assert.equal(w1.data.timeoutReason, "stall");
    assert.ok(w1.data.ackBatchId);
    // Keep W1 unacked for ~200ms while W2 still waits for hardDeadline (2s), wait actually W1 receipt is 1200ms so W2 at 2s will be after 1200ms!
    // Let's test Condition 1 right here: at t=1.0s W1 fires & holds slot until t=2.2s; at t=2.0s W2 hits hardDeadline while W1 STILL holds slot!
    const w2 = await w2P;
    assert.equal(w2.data.timeoutReason, "max_wait");
    assert.equal(w2.data.ackBatchId, undefined, "W2 must NOT claim receipt slot while W1 holds pendingFgDelivery");
    // Now ACK W1 (at ~t=2.0s, still within 1200ms lease from t=1.0s!)
    const ack1 = await rawHttp(d.state.port, "POST", "/inbox/ack", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: { batchId: w1.data.ackBatchId, conversationId: "conv-e4a" },
    });
    assert.equal(ack1.data.expired, false);
    assert.equal(ack1.data.applied, 1);

    // 4b: Post-ACK dedup: W1 fires stall at 1s and ACKs -> W2 (stall=1s, timeout=6s) pushed back by full 1s (fires at ~2s, not ~1.05s!)
    const s2 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e4b" });
    const tStart = Date.now();
    const a1 = runCtlAsync(dir, ["wait", s2.json.threadId, "--after", s2.json.cursor, "--timeout", "6", "--stall-timeout", "1"], { convId: "conv-e4b" });
    const a2 = runCtlAsync(dir, ["wait", s2.json.threadId, "--after", s2.json.cursor, "--timeout", "6", "--stall-timeout", "1"], { convId: "conv-e4b" });
    const [r1, r2] = await Promise.all([
      a1.promise.then((r) => ({ r, t: Date.now() - tStart })),
      a2.promise.then((r) => ({ r, t: Date.now() - tStart })),
    ]);
    const sorted = [r1, r2].sort((x, y) => x.t - y.t);
    assert.equal(sorted[0].r.json.timeoutReason, "stall");
    assert.equal(sorted[1].r.json.timeoutReason, "stall");
    assert.ok(sorted[1].t - sorted[0].t >= 850, `Expected W2 pushed back >=850ms after W1 ACK, got gap=${sorted[1].t - sorted[0].t}ms`);

    // 4c: Condition 1 — slot release on receipt expiry (with BG_STALL=0) immediately reschedules deferred W2!
    const s3 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e4c" });
    const t3 = Date.now();
    const f1P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e4c",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s3.json.threadId,
        after: s3.json.cursor,
        timeout: 15,
        stallTimeout: 1,
      },
    });
    const f2P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e4c",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s3.json.threadId,
        after: s3.json.cursor,
        timeout: 15,
        stallTimeout: 1,
      },
    });
    await f1P; // expires at ~1s, receipt expires at ~2.2s (unacked, BG_STALL=0) -> frees slot -> W2 MUST fire right around ~2.2s, NOT wait until 15s!
    const f2 = await f2P;
    const elapsed2 = Date.now() - t3;
    assert.equal(f2.data.timeoutReason, "stall");
    assert.ok(elapsed2 < 4500, `W2 should reschedule on slot expiry (~2.2s), not wait until 15s (got ${elapsed2}ms)`);
  } finally {
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E5. P0-3: Full-terminal queue self-eviction leaves NO dangling activeBgNotifId & NO 0ms storm", async () => {
  const dir = makeTempStateDir("e5");
  let d;
  try {
    d = await startDaemon(dir, { CODEX_BRIDGE_BG_STALL_SEC: "1", CODEX_BRIDGE_BG_MAX_RUN_SEC: "0" });
    const s = runCtl(dir, ["start", "--prompt", "emit_50_terminals_then_silent"], { convId: "conv-e5" });
    assert.equal(s.status, 0);
    await sleep(1400);
    const st1 = runCtl(dir, ["status", s.json.threadId], { convId: "conv-e5" });
    // Queue had 50 terminals -> watchdog self-evicted -> unreportedOverflowCount === 1 (NOT 100 from 0ms storm!)
    assert.ok(st1.json.summary.unreportedOverflowCount >= 1 && st1.json.summary.unreportedOverflowCount <= 2,
      `Expected 1-2 overflow from self-eviction (no 0ms storm), got ${st1.json.summary.unreportedOverflowCount}`);
    // Wait another 1.2s -> because activeBgNotifId was NOT left dangling, next cycle runs cleanly and increments overflow by 1
    await sleep(1200);
    const st2 = runCtl(dir, ["status", s.json.threadId], { convId: "conv-e5" });
    assert.ok(st2.json.summary.unreportedOverflowCount > st1.json.summary.unreportedOverflowCount,
      "Watchdog must remain scheduled after self-eviction (no dangling activeBgNotifId)");
  } finally {
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E6. P0-4: Turn isolation, pending retirement with exact 0.169.1 cancel payloads, startup interleaving & non-blocking requestUserInput", async () => {
  const dir = makeTempStateDir("e6");
  const repliesLog = path.join(dir, "mock-replies.jsonl");
  let d;
  try {
    d = await startDaemon(dir, {
      CODEX_BRIDGE_BG_STALL_SEC: "0",
      CODEX_BRIDGE_BG_MAX_RUN_SEC: "0",
      MOCK_REPLIES_LOG: repliesLog,
    });

    // 6a: Turn A has pending permissions approval, Turn B supersedes A -> A's pending retired with {permissions:{}, scope:"turn"} & doesn't hijack B!
    const s1 = runCtl(dir, ["start", "--prompt", "approval_no_complete:permissions"], { convId: "conv-e6" });
    await sleep(80);
    const s1b = runCtl(dir, ["send", s1.json.threadId, "--prompt", "complete_after:80:turn_b_ok"], { convId: "conv-e6" });
    const w1b = runCtl(dir, ["wait", s1.json.threadId, "--after", s1b.json.cursor, "--timeout", "5"], { convId: "conv-e6" });
    assert.equal(w1b.json.wakeup, "turn_completed");
    assert.equal(w1b.json.message, "turn_b_ok");

    // 6b: Legacy execCommandApproval retired with { decision: "abort" }
    const s2 = runCtl(dir, ["start", "--prompt", "approval_no_complete:legacy_exec"], { convId: "conv-e6" });
    await sleep(80);
    runCtl(dir, ["send", s2.json.threadId, "--prompt", "complete_after:50:after_legacy"], { convId: "conv-e6" });
    await sleep(120);

    // 6c: Late notifications & stale approval from previous turn do NOT disturb current turn!
    const s3 = runCtl(dir, ["start", "--prompt", "complete_after:30:first_turn"], { convId: "conv-e6" });
    await sleep(80);
    const s3b = runCtl(dir, ["send", s3.json.threadId, "--prompt", "late_from_prev_turn"], { convId: "conv-e6" });
    const w3b = runCtl(dir, ["wait", s3.json.threadId, "--after", s3b.json.cursor, "--timeout", "5", "--stall-timeout", "1"], { convId: "conv-e6" });
    assert.equal(w3b.json.wakeup, "timeout");
    assert.equal(w3b.json.timeoutReason, "stall");
    assert.equal(w3b.json.activeTurnId, s3b.json.turnId);

    // 6d: Missing turnId v2 request rejected with -32602
    const s4 = runCtl(dir, ["start", "--prompt", "approval_no_complete:missing_turnid_v2"], { convId: "conv-e6" });
    await sleep(80);
    const st4 = runCtl(dir, ["status", s4.json.threadId], { convId: "conv-e6" });
    assert.equal(st4.json.pendingRequests.length, 0);

    // 6e: Startup interleaving: serverRequest arrives BEFORE turn/start RPC result & turn/started
    const s5 = runCtl(dir, ["start", "--prompt", "server_req_before_turn_started"], { convId: "conv-e6" });
    await sleep(100);
    const st5 = runCtl(dir, ["status", s5.json.threadId], { convId: "conv-e6" });
    assert.equal(st5.json.summary.status, "waiting_input");
    assert.equal(st5.json.pendingRequests.length, 1);

    // 6f: RPC before turn/started notification preserves turn_started event (no duplicate wipe)
    const s6 = runCtl(dir, ["start", "--prompt", "rpc_before_turn_started_notif"], { convId: "conv-e6" });
    await sleep(100);
    const w6 = runCtl(dir, ["wait", s6.json.threadId, "--after", s6.json.cursor, "--events", "all", "--timeout", "2"], { convId: "conv-e6" });
    assert.ok(w6.json.events?.some((e) => e.kind === "turn_started"), "turn_started event must be preserved when RPC returns first");

    // 6g: Non-blocking requestUserInput (isBlocking: false) does NOT pause watchdog!
    const s7 = runCtl(dir, ["start", "--prompt", "non_blocking_user_input"], { convId: "conv-e6" });
    await sleep(80);
    const st7 = runCtl(dir, ["status", s7.json.threadId], { convId: "conv-e6" });
    assert.equal(st7.json.summary.status, "running", "Non-blocking requestUserInput must keep thread status=running");

    // Verify exact protocol cancel replies logged by mock app-server
    const replies = fs.readFileSync(repliesLog, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(replies.some((r) => r.result?.permissions && r.result?.scope === "turn"), "Permissions cancel must send {permissions:{}, scope:'turn'}");
    assert.ok(replies.some((r) => r.result?.decision === "abort"), "Legacy exec cancel must send {decision:'abort'}");
    assert.ok(replies.some((r) => r.result?.decision === "cancel"), "Stale v2 approval must send {decision:'cancel'}");
    assert.ok(replies.some((r) => r.error?.code === -32602), "Missing turnId v2 request must reply -32602");
    // Verify single-reply authority: NO rpcId received more than one reply!
    const idCounts = new Map();
    for (const r of replies) idCounts.set(r.id, (idCounts.get(r.id) || 0) + 1);
    for (const [rpcId, cnt] of idCounts.entries()) {
      assert.equal(cnt, 1, `Duplicate JSON-RPC reply detected for rpcId=${rpcId} (count=${cnt})`);
    }
  } finally {
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E7. Unwaited Hook mode: BG stall/max_run -> PreInvocation/Stop -> inboxOnly unmasked by /wait, turn-end retires leased watchdog, late Turn A ACK isolated", async () => {
  const dir = makeTempStateDir("e7");
  let d;
  try {
    d = await startDaemon(dir, {
      CODEX_BRIDGE_BG_STALL_SEC: "1",
      CODEX_BRIDGE_BG_MAX_RUN_SEC: "3",
      CODEX_BRIDGE_LEASE_MS: "900",
    });

    // 7a: Unwaited silent thread triggers BG turn_watchdog(stall) -> PreInvocation & Stop see it
    const s1 = runCtl(dir, ["start", "--prompt", "silent_item:commandExecution"], { convId: "conv-e7" });
    await sleep(1250);
    const pre1 = runHook(dir, { hookEventName: "PreInvocation", conversationId: "conv-e7" });
    assert.ok(pre1.json.injectSteps?.[0]?.systemMessage?.systemMessage?.includes("[Codex Supervisor]"));
    const stop1 = runHook(dir, {
      hookEventName: "Stop",
      conversationId: "conv-e7",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false,
      fullyIdle: true,
    });
    assert.equal(stop1.json.decision, "continue");

    // 7b: Owner now attaches /wait WHILE turn_watchdog is still in inbox -> /hook/poll MUST NOT mask inboxOnly alert, and /wait MUST NOT fire duplicate stall!
    const fgWait = runCtlAsync(dir, ["wait", s1.json.threadId, "--after", s1.json.cursor, "--timeout", "2", "--stall-timeout", "1"], { convId: "conv-e7" });
    await sleep(150);
    const stopWhileWaiting = runHook(dir, {
      hookEventName: "Stop",
      conversationId: "conv-e7",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false,
      fullyIdle: false,
    });
    assert.equal(stopWhileWaiting.json.decision, "continue", "inboxOnly turn_watchdog must NOT be masked by owner /wait");

    const fgRes = await fgWait.promise;
    assert.equal(fgRes.json.timeoutReason, "max_wait", "With activeBgNotifId present, FG wait must NOT emit second stall (only max_wait at hard cap)");

    // Read inbox with --no-ack (leases turn_watchdog for 500ms), then end turn via interrupt -> leased watchdog marked retired!
    const inbNoAck = runCtl(dir, ["inbox", "--no-ack"], { convId: "conv-e7" });
    assert.equal(inbNoAck.json.items.length, 1);
    assert.equal(inbNoAck.json.items[0].kind, "turn_watchdog");
    const staleBatchId = inbNoAck.json.batchId;

    runCtl(dir, ["interrupt", s1.json.threadId], { convId: "conv-e7" });
    await sleep(120);
    // Drain the turn_interrupted terminal notification
    runCtl(dir, ["inbox"], { convId: "conv-e7" });
    // Wait for 900ms lease on retired turn_watchdog to expire -> MUST be deleted, NOT reopened!
    await sleep(1050);
    const inbAfterRetire = runCtl(dir, ["inbox"], { convId: "conv-e7" });
    assert.equal(inbAfterRetire.json.items.length, 0, "Retired leased turn_watchdog must be deleted on lease expiry, not reopened");
    // Now cross-owner resume --claim MUST succeed cleanly (not blocked by retired watchdog)!
    const claim = runCtl(dir, ["resume", s1.json.threadId, "--claim"], { convId: "conv-e7-new" });
    assert.equal(claim.status, 0);
    assert.equal(claim.json.ownerConversationId, "conv-e7-new");

    // 7c: Unwaited livelock -> BG max_run (3s) fires turn_watchdog(max_wait), and /steer resets contact clock!
    const s2 = runCtl(dir, ["start", "--prompt", "livelock_deltas:250:5500"], { convId: "conv-e7-live" });
    await sleep(1500);
    // /steer at t=1.5s resets lastDeliveredContactMonoMs -> should NOT fire max_wait at t=3.0s!
    const stRes = runCtl(dir, ["steer", s2.json.threadId, "--prompt", "keep going"], { convId: "conv-e7-live" });
    assert.equal(stRes.status, 0);
    await sleep(1700); // t=3.2s total, only 1.7s since steer (< 3s)
    const inbBefore = runCtl(dir, ["inbox"], { convId: "conv-e7-live" });
    assert.equal(inbBefore.json.items.length, 0, "/steer must reset BG max_run clock");
    await sleep(1600); // t=4.8s total, ~3.3s since steer (>= 3s)
    const inbAfter = runCtl(dir, ["inbox"], { convId: "conv-e7-live" });
    assert.equal(inbAfter.json.items.length, 1);
    assert.equal(inbAfter.json.items[0].kind, "turn_watchdog");
    assert.equal(inbAfter.json.items[0].timeoutReason, "max_wait");

    // 7d: Turn A late ACK after Turn B starts deletes Turn A's leased watchdog cleanly WITHOUT delaying Turn B's 1s stall!
    const s3 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e7-ab" });
    await sleep(1200);
    const inbA = await rawHttp(d.state.port, "POST", "/inbox", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: { conversationId: "conv-e7-ab" },
    });
    assert.equal(inbA.data.items.length, 1);
    const batchA = inbA.data.batchId;
    // Start Turn B right away via fast rawHttp, wait 300ms (well within 900ms lease), then send late ACK for Turn A!
    const s3b = await rawHttp(d.state.port, "POST", "/send", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: { ownerConversationId: "conv-e7-ab", threadId: s3.json.threadId, prompt: "stay_running" },
    });
    await sleep(300);
    const lateAckA = await rawHttp(d.state.port, "POST", "/inbox/ack", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: { batchId: batchA, conversationId: "conv-e7-ab" },
    });
    assert.equal(lateAckA.data.applied, 1);
    // Turn B started at t=0, late ACK arrived at t=300ms -> Turn B's 1s stall MUST still fire by t=1150ms (NOT delayed to 1300ms+)!
    await sleep(850);
    const inbB = await rawHttp(d.state.port, "POST", "/inbox", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: { conversationId: "conv-e7-ab" },
    });
    assert.equal(inbB.data.items.length, 1);
    assert.equal(inbB.data.items[0].kind, "turn_watchdog");
    assert.equal(inbB.data.items[0].turnId, s3b.data.turnId);

    // Unused staleBatchId safety check
    assert.ok(staleBatchId);
  } finally {
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E8. --force idle->running reschedule, coalesce beats timeout, serverRequest/resolved no-contact & mixed-version matrix + HTTP 400", async () => {
  const dir = makeTempStateDir("e8");
  let d;
  let mockLegacyServer;
  try {
    d = await startDaemon(dir, { CODEX_BRIDGE_BG_STALL_SEC: "0", CODEX_BRIDGE_BG_MAX_RUN_SEC: "0" });

    // 8a: --force on idle thread -> never stall, silentSec: null
    const s1 = runCtl(dir, ["start", "--prompt", "complete_after:20:done_quick"], { convId: "conv-e8" });
    await sleep(80);
    const wIdle = runCtl(dir, ["wait", s1.json.threadId, "--after", s1.json.cursor, "--force", "--timeout", "1", "--stall-timeout", "1"], { convId: "conv-e8" });
    // First drain turn_completed, then force-wait on truly idle thread
    const wForce = runCtl(dir, ["wait", s1.json.threadId, "--after", wIdle.json.nextCursor, "--force", "--timeout", "1", "--stall-timeout", "1"], { convId: "conv-e8" });
    assert.equal(wForce.json.wakeup, "timeout");
    assert.equal(wForce.json.timeoutReason, "max_wait");
    assert.equal(wForce.json.silentSec, null);

    // 8b: --force idle (timeout=8, stall=1), then send silent turn at t=200ms -> reschedules to stall at ~1.2s (NOT 8s!)
    const t0 = Date.now();
    const forceAsync = runCtlAsync(dir, ["wait", s1.json.threadId, "--after", wForce.json.nextCursor, "--force", "--timeout", "8", "--stall-timeout", "1"], { convId: "conv-e8" });
    await sleep(200);
    runCtl(dir, ["send", s1.json.threadId, "--prompt", "stay_running"], { convId: "conv-e8" });
    const forceRes = await forceAsync.promise;
    const forceDt = Date.now() - t0;
    assert.equal(forceRes.json.wakeup, "timeout");
    assert.equal(forceRes.json.timeoutReason, "stall");
    assert.ok(forceDt < 3500, `Idle --force must reschedule to 1s stall on turn start, got ${forceDt}ms`);

    // 8c: Legacy HTTP request (omitting stallTimeout) on NEW daemon runs fixed wait (no stall!)
    const s2 = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e8" });
    const legWait = await rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: { threadId: s2.json.threadId, after: s2.json.cursor, timeout: 1 },
    });
    assert.equal(legWait.status, 200);
    assert.equal(legWait.data.timeoutReason, "max_wait");

    // 8d: Strict HTTP 400 validation on bad params (including stringified ints & null-proto objects -> never 500!)
    for (const badBody of [
      { threadId: s2.json.threadId, timeout: "abc" },
      { threadId: s2.json.threadId, timeout: "1" },
      { threadId: s2.json.threadId, timeout: " 2 " },
      { threadId: s2.json.threadId, timeout: 0 },
      { threadId: s2.json.threadId, timeout: 1801 },
      { threadId: s2.json.threadId, timeout: 5, stallTimeout: -1 },
      { threadId: s2.json.threadId, timeout: 5, stallTimeout: "1" },
      { threadId: s2.json.threadId, timeout: 5, stallTimeout: 10 },
      { threadId: s2.json.threadId, timeout: 5, stallTimeout: 1.5 },
      { threadId: s2.json.threadId, timeout: 5, timeoutReceiptMode: "invalid" },
      { threadId: s2.json.threadId, timeout: 5, timeoutReceiptMode: { bad: true } },
    ]) {
      const r = await rawHttp(d.state.port, "POST", "/wait", {
        headers: { Authorization: `Bearer ${d.state.token}` },
        body: badBody,
      });
      assert.equal(r.status, 400, `Expected HTTP 400 for ${JSON.stringify(badBody)}, got ${r.status}`);
    }

    // 8e: CLI pre-validation rejects --stall-timeout > --timeout
    const badCli = runCtl(dir, ["wait", s2.json.threadId, "--timeout", "10", "--stall-timeout", "20"]);
    assert.notEqual(badCli.status, 0);

    // 8f: Coalesce beats timeout when milestone arrives before timeout
    const s3 = runCtl(dir, ["start", "--prompt", "plan_then_stay:step1"], { convId: "conv-e8" });
    const wPlan = runCtl(dir, ["wait", s3.json.threadId, "--after", s3.json.cursor, "--events", "milestone", "--timeout", "1", "--stall-timeout", "1"], { convId: "conv-e8" });
    assert.equal(wPlan.json.wakeup, "plan_updated");

    // 8g: New CLI against mock legacy v1.4.0 daemon (without capabilities.stallWatchdog)
    const legDir = makeTempStateDir("e8-legacy");
    const capturedWaitBodies = [];
    mockLegacyServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true, pid: process.pid, instanceId: "legacy-inst-1", protocolVersion: 2, capabilities: { hookPoll: true, inbox: true } }));
        }
        if (req.url === "/wait") {
          capturedWaitBodies.push(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ wakeup: "idle", nextCursor: "legacy-inst-1:0" }));
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise((r) => mockLegacyServer.listen(0, "127.0.0.1", r));
    const legPort = mockLegacyServer.address().port;
    fs.writeFileSync(
      path.join(legDir, "daemon.json"),
      JSON.stringify({ pid: process.pid, instanceId: "legacy-inst-1", port: legPort, token: "tok" })
    );
    try {
      // Must run asynchronously so in-process mockLegacyServer can serve HTTP requests!
      // No flags -> must fall back to timeout: 600 and OMIT stallTimeout & timeoutReceiptMode
      const rDefault = await runCtlAsync(legDir, ["wait", "th-old"], { convId: "conv-leg" }).promise;
      assert.equal(rDefault.status, 0);
      assert.equal(capturedWaitBodies.length, 1);
      assert.equal(capturedWaitBodies[0].timeout, 600);
      assert.equal(capturedWaitBodies[0].stallTimeout, undefined);
      assert.equal(capturedWaitBodies[0].timeoutReceiptMode, undefined);

      // Explicit --stall-timeout 0 -> MUST fail fast before /wait!
      const rZero = await runCtlAsync(legDir, ["wait", "th-old", "--stall-timeout", "0"], { convId: "conv-leg" }).promise;
      assert.notEqual(rZero.status, 0);
      assert.equal(capturedWaitBodies.length, 1, "Explicit --stall-timeout 0 must reject before calling /wait");

      // Explicit --stall-timeout 10 -> MUST fail fast before /wait!
      const rExp = await runCtlAsync(legDir, ["wait", "th-old", "--stall-timeout", "10"], { convId: "conv-leg" }).promise;
      assert.notEqual(rExp.status, 0);
      assert.equal(capturedWaitBodies.length, 1);
    } finally {
      cleanupDir(legDir);
    }
  } finally {
    if (mockLegacyServer) mockLegacyServer.close();
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

await runTest("E9. Review R1 regressions: P0 W2 gets turn_completed/daemon_error (NOT stall) when W1 holds receipt, P1-1 superseded turn never resurrects, P1-2 serverRequest/resolved no-contact, real CLI stdout EPIPE", async () => {
  const dir = makeTempStateDir("e9");
  let d;
  let badHealthSrv;
  try {
    d = await startDaemon(dir, {
      CODEX_BRIDGE_BG_STALL_SEC: "600",
      CODEX_BRIDGE_BG_MAX_RUN_SEC: "2",
      CODEX_BRIDGE_FG_AUTO_RECEIPT_MS: "2000",
    });

    // 9a (P0): Pure terminal-only completion (NO /steer and NO preceding item/completed!) while W1 holds FG receipt slot and W2 is genuinely overdue ->
    // W2 MUST receive turn_completed (NOT timeout/stall!) and NO new receipt stays active!
    const s1 = runCtl(dir, ["start", "--prompt", "raw_terminal_after:1450"], { convId: "conv-e9-p0" });
    const w1P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e9-p0",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s1.json.threadId,
        after: s1.json.cursor,
        timeout: 15,
        stallTimeout: 1,
      },
    });
    const w2P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e9-p0",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: s1.json.threadId,
        after: s1.json.cursor,
        timeout: 15,
        stallTimeout: 1,
      },
    });
    const w1 = await w1P;
    assert.equal(w1.data.timeoutReason, "stall");
    assert.ok(w1.data.ackBatchId);
    // At t=1.45s (450ms overdue for W2, well inside W1's 2s receipt), raw turn/completed fires with ZERO prior activity refresh!
    const w2 = await w2P;
    assert.equal(w2.data.wakeup, "turn_completed", `P0 regression: W2 must get turn_completed, got ${JSON.stringify(w2.data)}`);

    // 9b (P1-1 & R2-P1): Superseded Turn A cannot resurrect OR overwrite status/lastTurnId with late turn/completed(failed)!
    const s2a = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e9-revive" });
    const s2b = runCtl(dir, ["send", s2a.json.threadId, "--prompt", "late_revive_after_complete"], { convId: "conv-e9-revive" });
    assert.equal(s2b.status, 0);
    await sleep(250);
    const st2 = runCtl(dir, ["status", s2a.json.threadId], { convId: "conv-e9-revive" });
    assert.equal(st2.json.summary.status, "idle", "Superseded Turn A late failed terminal must NOT overwrite status to error");
    assert.equal(st2.json.summary.activeTurnId, null);
    assert.equal(st2.json.summary.lastTurnId, s2b.json.turnId, "lastTurnId must stay Turn B, not revert to Turn A");
    assert.equal(st2.json.pendingRequests.length, 0);
    const w2Check = runCtl(dir, ["wait", s2a.json.threadId, "--after", s2b.json.cursor, "--timeout", "2"], { convId: "conv-e9-revive" });
    assert.equal(w2Check.json.wakeup, "turn_completed", "Wait must see Turn B completion, not stale Turn A turn_error");
    assert.equal(w2Check.json.message, "turn_b_done");

    // 9c (P1-2): Autonomous serverRequest/resolved resumes running WITHOUT crediting lastDeliveredContactMonoMs!
    // BG_MAX_RUN_SEC = 2s; turn starts at t=0, approval at 30ms, server resolves at 180ms, then livelock deltas keep running ->
    // Because serverRequest/resolved did NOT credit supervisor contact, BG max_run MUST fire around t=2.0s!
    const s3 = runCtl(dir, ["start", "--prompt", "approval_server_resolve_then_livelock"], { convId: "conv-e9-res" });
    assert.equal(s3.status, 0);
    await sleep(2400);
    const inb3 = runCtl(dir, ["inbox"], { convId: "conv-e9-res" });
    assert.ok(
      inb3.json.items.some((x) => x.kind === "turn_watchdog" && x.timeoutReason === "max_wait"),
      `Autonomous serverRequest/resolved must NOT credit contact; expected BG max_wait, got ${JSON.stringify(inb3.json.items)}`
    );

    // 9d (P2-2): Real CLI stdout EPIPE on `codex-ctl.mjs wait --stall-timeout 1` -> receipt expires -> hands off to inbox!
    await stopDaemon(d);
    d = await startDaemon(dir, {
      CODEX_BRIDGE_BG_STALL_SEC: "600",
      CODEX_BRIDGE_BG_MAX_RUN_SEC: "600",
      CODEX_BRIDGE_FG_AUTO_RECEIPT_MS: "350",
    });
    const s4 = runCtl(dir, ["start", "--prompt", "silent_item:commandExecution"], { convId: "conv-e9-epipe" });
    const epipeProc = spawn(NODE_BIN, [CTL, "wait", s4.json.threadId, "--after", s4.json.cursor, "--timeout", "10", "--stall-timeout", "1"], {
      cwd: MOCK_CWD,
      env: { ...process.env, CODEX_BRIDGE_STATE_DIR: dir, CODEX_BIN: NODE_BIN, ANTIGRAVITY_CONVERSATION_ID: "conv-e9-epipe" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // Close our read end of stdout immediately after 200ms (BEFORE daemon responds at 1s!) -> real EPIPE when codex-ctl writes stdout!
    setTimeout(() => {
      try {
        epipeProc.stdout.destroy();
      } catch {}
    }, 200);
    const epipeExit = await new Promise((resolve) => epipeProc.on("close", (code) => resolve(code)));
    assert.notEqual(epipeExit, 0, "Real stdout EPIPE should exit non-zero without sending ACK");
    await sleep(550); // Wait for 350ms receipt expiry -> hands off saved stall alert to inbox!
    const inbEpipe = runCtl(dir, ["inbox"], { convId: "conv-e9-epipe" });
    assert.equal(inbEpipe.json.items.length, 1, "Real CLI stdout EPIPE must hand off saved stall alert to inbox");
    assert.equal(inbEpipe.json.items[0].kind, "turn_watchdog");
    assert.equal(inbEpipe.json.items[0].timeoutReason, "stall");

    // 9e (R2-P0 multi-thread disconnect): Thread A has owner waiter (issues ACK batch on daemon_error),
    // Thread B has W1 holding receipt slot + overdue W2; pure timer-driven crash_after:1450 (NO /steer!) ->
    // Phase 1 commits ALL threads first, so BOTH Thread A AND Thread B's W2 MUST receive daemon_error (NOT stall)!
    const sA = runCtl(dir, ["start", "--prompt", "crash_after:1450"], { convId: "conv-e9-crash-a" });
    const sB = runCtl(dir, ["start", "--prompt", "stay_running"], { convId: "conv-e9-crash-b" });
    const wAP = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e9-crash-a",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: sA.json.threadId,
        after: sA.json.cursor,
        timeout: 15,
        stallTimeout: 10,
      },
    });
    const cw1P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e9-crash-b",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: sB.json.threadId,
        after: sB.json.cursor,
        timeout: 15,
        stallTimeout: 1,
      },
    });
    const cw2P = rawHttp(d.state.port, "POST", "/wait", {
      headers: { Authorization: `Bearer ${d.state.token}` },
      body: {
        ownerConversationId: "conv-e9-crash-b",
        supportsAckBatch: true,
        timeoutReceiptMode: "auto",
        threadId: sB.json.threadId,
        after: sB.json.cursor,
        timeout: 15,
        stallTimeout: 1,
      },
    });
    const cw1 = await cw1P;
    assert.equal(cw1.data.timeoutReason, "stall");
    // Wait for crash_after:1450 (pure timer, no /steer!) -> BOTH Thread A and Thread B's W2 get daemon_error!
    const [wA, cw2] = await Promise.all([wAP, cw2P]);
    assert.equal(wA.data.wakeup, "daemon_error", `Thread A expected daemon_error, got ${JSON.stringify(wA.data)}`);
    assert.equal(cw2.data.wakeup, "daemon_error", `Thread B W2 expected daemon_error (R2-P0), got ${JSON.stringify(cw2.data)}`);

    // 9f (P1-4): CLI strictly rejects capabilities.stallWatchdog="false" (string!) and missing instanceId
    const badDir = makeTempStateDir("e9-badhealth");
    let healthMode = "string_false";
    badHealthSrv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (healthMode === "string_false") {
        res.end(JSON.stringify({ ok: true, pid: process.pid, instanceId: "inst-strict", capabilities: { stallWatchdog: "false" } }));
      } else {
        res.end(JSON.stringify({ ok: true, pid: process.pid, capabilities: { stallWatchdog: true } })); // missing instanceId!
      }
    });
    await new Promise((r) => badHealthSrv.listen(0, "127.0.0.1", r));
    fs.writeFileSync(
      path.join(badDir, "daemon.json"),
      JSON.stringify({ pid: process.pid, instanceId: "inst-strict", port: badHealthSrv.address().port, token: "t" })
    );
    try {
      const rStrFalse = await runCtlAsync(badDir, ["wait", "th-1", "--stall-timeout", "5"]).promise;
      assert.notEqual(rStrFalse.status, 0, 'stallWatchdog: "false" must NOT be treated as true');
      healthMode = "missing_instance";
      const rMissInst = await runCtlAsync(badDir, ["wait", "th-1"]).promise;
      assert.notEqual(rMissInst.status, 0, "Missing instanceId in /health must fail strict check");
    } finally {
      cleanupDir(badDir);
    }
  } finally {
    if (badHealthSrv) badHealthSrv.close();
    await stopDaemon(d);
    cleanupDir(dir);
  }
});

const passed = results.filter((r) => r.ok).length;
console.log(`\nSummary: ${passed}/${results.length} passed.`);
if (passed !== results.length) {
  process.exit(1);
}

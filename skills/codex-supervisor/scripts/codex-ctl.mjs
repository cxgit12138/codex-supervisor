#!/usr/bin/env node
/**
 * Thin CLI client for Codex Supervisor Bridge Daemon.
 * Validates CLI flags before starting the daemon, auto-starts the local bridge
 * safely without deleting shared state files, and handles UTF-8 stdin/files.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, "bridge-daemon.mjs");
const STATE_DIR = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), ".gemini", "cache", "codex-supervisor");
const STATE_FILE = path.join(STATE_DIR, "daemon.json");
const MAX_STDIN_BYTES = 5 * 1024 * 1024;

const BOOL_FLAGS = new Set(["ephemeral", "stdin", "fallback-send", "force", "help"]);

const ALLOWED_FLAGS = {
  health: new Set([]),
  models: new Set(["limit"]),
  threads: new Set(["limit", "cwd"]),
  start: new Set(["cwd", "model", "sandbox", "approval", "effort", "mode", "name", "ephemeral", "prompt", "prompt-file", "stdin"]),
  resume: new Set(["cwd", "model", "sandbox", "approval", "effort", "mode", "prompt", "prompt-file", "stdin"]),
  fork: new Set(["cwd", "model", "sandbox", "approval", "effort", "mode", "name", "ephemeral", "prompt", "prompt-file", "stdin"]),
  send: new Set(["cwd", "model", "approval", "effort", "mode", "prompt", "prompt-file", "stdin"]),
  steer: new Set(["turn-id", "fallback-send", "prompt", "prompt-file", "stdin"]),
  interrupt: new Set(["turn-id"]),
  respond: new Set(["decision", "scope", "reason", "permissions", "answer", "answers"]),
  wait: new Set(["after", "timeout", "events", "force"]),
  status: new Set([]),
  history: new Set(["limit"]),
  stop: new Set([]),
};

function parseBoolValue(flag, raw) {
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  throw new Error(`Invalid boolean value for --${flag}: "${raw}" (expected true or false)`);
}

function parseIntFlag(flag, raw, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(String(raw))) {
    throw new Error(`Invalid integer for --${flag}: "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Out-of-range integer for --${flag}: ${raw} (expected ${min}..${max})`);
  }
  return n;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let stopFlags = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!stopFlags && a === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        const k = key.slice(0, eq);
        const v = key.slice(eq + 1);
        flags[k] = BOOL_FLAGS.has(k) ? parseBoolValue(k, v) : v;
      } else if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        if (i + 1 >= argv.length) {
          throw new Error(`Option --${key} requires a value`);
        }
        const nextVal = argv[i + 1];
        if (nextVal.startsWith("--")) {
          throw new Error(`Option --${key} requires a value (got option "${nextVal}"; use --${key}=... for literal values starting with --)`);
        }
        flags[key] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function validateFlags(cmd, flags) {
  const allowed = ALLOWED_FLAGS[cmd];
  if (!allowed) throw new Error(`Unknown command: ${cmd}`);
  for (const k of Object.keys(flags)) {
    if (k === "help") continue;
    if (!allowed.has(k)) {
      throw new Error(`Unknown option --${k} for command "${cmd}"`);
    }
  }
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const c of process.stdin) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += buf.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolvePrompt(flags) {
  const sources = [Boolean(flags["prompt-file"]), Boolean(flags.stdin || flags.prompt === "-"), typeof flags.prompt === "string" && flags.prompt !== "-"].filter(Boolean).length;
  if (sources > 1) {
    throw new Error("Specify only one of --prompt, --prompt-file, or --stdin");
  }
  if (flags["prompt-file"]) {
    const st = fs.statSync(flags["prompt-file"]);
    if (st.size > MAX_STDIN_BYTES) {
      throw new Error(`prompt file exceeds ${MAX_STDIN_BYTES} bytes`);
    }
    return fs.readFileSync(flags["prompt-file"], "utf8");
  }
  if (flags.stdin || flags.prompt === "-") {
    return await readStdin();
  }
  if (typeof flags.prompt === "string") {
    return flags.prompt;
  }
  return undefined;
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function httpRequestJson(port, method, route, { headers = {}, body = undefined, timeoutMs = 1860_000 } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    let payloadBuf = null;
    if (body !== undefined) {
      payloadBuf = Buffer.from(JSON.stringify(body), "utf8");
      reqHeaders["Content-Type"] = "application/json; charset=utf-8";
      reqHeaders["Content-Length"] = payloadBuf.length;
    }
    let settled = false;
    let req;
    const finishOk = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(val);
    };
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
    };
    const deadline = setTimeout(() => {
      const err = new Error(`HTTP request timeout (${timeoutMs}ms) on ${method} ${route}`);
      try {
        req?.destroy(err);
      } catch {}
      finishErr(err);
    }, timeoutMs);

    req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: reqHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("aborted", () => finishErr(new Error(`HTTP response aborted on ${method} ${route}`)));
        res.on("error", finishErr);
        res.on("close", () => {
          if (!res.complete) finishErr(new Error(`HTTP response closed prematurely on ${method} ${route}`));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text };
          }
          finishOk({ status: res.statusCode || 0, ok: res.statusCode >= 200 && res.statusCode < 300, data, text });
        });
      }
    );
    req.on("error", finishErr);
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

async function checkHealth(state) {
  if (!state || !state.port) return false;
  try {
    const res = await httpRequestJson(state.port, "GET", "/health", { timeoutMs: 1500 });
    return res.ok && Boolean(res.data?.ok);
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  let state = readState();
  if (await checkHealth(state)) return state;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Never delete daemon.json from CLI (avoids racing with another client's fresh daemon).
  // The lock-owning daemon atomically replaces daemon.json once ready.
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    state = readState();
    if (await checkHealth(state)) return state;
  }
  throw new Error(`Codex bridge daemon failed to start within 12s. Check ${path.join(STATE_DIR, "daemon.log")}`);
}

async function api(state, method, route, body = undefined, timeoutMs = 1860_000) {
  const res = await httpRequestJson(state.port, method, route, {
    headers: { Authorization: `Bearer ${state.token}` },
    body,
    timeoutMs,
  });
  if (!res.ok) {
    const msg = res.data?.error || res.text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.data;
}

function usage() {
  console.log(`Usage: node codex-ctl.mjs <command> [args] [options]

Commands:
  health                                  Check bridge daemon health
  models [--limit N]                      List available Codex models
  threads [--limit N] [--cwd DIR]         List recent Codex threads
  start [--cwd DIR] [--model M] [--sandbox danger-full-access|workspace-write|read-only]
        [--approval never|on-request|untrusted] [--effort low|medium|high|xhigh]
        [--mode plan|default] [--name TITLE] [--ephemeral] [--prompt TEXT | --prompt-file FILE | --stdin]
  resume <threadId> [--cwd DIR] [--model M] [--sandbox ...] [--approval ...] [--mode plan|default] [--prompt ...]
  fork <threadId> [--cwd DIR] [--model M] [--sandbox ...] [--approval ...] [--mode plan|default] [--name TITLE] [--ephemeral] [--prompt ...]
  send <threadId> [--model M] [--effort ...] [--mode plan|default] (--prompt TEXT | --prompt-file FILE | --stdin)
  steer <threadId> [--turn-id ID] [--fallback-send] (--prompt TEXT | --prompt-file FILE | --stdin)
  interrupt <threadId> [--turn-id ID]     Request interruption of active turn
  respond <reqId> --decision accept|acceptForSession|decline|cancel [--scope turn|session]
          [--reason TEXT] [--permissions JSON] | --answer TEXT | --answers JSON
  wait <threadId> [--after CURSOR] [--timeout SEC] [--events critical|milestone|all] [--force]
  status [threadId]                       Snapshot active thread(s) without blocking
  history <threadId> [--limit N]          Read compact recent turns from Codex thread
  stop                                    Stop local bridge daemon`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "help" || flags.help) {
    usage();
    return;
  }

  validateFlags(cmd, flags);

  // Pre-validate arguments BEFORE spawning daemon
  let prompt;
  let parsedAnswers;
  let parsedPermissions;
  let limit;
  let timeoutSec;

  if (flags.mode !== undefined && flags.mode !== "plan" && flags.mode !== "default") {
    throw new Error(`Invalid --mode "${flags.mode}" (expected "plan" or "default")`);
  }
  if (cmd === "models" || cmd === "threads" || cmd === "history") {
    limit = parseIntFlag("limit", flags.limit, 1, 200);
  }
  if (cmd === "wait") {
    if (!positional[1]) throw new Error("wait requires <threadId>");
    timeoutSec = parseIntFlag("timeout", flags.timeout ?? 600, 1, 1800);
    if (flags.events && !["milestone", "critical", "all"].includes(flags.events)) {
      throw new Error(`Invalid --events value: "${flags.events}" (expected critical|milestone|all)`);
    }
  }
  if (cmd === "start" || cmd === "resume" || cmd === "fork" || cmd === "send" || cmd === "steer") {
    prompt = await resolvePrompt(flags);
    if ((cmd === "send" || cmd === "steer") && (!positional[1] || !prompt)) {
      throw new Error(`${cmd} requires <threadId> and --prompt/--prompt-file/--stdin`);
    }
    if ((cmd === "resume" || cmd === "fork") && !positional[1]) {
      throw new Error(`${cmd} requires <threadId>`);
    }
  }
  if (cmd === "interrupt" && !positional[1]) {
    throw new Error("interrupt requires <threadId>");
  }
  if (cmd === "history" && !positional[1]) {
    throw new Error("history requires <threadId>");
  }
  if (cmd === "respond") {
    if (!positional[1]) throw new Error("respond requires <reqId>");
    const hasPermissionsFlag = Object.prototype.hasOwnProperty.call(flags, "permissions");
    if (!flags.decision && !hasPermissionsFlag && flags.answer === undefined && !flags.answers) {
      throw new Error("respond requires explicit --decision, --permissions, --answer, or --answers");
    }
    if (flags.answers) parsedAnswers = JSON.parse(flags.answers);
    if (hasPermissionsFlag) parsedPermissions = JSON.parse(flags.permissions);
  }

  if (cmd === "stop") {
    const state = readState();
    if (!(await checkHealth(state))) {
      console.log(JSON.stringify({ stopped: true, wasRunning: false }));
      return;
    }
    const r = await api(state, "POST", "/stop");
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const state = await ensureDaemon();

  if (cmd === "health") {
    const res = await httpRequestJson(state.port, "GET", "/health", { timeoutMs: 5000 });
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (cmd === "models") {
    const q = limit ? `?limit=${limit}` : "";
    console.log(JSON.stringify(await api(state, "GET", `/models${q}`), null, 2));
    return;
  }

  if (cmd === "threads") {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (flags.cwd) qs.set("cwd", String(flags.cwd));
    const suffix = qs.toString() ? `?${qs}` : "";
    console.log(JSON.stringify(await api(state, "GET", `/threads${suffix}`), null, 2));
    return;
  }

  if (cmd === "start") {
    const r = await api(state, "POST", "/start", {
      cwd: flags.cwd || process.cwd(),
      model: flags.model,
      sandbox: flags.sandbox || "workspace-write",
      approvalPolicy: flags.approval || "on-request",
      effort: flags.effort,
      mode: flags.mode,
      name: flags.name,
      ephemeral: Boolean(flags.ephemeral),
      prompt,
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "resume") {
    const r = await api(state, "POST", "/resume", {
      threadId: positional[1],
      cwd: flags.cwd,
      model: flags.model,
      sandbox: flags.sandbox,
      approvalPolicy: flags.approval,
      effort: flags.effort,
      mode: flags.mode,
      prompt,
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "fork") {
    const r = await api(state, "POST", "/fork", {
      threadId: positional[1],
      cwd: flags.cwd,
      model: flags.model,
      sandbox: flags.sandbox,
      approvalPolicy: flags.approval,
      effort: flags.effort,
      mode: flags.mode,
      name: flags.name,
      ephemeral: flags.ephemeral !== undefined ? Boolean(flags.ephemeral) : undefined,
      prompt,
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "send") {
    const r = await api(state, "POST", "/send", {
      threadId: positional[1],
      model: flags.model,
      effort: flags.effort,
      mode: flags.mode,
      cwd: flags.cwd,
      approvalPolicy: flags.approval,
      prompt,
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "steer") {
    const r = await api(state, "POST", "/steer", {
      threadId: positional[1],
      expectedTurnId: flags["turn-id"],
      fallbackSend: Boolean(flags["fallback-send"]),
      prompt,
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "interrupt") {
    const body = { threadId: positional[1] };
    if (flags["turn-id"] !== undefined) body.turnId = flags["turn-id"];
    const r = await api(state, "POST", "/interrupt", body);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "respond") {
    const body = { reqId: positional[1] };
    if (flags.decision) body.decision = flags.decision;
    if (flags.scope) body.scope = flags.scope;
    if (flags.reason) body.reason = flags.reason;
    if (Object.prototype.hasOwnProperty.call(flags, "permissions")) body.permissions = parsedPermissions;
    if (flags.answer !== undefined) body.answer = flags.answer;
    if (parsedAnswers) body.answers = parsedAnswers;
    const r = await api(state, "POST", "/respond", body);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "wait") {
    const r = await api(
      state,
      "POST",
      "/wait",
      {
        threadId: positional[1],
        after: flags.after ?? 0,
        timeout: timeoutSec,
        events: flags.events || "critical",
        forceWait: Boolean(flags.force),
      },
      (timeoutSec + 15) * 1000
    );
    console.log(JSON.stringify(r));
    return;
  }

  if (cmd === "status") {
    const threadId = positional[1];
    const q = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    console.log(JSON.stringify(await api(state, "GET", `/status${q}`), null, 2));
    return;
  }

  if (cmd === "history") {
    const qs = new URLSearchParams({ threadId: positional[1] });
    if (limit) qs.set("limit", String(limit));
    console.log(JSON.stringify(await api(state, "GET", `/history?${qs}`), null, 2));
    return;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message || String(err) }));
  process.exit(1);
});

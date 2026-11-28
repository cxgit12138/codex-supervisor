#!/usr/bin/env node
/**
 * Codex Supervisor Bridge Daemon
 * Holds a persistent `codex app-server --stdio` process and exposes a local
 * authenticated HTTP control API for zero-polling event-driven supervision.
 * Zero external dependencies (Node.js >= 20 built-ins only).
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { readSettings, applyDefaults, sessionSettings, writeSessionSettings, boundThread, openDesktop, bindThread, configRoot, activeInstallers } from "../../../lib/preferences.mjs";
import { projectSync } from "../../../lib/projects.mjs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const RAW_STATE_DIR = path.resolve(process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), ".gemini", "cache", "codex-supervisor"));

const ALLOWED_POSIX_SYSTEM_SYMLINKS = new Map([
  ["/var", "/private/var"],
  ["/tmp", "/private/tmp"],
  ["/etc", "/private/etc"],
]);

function validateAndCanonicalizePosixStatePath(dirPath) {
  // Walk existing segments from `/` down to dirPath:
  // - Allow ONLY explicit OS-level system symlink mappings (e.g. macOS /var -> /private/var, /tmp -> /private/tmp).
  // - Reject EVERY other symlink (inside home, outside home, or on STATE_DIR itself).
  // - Treat ONLY ENOENT as non-existent; rethrow EACCES/EPERM/ENOTDIR.
  const resolved = path.resolve(dirPath);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let physicalCur = root;

  for (let i = 0; i < parts.length; i++) {
    const nextPath = path.join(physicalCur, parts[i]);
    let lst;
    try {
      lst = fs.lstatSync(nextPath);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // Remaining segments do not exist yet; append verbatim onto canonical physicalCur
        physicalCur = path.join(physicalCur, ...parts.slice(i));
        break;
      }
      throw err;
    }

    if (lst.isSymbolicLink()) {
      const targetReal = fs.realpathSync(nextPath);
      const isLast = i === parts.length - 1;
      const expectedSystemTarget = ALLOWED_POSIX_SYSTEM_SYMLINKS.get(nextPath);
      if (isLast || !expectedSystemTarget || targetReal !== expectedSystemTarget) {
        throw new Error(`Refusing to operate across symlink path: ${nextPath}`);
      }
      physicalCur = targetReal;
    } else {
      physicalCur = nextPath;
    }
  }

  // Walk full descendant tree under canonical physicalCur if it already exists
  let rootSt;
  try {
    rootSt = fs.lstatSync(physicalCur);
  } catch (err) {
    if (err && err.code === "ENOENT") return physicalCur;
    throw err;
  }
  if (rootSt.isSymbolicLink()) {
    throw new Error(`Refusing to operate on symlink state path: ${physicalCur}`);
  }
  if (!rootSt.isDirectory()) {
    throw new Error(`State path exists and is not a directory: ${physicalCur}`);
  }
  const visited = new Set();
  const walk = (p) => {
    const lst = fs.lstatSync(p);
    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing to operate across symlink child: ${p}`);
    }
    if (!lst.isDirectory()) return;
    const key = `${lst.dev}:${lst.ino}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const entry of fs.readdirSync(p)) {
      walk(path.join(p, entry));
    }
  };
  walk(physicalCur);
  return physicalCur;
}

// Fixed static PowerShell script: NEVER interpolates dynamic paths into source code.
// Receives target path and mode strictly as data via CODEX_BRIDGE_ACL_TARGET / CODEX_BRIDGE_ACL_MODE.
const WINDOWS_ACL_STATIC_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$mode = $env:CODEX_BRIDGE_ACL_MODE",
  "$rawTarget = $env:CODEX_BRIDGE_ACL_TARGET",
  "if ([string]::IsNullOrWhiteSpace($rawTarget)) { throw 'Missing CODEX_BRIDGE_ACL_TARGET' }",
  "$root = [System.IO.Path]::GetFullPath($rawTarget)",
  "$reparse = [System.IO.FileAttributes]::ReparsePoint",
  "$dirAttr = [System.IO.FileAttributes]::Directory",
  "function Try-GetAttr([string]$p) {",
  "  try { return [System.IO.File]::GetAttributes($p) }",
  "  catch [System.IO.FileNotFoundException] { return $null }",
  "  catch [System.IO.DirectoryNotFoundException] { return $null }",
  "}",
  "function Assert-AncestorsClean([string]$fullPath) {",
  "  $driveRoot = [System.IO.Path]::GetPathRoot($fullPath)",
  "  $rel = $fullPath.Substring($driveRoot.Length).TrimEnd('\\', '/')",
  "  if ([string]::IsNullOrEmpty($rel)) { return }",
  "  $cur = $driveRoot",
  "  foreach ($seg in ($rel -split '[\\\\/]')) {",
  "    if ([string]::IsNullOrEmpty($seg)) { continue }",
  "    $cur = [System.IO.Path]::Combine($cur, $seg)",
  "    $a = Try-GetAttr $cur",
  "    if ($null -eq $a) { break }",
  "    if (($a -band $reparse) -ne 0) { throw \"ReparsePoint ancestor rejected: $cur\" }",
  "  }",
  "}",
  "function Assert-DescendantsClean([string]$p) {",
  "  $attr = Try-GetAttr $p",
  "  if ($null -eq $attr) { return }",
  "  if (($attr -band $reparse) -ne 0) { throw \"ReparsePoint rejected: $p\" }",
  "  if (($attr -band $dirAttr) -eq 0) { throw \"State path exists and is not a directory: $p\" }",
  "  foreach ($ch in [System.IO.Directory]::GetFileSystemEntries($p)) {",
  "    $ca = [System.IO.File]::GetAttributes($ch)",
  "    if (($ca -band $reparse) -ne 0) { throw \"ReparsePoint rejected: $ch\" }",
  "    if (($ca -band $dirAttr) -ne 0) { Assert-DescendantsClean $ch }",
  "  }",
  "}",
  "Assert-AncestorsClean $root",
  "Assert-DescendantsClean $root",
  "if ($mode -eq 'check_only') { exit 0 }",
  "$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$sysSid = 'S-1-5-18'",
  "$userObj = New-Object System.Security.Principal.SecurityIdentifier($userSid)",
  "$sysObj = New-Object System.Security.Principal.SecurityIdentifier($sysSid)",
  "$inh = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'",
  "$prop = [System.Security.AccessControl.PropagationFlags]::None",
  "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
  "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
  "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userObj, $rights, $inh, $prop, $allow)))",
  "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sysObj, $rights, $inh, $prop, $allow)))",
  "[System.IO.Directory]::SetAccessControl($root, $acl)",
  "$verify = [System.IO.Directory]::GetAccessControl($root)",
  "if (-not $verify.AreAccessRulesProtected) { throw 'Root DACL inheritance protection not enabled' }",
  "$seen = @{}",
  "foreach ($rule in $verify.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {",
  "  $sid = $rule.IdentityReference.Value",
  "  if ($sid -ne $userSid -and $sid -ne $sysSid) { throw \"Unauthorized ACL SID on state dir: $sid\" }",
  "  if ($rule.AccessControlType -ne $allow) { throw \"Unexpected Deny ACE for SID: $sid\" }",
  "  if (($rule.FileSystemRights -band $rights) -ne $rights) { throw \"Insufficient rights for SID: $sid\" }",
  "  $seen[$sid] = $true",
  "}",
  "if (-not $seen.ContainsKey($userSid) -or -not $seen.ContainsKey($sysSid)) { throw 'Missing required owner/SYSTEM SID in root DACL' }",
  "function Reset-ChildAcl([string]$dir) {",
  "  foreach ($ch in [System.IO.Directory]::GetFileSystemEntries($dir)) {",
  "    $ca = [System.IO.File]::GetAttributes($ch)",
  "    if (($ca -band $reparse) -ne 0) { throw \"ReparsePoint rejected: $ch\" }",
  "    if (($ca -band $dirAttr) -ne 0) {",
  "      $cAcl = New-Object System.Security.AccessControl.DirectorySecurity",
  "      $cAcl.SetAccessRuleProtection($false, $false)",
  "      [System.IO.Directory]::SetAccessControl($ch, $cAcl)",
  "      Reset-ChildAcl $ch",
  "    } else {",
  "      $fAcl = New-Object System.Security.AccessControl.FileSecurity",
  "      $fAcl.SetAccessRuleProtection($false, $false)",
  "      [System.IO.File]::SetAccessControl($ch, $fAcl)",
  "    }",
  "  }",
  "}",
  "Reset-ChildAcl $root",
].join("\n");
const WINDOWS_ACL_ENCODED = Buffer.from(WINDOWS_ACL_STATIC_SCRIPT, "utf16le").toString("base64");

function runWindowsAclScript(mode, targetDir) {
  const psBin = fs.existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    : "powershell.exe";
  const childEnv = {
    ...process.env,
    CODEX_BRIDGE_ACL_MODE: mode,
    CODEX_BRIDGE_ACL_TARGET: path.resolve(targetDir),
  };
  delete childEnv.PSModulePath;
  const res = spawnSync(psBin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_ACL_ENCODED], {
    encoding: "utf8",
    env: childEnv,
    windowsHide: true,
    timeout: 15_000,
  });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    const clmHint = /ConstrainedLanguage|Cannot invoke method/i.test(detail)
      ? " (Windows ACL helper requires FullLanguage PowerShell mode)"
      : "";
    throw new Error(`Windows ACL/${mode} failed on ${targetDir}${clmHint}: ${detail}`);
  }
}

// Validate & canonicalize STATE_DIR BEFORE creating subdirectories or lock file
let STATE_DIR = RAW_STATE_DIR;
if (process.platform === "win32") {
  runWindowsAclScript("check_only", STATE_DIR);
} else {
  STATE_DIR = validateAndCanonicalizePosixStatePath(STATE_DIR);
}

const LOGS_DIR = path.join(STATE_DIR, "logs");
const HOOKS_DIR = path.join(STATE_DIR, "hooks");
const STATE_FILE = path.join(STATE_DIR, "daemon.json");
const HOOK_STATE_FILE = path.join(STATE_DIR, "hook-daemon.json");
const LOCK_FILE = path.join(STATE_DIR, "daemon.lock");
const RECLAIM_LOCK_FILE = path.join(STATE_DIR, "daemon.lock.reclaim");
const DAEMON_LOG = path.join(STATE_DIR, "daemon.log");
const IDLE_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_IDLE_MS ?? 60 * 60 * 1000);
const PROTOCOL_VERSION = 2;
const MAX_MEM_EVENTS = 500;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const COALESCE_MS = 300;
const MAX_INLINE_TEXT = 2500;
const MAX_THREAD_NOTIFS = 50;
const MAX_GLOBAL_NOTIFS = 500;
const BATCH_LEASE_MS = Number(process.env.CODEX_BRIDGE_LEASE_MS ?? 30_000);
const HOOK_NUDGE_COOLDOWN_MS = Number(process.env.CODEX_BRIDGE_NUDGE_COOLDOWN_MS ?? 15_000);
const FLAG_RETRY_MS = Number(process.env.CODEX_BRIDGE_FLAG_RETRY_MS ?? 5_000);
const IDLE_SWEEP_MS = Number(process.env.CODEX_BRIDGE_IDLE_SWEEP_MS ?? 60_000);
const INBOX_MAX_BYTES = 16 * 1024;
const INBOX_MAX_THREADS = 10;
const INBOX_MAX_ITEMS = 20;
const NOTIF_TTL_MS = Number(process.env.CODEX_BRIDGE_NOTIF_TTL_MS ?? 60 * 60 * 1000);
const NORMAL_STOP_REASONS = new Set(["NO_TOOL_CALL"]);
const INSTANCE_ID = `${process.pid}-${Date.now()}`;
const INSTANCE_HOOKS_DIR = path.join(HOOKS_DIR, INSTANCE_ID);

// Prevent detached daemon from crashing if parent CLI closes stdout/stderr pipes after readiness
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });

function logDaemon(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(DAEMON_LOG, line, "utf8");
  } catch {}
}

/**
 * On Windows, Node's `0o600` does NOT restrict NTFS DACLs, and `%USERPROFILE%`
 * often inherits read access for `CodexSandboxUsers`. Replace the root DACL
 * with ONLY current user SID + SYSTEM via .NET SecurityIdentifier (stripping
 * both inherited and stray explicit ACEs), verify by SID, then reset children.
 */
function hardenStateDirPermissions() {
  if (process.platform !== "win32") {
    validateAndCanonicalizePosixStatePath(STATE_DIR);
    fs.chmodSync(STATE_DIR, 0o700);
    fs.chmodSync(LOGS_DIR, 0o700);
    return;
  }
  runWindowsAclScript("harden", STATE_DIR);
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

function isPidDefinitelyDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return Boolean(e && e.code === "ESRCH");
  }
}

function inspectLockStaleness() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (isPidAlive(info.pid)) {
      return { stale: false, missing: false };
    }
    return { stale: isPidDefinitelyDead(info.pid), missing: false };
  } catch (err) {
    if (err && err.code === "ENOENT") return { stale: false, missing: true };
    // Corrupt or mid-write lock: treat as stale only if older than 5s
    try {
      const st = fs.statSync(LOCK_FILE);
      return { stale: Date.now() - st.mtimeMs >= 5000, missing: false };
    } catch (stErr) {
      if (stErr && stErr.code === "ENOENT") return { stale: false, missing: true };
      return { stale: false, missing: false };
    }
  }
}

function writeNewStartupLockExclusive() {
  const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
  let closed = false;
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, instanceId: INSTANCE_ID, startedAt: new Date().toISOString() }),
      "utf8"
    );
    fs.closeSync(fd);
    closed = true;
  } catch (err) {
    if (!closed) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    throw err;
  }
  ownsLock = true;
}

let ownsLock = false;
let winMutexServer = null;

function computeWindowsPhysicalPipeKey(dirPath) {
  // Deterministic single physical identity: fail loudly if realpath/stat fails (never silently diverge between two contenders)
  const canonical = fs.realpathSync.native(dirPath);
  const st = fs.statSync(canonical, { bigint: true });
  const identity = st.ino > 0n ? `id:${st.dev}:${st.ino}` : `path:${canonical.toLowerCase()}`;
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

function acquireWindowsKernelMutex() {
  const hash = computeWindowsPhysicalPipeKey(STATE_DIR);
  const pipePath = `\\\\.\\pipe\\codex-supervisor-lock-${hash}`;
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      try { sock.destroy(); } catch {}
    });
    const onErr = (err) => {
      if (err && err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(err);
      }
    };
    srv.once("error", onErr);
    srv.listen({ path: pipePath, exclusive: true }, () => {
      srv.off("error", onErr);
      srv.on("error", () => {});
      // Mixed-version compatibility: acquire LOCK_FILE via shared exclusive `wx` protocol
      // so a legacy v1 daemon (without named pipe) racing on `wx` is NEVER overwritten.
      // Never auto-unlink an existing stale LOCK_FILE on Windows because a concurrent legacy v1
      // daemon does not participate in the named pipe and could replace LOCK_FILE before unlink.
      const releaseAndYield = () => {
        try { srv.close(); } catch {}
        resolve(false);
      };
      try {
        try {
          writeNewStartupLockExclusive();
        } catch (wErr) {
          if (!wErr || wErr.code !== "EEXIST") throw wErr;
          const legacyCheck = inspectLockStaleness();
          if (legacyCheck.missing) {
            // Disappeared concurrently; retry exclusive wx once without unlinking anything
            try {
              writeNewStartupLockExclusive();
            } catch (wErr2) {
              if (wErr2 && wErr2.code === "EEXIST") return releaseAndYield();
              throw wErr2;
            }
          } else if (!legacyCheck.stale) {
            return releaseAndYield();
          } else {
            throw new Error(
              `Stale lock file exists at ${LOCK_FILE}; refusing uncoordinated auto-removal for mixed-version safety. Remove it manually if no daemon is running.`
            );
          }
        }
      } catch (err) {
        try { srv.close(); } catch {}
        return reject(err);
      }

      srv.unref();
      winMutexServer = srv;
      resolve(true);
    });
  });
}

async function acquireStartupLock() {
  // On Windows, use an OS-kernel-enforced exclusive named pipe keyed by physical directory identity
  // (FILE_FLAG_FIRST_PIPE_INSTANCE): automatically released by the kernel on ANY process death.
  if (process.platform === "win32") {
    return await acquireWindowsKernelMutex();
  }

  // POSIX fallback: exclusive LOCK_FILE + non-racy RECLAIM_LOCK_FILE (never auto-unlinks another contender's reclaim lock)
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      writeNewStartupLockExclusive();
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const check = inspectLockStaleness();
      if (check.missing) continue;
      if (!check.stale) return false; // Live daemon owns the lock

      let rfd = null;
      let reclaimAcquired = false;
      try {
        rfd = fs.openSync(RECLAIM_LOCK_FILE, "wx", 0o600);
        reclaimAcquired = true;
      } catch (rErr) {
        if (rErr.code !== "EEXIST") throw rErr;
        // Another contender holds RECLAIM_LOCK_FILE; wait briefly and re-check LOCK_FILE without touching RECLAIM_LOCK_FILE
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }

      try {
        let rClosed = false;
        try {
          fs.writeFileSync(rfd, JSON.stringify({ pid: process.pid, instanceId: INSTANCE_ID }), "utf8");
          fs.closeSync(rfd);
          rClosed = true;
        } finally {
          if (!rClosed && rfd !== null) {
            try { fs.closeSync(rfd); } catch {}
          }
        }

        const recheck = inspectLockStaleness();
        if (!recheck.missing && !recheck.stale) {
          return false; // Another contender installed a live lock
        }
        if (!recheck.missing) {
          try {
            fs.unlinkSync(LOCK_FILE);
          } catch (uErr) {
            if (!uErr || uErr.code !== "ENOENT") throw uErr;
          }
        }
        try {
          writeNewStartupLockExclusive();
          return true;
        } catch (wErr) {
          if (wErr && wErr.code === "EEXIST") {
            return false; // Another contender won the race cleanly
          }
          throw wErr;
        }
      } finally {
        if (reclaimAcquired) {
          try { fs.unlinkSync(RECLAIM_LOCK_FILE); } catch {}
        }
      }
    }
  }
  if (fs.existsSync(RECLAIM_LOCK_FILE)) {
    throw new Error(
      `Stale startup reclaim lock exists at ${RECLAIM_LOCK_FILE}; refusing unsafe auto-steal. Remove it manually if no daemon is starting.`
    );
  }
  return false;
}

if (activeInstallers().length) throw new Error("插件正在更新，请稍后派单");
if (!(await acquireStartupLock())) {
  // Flush stdout cleanly before exiting so parent CLI always reads complete {"alreadyRunning":true}
  await new Promise((resolve) => {
    const fallback = setTimeout(resolve, 200);
    fallback.unref();
    process.stdout.write(JSON.stringify({ alreadyRunning: true }) + "\n", () => {
      clearTimeout(fallback);
      resolve();
    });
  });
  process.exit(0);
}

// Harden NTFS DACL ONLY after owning the startup lock, and BEFORE creating HOOKS_DIR or writing secrets
hardenStateDirPermissions();

function initInstanceHooksDir() {
  fs.mkdirSync(HOOKS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(INSTANCE_HOOKS_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(HOOKS_DIR, 0o700);
      fs.chmodSync(INSTANCE_HOOKS_DIR, 0o700);
    } catch {}
  }
  // Conservatively prune stale subdirs (>24h old & confirmed dead via ESRCH) without touching live or EPERM instances
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(HOOKS_DIR)) {
      if (entry === INSTANCE_ID) continue;
      const m = entry.match(/^(\d+)-\d+$/);
      if (!m) continue;
      const full = path.join(HOOKS_DIR, entry);
      try {
        const lst = fs.lstatSync(full);
        if (lst.isSymbolicLink() || !lst.isDirectory()) continue;
        if (lst.mtimeMs > cutoff) continue;
        const oldPid = Number(m[1]);
        if (isPidDefinitelyDead(oldPid)) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

initInstanceHooksDir();

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
const hookToken = crypto.randomBytes(24).toString("hex");
let lastActivityMs = Date.now();
let shuttingDown = false;
let dispatches = 0;
const syncProjects = projectSync(path.join(configRoot, "projects"), path.join(STATE_DIR, "projects.json"), rpcCall);

let codexProc = null;
let codexReady = false;
let codexInitInfo = null;
let rpcNextId = 1;
const pendingRpc = new Map();

let serverReqNextSeq = 1;
let nextOwnerGen = 1;
let nextNotifId = 1;
let nextBatchSeq = 1;
let inboxRotateOffset = 0;
const pendingServerRequests = new Map(); // reqId (string `${INSTANCE_ID}:${seq}`) -> entry
const threads = new Map(); // threadId -> ThreadState
const threadOwners = new Map(); // threadId -> { ownerConversationId, ownerGen } (preserved across idle eviction)
const evictedThreadSeq = new Map(); // threadId -> last nextSeq before idle eviction
const threadLocks = new Map(); // threadId -> Promise chain
const activeBatches = new Map(); // batchId -> { batchId, instanceId, conversationId, expiresAt, entries }
const convFlagCache = new Map(); // conversationId -> { unread: boolean, active: boolean }
const flagDirty = new Set(); // Set<conversationId> whose disk flag sync failed
const convNudgeState = new Map(); // conversationId -> { signature: string, lastNudgeAt: number }
let flagRetryLogLastMs = 0;

function parseOptionalConversationId(val) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val !== "string") {
    const err = new Error("Invalid conversationId: must be a string");
    err.statusCode = 400;
    throw err;
  }
  const trimmed = val.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 256) {
    const err = new Error("Invalid conversationId: exceeds 256 characters");
    err.statusCode = 400;
    throw err;
  }
  return trimmed;
}

function normalizeConversationId(val) {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
}

function convFlagKey(conversationId) {
  return crypto.createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 32);
}

function setThreadOwnerRecord(threadId, ownerConversationId, ownerGen) {
  if (!threadId || threadId === "unknown") return;
  // Preserve valid ownership for the entire daemon instance lifetime (never silently evict)
  threadOwners.set(threadId, { ownerConversationId: ownerConversationId || null, ownerGen });
}

function bindNewThreadOwner(st, rawConvId) {
  const convId = normalizeConversationId(rawConvId);
  const prevOwner = st.ownerConversationId;
  st.ownerConversationId = convId;
  st.ownerGen = nextOwnerGen++;
  setThreadOwnerRecord(st.threadId, st.ownerConversationId, st.ownerGen);
  if (prevOwner && prevOwner !== st.ownerConversationId) refreshConversationFlags(prevOwner);
  if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
}

function hasActiveBatchForThread(threadId, now = Date.now()) {
  for (const b of activeBatches.values()) {
    if (now >= b.expiresAt) continue;
    if (b.entries.some((e) => e.threadId === threadId)) return true;
  }
  return false;
}

function hasUnexpiredNotificationOrOverflow(st, now = Date.now()) {
  if (st.hookNotifications.some((n) => n.ownerGen === st.ownerGen && now - n.createdAtMs < NOTIF_TTL_MS)) {
    return true;
  }
  if (st.overflowTotal > st.overflowAckedThrough && (st.overflowUpdatedAtMs === 0 || now - st.overflowUpdatedAtMs < NOTIF_TTL_MS)) {
    return true;
  }
  return false;
}

function syncFlagFile(filePath, wantExist) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (wantExist) {
        fs.writeFileSync(filePath, "", { mode: 0o600 });
      } else {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          if (err && err.code !== "ENOENT") throw err;
        }
      }
      return true;
    } catch (err) {
      if (attempt < 2 && err && (err.code === "EPERM" || err.code === "EBUSY")) {
        continue;
      }
      const now = Date.now();
      if (now - flagRetryLogLastMs > 30_000) {
        flagRetryLogLastMs = now;
        logDaemon(`Flag sync failed (${wantExist ? "create" : "unlink"} ${filePath}): ${err.message}`);
      }
      return false;
    }
  }
  return false;
}

function isWaiterConnected(w) {
  return Boolean(w && w.res && !w.res.destroyed && !w.res.writableEnded);
}

function isEligibleWaiterBase(st, w) {
  return Boolean(
    isWaiterConnected(w) &&
      st.ownerConversationId !== null &&
      w.ownerConversationId === st.ownerConversationId &&
      w.ownerGen === st.ownerGen
  );
}

function hasEligibleWaiterForEvent(st, seq, level = "critical") {
  for (const w of st.waiters) {
    if (isEligibleWaiterBase(st, w) && seq > w.afterSeq && levelMatches(level, w.eventsFilter)) {
      return true;
    }
  }
  return false;
}

function hasEligibleWaiterForPending(st, reqEntry = null) {
  const reqSeq = reqEntry?.eventSeq || 0;
  for (const w of st.waiters) {
    if (!isEligibleWaiterBase(st, w)) continue;
    // Ahead-of-head waiter (afterSeq >= eventSeq) will NOT receive this request in pushEvent and MUST NOT suppress Hook
    if (reqSeq > 0) {
      if (reqSeq > w.afterSeq) return true;
    } else if (w.afterSeq <= st.nextSeq - 1) {
      return true;
    }
  }
  return false;
}

function hasEligibleWaiterForFuture(st) {
  const headSeq = st.nextSeq - 1;
  for (const w of st.waiters) {
    if (isEligibleWaiterBase(st, w) && w.afterSeq <= headSeq && levelMatches("critical", w.eventsFilter)) {
      return true;
    }
  }
  return false;
}

function computeConversationFlagState(conversationId) {
  let wantUnread = false;
  let wantActive = false;
  for (const st of threads.values()) {
    if (st.ownerConversationId !== conversationId) continue;
    const hasNotif = st.hookNotifications.some((n) => n.ownerGen === st.ownerGen);
    const hasOverflow = st.overflowTotal > st.overflowAckedThrough;
    let hasPending = false;
    for (const r of pendingServerRequests.values()) {
      if (r.threadId === st.threadId && r.ownerGen === st.ownerGen) {
        hasPending = true;
        break;
      }
    }
    if (hasNotif || hasOverflow || hasPending) {
      wantUnread = true;
    }
    if (hasPending || (st.status === "running" && !hasEligibleWaiterForFuture(st))) {
      wantActive = true;
    }
    if (wantUnread && wantActive) break;
  }
  return { unread: wantUnread, active: wantActive };
}

function refreshConversationFlags(conversationId, force = false) {
  if (!conversationId || shuttingDown) return;
  const desired = computeConversationFlagState(conversationId);
  const prev = convFlagCache.get(conversationId);
  if (!force && !flagDirty.has(conversationId) && prev && prev.unread === desired.unread && prev.active === desired.active) {
    return;
  }
  const key = convFlagKey(conversationId);
  const unreadPath = path.join(INSTANCE_HOOKS_DIR, `unread-${key}.flag`);
  const activePath = path.join(INSTANCE_HOOKS_DIR, `active-${key}.flag`);
  const ok1 = syncFlagFile(unreadPath, desired.unread);
  const ok2 = syncFlagFile(activePath, desired.active);
  if (ok1 && ok2) {
    if (!desired.unread && !desired.active) {
      convFlagCache.delete(conversationId);
    } else {
      convFlagCache.set(conversationId, desired);
    }
    flagDirty.delete(conversationId);
  } else {
    flagDirty.add(conversationId);
  }
}

function recordOverflow(st, count = 1, now = Date.now()) {
  st.overflowTotal += count;
  st.overflowUpdatedAtMs = now;
}

function normalizeNotificationKind(kind, data) {
  if (kind === "turn_completed" && data?.status === "interrupted") return "turn_interrupted";
  return kind;
}

const HOOK_NOTIFICATION_KINDS = new Set(["supervisor_message", "turn_completed", "turn_error", "daemon_error"]);

function buildCompactNotifData(normKind, data) {
  const out = {};
  if (normKind === "supervisor_message") {
    out.message = truncateText(String(data?.message || ""), MAX_INLINE_TEXT);
    if (data?.truncated) out.truncated = true;
  } else if (normKind === "turn_completed" || normKind === "turn_interrupted") {
    if (data?.status) out.status = data.status;
    if (data?.lastMessage) out.message = truncateText(String(data.lastMessage), MAX_INLINE_TEXT);
    if (Array.isArray(data?.turnFiles) && data.turnFiles.length > 0) out.files = data.turnFiles.slice(0, 20);
    if (data?.turnCommandsCount) out.turnCommandsCount = data.turnCommandsCount;
  } else if (normKind === "turn_error" || normKind === "daemon_error") {
    const errVal = data?.error?.message || data?.error || data?.message || "Unknown error";
    out.error = truncateText(String(typeof errVal === "string" ? errVal : JSON.stringify(errVal)), 1200);
    if (data?.lastMessage) out.message = truncateText(String(data.lastMessage), MAX_INLINE_TEXT);
  }
  return out;
}

function evictOneFromThreadNotifs(st, now) {
  if (st.hookNotifications.length === 0) return false;
  const isUnleased = (n) => !n.leaseBatchId || now >= n.leaseUntil;
  // Prefer evicting unleased supervisor_message -> unleased non-terminal -> unleased oldest -> leased supervisor_message -> oldest
  let idx = st.hookNotifications.findIndex((n) => n.kind === "supervisor_message" && isUnleased(n));
  if (idx === -1) idx = st.hookNotifications.findIndex((n) => isUnleased(n));
  if (idx === -1) idx = st.hookNotifications.findIndex((n) => n.kind === "supervisor_message");
  if (idx === -1) idx = 0;
  st.hookNotifications.splice(idx, 1);
  recordOverflow(st, 1, now);
  return true;
}

function enforceGlobalNotifCap(now = Date.now()) {
  let total = 0;
  for (const st of threads.values()) total += st.hookNotifications.length;
  const isUnleased = (n) => !n.leaseBatchId || now >= n.leaseUntil;
  const pickVictim = (predicate) => {
    let victimSt = null;
    let victimIdx = -1;
    let victimTs = Infinity;
    for (const st of threads.values()) {
      for (let i = 0; i < st.hookNotifications.length; i++) {
        const n = st.hookNotifications[i];
        if (predicate(n) && n.createdAtMs < victimTs) {
          victimSt = st;
          victimIdx = i;
          victimTs = n.createdAtMs;
        }
      }
    }
    return victimSt ? { victimSt, victimIdx } : null;
  };
  while (total > MAX_GLOBAL_NOTIFS) {
    const picked =
      pickVictim((n) => n.kind === "supervisor_message" && isUnleased(n)) ||
      pickVictim((n) => isUnleased(n)) ||
      pickVictim((n) => n.kind === "supervisor_message") ||
      pickVictim(() => true);
    if (!picked) break;
    picked.victimSt.hookNotifications.splice(picked.victimIdx, 1);
    recordOverflow(picked.victimSt, 1, now);
    total--;
    if (picked.victimSt.ownerConversationId) refreshConversationFlags(picked.victimSt.ownerConversationId);
  }
}

function enqueueHookNotification(st, ev) {
  if (!HOOK_NOTIFICATION_KINDS.has(ev.kind)) return null;
  const now = Date.now();
  const normKind = normalizeNotificationKind(ev.kind, ev.data);
  const item = {
    notifId: `${INSTANCE_ID}:n${nextNotifId++}`,
    seq: ev.seq,
    kind: normKind,
    turnId: ev.turnId || null,
    ownerGen: st.ownerGen,
    data: buildCompactNotifData(normKind, ev.data),
    createdAtMs: now,
    leaseBatchId: null,
    leaseUntil: 0,
  };
  st.hookNotifications.push(item);
  while (st.hookNotifications.length > MAX_THREAD_NOTIFS) {
    if (!evictOneFromThreadNotifs(st, now)) break;
  }
  enforceGlobalNotifCap(now);
  return item;
}

function pruneExpiredBatchesAndNotifications(now = Date.now()) {
  const affectedConvs = new Set();
  for (const [bid, batch] of activeBatches.entries()) {
    if (now >= batch.expiresAt) {
      activeBatches.delete(bid);
      if (batch.conversationId) affectedConvs.add(batch.conversationId);
    }
  }
  for (const st of threads.values()) {
    let changed = false;
    for (let i = st.hookNotifications.length - 1; i >= 0; i--) {
      const n = st.hookNotifications[i];
      if (n.leaseBatchId && now >= n.leaseUntil) {
        n.leaseBatchId = null;
        n.leaseUntil = 0;
      }
      if (now - n.createdAtMs >= NOTIF_TTL_MS) {
        st.hookNotifications.splice(i, 1);
        recordOverflow(st, 1, now);
        changed = true;
      }
    }
    if (st.overflowTotal > st.overflowAckedThrough && st.overflowUpdatedAtMs > 0 && now - st.overflowUpdatedAtMs >= NOTIF_TTL_MS) {
      st.overflowAckedThrough = st.overflowTotal;
      changed = true;
    }
    if (changed && st.ownerConversationId) affectedConvs.add(st.ownerConversationId);
  }
  for (const c of affectedConvs) refreshConversationFlags(c);
}

/**
 * Unified synchronous batch issuance shared by `/inbox` and `/wait`.
 * Only leases notifications that currently have NO unexpired lease; first channel wins.
 */
function issueAckBatch(conversationId, candidates, now = Date.now()) {
  pruneExpiredBatchesAndNotifications(now);
  const entries = [];
  const toLease = [];

  for (const cand of candidates) {
    const { st, notifIds = [], pendingReqIds = [], includeOverflow = false } = cand;
    if (!st) continue;
    const wantedNotifSet = new Set(notifIds);
    const leasedNotifIds = [];
    for (const n of st.hookNotifications) {
      if (n.ownerGen !== st.ownerGen) continue;
      if (!wantedNotifSet.has(n.notifId)) continue;
      if (n.leaseBatchId && now < n.leaseUntil) continue; // Already held by another active batch
      leasedNotifIds.push(n.notifId);
      toLease.push(n);
    }

    const validPendingIds = [];
    for (const reqId of pendingReqIds) {
      const r = pendingServerRequests.get(reqId);
      if (r && r.threadId === st.threadId && r.ownerGen === st.ownerGen) {
        validPendingIds.push(reqId);
      }
    }

    const overflowThrough = includeOverflow && st.overflowTotal > st.overflowAckedThrough ? st.overflowTotal : 0;

    if (leasedNotifIds.length > 0 || validPendingIds.length > 0 || overflowThrough > 0) {
      entries.push({
        threadId: st.threadId,
        ownerGen: st.ownerGen,
        notifIds: leasedNotifIds,
        overflowThrough,
        pendingReqIds: validPendingIds,
      });
    }
  }

  if (entries.length === 0) return null;

  const batchId = `${INSTANCE_ID}:b${nextBatchSeq++}`;
  const expiresAt = now + BATCH_LEASE_MS;
  for (const n of toLease) {
    n.leaseBatchId = batchId;
    n.leaseUntil = expiresAt;
  }

  activeBatches.set(batchId, {
    batchId,
    instanceId: INSTANCE_ID,
    conversationId: conversationId || null,
    expiresAt,
    entries,
  });
  return { batchId, expiresAt };
}

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
    const savedOwner = threadOwners.get(threadId);
    st = {
      threadId,
      ownerConversationId: savedOwner?.ownerConversationId ?? null,
      ownerGen: savedOwner?.ownerGen ?? 0,
      name: null,
      cwd: null,
      model: null,
      effort: null,
      settingsRevision: 0,
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
      hookNotifications: [],
      overflowTotal: 0,
      overflowAckedThrough: 0,
      overflowUpdatedAtMs: 0,
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

function showDesktopThread(threadId, enabled) {
  if (!enabled) return;
  openDesktop(threadId, true);
  if (process.platform === "win32") {
    // 旧全局 hook 也按日志修改时间去重，交接期间共用这个标记。
    const log = fs.statSync(getThreadState(threadId).logPath, { throwIfNoEntry: false });
    if (log) {
      try { writeJsonAtomic(path.join(STATE_DIR, "last-opened.json"), { threadId, mtimeMs: log.mtimeMs }); }
      catch (err) { logDaemon("无法记录桌面跳转：" + err.message); }
    }
  }
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
  if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
  return true;
}

function compactRequest(r) {
  const p = r.params || {};
  if (r.method === "item/tool/call" && p.tool === "message_supervisor") {
    return {
      reqId: r.reqId,
      tool: "message_supervisor",
      message: truncateText(String(r.supervisorMessage || ""), MAX_INLINE_TEXT),
      ...(r.submitting ? { submitting: true } : {}),
    };
  }
  const out = { reqId: r.reqId, method: r.method };
  if (r.submitting) out.submitting = true;
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

function buildWaitPayload(st, { timedOut, matched, gap, eventsFilter, rendered = null }) {
  const latestSeq = st.nextSeq - 1;
  const pending = listPendingRequests(st.threadId).map(compactRequest);
  const actualTimedOut = matched.length > 0 ? false : Boolean(timedOut);

  const terminalEvs = matched.filter((e) => e.kind === "turn_completed" || e.kind === "turn_error" || e.kind === "daemon_error");
  const terminalEv = terminalEvs[terminalEvs.length - 1] || null;
  const supMsgEvs = matched.filter((e) => e.kind === "supervisor_message");
  const msgEvs = matched.filter((e) => e.kind === "agent_message");
  const planEv = [...matched].reverse().find((e) => e.kind === "plan_updated");

  const summarizeTerminal = (ev) => {
    const errVal = ev.data?.error?.message || ev.data?.error || (ev.kind === "daemon_error" ? ev.data?.message : null);
    return {
      kind: ev.kind === "turn_completed" && ev.data?.status === "interrupted" ? "turn_interrupted" : ev.kind,
      turnId: ev.turnId || undefined,
      ...(ev.data?.lastMessage ? { message: ev.data.lastMessage } : {}),
      ...(errVal ? { error: errVal } : {}),
    };
  };

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
    if (rendered) {
      for (const r of pending) rendered.reqIds.add(r.reqId);
    }
    // Never silently drop supervisor_message events that arrived in the same batch before a pending request
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
      if (rendered) {
        for (const e of supMsgEvs) rendered.notifSeqs.add(e.seq);
      }
    }
    // If any terminal event coexists with a pending request, include full message/error summary so nothing is lost
    if (terminalEvs.length > 0) {
      out.terminalEvents = terminalEvs.map(summarizeTerminal);
      if (rendered) {
        for (const e of terminalEvs) rendered.notifSeqs.add(e.seq);
      }
    }
  } else if (wakeup === "supervisor_message" && supMsgEvs.length > 0) {
    out.message = supMsgEvs.length === 1 ? supMsgEvs[0].data.message : supMsgEvs.map((e) => e.data.message).join("\n---\n");
    if (rendered) {
      for (const e of supMsgEvs) rendered.notifSeqs.add(e.seq);
    }
    if (supMsgEvs.some((e) => e.data.truncated)) {
      out.truncated = true;
      out.logPath = st.logPath;
    }
  } else if (wakeup === "turn_completed" && terminalEv) {
    const msg = terminalEv.data?.lastMessage || "";
    if (msg) out.message = msg;
    if (rendered) {
      for (const e of terminalEvs) rendered.notifSeqs.add(e.seq);
    }
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
      if (rendered) {
        for (const e of supMsgEvs) rendered.notifSeqs.add(e.seq);
      }
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
    if (rendered) {
      for (const e of terminalEvs) rendered.notifSeqs.add(e.seq);
    }
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
      if (rendered) {
        for (const e of supMsgEvs) rendered.notifSeqs.add(e.seq);
      }
    }
    if (terminalEvs.length > 1) {
      out.earlierTerminalEvents = terminalEvs.slice(0, -1).map(summarizeTerminal);
    }
  } else if ((wakeup === "turn_error" || wakeup === "daemon_error") && terminalEv) {
    out.error = terminalEv.data?.error?.message || terminalEv.data?.error || st.lastError;
    if (terminalEv.data?.lastMessage) out.message = terminalEv.data.lastMessage;
    if (rendered) {
      for (const e of terminalEvs) rendered.notifSeqs.add(e.seq);
    }
    if (supMsgEvs.length > 0) {
      out.supervisorMessages = supMsgEvs.map((e) => e.data.message);
      if (rendered) {
        for (const e of supMsgEvs) rendered.notifSeqs.add(e.seq);
      }
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
    if (pending.length > 0) {
      out.requests = pending;
      if (rendered) {
        for (const r of pending) rendered.reqIds.add(r.reqId);
      }
    }
    if (st.lastMessage) out.message = truncateText(st.lastMessage, 600);
    if (st.lastError) out.error = st.lastError?.message || st.lastError;
  } else if (wakeup === "idle" && st.lastMessage) {
    out.message = truncateText(st.lastMessage, 800);
  }

  // Only include granular timeline when caller explicitly requests `--events all`
  // Note: seq/kind-only timeline rows do NOT count as rendered notification bodies for ACK.
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

function attachWaitAckBatch(st, payload, rendered, { supportsAckBatch, ownerConversationId, ownerGen }) {
  if (!supportsAckBatch) return payload;
  if (!st.ownerConversationId || ownerConversationId !== st.ownerConversationId || ownerGen !== st.ownerGen) {
    return payload;
  }
  const notifIds = [];
  if (rendered.notifSeqs.size > 0) {
    for (const n of st.hookNotifications) {
      if (n.ownerGen === st.ownerGen && rendered.notifSeqs.has(n.seq)) {
        notifIds.push(n.notifId);
      }
    }
  }
  const pendingReqIds = Array.from(rendered.reqIds);
  if (notifIds.length === 0 && pendingReqIds.length === 0) return payload;

  const batch = issueAckBatch(ownerConversationId, [
    { st, notifIds, pendingReqIds, includeOverflow: false },
  ]);
  if (batch) {
    payload.ackBatchId = batch.batchId;
    payload.ackExpiresAt = batch.expiresAt;
  }
  return payload;
}

function resolveWaiter(st, waiter, timedOut = false) {
  if (!cleanupWaiter(st, waiter)) return;
  const matched = st.events.filter((e) => e.seq > waiter.afterSeq && levelMatches(e.level, waiter.eventsFilter));
  const gap = detectCursorGap(st, waiter.afterSeq, waiter.afterProvided, waiter.instanceMismatch);
  const rendered = { notifSeqs: new Set(), reqIds: new Set() };
  const payload = buildWaitPayload(st, { timedOut, matched, gap, eventsFilter: waiter.eventsFilter, rendered });
  if (isWaiterConnected(waiter)) {
    attachWaitAckBatch(st, payload, rendered, waiter);
  }
  waiter.resolve(payload);
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

  // Invariant 1: ALWAYS record target critical notifications first, even when eligible waiters exist
  if (level === "critical" && HOOK_NOTIFICATION_KINDS.has(kind)) {
    enqueueHookNotification(st, ev);
  }

  for (const waiter of Array.from(st.waiters)) {
    if (ev.seq <= waiter.afterSeq) continue;
    if (!levelMatches(ev.level, waiter.eventsFilter)) continue;

    if (ev.level === "critical") {
      resolveWaiter(st, waiter, false);
    } else if (!waiter.coalesceTimer) {
      waiter.coalesceTimer = setTimeout(() => resolveWaiter(st, waiter, false), COALESCE_MS);
    }
  }

  if (st.ownerConversationId && (level === "critical" || kind === "turn_started")) {
    refreshConversationFlags(st.ownerConversationId);
  }
  return ev;
}

function prunePendingRequestsForThread(threadId, turnId = null) {
  let removed = false;
  for (const [reqId, r] of pendingServerRequests.entries()) {
    if (r.threadId !== threadId) continue;
    if (turnId && r.turnId && r.turnId !== turnId) continue;
    pendingServerRequests.delete(reqId);
    removed = true;
  }
  if (removed) {
    const st = threads.get(threadId);
    if (st?.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
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
      ownerGen: r.ownerGen,
      inboxRead: Boolean(r.inboxRead),
      submitting: Boolean(r.submitting),
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
    ownerConversationId: st.ownerConversationId,
    ownerGen: st.ownerGen,
    name: st.name,
    cwd: st.cwd,
    model: st.model,
    effort: st.effort,
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
    unackedNotificationsCount: st.hookNotifications.filter((n) => n.ownerGen === st.ownerGen).length,
    unreportedOverflowCount: Math.max(0, st.overflowTotal - st.overflowAckedThrough),
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

  if (method === "thread/settings/updated" && threadId) {
    const st = threads.get(threadId);
    if (st) {
      st.model = p.threadSettings.model;
      st.effort = p.threadSettings.effort;
      st.settingsRevision++;
      appendThreadLog(st, { kind: "session_selection", model: st.model, effort: st.effort });
    }
    return;
  }
  if (method === "model/rerouted" && threadId) {
    const st = getThreadState(threadId);
    st.model = p.toModel;
    st.reroutedTurn = p.turnId;
    appendThreadLog(st, { kind: "model_rerouted", model: p.toModel, turnId: p.turnId });
    return;
  }

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
      if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
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
    appendThreadLog(st, { kind: "token_usage", turnId: p.turnId, tokenUsage: p.tokenUsage });
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
  "and with `wait_for_reply: true` when you are blocked and need a decision, clarification, or confirmation from the supervisor — " +
  "or whenever the supervisor explicitly instructs you in the prompt to call `message_supervisor`. " +
  "Otherwise do not call it for routine file reads, minor edits, or final completion (just return your final answer normally).";

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
    const qEntry = {
      reqId,
      rpcId: msg.id,
      method,
      threadId,
      turnId,
      ownerGen: st.ownerGen,
      eventSeq: 0,
      inboxRead: false,
      submitting: false,
      params: p,
      supervisorMessage: text,
      createdAt: new Date().toISOString(),
    };
    pendingServerRequests.set(reqId, qEntry);
    st.status = "waiting_input";
    const qEv = pushEvent(threadId, "critical", "supervisor_question", turnId, {
      reqId,
      message: truncateText(text, MAX_INLINE_TEXT),
    });
    qEntry.eventSeq = qEv.seq;
    return;
  }

  // Resolve legacy p.conversationId only to known Codex threads; never treat it as an Antigravity owner
  let threadId = p.threadId || null;
  if (!threadId && p.conversationId && (threads.has(p.conversationId) || threadOwners.has(p.conversationId))) {
    threadId = p.conversationId;
  }
  if (!threadId) threadId = p.conversationId || "unknown";
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
    ownerGen: st.ownerGen,
    eventSeq: 0,
    inboxRead: false,
    submitting: false,
    params: p,
    preview,
    createdAt: new Date().toISOString(),
  };
  pendingServerRequests.set(reqId, entry);
  st.status = "waiting_input";

  const isUserInput = method === "item/tool/requestUserInput";
  const reqEv = pushEvent(
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
  entry.eventSeq = reqEv.seq;
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
    } else if (st.ownerConversationId) {
      refreshConversationFlags(st.ownerConversationId);
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

function lockFirstDispatch(scope, run) {
  // 同一未派单对话的保存和首次绑定按顺序执行。
  const key = scope?.sessionKey || scope?.conversationId;
  return key ? withThreadLock("session-settings:" + key, run) : run();
}

async function dispatchSettings(raw, scope, cwd) {
  const overrides = scope ? { ...sessionSettings(STATE_DIR, scope) } : {};
  delete overrides.pending;
  delete overrides.bound;
  for (const field of ["model", "effort"]) if (raw[field]) overrides[field] = raw[field];
  let { model, effort } = applyDefaults(overrides, readSettings());
  if (!model || !effort) {
    const { config } = await rpcCall("config/read", { cwd: raw.cwd || cwd });
    model ||= config.model;
    effort ||= config.model_reasoning_effort;
    if (!model || !effort) {
      let cursor;
      do {
        const page = await rpcCall("model/list", { limit: 100, cursor });
        const entry = (page.data || page.models).find(m => model ? m.id === model || m.model === model : m.isDefault);
        if (entry) {
          model ||= entry.model || entry.id;
          effort ||= entry.defaultReasoningEffort;
          break;
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
  }
  return { ...raw, model, effort, overrides };
}

async function startSelectedTurn(st, body, params) {
  const revision = st.settingsRevision;
  const result = await rpcCall("turn/start", params);
  const turnId = result.turn?.id || result.turnId || null;
  // 同一次请求期间收到的实际配置或改派通知优先于请求参数。
  if (revision === st.settingsRevision) {
    if (!turnId || st.reroutedTurn !== turnId) st.model = body.model || st.model;
    st.effort = body.effort ?? st.effort;
  }
  if (params.cwd) st.cwd = params.cwd;
  markTurnStartedIfNotFinished(st, turnId);
  writeSessionSettings(STATE_DIR, { threadId: st.threadId }, body.overrides);
  return turnId;
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

function handleHookPoll(body) {
  const now = Date.now();
  pruneExpiredBatchesAndNotifications(now);

  const conversationId = normalizeConversationId(body.conversationId);
  const hookEventName = typeof body.hookEventName === "string" ? body.hookEventName : "";
  if (!conversationId || (hookEventName !== "PreInvocation" && hookEventName !== "Stop")) {
    return { instanceId: INSTANCE_ID, action: "none" };
  }

  let claimableNotifCount = 0;
  let overflowTotalUnreported = 0;
  let unreadPendingCount = 0;
  let unresolvedPendingCount = 0;
  let runningUnwaitedCount = 0;
  const preThreads = new Set();
  const stopThreads = new Set();

  for (const st of threads.values()) {
    if (st.ownerConversationId !== conversationId) continue;

    let threadHasPreItem = false;
    let threadHasStopItem = false;

    for (const n of st.hookNotifications) {
      if (n.ownerGen !== st.ownerGen) continue;
      if (n.leaseBatchId && now < n.leaseUntil) continue;
      if (hasEligibleWaiterForEvent(st, n.seq, "critical")) continue;
      claimableNotifCount++;
      threadHasPreItem = true;
      threadHasStopItem = true;
    }

    const unreportedOverflow = Math.max(0, st.overflowTotal - st.overflowAckedThrough);
    if (unreportedOverflow > 0) {
      // Hook overflows are NOT masked by ordinary /wait (which cannot report Hook overflow)
      overflowTotalUnreported += unreportedOverflow;
      threadHasPreItem = true;
      threadHasStopItem = true;
    }

    for (const r of pendingServerRequests.values()) {
      if (r.threadId !== st.threadId || r.ownerGen !== st.ownerGen) continue;
      if (hasEligibleWaiterForPending(st, r)) continue;
      unresolvedPendingCount++;
      threadHasStopItem = true;
      if (!r.inboxRead) {
        unreadPendingCount++;
        threadHasPreItem = true;
      }
    }

    if (st.status === "running" && !hasEligibleWaiterForFuture(st)) {
      runningUnwaitedCount++;
    }

    if (threadHasPreItem) preThreads.add(st.threadId);
    if (threadHasStopItem) stopThreads.add(st.threadId);
  }

  if (hookEventName === "PreInvocation") {
    const unreadTotal = claimableNotifCount + overflowTotalUnreported;
    if (unreadTotal === 0 && unreadPendingCount === 0) {
      return { instanceId: INSTANCE_ID, action: "none" };
    }
    const sig = `${preThreads.size}:${claimableNotifCount}:${overflowTotalUnreported}:${unreadPendingCount}`;
    const prev = convNudgeState.get(conversationId);
    if (prev && prev.signature === sig && now - prev.lastNudgeAt < HOOK_NUDGE_COOLDOWN_MS) {
      return { instanceId: INSTANCE_ID, action: "none", throttled: true };
    }
    convNudgeState.set(conversationId, { signature: sig, lastNudgeAt: now });
    return {
      instanceId: INSTANCE_ID,
      action: "inject",
      threads: preThreads.size,
      unread: unreadTotal,
      pending: unreadPendingCount,
    };
  }

  // Stop hook (skips PreInvocation 15s cooldown; strict boolean check on continuationActive)
  if (!NORMAL_STOP_REASONS.has(body.terminationReason) || body.continuationActive !== false) {
    return { instanceId: INSTANCE_ID, action: "none" };
  }

  const stopUnreadTotal = claimableNotifCount + overflowTotalUnreported;
  if (stopUnreadTotal > 0 || unresolvedPendingCount > 0) {
    return {
      instanceId: INSTANCE_ID,
      action: "stop_continue_inbox",
      threads: stopThreads.size,
      unread: stopUnreadTotal,
      pending: unresolvedPendingCount,
    };
  }

  if (body.fullyIdle === true && runningUnwaitedCount > 0) {
    return {
      instanceId: INSTANCE_ID,
      action: "stop_continue_wait",
      running: runningUnwaitedCount,
    };
  }

  return { instanceId: INSTANCE_ID, action: "none" };
}

function buildMinimalPendingSummary(r, st) {
  return {
    reqId: r.reqId,
    threadId: r.threadId,
    method: r.method,
    ...(r.params?.tool ? { tool: r.params.tool } : {}),
    inboxRead: Boolean(r.inboxRead),
    ...(r.submitting ? { submitting: true } : {}),
    truncated: true,
    logPath: st?.logPath || null,
  };
}

function handleInboxRead(body) {
  const now = Date.now();
  pruneExpiredBatchesAndNotifications(now);

  const reqConvId = parseOptionalConversationId(body.conversationId);
  const reqThreadId = typeof body.threadId === "string" && body.threadId.trim() ? body.threadId.trim() : null;
  const maxItems = Math.max(1, Math.min(INBOX_MAX_ITEMS, Number(body.limit || INBOX_MAX_ITEMS)));

  let selectedThreads = [];
  if (reqThreadId) {
    const st = threads.get(reqThreadId);
    if (st) {
      if (st.ownerConversationId !== null && st.ownerConversationId !== reqConvId) {
        const err = new Error(
          reqConvId
            ? `Thread "${reqThreadId}" is routed to another conversation.`
            : `Thread "${reqThreadId}" is routed to a specific conversation; ANTIGRAVITY_CONVERSATION_ID is required to read its inbox.`
        );
        err.statusCode = 403;
        throw err;
      }
      selectedThreads = [st];
    }
  } else if (reqConvId !== null) {
    selectedThreads = Array.from(threads.values()).filter((st) => st.ownerConversationId === reqConvId);
  } else {
    // Missing conversationId: NEVER read or consume threads routed to other conversations (only unowned threads)
    selectedThreads = Array.from(threads.values()).filter((st) => st.ownerConversationId === null);
  }

  // Rotate starting index across selected threads so no thread starves under pagination
  if (selectedThreads.length > 1) {
    const shift = inboxRotateOffset % selectedThreads.length;
    selectedThreads = selectedThreads.slice(shift).concat(selectedThreads.slice(0, shift));
    inboxRotateOffset = (inboxRotateOffset + 1) % 1_000_000;
  }

  const out = {
    instanceId: INSTANCE_ID,
    items: [],
    pendingRequests: [],
    overflows: [],
    inFlightLeasedCount: 0,
    readPendingTotal: 0,
    hasMore: false,
    threadsMeta: {},
  };

  const candidatesByThread = new Map(); // threadId -> { st, notifIds, pendingReqIds, includeOverflow }
  const ensureCandidate = (st) => {
    let c = candidatesByThread.get(st.threadId);
    if (!c) {
      c = { st, notifIds: [], pendingReqIds: [], includeOverflow: false };
      candidatesByThread.set(st.threadId, c);
    }
    return c;
  };
  const serializedBytes = () => Buffer.byteLength(JSON.stringify(out), "utf8");
  // Reserve headroom for batchId (~45B) and expiresAt (~25B) so final HTTP JSON is strictly <= INBOX_MAX_BYTES (16 KiB)
  const BYTE_BUDGET = INBOX_MAX_BYTES - 180;

  // Atomic append helper: enforces BOTH INBOX_MAX_THREADS (across all priorities) AND BYTE_BUDGET,
  // rolling back payload + threadsMeta together on rejection.
  const tryCommit = (st, applyFn, rollbackFn, { enforceThreadCap = true } = {}) => {
    const hadMeta = Object.prototype.hasOwnProperty.call(out.threadsMeta, st.threadId);
    if (enforceThreadCap && !hadMeta && Object.keys(out.threadsMeta).length >= INBOX_MAX_THREADS) {
      return false;
    }
    if (!hadMeta) {
      out.threadsMeta[st.threadId] = {
        status: st.status,
        nextCursor: formatCursor(st.nextSeq - 1),
        logPath: st.logPath,
      };
    }
    applyFn();
    if (serializedBytes() <= BYTE_BUDGET) {
      return true;
    }
    rollbackFn();
    if (!hadMeta) {
      delete out.threadsMeta[st.threadId];
    }
    return false;
  };

  // Count in-flight leased notifications & collect pending requests split by unread vs already-read
  const unreadPendingList = [];
  const readPendingList = [];
  for (const st of selectedThreads) {
    for (const n of st.hookNotifications) {
      if (n.ownerGen === st.ownerGen && n.leaseBatchId && now < n.leaseUntil) {
        out.inFlightLeasedCount++;
      }
    }
    for (const r of pendingServerRequests.values()) {
      if (r.threadId !== st.threadId || r.ownerGen !== st.ownerGen) continue;
      if (r.inboxRead) readPendingList.push({ st, r });
      else unreadPendingList.push({ st, r });
    }
  }
  out.readPendingTotal = readPendingList.length;

  // Priority 1: UNREAD live blocking requests (advances cleanly on ACK because ACK sets inboxRead = true)
  for (const { st, r } of unreadPendingList) {
    const fullReq = { threadId: st.threadId, inboxRead: false, ...compactRequest(r) };
    const addedFull = tryCommit(
      st,
      () => out.pendingRequests.push(fullReq),
      () => out.pendingRequests.pop()
    );
    if (addedFull) {
      ensureCandidate(st).pendingReqIds.push(r.reqId);
      continue;
    }
    const minReq = buildMinimalPendingSummary(r, st);
    const addedMin = tryCommit(
      st,
      () => out.pendingRequests.push(minReq),
      () => out.pendingRequests.pop()
    );
    if (addedMin) {
      ensureCandidate(st).pendingReqIds.push(r.reqId);
      continue;
    }
    out.hasMore = true;
    // Do NOT break if rejection was purely INBOX_MAX_THREADS: another unread request on an already-included thread may still fit
    if (Object.keys(out.threadsMeta).length < INBOX_MAX_THREADS) break;
  }

  // Priority 2: Unreported overflow watermarks
  for (const st of selectedThreads) {
    const unreported = Math.max(0, st.overflowTotal - st.overflowAckedThrough);
    if (unreported <= 0) continue;
    const ovObj = { threadId: st.threadId, unreportedCount: unreported, overflowThrough: st.overflowTotal };
    const added = tryCommit(
      st,
      () => out.overflows.push(ovObj),
      () => out.overflows.pop()
    );
    if (added) {
      ensureCandidate(st).includeOverflow = true;
    } else {
      out.hasMore = true;
      if (Object.keys(out.threadsMeta).length < INBOX_MAX_THREADS) break;
    }
  }

  // Priority 3: Claimable non-blocking & terminal notifications (round-robin across threads, bounded by global INBOX_MAX_THREADS & bytes)
  const queues = [];
  for (const st of selectedThreads) {
    const claimable = st.hookNotifications.filter(
      (n) => n.ownerGen === st.ownerGen && (!n.leaseBatchId || now >= n.leaseUntil)
    );
    if (claimable.length > 0) {
      queues.push({ st, list: claimable, idx: 0 });
    }
  }

  let madeProgress = true;
  while (madeProgress && out.items.length < maxItems) {
    madeProgress = false;
    for (const q of queues) {
      if (out.items.length >= maxItems) break;
      if (q.idx >= q.list.length) continue;
      const n = q.list[q.idx];
      const itemObj = {
        notifId: n.notifId,
        threadId: q.st.threadId,
        seq: n.seq,
        kind: n.kind,
        turnId: n.turnId,
        ...n.data,
      };
      const addedFull = tryCommit(
        q.st,
        () => out.items.push(itemObj),
        () => out.items.pop()
      );
      if (addedFull) {
        q.idx++;
        ensureCandidate(q.st).notifIds.push(n.notifId);
        madeProgress = true;
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(out.threadsMeta, q.st.threadId) && Object.keys(out.threadsMeta).length >= INBOX_MAX_THREADS) {
        out.hasMore = true;
        continue;
      }
      if (out.items.length === 0) {
        // Single oversized item: try minimal truncated summary and STILL verify BYTE_BUDGET
        const truncObj = {
          notifId: n.notifId,
          threadId: q.st.threadId,
          seq: n.seq,
          kind: n.kind,
          turnId: n.turnId,
          ...(n.data?.message ? { message: truncateText(n.data.message, 300) } : {}),
          ...(n.data?.error ? { error: truncateText(n.data.error, 300) } : {}),
          truncated: true,
          logPath: q.st.logPath,
        };
        const addedTrunc = tryCommit(
          q.st,
          () => out.items.push(truncObj),
          () => out.items.pop()
        );
        if (addedTrunc) {
          q.idx++;
          ensureCandidate(q.st).notifIds.push(n.notifId);
          madeProgress = true;
          continue;
        }
      }
      out.hasMore = true;
      madeProgress = false;
      break;
    }
  }

  for (const q of queues) {
    if (q.idx < q.list.length) {
      out.hasMore = true;
      break;
    }
  }

  // Priority 4: Already-read live blocking requests (respects global INBOX_MAX_THREADS & budget; omits silently using readPendingTotal)
  for (const { st, r } of readPendingList) {
    const compactRead =
      readPendingList.length <= 5
        ? { threadId: st.threadId, inboxRead: true, ...compactRequest(r) }
        : buildMinimalPendingSummary(r, st);
    const added = tryCommit(
      st,
      () => out.pendingRequests.push(compactRead),
      () => out.pendingRequests.pop()
    );
    if (!added) {
      if (!Object.prototype.hasOwnProperty.call(out.threadsMeta, st.threadId) && Object.keys(out.threadsMeta).length >= INBOX_MAX_THREADS) {
        continue;
      }
      const minRead = buildMinimalPendingSummary(r, st);
      const addedMin = tryCommit(
        st,
        () => out.pendingRequests.push(minRead),
        () => out.pendingRequests.pop()
      );
      if (!addedMin) break;
    }
  }

  const effectiveConvId = reqConvId;
  const batch = issueAckBatch(effectiveConvId, Array.from(candidatesByThread.values()), now);
  if (batch) {
    out.batchId = batch.batchId;
    out.expiresAt = batch.expiresAt;
  }

  return out;
}

function handleInboxAck(body) {
  const now = Date.now();
  pruneExpiredBatchesAndNotifications(now);

  const batchId = typeof body.batchId === "string" ? body.batchId.trim() : "";
  if (!batchId) {
    const err = new Error("batchId required");
    err.statusCode = 400;
    throw err;
  }

  const reqConvId = parseOptionalConversationId(body.conversationId);
  const batch = activeBatches.get(batchId);
  if (!batch) {
    return { ok: true, applied: 0, expired: true };
  }

  // Strict full conversation identity check: null matches ONLY null
  if ((reqConvId ?? null) !== (batch.conversationId ?? null)) {
    const err = new Error("Conversation mismatch for batchId");
    err.statusCode = 403;
    throw err;
  }

  activeBatches.delete(batchId);
  let applied = 0;
  const affectedConvs = new Set();

  for (const entry of batch.entries) {
    const st = threads.get(entry.threadId);
    if (!st || st.ownerGen !== entry.ownerGen) continue;

    if (entry.notifIds.length > 0) {
      const idSet = new Set(entry.notifIds);
      for (let i = st.hookNotifications.length - 1; i >= 0; i--) {
        const n = st.hookNotifications[i];
        // Late B1 ACK never touches B2 because leaseBatchId must match batchId strictly
        if (n.ownerGen === entry.ownerGen && idSet.has(n.notifId) && n.leaseBatchId === batchId) {
          st.hookNotifications.splice(i, 1);
          applied++;
        }
      }
    }

    if (entry.overflowThrough > 0 && entry.overflowThrough > st.overflowAckedThrough) {
      st.overflowAckedThrough = Math.max(st.overflowAckedThrough, entry.overflowThrough);
      applied++;
    }

    for (const reqId of entry.pendingReqIds) {
      const r = pendingServerRequests.get(reqId);
      if (r && r.threadId === entry.threadId && r.ownerGen === entry.ownerGen) {
        if (!r.inboxRead) {
          r.inboxRead = true;
          applied++;
        }
      }
    }

    if (st.ownerConversationId) affectedConvs.add(st.ownerConversationId);
  }

  for (const c of affectedConvs) refreshConversationFlags(c);
  return { ok: true, applied, expired: false };
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/health" && req.method === "GET") {
    return jsonResponse(res, 200, {
      ok: codexReady,
      pid: process.pid,
      instanceId: INSTANCE_ID,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { hookPoll: true, inbox: true },
      codexBin,
      codexInitInfo,
      activeThreads: Array.from(threads.values()).filter((t) => t.status === "running" || t.status === "waiting_input").length,
      pendingRequestsCount: pendingServerRequests.size,
    });
  }

  const auth = req.headers.authorization || "";

  // Dedicated least-privilege Hook route: accepts ONLY hookToken; empty probes do NOT extend idle TTL
  if (url.pathname === "/hook/poll" && req.method === "POST") {
    if (auth !== `Bearer ${hookToken}`) {
      return jsonResponse(res, 401, { error: "Unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const result = handleHookPoll(body);
      if (result.action !== "none") {
        lastActivityMs = Date.now();
      }
      return jsonResponse(res, 200, result);
    } catch (err) {
      const code = err.statusCode || 500;
      logDaemon(`Hook poll error (${code}): ${err.message}`);
      if (!res.writableEnded && !res.destroyed) {
        return jsonResponse(res, code, { error: err.message || String(err) });
      }
      return;
    }
  }

  if (auth !== `Bearer ${authToken}`) {
    return jsonResponse(res, 401, { error: "Unauthorized" });
  }

  lastActivityMs = Date.now();
  const dispatch = ["/start", "/resume", "/fork", "/send", "/steer", "/session-settings", "/sync-projects"].includes(url.pathname);
  if (dispatch && activeInstallers().length) return jsonResponse(res, 409, { error: "插件正在更新" });
  if (dispatch) dispatches++;

  try {
    if (url.pathname === "/update-idle" && req.method === "POST") {
      const busy = dispatches || pendingServerRequests.size || [...threads.values()].some(st =>
        st.activeTurnId || st.status === "running" || st.status === "waiting_input" || st.waiters.size ||
        hasUnexpiredNotificationOrOverflow(st));
      if (busy) return jsonResponse(res, 409, { error: "监管任务或未读通知尚未处理，请稍后更新" });
      return jsonResponse(res, 200, { idle: true });
    }
    if (url.pathname === "/sync-projects" && req.method === "POST") {
      await syncProjects();
      return jsonResponse(res, 200, { synced: true });
    }
    if (url.pathname === "/inbox" && req.method === "POST") {
      const body = await readJsonBody(req);
      return jsonResponse(res, 200, handleInboxRead(body));
    }

    if (url.pathname === "/inbox/ack" && req.method === "POST") {
      const body = await readJsonBody(req);
      return jsonResponse(res, 200, handleInboxAck(body));
    }
    if (url.pathname === "/session-settings" && req.method === "POST") {
      const data = await readJsonBody(req);
      return await lockFirstDispatch(data, async () => {
        const bound = data.conversationId ? boundThread(STATE_DIR, data.conversationId) : data.sessionKey && sessionSettings(STATE_DIR, { sessionKey: data.sessionKey }).bound;
        if ((data.conversationId || bound) && data.threadId && bound !== data.threadId) return jsonResponse(res, 409, { error: "对话绑定已改变，请刷新后再修改" });
        const scope = { ...data, threadId: bound || data.threadId };
        const save = () => {
          const prefs = sessionSettings(STATE_DIR, scope);
          for (const key of ["model", "effort"]) {
            if (data[key] === undefined) continue;
            if (typeof data[key] !== "string") throw new Error("会话设置格式无效");
            if (data[key]) prefs[key] = data[key];
            else delete prefs[key];
          }
          prefs.pending = true;
          writeSessionSettings(STATE_DIR, scope, prefs);
          return prefs;
        };
        return jsonResponse(res, 200, scope.threadId ? await withThreadLock(scope.threadId, save) : save());
      });
    }
    if (url.pathname === "/models" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 30);
      const all = url.searchParams.has("settings");
      const rows = [];
      let cursor;
      do {
        const data = await rpcCall("model/list", { limit, cursor });
        rows.push(...(data.data || data.models || []));
        cursor = data.nextCursor;
      } while (all && cursor);
      const items = rows.filter(m => !m.hidden).map((m) => ({
        id: m.id || m.model || m.slug,
        displayName: m.displayName || m.id,
        defaultReasoningEffort: m.defaultReasoningEffort || null,
        isDefault: Boolean(m.isDefault),
        supportedReasoningEfforts: (m.supportedReasoningEfforts || []).map(level => level.reasoningEffort),
      }));
      const config = all ? (await rpcCall("config/read", {})).config : {};
      return jsonResponse(res, 200, { models: items, configuredModel: config.model, configuredEffort: config.model_reasoning_effort });
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
      const settings = readSettings();
      const raw = await readJsonBody(req);
      const scope = raw.sessionKey ? { sessionKey: raw.sessionKey } : raw.ownerConversationId ? { conversationId: raw.ownerConversationId } : null;
      return await lockFirstDispatch(scope, async () => {
        const previous = raw.sessionKey && sessionSettings(STATE_DIR, scope).bound;
        if (previous) return jsonResponse(res, 409, { error: "这份首单设置已绑定会话，请用 send 续聊", threadId: previous });
        const body = await dispatchSettings(raw, scope);
        const reqMode = validateMode(body.mode);
        const startParams = {
          dynamicTools: [SUPERVISOR_DYNAMIC_TOOL],
          developerInstructions: body.developerInstructions
            ? `${SUPERVISOR_DEV_INSTRUCTIONS}\n\n${body.developerInstructions}`
            : SUPERVISOR_DEV_INSTRUCTIONS,
        };
        if (body.cwd) startParams.cwd = body.cwd;
        if (body.model) startParams.model = body.model;
        if (body.effort) startParams.config = { model_reasoning_effort: body.effort };
        if (body.sandbox) startParams.sandbox = body.sandbox;
        if (body.approvalPolicy) startParams.approvalPolicy = body.approvalPolicy;
        if (body.ephemeral !== undefined) startParams.ephemeral = Boolean(body.ephemeral);
        if (body.baseInstructions) startParams.baseInstructions = body.baseInstructions;

        const projectId = await syncProjects(body.projectId, body.cwd);
        if (projectId) startParams.projectId = projectId;
        const thRes = await rpcCall("thread/start", startParams);
        const threadId = thRes.thread?.id || thRes.threadId || thRes.id;

        const result = await withThreadLock(threadId, async () => {
          const st = getThreadState(threadId);
          // Bind notification routing synchronously BEFORE turn/start RPC
          bindNewThreadOwner(st, body.ownerConversationId);
          st.cwd = thRes.cwd || thRes.thread?.cwd || body.cwd || null;
          st.model = thRes.model || body.model || null;
          st.effort = thRes.reasoningEffort ?? body.effort ?? null;
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
            effort: st.effort,
            sandbox: st.sandbox,
            approvalPolicy: st.approvalPolicy,
          });

          if (!body.prompt) writeSessionSettings(STATE_DIR, { threadId: st.threadId }, body.overrides);
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
            turnId = await startSelectedTurn(st, body, turnParams);
            if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
            appendThreadLog(st, {
              kind: "supervisor_prompt",
              action: "start",
              turnId,
              model: st.model,
              effort: st.effort,
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
        if (body.prompt) {
          try {
            bindThread(STATE_DIR, body.ownerConversationId, threadId);
            if (scope) writeSessionSettings(STATE_DIR, scope, raw.sessionKey ? { bound: threadId } : {});
          }
          catch (err) { result.panelWarning = "任务已派发，会话绑定保存失败：" + err.message; }
          showDesktopThread(threadId, settings.openDesktop);
        }
        return jsonResponse(res, 200, result);
      });
    }

    if (url.pathname === "/resume" && req.method === "POST") {
      const raw = await readJsonBody(req);
      if (!raw.threadId) return jsonResponse(res, 400, { error: "threadId required" });
      if (raw.claimOwner && raw.prompt) {
        return jsonResponse(res, 400, { error: "resume --claim cannot be combined with --prompt; claim first, then call send" });
      }
      const reqMode = validateMode(raw.mode);
      const reqConvId = normalizeConversationId(raw.ownerConversationId);

      const out = await withThreadLock(raw.threadId, async () => {
        const body = await dispatchSettings(raw, { threadId: raw.threadId }, getThreadState(raw.threadId).cwd);
        const params = { threadId: body.threadId, excludeTurns: true };
        if (body.cwd) params.cwd = body.cwd;
        if (body.model) params.model = body.model;
        if (body.effort) params.config = { model_reasoning_effort: body.effort };
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
        st.model = resData.model || body.model || st.model;
        st.effort = resData.reasoningEffort ?? body.effort ?? st.effort;
        st.sandbox = effSandbox || st.sandbox;
        st.approvalPolicy = effApproval || st.approvalPolicy;
        st.name = resData.thread?.name || st.name;

        if (mismatches.length > 0) {
          const err = new Error(`Resume constraint mismatch (upstream kept loaded thread settings): ${mismatches.join("; ")}`);
          err.statusCode = 409;
          throw err;
        }

        // Synchronous ownership claim/transfer critical section (NO await between checks and commit)
        pruneExpiredBatchesAndNotifications();
        if (reqConvId) {
          if (!st.ownerConversationId) {
            if (
              st.status !== "running" &&
              st.waiters.size === 0 &&
              !hasActiveBatchForThread(st.threadId)
            ) {
              st.ownerConversationId = reqConvId;
              st.ownerGen = nextOwnerGen++;
              setThreadOwnerRecord(st.threadId, st.ownerConversationId, st.ownerGen);
              // Atomically migrate any live unowned requests/notifications to the new ownerGen
              for (const r of pendingServerRequests.values()) {
                if (r.threadId === st.threadId) {
                  r.ownerGen = st.ownerGen;
                  r.inboxRead = false;
                }
              }
              for (const n of st.hookNotifications) {
                n.ownerGen = st.ownerGen;
                n.leaseBatchId = null;
                n.leaseUntil = 0;
              }
              refreshConversationFlags(st.ownerConversationId);
            } else if (body.claimOwner) {
              const err = new Error("Cannot claim unowned thread while it has an active turn, waiter, or in-flight batch.");
              err.statusCode = 409;
              throw err;
            }
          } else if (st.ownerConversationId !== reqConvId && body.claimOwner) {
            const reasons = [];
            if (st.activeTurnId || st.status === "running" || st.status === "waiting_input") {
              reasons.push(`status=${st.status}`);
            }
            if (listPendingRequests(st.threadId).length > 0) reasons.push("pending_requests");
            if (st.hookNotifications.some((n) => n.ownerGen === st.ownerGen)) reasons.push("unacked_notifications");
            if (st.overflowTotal > st.overflowAckedThrough) reasons.push("unreported_overflow");
            if (hasActiveBatchForThread(st.threadId)) reasons.push("active_batch");
            if (Array.from(st.waiters).some((w) => isEligibleWaiterBase(st, w))) reasons.push("active_owner_waiter");
            if (reasons.length > 0) {
              const err = new Error(`Cannot claim owned thread until it is clean (${reasons.join(", ")}).`);
              err.statusCode = 409;
              throw err;
            }
            const oldOwner = st.ownerConversationId;
            st.ownerConversationId = reqConvId;
            st.ownerGen = nextOwnerGen++;
            st.hookNotifications = [];
            st.overflowTotal = 0;
            st.overflowAckedThrough = 0;
            st.overflowUpdatedAtMs = 0;
            setThreadOwnerRecord(st.threadId, st.ownerConversationId, st.ownerGen);
            refreshConversationFlags(oldOwner);
            refreshConversationFlags(st.ownerConversationId);
          }
        } else if (body.claimOwner) {
          const err = new Error("resume --claim requires ANTIGRAVITY_CONVERSATION_ID (ownerConversationId).");
          err.statusCode = 400;
          throw err;
        }

        appendThreadLog(st, {
          kind: "thread_meta",
          action: "resume",
          name: st.name,
          cwd: st.cwd,
          model: st.model,
          effort: st.effort,
          sandbox: st.sandbox,
          approvalPolicy: st.approvalPolicy,
        });

        if (!body.prompt) writeSessionSettings(STATE_DIR, { threadId: st.threadId }, body.overrides);
        const cursorBefore = st.nextSeq - 1;
        let turnId = null;
        if (body.prompt) {
          const turnParams = { threadId: body.threadId, input: makeTextInput(body.prompt) };
          if (body.model) turnParams.model = body.model;
          if (body.effort) turnParams.effort = body.effort;
          applyCollaborationMode(turnParams, body, st);
          turnId = await startSelectedTurn(st, body, turnParams);
          if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
          appendThreadLog(st, {
            kind: "supervisor_prompt",
            action: "resume",
            turnId,
            model: st.model,
            effort: st.effort,
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
          ownerConversationId: st.ownerConversationId,
          effective: { cwd: st.cwd, sandbox: st.sandbox, approvalPolicy: st.approvalPolicy, model: st.model, effort: st.effort },
          logPath: st.logPath,
        };
      });
      return jsonResponse(res, 200, out);
    }

    if (url.pathname === "/fork" && req.method === "POST") {
      const raw = await readJsonBody(req);
      if (!raw.threadId) return jsonResponse(res, 400, { error: "threadId required" });
      const body = await dispatchSettings(raw, { threadId: raw.threadId }, getThreadState(raw.threadId).cwd);
      const reqMode = validateMode(body.mode);

      const params = { threadId: body.threadId, excludeTurns: true };
      if (body.cwd) params.cwd = body.cwd;
      if (body.model) params.model = body.model;
      if (body.effort) params.config = { model_reasoning_effort: body.effort };
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
        // Bind routing ONLY on the new forked thread (source thread stays untouched)
        bindNewThreadOwner(st, body.ownerConversationId);
        st.cwd = effCwd || st.cwd;
        st.model = resData.model || body.model || st.model;
        st.effort = resData.reasoningEffort ?? body.effort ?? st.effort;
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
          effort: st.effort,
          sandbox: st.sandbox,
          approvalPolicy: st.approvalPolicy,
        });

        if (!body.prompt) writeSessionSettings(STATE_DIR, { threadId: st.threadId }, body.overrides);
        const cursorBefore = st.nextSeq - 1;
        let turnId = null;
        if (body.prompt) {
          const turnParams = { threadId: newThreadId, input: makeTextInput(body.prompt) };
          if (body.model) turnParams.model = body.model;
          if (body.effort) turnParams.effort = body.effort;
          try {
            applyCollaborationMode(turnParams, body, st);
            turnId = await startSelectedTurn(st, body, turnParams);
            if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
            appendThreadLog(st, {
              kind: "supervisor_prompt",
              action: "fork",
              turnId,
              model: st.model,
              effort: st.effort,
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
          effective: { cwd: st.cwd, sandbox: st.sandbox, approvalPolicy: st.approvalPolicy, model: st.model, effort: st.effort },
          logPath: st.logPath,
        };
      });
      return jsonResponse(res, 200, out);
    }

    if (url.pathname === "/send" && req.method === "POST") {
      const raw = await readJsonBody(req);
      const { openDesktop: shouldOpen } = readSettings();
      if (!raw.threadId || !raw.prompt) {
        return jsonResponse(res, 400, { error: "threadId and prompt required" });
      }
      const reqMode = validateMode(raw.mode);
      const out = await withThreadLock(raw.threadId, async () => {
        const body = await dispatchSettings(raw, { threadId: raw.threadId }, getThreadState(raw.threadId).cwd);
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

        const turnId = await startSelectedTurn(st, body, turnParams);
        if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
        appendThreadLog(st, {
          kind: "supervisor_prompt",
          action: "send",
          turnId,
          model: st.model,
          effort: st.effort,
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
      showDesktopThread(out.threadId, shouldOpen);
      return jsonResponse(res, 200, out);
    }

    if (url.pathname === "/steer" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { openDesktop: shouldOpen } = readSettings();
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
            const settings = await dispatchSettings(body, { threadId: st.threadId }, st.cwd);
            const turnId = await startSelectedTurn(st, settings, {
              model: settings.model, effort: settings.effort,
              threadId: body.threadId,
              input: makeTextInput(body.prompt),
            });
            if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
            appendThreadLog(st, {
              kind: "supervisor_prompt",
              action: "fallback_send",
              turnId,
              model: st.model,
              effort: st.effort,
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
            const settings = await dispatchSettings(body, { threadId: st.threadId }, st.cwd);
            const turnId = await startSelectedTurn(st, settings, {
              model: settings.model, effort: settings.effort,
              threadId: body.threadId,
              input: makeTextInput(body.prompt),
            });
            if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
            appendThreadLog(st, {
              kind: "supervisor_prompt",
              action: "fallback_send",
              turnId,
              model: st.model,
              effort: st.effort,
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
      showDesktopThread(out.threadId, shouldOpen);
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
      const stBefore = threads.get(entry.threadId);
      if (stBefore?.ownerConversationId) refreshConversationFlags(stBefore.ownerConversationId);
      try {
        await sendJsonRpcAsync({ jsonrpc: "2.0", id: entry.rpcId, result });
      } catch (err) {
        if (pendingServerRequests.get(reqId) === entry) {
          entry.submitting = false;
          const stRollback = threads.get(entry.threadId);
          if (stRollback?.ownerConversationId) refreshConversationFlags(stRollback.ownerConversationId);
        }
        throw err;
      }
      pendingServerRequests.delete(reqId);

      const st = getThreadState(entry.threadId);
      if (listPendingRequests(entry.threadId).length === 0 && st.activeTurnId) {
        st.status = "running";
      }
      appendThreadLog(st, { kind: "server_request_responded", reqId, method: entry.method, result });
      if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
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
      pruneExpiredBatchesAndNotifications();
      const st = getThreadState(body.threadId);
      const { seq: afterSeq, provided: afterProvided, instanceMismatch } = parseCursor(body.after);
      const timeoutSec = Math.max(1, Math.min(1800, Number(body.timeout ?? 600)));
      const eventsFilter = body.events || "critical";
      const callerConversationId = normalizeConversationId(body.ownerConversationId);
      const supportsAckBatch = Boolean(body.supportsAckBatch);
      const callerOwnerGen = st.ownerGen;
      const ackCtx = { supportsAckBatch, ownerConversationId: callerConversationId, ownerGen: callerOwnerGen };
      const gap = detectCursorGap(st, afterSeq, afterProvided, instanceMismatch);

      const respondWaitSync = (opts) => {
        const rendered = { notifSeqs: new Set(), reqIds: new Set() };
        const payload = buildWaitPayload(st, { ...opts, rendered });
        attachWaitAckBatch(st, payload, rendered, ackCtx);
        return jsonResponse(res, 200, payload);
      };

      // If daemon restarted or buffer truncated, wake immediately so supervisor can resync
      if (gap.cursorGap) {
        const existingAll = st.events.filter((e) => levelMatches(e.level, eventsFilter));
        return respondWaitSync({ timedOut: false, matched: existingAll.slice(-5), gap, eventsFilter });
      }

      const existing = st.events.filter((e) => e.seq > afterSeq && levelMatches(e.level, eventsFilter));
      const hasCriticalExisting = existing.some((e) => e.level === "critical");
      const pend = listPendingRequests(st.threadId);

      if (hasCriticalExisting || pend.length > 0) {
        return respondWaitSync({ timedOut: false, matched: existing, gap, eventsFilter });
      }

      if (existing.length > 0 && !st.activeTurnId) {
        return respondWaitSync({ timedOut: false, matched: existing, gap, eventsFilter });
      }

      if (!st.activeTurnId && !body.forceWait && existing.length === 0) {
        return respondWaitSync({ timedOut: false, matched: [], gap, eventsFilter });
      }

      if (res.destroyed || res.writableEnded) return;

      const payload = await new Promise((resolve) => {
        const waiter = {
          afterSeq,
          afterProvided,
          instanceMismatch,
          eventsFilter,
          ownerConversationId: callerConversationId,
          ownerGen: callerOwnerGen,
          supportsAckBatch,
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
        if (st.ownerConversationId) refreshConversationFlags(st.ownerConversationId);
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
  } finally {
    if (dispatch) dispatches--;
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

function writeJsonAtomic(filePath, obj) {
  const tmpFile = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmpFile, "wx", 0o600);
  let closed = false;
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2), "utf8");
    fs.closeSync(fd);
    closed = true;
    if (process.platform !== "win32") {
      fs.chmodSync(tmpFile, 0o600);
    }
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    if (!closed) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    throw err;
  }
}

function unlinkOwnedStateFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const st = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (st.instanceId === INSTANCE_ID || (!st.instanceId && st.pid === process.pid)) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

function cleanupAndExit(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  unlinkOwnedStateFile(STATE_FILE);
  unlinkOwnedStateFile(HOOK_STATE_FILE);
  try {
    fs.rmSync(INSTANCE_HOOKS_DIR, { recursive: true, force: true });
  } catch {}
  try {
    server.close();
  } catch {}
  // Terminate child process BEFORE releasing startup lock
  killCodexTree();
  if (winMutexServer) {
    try {
      winMutexServer.close();
    } catch {}
    winMutexServer = null;
  }
  if (ownsLock) {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const info = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        if (info.instanceId === INSTANCE_ID || (!info.instanceId && info.pid === process.pid)) {
          fs.unlinkSync(LOCK_FILE);
        }
      }
    } catch {}
  }
  process.exit(code);
}

process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

// Independent backoff retry for failed flag writes (recovers even when no new Codex events arrive)
setInterval(() => {
  if (shuttingDown || flagDirty.size === 0) return;
  for (const convId of Array.from(flagDirty)) {
    refreshConversationFlags(convId, true);
  }
}, FLAG_RETRY_MS).unref();

// Independent expired batch/notification TTL sweeper (runs even when IDLE_TIMEOUT_MS === 0)
setInterval(() => {
  if (shuttingDown) return;
  pruneExpiredBatchesAndNotifications();
}, Math.min(IDLE_SWEEP_MS, 30_000)).unref();

if (IDLE_TIMEOUT_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    pruneExpiredBatchesAndNotifications(now);
    // Evict long-idle threads from memory while preserving lightweight threadOwners & nextSeq
    for (const [tid, st] of threads.entries()) {
      const hasPending = listPendingRequests(tid).length > 0;
      const locked = threadLocks.has(tid);
      const batched = hasActiveBatchForThread(tid, now);
      const hasUnread = hasUnexpiredNotificationOrOverflow(st, now);
      if (
        !locked &&
        !batched &&
        !hasPending &&
        !hasUnread &&
        st.status !== "running" &&
        st.status !== "waiting_input" &&
        st.waiters.size === 0 &&
        now - st.updatedAt > IDLE_TIMEOUT_MS
      ) {
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
      activeBatches.size > 0 ||
      threadLocks.size > 0 ||
      Array.from(threads.values()).some(
        (t) =>
          t.status === "running" ||
          t.status === "waiting_input" ||
          t.waiters.size > 0 ||
          hasUnexpiredNotificationOrOverflow(t, now)
      );
    if (!busy && now - lastActivityMs > IDLE_TIMEOUT_MS) {
      logDaemon("Idle timeout reached; shutting down daemon cleanly.");
      cleanupAndExit(0);
    }
  }, IDLE_SWEEP_MS).unref();
}

if (activeInstallers().length) cleanupAndExit(1);
await startCodexProcess();
syncProjects().catch(err => logDaemon("项目同步失败：" + err.message));

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const startedAt = new Date().toISOString();
  const state = {
    pid: process.pid,
    instanceId: INSTANCE_ID,
    protocolVersion: PROTOCOL_VERSION,
    port,
    token: authToken,
    codexBin,
    startedAt,
  };
  const hookState = {
    pid: process.pid,
    instanceId: INSTANCE_ID,
    protocolVersion: PROTOCOL_VERSION,
    port,
    hookToken,
    startedAt,
  };
  try {
    writeJsonAtomic(STATE_FILE, state);
    writeJsonAtomic(HOOK_STATE_FILE, hookState);
  } catch (err) {
    logDaemon(`Failed to publish discovery files: ${err.message}`);
    cleanupAndExit(1);
    return;
  }
  logDaemon(`Bridge daemon listening on http://127.0.0.1:${port} (pid=${process.pid}, instanceId=${INSTANCE_ID})`);
  console.log(JSON.stringify({ ready: true, pid: process.pid, instanceId: INSTANCE_ID, port, protocolVersion: PROTOCOL_VERSION }));
});

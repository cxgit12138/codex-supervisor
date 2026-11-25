---
name: codex-supervisor
description: >-
  Use when the user asks to delegate work or plan tasks with OpenAI Codex,
  supervise/monitor Codex while it works, send mid-turn steering instructions to
  a running Codex session, resume or fork a Codex Desktop thread, or list local
  Codex models/sessions.
---

# Codex Supervisor

Drive and supervise local OpenAI Codex sessions over `codex app-server` using
the bundled zero-dependency bridge scripts in [scripts/](./scripts/).

Resolve the bundled scripts from the installed plugin directory (default global
install paths below; adjust if installed under a workspace `.agents/plugins/`):

```powershell
# Windows (PowerShell)
$DAEMON = "$env:USERPROFILE\.gemini\config\plugins\codex-supervisor\skills\codex-supervisor\scripts\bridge-daemon.mjs"
$CTL = "$env:USERPROFILE\.gemini\config\plugins\codex-supervisor\skills\codex-supervisor\scripts\codex-ctl.mjs"
```

```bash
# macOS / Linux (bash/zsh)
DAEMON="$HOME/.gemini/config/plugins/codex-supervisor/skills/codex-supervisor/scripts/bridge-daemon.mjs"
CTL="$HOME/.gemini/config/plugins/codex-supervisor/skills/codex-supervisor/scripts/codex-ctl.mjs"
```

## 0. Start the Persistent Bridge Daemon First (Required on Windows)

Short-lived `run_command` calls on Windows terminate child processes when they
exit. Before calling `codex-ctl.mjs`, ensure the bridge daemon is running as an
Antigravity managed daemon (`IsDaemon: true`, `WaitMsBeforeAsync: 2000`):

```powershell
# Windows:
node "$env:USERPROFILE\.gemini\config\plugins\codex-supervisor\skills\codex-supervisor\scripts\bridge-daemon.mjs"
# macOS / Linux:
# node "$HOME/.gemini/config/plugins/codex-supervisor/skills/codex-supervisor/scripts/bridge-daemon.mjs"
```

Wait until it prints `{"ready":true,...}` (or `{"alreadyRunning":true}` if one
is already active). All subsequent `codex-ctl.mjs` calls connect to this
persistent `127.0.0.1` bridge (owner-only state/logs in
`~/.gemini/cache/codex-supervisor/`), auto-discovering the local `codex`
executable (or honoring `CODEX_BIN`) and reusing `~/.codex` auth and thread
history.

## 1. Permission Policy (Supervisor Decides)

Choose `--sandbox` and `--approval` based on task risk (unless the user
specifies otherwise):

- **Trusted coding / build / test tasks in the user's repo** (when the user
  permits full local tool access): `--sandbox danger-full-access --approval never`
- **Sensitive / risky changes where you want approval checkpoints**:
  `--sandbox workspace-write --approval on-request`
- **Read-only code review / investigation**:
  `--sandbox read-only --approval never`

> **Resuming existing threads**: if you pass explicit `--sandbox`, `--approval`,
> or `--cwd` to `resume`, the bridge verifies the effective settings returned by
> Codex and refuses to submit a prompt (HTTP 409) if an already-loaded thread
> kept looser settings.

## 2. Core Supervision Loop (Zero-Polling, Low Token Cost)

1. **Discover models/threads (optional)**:
   - `node $CTL models`
   - `node $CTL threads --limit 10`
2. **Start (or resume / fork) a Codex session**:
   - **Always verify the target workspace (`--cwd <dir>`) before starting a new session**:
     - Explicitly pass `--cwd <target_dir>` on `start` whenever the user names a
       specific repository/folder or multiple workspaces are active (never
       silently assume the shell's default directory is the intended repo, and
       ensure the directory exists first).
     - `--cwd` sets Codex's working root, `workspace-write` sandbox boundary,
       and the workspace badge shown in the side-pane panel. If the user
       switches to a different repository mid-conversation, start a new Codex
       thread with the new `--cwd` instead of reusing an unrelated thread.
   - Optional flags on `start`, `resume`, `fork`, and `send`:
     - `--cwd <dir>` (target workspace directory; defaults to the shell's
       current directory on `start` if omitted)
     - `--model <id>` and `--effort <low|medium|high|xhigh>` (omit to use
       Codex's configured defaults; can also switch model/effort on any `send`)
     - `--mode <plan|default>` (optional; omit for normal execution. Pass
       `--mode plan` to enter Codex Plan collaboration mode with built-in
       `request_user_input` and structured `plan` output; pass `--mode default`
       on the next `send` to return to normal execution)
   - Prefer passing multi-line or Chinese prompts via `--prompt-file` (safest
     across both PowerShell 7 and Windows PowerShell 5.1) or `--stdin` (in
     PowerShell 7 / `pwsh` UTF-8). For a literal `--prompt` value starting with
     `--`, use `--prompt=...`:
     ```powershell
     @'
     <clear task brief + acceptance criteria>
     '@ | node $CTL start --cwd "<repo>" --sandbox danger-full-access --approval never --name "<short title>" --stdin
     ```
   - Record `threadId` and `cursor` (format `<instanceId>:<seq>`) from the JSON
     output.
3. **Wait reactively on blocking/terminal events (NEVER poll in a loop)**:
   - **`wait` is one-shot (exits on each single wakeup).** You MUST re-arm
     `node $CTL wait <threadId> --after <nextCursor>` after **every**
     non-terminal wakeup (`supervisor_message`, `supervisor_question`,
     `approval_request`, `user_input_request`, `timeout`, `plan_updated`,
     `agent_message`) until a terminal wakeup arrives (`turn_completed`,
     `turn_interrupted`, `turn_error`, `daemon_error`). After launching `wait`
     with `WaitMsBeforeAsync=500`, stop calling tools so the system wakes you
     automatically. (Only skip re-arming after a mid-turn `steer` if an
     existing background `wait` for that thread is already running.)
   - Run `wait` with `run_command(..., WaitMsBeforeAsync=500)`:
     ```powershell
     node $CTL wait <threadId> --after <cursor>
     ```
   - Default mode is `--events critical --timeout 600` (10-minute heartbeat; max
     `1800`s for heavy builds/tests). Routine mid-turn `commentary` does NOT
     wake you (pass `--events milestone` only if you want every commentary).
     Every `start` thread automatically gives Codex a native
     `message_supervisor(message, wait_for_reply)` tool so Codex can
     intentionally ping or ask you mid-task. You wake on:
     - `supervisor_message` (non-blocking milestone/risk ping from Codex; Codex
       keeps running — steer if needed, then re-arm `wait`)
     - `supervisor_question` (blocking question from Codex via
       `message_supervisor`; reply with `respond <reqId> --answer "..."`)
     - `approval_request` / `user_input_request` (immediate wakeup, includes
       file-change preview when available)
     - `turn_completed` / `turn_interrupted` / `turn_error` / `daemon_error`
     - `cursor_gap` (if daemon restarted or >500 events elapsed — inspect
       `status` / `history` to resync)
     - `timeout` heartbeat (600s default; check `status` if it seems stuck)
4. **Act on each wakeup** (check the top-level `wakeup` field):
   - **`supervisor_question`** (`requests` array has `tool: "message_supervisor"`):
     reply directly into Codex's paused tool call:
     `node $CTL respond <reqId> --answer "<decision or guidance>"`
     Then re-arm `wait --after <nextCursor>`.
   - **`supervisor_message`**: read Codex's milestone/risk update (`message`).
     If course correction is needed, send `steer`; otherwise just re-arm
     `wait --after <nextCursor>`.
   - **`approval_request` / `user_input_request`** (`requests` array is present):
     review the command, file preview, or question and reply explicitly (never
     omits `--decision`):
     - Command / file approval:
       `node $CTL respond <reqId> --decision accept` (or `acceptForSession` / `decline` / `cancel`)
     - Permissions approval:
       `node $CTL respond <reqId> --decision accept --scope turn` (or `--scope session`, or `--permissions '<json>'`)
     - User input:
       `node $CTL respond <reqId> --answer "<reply>"` (single question) or
       `--answers '{"<qId>":{"answers":["<reply>"]}}'` (multi-question)
     - Then re-arm `wait --after <nextCursor>`.
   - **Mid-turn steering (`steer`)**: anytime while Codex is running (e.g., user
     gives a new instruction, or on `timeout`/`agent_message`), inject a
     mid-turn **steer** (插队消息) right away — no need to wait for the turn to
     end:
     ```powershell
     @'
     <concise course correction>
     '@ | node $CTL steer <threadId> --fallback-send --stdin
     ```
     (`--fallback-send` only falls back to a new turn when the thread is cleanly
     idle and no `--turn-id` mismatch occurred. If a background `wait` task is
     already running for this thread, do NOT spawn a duplicate `wait` after
     `steer`.)
     Use `node $CTL interrupt <threadId>` to request immediate halt, then
     confirm `turn_interrupted` via `wait`.
   - **`turn_completed` / `turn_interrupted`**: also check `supervisorMessages`
     if present (batched non-blocking pings delivered alongside completion). Do
     NOT blindly trust Codex's `message` — inspect real changes (`git status`,
     `git diff`) and run relevant verification. If rework is needed, continue
     the same thread via `send` (context stays in Codex's thread, keeping your
     prompt short and token-cheap):
     ```powershell
     @'
     <specific defects to fix>
     '@ | node $CTL send <threadId> --stdin
     ```
     Then re-arm `wait --after <nextCursor>`.
   - **`cursor_gap` / `turn_error` / `daemon_error`**: inspect `error` or run
     `status` / `history` to resync before deciding next steps.

## 3. Useful Inspection & Lifecycle Commands

- **Non-blocking snapshot**: `node $CTL status <threadId>`
- **Paginated compact turn history**: `node $CTL history <threadId> --limit 6`
- **Resume an existing Desktop App thread** (only when Desktop App does not hold
  its writer lock; if it fails with `already has an active writer`, use `fork`
  instead or ask the user to close Desktop App):
  `node $CTL resume <threadId>`
- **Fork an existing Desktop App thread** (branches from persisted thread
  history without conflicting with Desktop App's writer lock; an in-flight
  Desktop turn is not guaranteed to be captured live):
  `node $CTL fork <threadId> --name "<title>" --prompt-file <file>`
- **Stop local bridge daemon**: `node $CTL stop` when all Codex supervision work
  is finished (releases thread writer locks cleanly; daemon also auto-exits
  after 60 minutes idle).
- **Full raw transcript**: only read `logPath` if an event was
  truncated and you actually need the full output.

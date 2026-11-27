# Changelog

All notable changes to **Codex Supervisor** are documented in this file.

## [1.4.1] - 2026-11-27

### Added
- **Activity-Aware Stall Watchdog (`watchdog-core.mjs`, `bridge-daemon.mjs`, `codex-ctl.mjs`)**:
  - Replaces blind fixed-interval heartbeat polling with dual-threshold activity-aware stall detection: **10 min (`600s`) silence stall threshold** + **30 min (`1800s`) hard ceiling** by default.
  - Tracks real Codex progress (`item/started`, `item/completed`, streaming text/reasoning/command/file deltas, `plan/updated` & `patchUpdated` schema-bounded digests, and blocking approvals/questions) using three orthogonal monotonic (`performance.now()`) clocks (`turnRunningSince`, `lastProgress`, `lastDeliveredContact`) that refresh cleanly after every confirmed supervisor wakeup.
  - Added `--stall-timeout <sec>` (`0..1800`, `0` disables silence detection) to `codex-ctl.mjs wait`, with strict `/health` `capabilities.stallWatchdog === true` negotiation and bidirectional compatibility with older v1.4.0 daemons.
  - Includes sanitized diagnostic metadata (`timeoutReason: "stall" | "max_wait"`, `silentSec`, `lastActivityKind`, `lastActivityAt`, allowlisted `activeItems`, and sanitized `lastNonRetryableError.code`) in timeout wakeups and `status` summaries.
- **Unwaited Hook / Inbox Background Watchdog**:
  - Runs an independent background watchdog (`CODEX_BRIDGE_BG_STALL_SEC=600`, `CODEX_BRIDGE_BG_MAX_RUN_SEC=1800`) for active turns with no attached foreground `wait`, delivering deduplicated `inboxOnly` `turn_watchdog` notifications via existing `PreInvocation` / `Stop` hooks and `codex-ctl.mjs inbox` (without modifying the fixed security-isolated hook templates).
  - Enforces a single-writer alert slot per turn with `fg_timeout_receipt` lease confirmation (`auto` 5s / `manual` 30s), seamlessly handing off failed foreground `EPIPE` deliveries to the background inbox without duplicate storms.
- **Portable 11-Group Watchdog Verification Suite (`tests/verify-watchdog.mjs`)**:
  - Covers unit scheduling/sanitization, active streaming suppression, silent stall detection, `EPIPE` handoff, multi-waiter slot contention, full-queue self-eviction, turn isolation & `0.169.1` cancel payloads, unwaited Hook/Inbox delivery, `--force` rescheduling, and mixed-version compatibility.

### Changed
- **Sidecar Panel Collapsible Long Bubbles (`sidecars/codex_panel/app.js`, `styles.css`, `index.html`)**:
  - Caps tall non-tool chat bubbles at `260px` (with a `56px` hysteresis buffer so short overflows stay natural) using a theme-aware bottom fade mask and a minimalist `显示更多` / `收起` toggle with zero inner scrollbars.
  - Preserves expanded bubble state and keyboard focus across poll re-renders, anchors scroll cleanly on collapse (keeping the toggle visible in short viewports), links buttons via `aria-controls`, and adapts smoothly to panel width/height resizes.
- **Codex `0.169.1` App-Server Protocol Hardening**:
  - Strict `threadId + turnId` scoping prevents late notifications or superseded turns from resurrecting completed turns or poisoning active stall timers.
  - Enforces single-reply authority on server requests with exact `0.169.1` retirement/cancel payloads (`{ permissions: {}, scope: "turn" }` for permissions, `{ decision: "abort" }` for legacy approvals, `{ decision: "cancel" }` for v2 approvals, `-32602` on malformed requests) and distinguishes non-blocking `item/tool/requestUserInput` (`isBlocking: false`).
  - Upgraded `POST /wait` validation to strict non-coercing JSON integers and two-phase disconnect cleanup across multi-thread teardown.

### Fixed
- **Per-Turn Reasoning Effort Tracking & Sidecar Display (`bridge-daemon.mjs`, `sidecars/codex_panel/main.mjs`, `sidecars/codex_panel/app.js`)**:
  - Tracks thread-level `(model, effort)` separately from active-turn snapshots (`activeTurnModel`, `activeTurnEffort`), reading `reasoningEffort` from `thread/start|resume|fork`, clearing stale effort on cross-model switches, and preventing same-turn appends or rejected `turn/start` responses from relabeling an already-running turn.
  - Upgraded sidecar log parsing to a two-pass per-turn index with explicit `effortExplicit`/`committed`/`turnConfigApplied` handling, atomic live-bubble scope resolution, and ETag inclusion of `effort` / `lastModelSub` so follow-up turns and legacy logs consistently display their true reasoning effort.

### Upgrade Notes
- Finish active tasks and run `codex-ctl.mjs stop` so the bridge restarts on the v1.4.1 daemon advertising `capabilities.stallWatchdog: true`.

---

## [1.4.0] - 2026-11-26

### Added
- **Between-Turn Automatic Hook Notifications (`hooks.json`, `hooks/codex-hook.mjs`)**:
  - Added plugin-root `PreInvocation` and conditional `Stop` lifecycle hooks so Antigravity receives timely `[Codex Supervisor]` reminders between tool turns even when busy with other work and not holding an active `wait`.
  - Fixed-template high-privilege notifications (zero Codex free text in `systemMessage` / `Stop.reason`) to prevent prompt-injection privilege escalation.
  - Zero-HTTP fast path via per-instance conversation flag files (`hooks/<instanceId>/`), PID liveness guard (avoiding Windows loopback TCP `ECONNREFUSED` stalls), strict fail-open behavior, and isolated least-privilege `hook-daemon.json` (`hookToken`).
- **Reliable Inbox & Lease/ACK Protocol (`codex-ctl.mjs inbox`, `inbox ack`)**:
  - Added `POST /inbox`, `POST /inbox/ack`, and `POST /hook/poll` in `bridge-daemon.mjs`, plus `codex-ctl.mjs inbox [threadId] [--limit N] [--no-ack]` and `codex-ctl.mjs inbox ack <batchId>`.
  - Unconditionally buffers target non-blocking/terminal critical events in bounded per-thread `hookNotifications` with monotonic overflow watermarks (`overflowTotal` / `overflowAckedThrough`) and unified 30s batch leases shared across `/inbox` and `/wait` (stdout-complete auto-ACK by default, optional `--no-ack` for manual confirmation).
  - Enforces a strict 16 KiB UTF-8 serialized payload budget and 10-thread cap per inbox page with non-starving pagination.
- **Strict Auto-Notification Routing & Explicit Ownership Transfer (`resume --claim`)**:
  - Routes background notifications per `ANTIGRAVITY_CONVERSATION_ID` (`ownerGen` + `threadOwners` preserved across idle thread eviction); `wait`/`send`/`steer` never silently hijack ownership; cross-conversation transfer requires explicit clean `resume <threadId> --claim`.
- **Portable 26-Scenario E2E Verification Suite (`tests/verify-hooks-e2e.mjs`)**:
  - Zero-dependency end-to-end tests covering routing, lease/ACK, `EPIPE`, overflow watermarks, 16 KiB pagination, prompt-injection isolation, Windows SID DACL hardening, reparse-point guards, and concurrent startup locking.

### Changed
- **Hardened Single-Instance Locking & Windows ACL**:
  - Windows ACL hardening now uses pure .NET `SecurityIdentifier` APIs via a static PowerShell script with environment-variable data passing (eliminating locale/text parsing and `$`/backtick quoting issues) and full ancestor+descendant `ReparsePoint` verification; POSIX uses an explicit OS-prefix symlink allowlist.
  - Windows single-instance locking uses a kernel-released exclusive named pipe keyed by physical directory identity (`realpathSync.native` + NTFS `dev:ino`) combined with the shared `wx` lockfile protocol for mixed-version safety.
  - `codex-ctl.mjs` no longer pre-creates `STATE_DIR` before daemon path validation and now surfaces early daemon startup failures immediately.
- **Explicit `message_supervisor` Requests**:
  - Updated `SUPERVISOR_DEV_INSTRUCTIONS` so Codex honors explicit supervisor instructions in the prompt to call `message_supervisor` while remaining quiet on routine operations.

### Upgrade Notes
- Restart **Antigravity** once after updating so the host registers `hooks.json`.
- If an older `bridge-daemon.mjs` is already running, finish active tasks and run `codex-ctl.mjs stop` to switch to the v1.4.0 daemon (`protocolVersion: 2`).

---

## [1.3.2] - 2026-11-25

### Added
- Support for `--mode plan|default` collaboration mode on `start`, `resume`, `fork`, and `send`.
- Expanded thread logging and Sidecar panel rendering for `commandActions` (read/search/list classification), plans, review mode transitions, and context compaction items.
- Updated `SKILL.md` and `README.md` with `--mode` and `--cwd` guidance.

---

## [1.3.1] - 2026-11-25

### Added
- Initial open-source release of **Codex Supervisor for Antigravity**:
  - Persistent local `127.0.0.1` `codex app-server --stdio` bridge (`bridge-daemon.mjs`) and thin CLI (`codex-ctl.mjs`) with zero external npm dependencies.
  - Zero-polling reactive `wait`, mid-turn `steer`, `interrupt`, approval/user-input `respond`, and `resume`/`fork`.
  - Native dynamic `message_supervisor(message, wait_for_reply)` bidirectional communication tool.
  - Native Antigravity Aux Pane Sidecar live chat viewer (`sidecars/codex_panel`) with 3-tier detail filtering and ETag polling.

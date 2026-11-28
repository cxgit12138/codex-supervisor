# Changelog

All notable changes to **Codex Supervisor** are documented in this file.

## [1.5.0] — MaLinYu Fork

- 侧栏设置支持选择新派单的默认模型、思考强度和桌面跳转。用量页只统计监管线程。
- 首次派单保存对话绑定，MCP 查看工具打开对应线程。新增本地项目按目录同步到 Codex。
- 设置页检查 Fork 的发布包，点击安装时校验文件、备份旧版并在切换失败时恢复。

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

# Codex Supervisor for Antigravity

[![Release](https://img.shields.io/github/v/release/cxgit12138/codex-supervisor?color=blue)](https://github.com/cxgit12138/codex-supervisor/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-green.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen.svg)](#)

[中文文档](#中文文档) | [English](#english) | [更新日志 / Changelog](CHANGELOG.md)

让 **Google Antigravity** 把你本机的 **OpenAI Codex** 当作原生子代理来派活、监工、实时插队纠偏与验收——基于官方 `codex app-server` JSON-RPC 协议构建，**零外部依赖、零轮询低 Token 消耗**，并自带 Antigravity 原生右侧**实时双边聊天气泡面板**。

![Codex Supervisor 实时监工与双边对话演示](assets/demo.gif)

---

## 设置与更新

主页「当前会话」的选择只影响该对话的下一轮；右侧卡片显示最近实际使用的模型与强度。「设置」管理全局默认和桌面跳转，用量页按本地日期汇总监管日志，更新页从 GitHub Releases 检查安装包。设置保存在 `~/.gemini/config/codex-supervisor/settings.json`。GitHub 发布包已包含 MCP 视图 SDK，无需 npm install。按钮安装需要系统 curl 和 Python 3.8+（Windows 使用 python.exe）。需要代理时可设置 HTTPS_PROXY。

主分支构建发布在滚动标签 `latest`，正式标签应与 plugin.json 版本一致，例如 `v1.5.0`。包内 install-info.json 记录提交和版本。安装器保留旧版于同一配置目录下的 backups；更新完成后重启 Antigravity 加载新版 MCP 和 hooks。通过 Git 克隆安装的用户可用 git pull 更新。按钮安装需使用 Release 发布包。更新源取自 plugin.json 的 repository。

## 中文文档

### 核心特性

- **MCP Apps 侧栏实时对话面板**
  - 左 Codex / 右 Antigravity 双边气泡流，实时同步派单、插队、主动汇报、审批问答、执行出错与最终回复；
  - 支持 **三档详略切换**（`简洁` 仅核心对话 / `默认` 含过程说明、计划与系统状态 / `详细` 展开全部读取文件、搜索代码、列出目录、执行命令、修改文件、查看图片、网页搜索、MCP 工具、协作子代理等工具调用与可折叠输出）；
  - 顶部显示工作区目录、模型名与沙箱标签，每条 Codex 气泡自动标注当前回合的模型名与思考深度（`model · effort`）；
  - 自动跟随 Antigravity 宿主亮/暗色主题，采用 ETag 增量轮询与磁盘缓存，查看面板 **零 LLM Token 消耗**。
- **零轮询事件唤醒（Reactive Wait）+ 工具轮次间隙自动通知（Lifecycle Hooks）**
  - 常驻本地桥接守护进程 `bridge-daemon.mjs` 维持 `codex app-server --stdio` 长连接；
  - Antigravity 挂起后台 `wait` 后仅在关键节点（主动汇报/请示、审批请求、回合完成、出错或**智能静默卡死检测**：连续 10 分钟无桥接层活动才触发 `stall`，单次等待硬上限 30 分钟防活锁，健康长任务零多余唤醒）唤醒，大幅节省 Token；
  - 即使 Antigravity **未挂 `wait`、正在忙其他任务**，插件自带的 `hooks.json`（`PreInvocation` 与条件启用的 `Stop`）也会在下一轮工具间隙注入精简固定模板系统提醒（防 Prompt Injection 提权），引导通过 `codex-ctl.mjs inbox` 按普通工具权限分页读取正文（含后台卡死/超限去重告警 `turn_watchdog`，单页 ≤16 KiB，存在 `hasMore` 时继续拉取；内存保留随当前 daemon 实例最长 60 分钟，确认边界为 CLI 完整写出 stdout）；在支持 `Stop` 停机原因与 `continuationActive: false` 字段的客户端上，准备彻底停机而 Codex 仍在跑且未挂 `wait` 时会自动兜底提醒一次（完全空闲的会话无法由外部主动推醒）。
- **原生双向通信工具 `message_supervisor`**
  - 新建会话时自动向 Codex 注入动态工具 `message_supervisor(message, wait_for_reply)`：
    - `wait_for_reply: false`：Codex 边干活边向 Antigravity 发送阶段汇报或风险提示；
    - `wait_for_reply: true`：遇到方案分歧或关键决策时暂停等待 Antigravity 拍板回复。
- **中途插队纠偏（`turn/steer`）与审批接管**
  - 不用等当前回合结束，随时给运行中的 Codex 注入纠偏指令（`steer`）或立即喊停（`interrupt`）；
  - 完整接管 Codex 的命令执行审批、文件补丁审批、额外权限审批与用户提问（`requestApproval` / `requestUserInput`）。
- **接管与分叉现有会话（`resume` / `fork`）**
  - 自动复用本机 `~/.codex` 登录态、配置与历史记录，**无需打开 Codex Desktop App 即可工作**；
  - 若 Codex Desktop App 正占用某会话写锁，可使用 `fork` 无冲突分叉续聊。
- **开箱即用 & 安全隔离**
  - **0 外部 npm 依赖**，纯 Node.js 内置模块 + Antigravity 内置 `sidecar_sdk`；
  - 桥接服务仅监听 `127.0.0.1` 随机端口 + 随机 Bearer Token，运行态与日志统一落在 `~/.gemini/cache/codex-supervisor/`（Windows 自动收紧 NTFS DACL，macOS/Linux 为 `0o700` / `0o600`），不污染任何项目仓库；
  - Sidecar API 使用 `POST` + `X-Sidecar-Token` 鉴权。

---

### 环境要求

- **Antigravity App**（支持插件与 MCP Apps 侧栏）
- **Node.js >= 22**
- 本机已安装并登录 **OpenAI Codex**（以下任一即可）：
  - **Codex Desktop App**（Windows 自动发现 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，macOS 自动发现 `/Applications/Codex.app/Contents/Resources/codex`）
  - **Codex CLI**（`codex` 已加入系统 `PATH`，或通过环境变量 `CODEX_BIN` 手动指定可执行文件路径）

---

### 安装与升级

#### 方式一：使用 Antigravity CLI 一键安装（推荐）

```bash
agy plugin install https://github.com/cxgit12138/codex-supervisor
```

#### 方式二：手动克隆到全局插件目录（支持锁定 Release 版本）

**Windows（PowerShell）：**

```powershell
# 安装最新主分支
git clone https://github.com/cxgit12138/codex-supervisor.git "$env:USERPROFILE\.gemini\config\plugins\codex-supervisor"
```

**macOS / Linux：**

```bash
# 安装最新主分支
git clone https://github.com/cxgit12138/codex-supervisor.git "$HOME/.gemini/config/plugins/codex-supervisor"
```

也可以直接从 [GitHub Releases](https://github.com/cxgit12138/codex-supervisor/releases) 下载对应版本的 `codex-supervisor.zip`，解压到上述 `codex-supervisor` 插件目录中。

#### 升级插件

- **通过 `git clone` 安装**：在插件目录执行 `git pull`；
- **通过 CLI 安装**：重新运行安装命令或拉取最新 Release；
- 升级完成后，若已有旧版桥接进程在运行，待当前任务结束执行一次 `codex-ctl.mjs stop`，然后**重启一次 Antigravity 客户端**（使新版 Sidecar 面板与 `hooks.json` 生效）。

安装完成后：
1. 在 Antigravity 的 **Plugins / Customizations** 页面确认 **Codex Supervisor** 已启用（首次安装或升级后建议重启一次客户端）；
2. 点击右侧边栏的 **`+`** 按钮，选择 **Codex Supervisor** 即可打开实时监工对话面板。

---

### 快速上手

启用插件后，直接在 Antigravity 对话中用自然语言指挥即可：

- **派活并全程监工**：
  > 派 Codex 在当前仓库里实现 XXX 功能，你来全程监工验收
- **指定模型 / 思考深度 / 权限模式**：
  > 用 Codex 的最高思考深度帮我只读审查这个 PR 的边界问题
- **中途插队纠偏**：
  > 给正在干活的 Codex 发一条插队指令：不要改公共接口签名，先补单测
- **查看本地模型与会话 / 接管或分叉历史会话**：
  > 列出我本地 Codex 可用的模型和最近 10 个会话，分叉最近的那个继续改

---

### 工作原理与目录结构

```text
codex-supervisor/
├── plugin.json                         # Antigravity 插件清单
├── hooks.json                          # 插件级生命周期钩子（PreInvocation + Stop）
├── CHANGELOG.md                        # 版本更新日志
├── hooks/
│   └── codex-hook.mjs                  # 零依赖快路径 Hook（独立 hook-daemon.json 鉴权 + 固定模板提醒）
├── assets/
│   ├── logo.svg                        # 插件图标
│   └── demo.gif                        # 实时监工与双边对话演示动图
├── mcp_config.json                     # MCP 服务和侧栏入口
├── mcp/                                # 侧栏视图和 MCP 通信
├── lib/                                # 配置、项目同步、用量和更新
├── sidecars/codex_panel/               # 后台项目监听与共用聊天组件
│   ├── sidecar.json                    # 后台 Sidecar 配置
│   ├── main.mjs                        # 只读本地后端（解析日志 + 叠加实时状态 + ETag）
│   ├── index.html                      # 面板结构
│   ├── styles.css                      # 跟随宿主亮/暗主题样式
│   └── app.js                          # 三档过滤与实时气泡渲染
├── skills/codex-supervisor/            # 渐进式披露 Skill（低上下文开销）
│   ├── SKILL.md                        # Antigravity 监工操作协议
│   └── scripts/
│       ├── bridge-daemon.mjs           # 本地 127.0.0.1 桥接守护进程 + codex app-server 客户端
│       ├── watchdog-core.mjs           # 纯函数单调时钟卡死看门狗与有界变更摘要模块
│       └── codex-ctl.mjs               # 精简 CLI 控制端
└── tests/                              # 可移植 E2E 回归测试（仅开发验证，不被宿主加载）
    ├── verify-hooks-e2e.mjs            # `node tests/verify-hooks-e2e.mjs` 一键跑 26 组端到端测试
    └── fixtures/app-server             # 模拟 codex app-server --stdio 测试桩
```

核心 CLI 子命令（由 Antigravity 按需调用 `skills/codex-supervisor/scripts/codex-ctl.mjs`）：

| 命令 | 说明 |
| :--- | :--- |
| `models` / `threads` | 列出本地 Codex 可用模型、历史会话与默认配置 |
| `start` / `send` | 新建会话并派发任务，或在原线程继续追问/返工（支持 `--model` / `--effort` / `--mode plan\|default` / `--sandbox` / `--approval`） |
| `resume` / `fork` | 接管或无冲突分叉本地已有 Codex 会话（支持 `resume --claim` 对干净线程显式转移自动通知路由） |
| `steer` / `interrupt` | 向运行中的回合中途插队纠偏，或请求立即中断 |
| `wait` / `respond` | 零轮询阻塞等待关键事件；显式回复审批、提问或 `message_supervisor` 请示 |
| `inbox` / `inbox ack` | 非阻塞读取本会话未确认关键通知与存活阻塞请求（默认完整写出 stdout 后自动 ACK，可选 `--no-ack`） |
| `status` / `history` / `stop` | 查看实时状态快照、拉取分页历史、清理停止常驻桥接进程 |

---

### 注意事项与常见问题（避坑指南）

1. **Codex Desktop App 的会话写锁（`already has an active writer`）**
   - 在 Windows 上，Codex Desktop App 只要在**本次启动后打开或切到过某个会话**，即便后来切去了其他会话，底层文件写锁（`~/.codex/thread-writer-locks/*.lock`）也会一直保持到 **Codex Desktop App 完全退出**。
   - **解决方式**：
     - **推荐**：直接让 Antigravity 用 `fork` 从该会话分叉续聊（保留完整历史且与桌面端互不冲突，无需关闭桌面端）；
     - 或者完全退出 Codex Desktop App 后再使用 `resume` 续聊原会话。
   - 另外，日常派发新任务**不需要打开 Codex Desktop App**——关闭桌面端也能正常复用 `~/.codex` 登录态与历史记录。

2. **为什么右侧面板里看不到我在 Codex Desktop App 里聊过的旧会话？**
   - 侧边栏下拉列表**仅展示通过 Codex Supervisor 派发、接管（`resume`）或分叉（`fork`）过的监管会话**（日志存放在 `~/.gemini/cache/codex-supervisor/logs/`），不会把你桌面端所有的私人历史会话混进来。
   - 如果想在右侧面板跟进某个桌面端旧会话，先让 Antigravity 列出本地会话并对它执行一次 `resume` 或 `fork` 即可出现在下拉框中。

3. **旧会话与新会话的功能差异（`message_supervisor`）**
   - `codex app-server` 协议仅支持在新建线程（`start`）时注册动态工具，因此只有通过本插件**新建的会话**才会自动拥有原生 `message_supervisor`（主动阶段汇报 / 阻塞请示）工具；
   - 通过 `resume` / `fork` 接管的桌面端旧会话仍完整支持派单追问、中途 `steer` 插队、`interrupt` 喊停、审批与提问接管以及侧边栏实时展示。

4. **安装或更新插件后侧边栏空白 / 入口未出现 / Hook 未生效**
   - MCP 面板、后台 Sidecar 与根目录 `hooks.json` 均在客户端启动时初始化（部分 Antigravity 版本热重载插件时不会重新注册 Hook 或重启 Sidecar）；首次安装或升级后，请**重启一次 Antigravity 客户端**。
   - 若升级前已有旧版 `bridge-daemon.mjs` 在运行，旧实例仍兼容现有 `wait` 流程；待当前任务结束后执行 `codex-ctl.mjs stop` 即可平滑切换到支持 Hook 与 `inbox` 的新版守护进程。

5. **常驻桥接进程与写锁释放**
   - 桥接进程 `bridge-daemon.mjs` 会在空闲 **60 分钟后自动退出**；如果结束后想立刻切回 Codex Desktop App 编辑同一会话，可让 Antigravity 执行 `stop`（或运行 `codex-ctl.mjs stop`）立即释放线程写锁。

6. **权限与模型默认行为**
   - 模型和强度逐项取值：本轮显式参数、当前会话覆盖、插件全局默认、工作目录对应的 Codex 配置；
   - 权限模式由 Antigravity 根据任务风险自动选择（可信仓库开发 / 需审批 / 只读审查），你也可以在对话中随时明确指定（例如「只读模式审查」「改文件前先让我审批」）。

7. **如何自定义 `codex` 可执行文件路径？**
   - 如果你的 `codex` 不在系统 `PATH` 或默认安装路径下，设置环境变量 `CODEX_BIN` 指向 `codex` / `codex.exe` 即可覆盖自动发现逻辑。

---

## English

**Codex Supervisor** is a zero-dependency **Antigravity** plugin that lets Antigravity dispatch, supervise, mid-turn steer, approve, and review local **OpenAI Codex** sessions over the official `codex app-server` JSON-RPC protocol — paired with a native live side-pane chat viewer.

### Highlights

- **MCP Apps Side-Pane Chat Viewer**: Live left (Codex) / right (Antigravity) conversation stream with a 3-tier detail switcher (`Minimal` / `Default` / `Detailed`), workspace & model badges, per-bubble `model · effort` indicators, collapsible command/diff/tool outputs, Antigravity light/dark theme sync, and ETag polling at **zero LLM token cost**.
- **Zero-Polling Reactive Supervision + Activity-Aware Stall Watchdog + Hook Notifications**: A local `127.0.0.1` bridge daemon (`bridge-daemon.mjs`) holds the `codex app-server --stdio` session (verified against `codex-cli 0.169.1`) and wakes background `wait` calls only on milestones, requests, completion, errors, or genuine turn silence (default 10 min stall watchdog + 30 min per-request hard ceiling, eliminating spurious wakeups on healthy long runs; graceful fallback to 600s fixed wait on older daemons). Even when Antigravity is busy without an active `wait`, bundled `hooks.json` (`PreInvocation` and conditional `Stop` on clients emitting `NO_TOOL_CALL` + `continuationActive: false`) injects fixed-template reminders between tool turns — including deduplicated `turn_watchdog` inbox alerts when an owned running turn stalls or hits the 30 min no-contact ceiling — so Antigravity can safely inspect paginated untrusted Codex payloads (≤16 KiB/page, auto-ACK on complete CLI stdout) via `codex-ctl.mjs inbox` and arm `wait` before going idle.
- **Native Bidirectional `message_supervisor` Tool**: Codex can proactively push non-blocking progress updates (`wait_for_reply: false`) or pause to ask the supervisor for decisions (`wait_for_reply: true`).
- **Mid-Turn Steering (`turn/steer`), Approvals & Thread Forking**: Inject corrections while Codex is still working, handle command/patch/permission approvals explicitly, and `fork` Codex Desktop threads cleanly without writer-lock conflicts.
- **Secure & Self-Contained**: Zero npm dependencies, loopback-only bridge with random Bearer token, owner-only state/logs under `~/.gemini/cache/codex-supervisor/` (NTFS DACL hardening on Windows, `0o700`/`0o600` on POSIX), and token-authenticated `POST` sidecar API.

### Requirements

- **Antigravity** with plugin & sidecar UI support
- **Node.js >= 22**
- Local **OpenAI Codex** installed and authenticated (Codex Desktop App or `codex` CLI on `PATH`, or `CODEX_BIN` env var)

### Install & Upgrade

```bash
agy plugin install https://github.com/cxgit12138/codex-supervisor
```

Or clone manually into Antigravity's global plugins directory (or download codex-supervisor.zip from [GitHub Releases](https://github.com/cxgit12138/codex-supervisor/releases)):

```powershell
# Windows (PowerShell)
git clone https://github.com/cxgit12138/codex-supervisor.git "$env:USERPROFILE\.gemini\config\plugins\codex-supervisor"
```

```bash
# macOS / Linux
git clone https://github.com/cxgit12138/codex-supervisor.git "$HOME/.gemini/config/plugins/codex-supervisor"
```

To upgrade, run `git pull` (or check out the latest release tag), stop any older running bridge daemon via `codex-ctl.mjs stop` after active tasks finish, and restart **Antigravity** once so `hooks.json` and the Sidecar reload cleanly.

Then open the live chat panel via the sidecar **`+`** button → **Codex Supervisor**, and ask Antigravity to delegate a task to Codex. See [CHANGELOG.md](CHANGELOG.md) for release history, and run `node tests/verify-hooks-e2e.mjs` / `node tests/verify-watchdog.mjs` to execute the portable E2E suites.

### Notes & Troubleshooting

- **Codex Desktop writer locks (`already has an active writer`)**: On Windows, once Codex Desktop App opens a thread during a run, it holds the file writer lock until the Desktop App exits. Use **`fork`** to branch the thread cleanly without closing Desktop App, or exit Desktop App before calling `resume`. New sessions do not require Codex Desktop App to be running.
- **Why older Desktop threads aren't in the side-pane dropdown**: The panel only lists sessions supervised via this plugin (`~/.gemini/cache/codex-supervisor/logs/`). `resume` or `fork` any Desktop thread once to bring it into the panel.
- **`message_supervisor` availability**: Dynamic tools are registered on `thread/start`, so native `message_supervisor` pings/questions apply to newly started threads (resumed/forked threads still support full `send`, `steer`, `interrupt`, approvals, and live side-pane viewing).
- **Panel missing or Hooks didn't activate after install/update**: Restart the **Antigravity** client once so `hooks.json`, the sidecar backend process, and webview cache initialize cleanly (toggling the plugin in-place may not re-register hooks or re-spawn sidecar processes on some Antigravity builds). If an older daemon was running, run `codex-ctl.mjs stop` after current tasks finish to switch to the updated bridge daemon.
- **Releasing locks after supervision**: The bridge daemon auto-exits after 60 minutes of idle time, or run `codex-ctl.mjs stop` to release thread locks immediately.

---

## License

[MIT](LICENSE) © 2026 cxgit12138

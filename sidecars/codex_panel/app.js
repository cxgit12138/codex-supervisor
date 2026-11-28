function chatRenderer(openThread) {
  const $ = id => document.getElementById(id);
  const VALID_MODES = new Set(["concise", "default", "detailed"]);
  let initialMode = "default";
  try {
    const saved = localStorage.getItem("codex_panel_detail_mode");
    if (saved === "minimal") initialMode = "concise";
    else if (VALID_MODES.has(saved)) initialMode = saved;
  } catch {}

  const state = {
    detailMode: initialMode, // "concise" | "default" | "detailed"
    data: null,
    stickToBottom: true,
    lastListKey: "",
    renderedThreadId: "",
    openDetails: new Set(),
  };

  // ---------- Safe Markdown Rendering ----------
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  function renderInline(line) {
    // Split on inline code first so `**bold**` inside backticks is never rewritten
    const parts = String(line || "").split(/(`[^`]+`)/g);
    return parts
      .map((part) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
          return `<code>${esc(part.slice(1, -1))}</code>`;
        }
        return esc(part).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      })
      .join("");
  }

  function renderMarkdown(raw) {
    const text = String(raw || "").replace(/\r\n/g, "\n");
    const blocks = [];
    // Only recognize fenced code blocks starting at line beginning
    const linesAll = text.split("\n");
    let inFence = false;
    let buf = [];
    const flushBuf = (type) => {
      if (!buf.length) return;
      blocks.push({ type, val: buf.join("\n") });
      buf = [];
    };
    for (const line of linesAll) {
      if (/^```/.test(line.trimStart())) {
        if (!inFence) {
          flushBuf("text");
          inFence = true;
        } else {
          flushBuf("code");
          inFence = false;
        }
      } else {
        buf.push(line);
      }
    }
    flushBuf(inFence ? "code" : "text");

    return blocks
      .map((b) => {
        if (b.type === "code") {
          return `<pre><code>${esc(b.val.replace(/\n$/, ""))}</code></pre>`;
        }
        const lines = b.val.split("\n");
        let out = "";
        let inUl = false;
        let para = [];
        const flushPara = () => {
          if (!para.length) return;
          out += `<p>${para.map(renderInline).join("<br>")}</p>`;
          para = [];
        };
        const closeUl = () => {
          if (!inUl) return;
          out += "</ul>";
          inUl = false;
        };
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            flushPara();
            closeUl();
            continue;
          }
          const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
          if (heading) {
            flushPara();
            closeUl();
            out += `<p class="md-heading">${renderInline(heading[1])}</p>`;
            continue;
          }
          const bullet = trimmed.match(/^[-*]\s+(.+)$/);
          if (bullet) {
            flushPara();
            if (!inUl) {
              out += "<ul>";
              inUl = true;
            }
            out += `<li>${renderInline(bullet[1])}</li>`;
          } else {
            closeUl();
            para.push(line);
          }
        }
        flushPara();
        closeUl();
        return out;
      })
      .join("");
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function statusLabel(st) {
    return {
      running: "运行中",
      waiting_input: "等待回复",
      error: "出错",
      idle: "空闲",
    }[st] || "空闲";
  }

  function basename(p) {
    if (!p) return "";
    const parts = String(p).replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  // ---------- Render ----------
  function renderSessions(sessions, activeId) {
    const sel = $("session-select");
    if (!sessions.length) {
      sel.innerHTML = `<option value="">暂无会话</option>`;
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = sessions
      .map((s) => {
        const prefix = s.status === "running" ? "● " : s.status === "waiting_input" ? "◉ " : "";
        const ws = s.cwd ? ` · ${basename(s.cwd)}` : "";
        const label = `${prefix}${s.name}${ws} (${s.visibleCount}条)`;
        return `<option value="${esc(s.threadId)}" ${s.threadId === activeId ? "selected" : ""}>${esc(label)}</option>`;
      })
      .join("");
  }

  function messageVisibleInMode(m, mode) {
    const tier = m.tier || "core";
    if (mode === "detailed") return true;
    if (mode === "default") return tier === "core" || tier === "narration";
    return tier === "core";
  }

  function renderActive(data) {
    const dot = $("status-dot");
    const chips = $("meta-chips");
    const list = $("chat-list");
    const empty = $("empty-state");
    const liveBox = $("live-indicator");
    const liveDraft = $("live-draft");

    const active = data.active;
    if (!active) {
      dot.className = "dot dot-idle";
      chips.innerHTML = "";
      list.innerHTML = "";
      empty.classList.remove("hidden");
      liveBox.classList.add("hidden");
      state.lastListKey = "";
      return;
    }

    empty.classList.add("hidden");
    const meta = active.meta || {};
    const status = meta.status || "idle";
    dot.className = `dot dot-${status}`;
    dot.title = statusLabel(status);

    const chipItems = [];
    if (status === "running" || status === "waiting_input") {
      chipItems.push(`<span class="chip chip-live">${esc(statusLabel(status))}</span>`);
    }
    if (meta.cwd) {
      chipItems.push(
        `<span class="chip chip-ws" title="工作区：${esc(meta.cwd)}"><svg class="chip-ico" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.8h5A1.5 1.5 0 0 1 14 6.3v5.2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>${esc(basename(meta.cwd))}</span>`
      );
    }
    if (meta.model) chipItems.push(`<span class="chip" title="模型">${esc(meta.model)}</span>`);
    if (meta.sandbox) chipItems.push(`<span class="chip" title="沙箱">${esc(meta.sandbox)}</span>`);
    chips.innerHTML = chipItems.join("");

    const filtered = (active.messages || []).filter((m) => messageVisibleInMode(m, state.detailMode));
    const listKey = `${meta.threadId}|${state.detailMode}|${meta.mtimeMs || 0}|${meta.size || 0}|${filtered.length}`;

    if (listKey !== state.lastListKey) {
      // Save open <details> under the PREVIOUSLY rendered thread ID (never attribute to newly switched thread)
      const prevTid = state.renderedThreadId || meta.threadId;
      for (const det of list.querySelectorAll("details[data-msg-id]")) {
        const key = `${prevTid}:${det.dataset.msgId}`;
        if (det.open) state.openDetails.add(key);
        else state.openDetails.delete(key);
      }

      if (!filtered.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-desc">当前档位暂无可显示的对话消息${meta.processCount ? "（可切换右上角「默认 / 详细」查看过程说明与工具调用）" : ""}。</div></div>`;
      } else {
        list.innerHTML = filtered
          .map((m) => {
            if (m.side === "system") {
              return `<div class="msg-row side-system"><span class="system-divider">${esc(m.text)}</span></div>`;
            }
            const isSup = m.side === "supervisor";
            const role = isSup ? "Antigravity" : "Codex";
            const cls = [
              "bubble",
              isSup ? "bubble-supervisor" : "bubble-codex",
              m.tier && m.tier !== "core" ? "bubble-process" : "",
            ].join(" ");
            const openAttr = state.openDetails.has(`${meta.threadId}:${m.id}`) ? " open" : "";
            const detailHtml = m.detail
              ? `<details class="cmd-details" data-msg-id="${esc(m.id)}"${openAttr}><summary>查看输出详情</summary><pre>${esc(m.detail)}</pre></details>`
              : "";
            return `
              <div class="msg-row side-${isSup ? "supervisor" : "codex"}">
                <div class="${cls}">
                  <div class="bubble-head">
                    <span class="role-name">${role}</span>
                    ${m.badge ? `<span class="badge tone-${esc(m.tone || "muted")}">${esc(m.badge)}</span>` : ""}
                    ${m.sub ? `<span class="meta-sub">${esc(m.sub)}</span>` : ""}
                    <span class="msg-time">${esc(fmtTime(m.ts))}</span>
                  </div>
                  <div class="bubble-body">${renderMarkdown(m.text)}</div>
                  ${detailHtml}
                </div>
              </div>`;
          })
          .join("");
      }
      state.lastListKey = listKey;
      state.renderedThreadId = meta.threadId;
    }

    const liveModelSub = $("live-model-sub");
    if (status === "running") {
      liveBox.classList.remove("hidden");
      const mSub = meta.lastModelSub || meta.model || "";
      if (liveModelSub) {
        liveModelSub.textContent = mSub;
        liveModelSub.classList.toggle("hidden", !mSub);
      }
      liveDraft.innerHTML = active.inFlightDraft
        ? renderMarkdown(active.inFlightDraft)
        : `<p style="color:var(--cs-fg-muted)">Codex 正在执行任务…</p>`;
    } else {
      liveBox.classList.add("hidden");
    }

    const scroller = $("chat-scroll");
    if (state.stickToBottom) {
      requestAnimationFrame(() => {
        scroller.scrollTop = scroller.scrollHeight;
      });
    }
  }

  function syncModeButtons() {
    for (const btn of $("detail-mode").querySelectorAll(".seg-btn")) {
      const on = btn.dataset.mode === state.detailMode;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  syncModeButtons();

  $("detail-mode").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || !VALID_MODES.has(btn.dataset.mode)) return;
    state.detailMode = btn.dataset.mode;
    syncModeButtons();
    try {
      localStorage.setItem("codex_panel_detail_mode", state.detailMode);
    } catch {}
    if (state.data) renderActive(state.data);
  });

  const scroller = $("chat-scroll");
  const scrollBtn = $("scroll-bottom-btn");
  scroller.addEventListener("scroll", () => {
    const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    state.stickToBottom = dist < 48;
    scrollBtn.classList.toggle("hidden", state.stickToBottom);
  });
  scrollBtn.addEventListener("click", () => {
    state.stickToBottom = true;
    scroller.scrollTop = scroller.scrollHeight;
    scrollBtn.classList.add("hidden");
  });

  $("session-select").onchange = () => openThread($("session-select").value);
  return data => {
    if (state.renderedThreadId !== data.active?.meta.threadId) state.stickToBottom = true;
    state.data = data;
    renderSessions(data.sessions, data.active?.meta.threadId);
    renderActive(data);
  };
}

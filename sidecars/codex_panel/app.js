/**
 * Codex Supervisor Sidecar Panel Frontend.
 * Polls /api/state with ETag caching, syncs Antigravity theme, renders
 * human-friendly left/right chat bubbles, and switches between Codex sessions.
 */
(() => {
  const POLL_MS = 1400;
  const COLLAPSE_MAX_PX = 260;
  const COLLAPSE_TRIGGER_PX = COLLAPSE_MAX_PX + 56; // Avoid folding bubbles that only overflow by 1-2 lines
  const CHEVRON_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;
  const $ = (id) => document.getElementById(id);

  const VALID_MODES = new Set(["minimal", "default", "detailed"]);
  let initialMode = "default";
  try {
    const saved = localStorage.getItem("codex_panel_detail_mode");
    if (saved && VALID_MODES.has(saved)) initialMode = saved;
  } catch {}

  const state = {
    etag: "",
    selectedThreadId: "",
    detailMode: initialMode, // "minimal" | "default" | "detailed"
    data: null,
    timer: null,
    stickToBottom: true,
    reqSeq: 0,
    lastListKey: "",
    renderedThreadId: "",
    openDetails: new Set(),
    expandedBubbles: new Set(),
  };

  function showDiagError(msg) {
    const text = String(msg || "未知错误");
    const sel = $("session-select");
    if (sel && !state.data) {
      sel.textContent = "";
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = `错误: ${text.slice(0, 60)}`;
      sel.appendChild(opt);
    }
    const empty = $("empty-state");
    if (empty && !state.data) {
      empty.classList.remove("hidden");
      const t = empty.querySelector(".empty-title");
      const d = empty.querySelector(".empty-desc");
      if (t) t.textContent = "加载会话失败";
      if (d) d.textContent = text;
    }
  }

  window.addEventListener("error", (e) => showDiagError(`JS Error: ${e.message || e.error}`));
  window.addEventListener("unhandledrejection", (e) => showDiagError(`Promise Error: ${e.reason?.message || e.reason}`));

  // ---------- Host Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;color:var(--background, #f6f7f9)";
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith("color(") ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? "dark" : "light";
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });

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

  function setExpandButtonState(btn, expanded) {
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    const label = btn.querySelector(".expand-label");
    if (label) label.textContent = expanded ? "收起" : "显示更多";
  }

  function applyBubbleCollapse(listEl, threadId) {
    if (!listEl || !threadId) return;
    for (const bubble of listEl.querySelectorAll('.bubble[data-collapsible="1"]')) {
      const wrap = bubble.querySelector(".bubble-body-wrap");
      const body = wrap?.querySelector(".bubble-body");
      const btn = bubble.querySelector(".bubble-expand-btn");
      if (!wrap || !body || !btn) continue;
      // Measure true natural content height of inner .bubble-body (unclipped even when wrap is collapsed)
      const fullHeight = body.scrollHeight;
      const needsCollapse = fullHeight > COLLAPSE_TRIGGER_PX;
      if (!needsCollapse) {
        wrap.classList.remove("is-collapsed");
        btn.classList.add("hidden");
        continue;
      }
      const key = `${threadId}:${bubble.dataset.bubbleId}`;
      const expanded = state.expandedBubbles.has(key);
      wrap.classList.toggle("is-collapsed", !expanded);
      btn.classList.remove("hidden");
      setExpandButtonState(btn, expanded);
    }
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
      const activeEl = document.activeElement;
      const focusedExpandId =
        state.renderedThreadId === meta.threadId &&
        activeEl instanceof HTMLElement &&
        activeEl.classList.contains("bubble-expand-btn") &&
        list.contains(activeEl)
          ? activeEl.dataset.expandId || null
          : null;

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
            const isCollapsible = (m.tier || "core") !== "tool";
            const cls = [
              "bubble",
              isSup ? "bubble-supervisor" : "bubble-codex",
              m.tier && m.tier !== "core" ? "bubble-process" : "",
            ].join(" ");
            const openAttr = state.openDetails.has(`${meta.threadId}:${m.id}`) ? " open" : "";
            const detailHtml = m.detail
              ? `<details class="cmd-details" data-msg-id="${esc(m.id)}"${openAttr}><summary>查看输出详情</summary><pre>${esc(m.detail)}</pre></details>`
              : "";
            const bodyId = `bubble-body-${esc(m.id)}`;
            const bodyHtml = isCollapsible
              ? `<div id="${bodyId}" class="bubble-body-wrap"><div class="bubble-body">${renderMarkdown(m.text)}</div><div class="bubble-fade" aria-hidden="true"></div></div>
                  <button type="button" class="bubble-expand-btn hidden" data-expand-id="${esc(m.id)}" aria-controls="${bodyId}" aria-expanded="false"><span class="expand-label">显示更多</span>${CHEVRON_SVG}</button>`
              : `<div class="bubble-body">${renderMarkdown(m.text)}</div>`;
            return `
              <div class="msg-row side-${m.side}">
                <div class="${cls}" data-bubble-id="${esc(m.id)}"${isCollapsible ? ' data-collapsible="1"' : ""}>
                  <div class="bubble-head">
                    <span class="role-name">${role}</span>
                    ${m.badge ? `<span class="badge tone-${esc(m.tone || "muted")}">${esc(m.badge)}</span>` : ""}
                    ${m.sub ? `<span class="meta-sub">${esc(m.sub)}</span>` : ""}
                    <span class="msg-time">${esc(fmtTime(m.ts))}</span>
                  </div>
                  ${bodyHtml}
                  ${detailHtml}
                </div>
              </div>`;
          })
          .join("");
        applyBubbleCollapse(list, meta.threadId);
        if (focusedExpandId) {
          for (const btn of list.querySelectorAll(".bubble-expand-btn")) {
            if (btn.dataset.expandId === focusedExpandId && !btn.classList.contains("hidden")) {
              btn.focus({ preventScroll: true });
              break;
            }
          }
        }
      }
      state.lastListKey = listKey;
      state.renderedThreadId = meta.threadId;
    }

    const liveModelSub = $("live-model-sub");
    if (status === "running") {
      liveBox.classList.remove("hidden");
      const mSub = "lastModelSub" in meta ? (meta.lastModelSub || "") : (meta.model || "");
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

  // ---------- Polling ----------
  async function poll(force = false) {
    const mySeq = ++state.reqSeq;
    const reqThreadId = state.selectedThreadId;
    const reqEtag = force ? "" : state.etag;

    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const apiUrl = new URL("api/state", window.location.href);
      const res = await f(apiUrl.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: reqThreadId || undefined,
          etag: reqEtag || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${apiUrl.pathname})`);
      const payload = await res.json();
      // Discard out-of-order responses after rapid session switching or manual refresh
      if (mySeq !== state.reqSeq) return;
      if (payload.unchanged) return;
      state.etag = payload.etag || "";
      state.data = payload;
      if (!state.selectedThreadId && payload.activeThreadId) {
        state.selectedThreadId = payload.activeThreadId;
      }
      renderSessions(payload.sessions || [], payload.activeThreadId);
      renderActive(payload);
    } catch (err) {
      if (mySeq !== state.reqSeq) return;
      showDiagError(err?.message || err);
    }
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    const delay = document.hidden ? 6000 : POLL_MS;
    state.timer = setTimeout(async () => {
      await poll(false);
      schedulePoll();
    }, delay);
  }

  // ---------- Events ----------
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

  $("session-select").addEventListener("change", (e) => {
    state.selectedThreadId = e.target.value || "";
    state.etag = "";
    state.stickToBottom = true;
    poll(true);
  });

  $("refresh-btn").addEventListener("click", () => {
    state.etag = "";
    poll(true);
  });

  const scroller = $("chat-scroll");
  const scrollBtn = $("scroll-bottom-btn");
  const chatList = $("chat-list");

  function syncScrollBtn() {
    const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    state.stickToBottom = dist < 48;
    scrollBtn.classList.toggle("hidden", state.stickToBottom);
  }

  scroller.addEventListener("scroll", syncScrollBtn);
  scrollBtn.addEventListener("click", () => {
    state.stickToBottom = true;
    scroller.scrollTop = scroller.scrollHeight;
    scrollBtn.classList.add("hidden");
  });

  chatList.addEventListener("click", (e) => {
    const btn = e.target.closest(".bubble-expand-btn");
    if (!btn) return;
    const bubble = btn.closest('.bubble[data-collapsible="1"]');
    const wrap = bubble?.querySelector(".bubble-body-wrap");
    const tid = state.renderedThreadId;
    if (!bubble || !wrap || !tid) return;

    const key = `${tid}:${bubble.dataset.bubbleId}`;
    const nextExpanded = !state.expandedBubbles.has(key);
    if (nextExpanded) {
      state.expandedBubbles.add(key);
      if (state.expandedBubbles.size > 500) {
        const oldest = state.expandedBubbles.keys().next().value;
        state.expandedBubbles.delete(oldest);
      }
    } else {
      state.expandedBubbles.delete(key);
    }

    wrap.classList.toggle("is-collapsed", !nextExpanded);
    setExpandButtonState(btn, nextExpanded);

    // When collapsing a tall bubble whose top is scrolled above the viewport, anchor cleanly to its top
    // while ensuring the focused toggle button remains visible even in short panels
    if (!nextExpanded) {
      const bRect = bubble.getBoundingClientRect();
      const sRect = scroller.getBoundingClientRect();
      if (bRect.top < sRect.top) {
        scroller.scrollTop += bRect.top - sRect.top - 12;
      }
      const btnRect = btn.getBoundingClientRect();
      if (btnRect.bottom > sRect.bottom) {
        scroller.scrollTop += btnRect.bottom - sRect.bottom + 12;
      }
    }
    syncScrollBtn();
  });

  if (typeof ResizeObserver === "function") {
    let lastW = 0;
    let lastH = 0;
    let resizeRaf = 0;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const w = Math.round(rect?.width || 0);
      const h = Math.round(rect?.height || 0);
      if ((!w && !h) || (w === lastW && h === lastH)) return;
      const widthChanged = w !== lastW;
      lastW = w;
      lastH = h;
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const wasSticking = state.stickToBottom;
        if (widthChanged && state.renderedThreadId) {
          applyBubbleCollapse(chatList, state.renderedThreadId);
        }
        if (wasSticking) {
          scroller.scrollTop = scroller.scrollHeight;
        }
        syncScrollBtn();
      });
    });
    ro.observe(scroller);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll(false);
    schedulePoll();
  });

  (async () => {
    await poll(true);
    schedulePoll();
  })();
})();

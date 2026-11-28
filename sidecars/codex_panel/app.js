function chatRenderer(openThread, refresh) {
  const COLLAPSE_MAX_PX = 260;
  const CHEVRON_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;
  const CHECK_SVG = `<svg class="session-opt-check" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>`;
  const $ = (id) => document.getElementById(id);

  const reducedMotionQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  const prefersReducedMotion = () => Boolean(reducedMotionQuery?.matches);

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
    autoScrolling: false,
    autoScrollRaf: 0,
    pendingScrollRaf: 0,
    userScrollGen: 0,
    lastListKey: "",
    renderedThreadId: "",
    renderedMode: "",
    renderedMsgs: [],
    liveVisible: false,
    lastLiveDraft: "",
    lastLiveDraftItemIds: [],
    openDetails: new Set(),
    expandedBubbles: new Set(),
    sessions: [],
    sessionMenuSig: "",
    sessionMenuOpen: false,
    highlightedThreadId: "",
  };

  const bubbleAnimCleanups = new WeakMap();

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

  function fmtRelTime(iso) {
    if (!iso) return "";
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return "";
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return "刚刚";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}小时前`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}天前`;
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}`;
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

  function syncMenuHighlight(scrollIntoView = false) {
    const menu = $("session-menu");
    if (!menu) return;
    let activeOptId = "";
    for (const opt of menu.querySelectorAll(".session-opt")) {
      const hit = opt.dataset.threadId === state.highlightedThreadId;
      opt.classList.toggle("is-highlighted", hit);
      if (hit) {
        activeOptId = opt.id;
        if (scrollIntoView) opt.scrollIntoView({ block: "nearest" });
      }
    }
    if (activeOptId) menu.setAttribute("aria-activedescendant", activeOptId);
    else menu.removeAttribute("aria-activedescendant");
  }

  function updateSessionMenuMaxHeight() {
    const trigger = $("session-trigger");
    const menu = $("session-menu");
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const avail = Math.max(0, Math.floor(window.innerHeight - rect.bottom - 10));
    menu.style.maxHeight = `${Math.min(350, avail)}px`;
  }

  function refreshMenuRelativeTimes() {
    const menu = $("session-menu");
    if (!menu) return;
    for (const el of menu.querySelectorAll(".session-opt-time[data-ts]")) {
      el.textContent = fmtRelTime(el.dataset.ts);
    }
  }

  function openSessionMenu(initialThreadId = null) {
    const trigger = $("session-trigger");
    const menu = $("session-menu");
    if (!trigger || !menu || trigger.disabled || !state.sessions.length) return;
    state.sessionMenuOpen = true;
    refreshMenuRelativeTimes();
    updateSessionMenuMaxHeight();
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    state.highlightedThreadId =
      initialThreadId ||
      state.data?.activeThreadId ||
      state.sessions[0]?.threadId ||
      "";
    syncMenuHighlight(true);
    menu.focus({ preventScroll: true });
  }

  function closeSessionMenu(restoreFocus = false) {
    const trigger = $("session-trigger");
    const menu = $("session-menu");
    if (!state.sessionMenuOpen) return;
    state.sessionMenuOpen = false;
    if (menu) menu.classList.add("hidden");
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }
  }

  function selectSession(threadId) {
    if (!threadId) return;
    const prevId = state.data?.activeThreadId || "";
    closeSessionMenu(true);
    if (threadId === prevId) return;
    cancelAutoScroll();
    state.stickToBottom = true;
    openThread(threadId);
  }

  // ---------- Render ----------
  function renderSessions(sessions, activeId) {
    state.sessions = sessions;
    const trigger = $("session-trigger");
    const trigTitle = $("session-trigger-title");
    const trigCount = $("session-trigger-count");
    const menu = $("session-menu");
    if (!trigger || !trigTitle || !menu) return;

    if (!sessions.length) {
      trigTitle.textContent = "暂无会话";
      if (trigCount) trigCount.classList.add("hidden");
      trigger.disabled = true;
      closeSessionMenu(false);
      if (state.sessionMenuSig !== "__empty__") {
        menu.innerHTML = `<div class="session-empty">暂无会话记录</div>`;
        state.sessionMenuSig = "__empty__";
      }
      return;
    }

    trigger.disabled = false;
    const current = sessions.find((s) => s.threadId === activeId) || sessions[0];
    trigTitle.textContent = current.name || `会话 ${current.threadId.slice(0, 8)}`;
    trigTitle.title = current.name || "";
    if (trigCount) {
      trigCount.textContent = `${current.visibleCount || 0}条`;
      trigCount.classList.remove("hidden");
    }

    const menuSig = sessions
      .map((s) => `${s.threadId}:${s.status}:${s.name}:${s.cwd || ""}:${s.model || ""}:${s.visibleCount}:${s.updatedAt || ""}`)
      .join("|") + `#${activeId || ""}`;
    if (menuSig === state.sessionMenuSig) return;
    state.sessionMenuSig = menuSig;

    const prevScrollTop = menu.scrollTop;
    const hadMenuFocus =
      state.sessionMenuOpen &&
      (document.activeElement === menu || menu.contains(document.activeElement));
    menu.innerHTML = sessions
      .map((s, idx) => {
        const selected = s.threadId === activeId;
        const st = s.status || "idle";
        const metaParts = [];
        if (s.cwd) metaParts.push(basename(s.cwd));
        if (s.model) metaParts.push(s.model);
        metaParts.push(`${s.visibleCount || 0}条`);
        const metaHtml = metaParts
          .map((p) => `<span class="session-opt-meta-item">${esc(p)}</span>`)
          .join(`<span class="session-opt-sep">·</span>`);
        const relTime = fmtRelTime(s.updatedAt);
        const optId = `session-opt-${idx}`;
        return `
          <button
            type="button"
            id="${optId}"
            class="session-opt${selected ? " is-selected" : ""}"
            role="option"
            tabindex="-1"
            aria-selected="${selected ? "true" : "false"}"
            data-thread-id="${esc(s.threadId)}"
          >
            <span class="session-opt-top">
              <span class="session-opt-dot dot-${esc(st)}" title="${esc(statusLabel(st))}"></span>
              <span class="session-opt-name">${esc(s.name || `会话 ${s.threadId.slice(0, 8)}`)}</span>
              ${relTime ? `<span class="session-opt-time" data-ts="${esc(s.updatedAt || "")}">${esc(relTime)}</span>` : ""}
              ${selected ? CHECK_SVG : ""}
            </span>
            <span class="session-opt-meta">${metaHtml}</span>
          </button>`;
      })
      .join("");
    if (state.sessionMenuOpen) {
      menu.scrollTop = prevScrollTop;
      if (!sessions.some((s) => s.threadId === state.highlightedThreadId)) {
        state.highlightedThreadId = activeId || sessions[0].threadId;
      }
      syncMenuHighlight(false);
      if (hadMenuFocus && document.activeElement !== menu) {
        menu.focus({ preventScroll: true });
      }
    }
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

  function buildMessageHtml(m, threadId) {
    if (m.side === "system") {
      return `<div class="msg-row side-system" data-row-id="${esc(m.id)}"><span class="system-divider">${esc(m.text)}</span></div>`;
    }
    const isSup = m.side === "supervisor";
    const role = isSup ? "Antigravity" : "Codex";
    const isCollapsible = (m.tier || "core") !== "tool";
    const cls = [
      "bubble",
      isSup ? "bubble-supervisor" : "bubble-codex",
      m.tier && m.tier !== "core" ? "bubble-process" : "",
    ].join(" ");
    const openAttr = state.openDetails.has(`${threadId}:${m.id}`) ? " open" : "";
    const detailHtml = m.detail
      ? `<details class="cmd-details" data-msg-id="${esc(m.id)}"${openAttr}><summary>查看输出详情</summary><pre>${esc(m.detail)}</pre></details>`
      : "";
    const bodyId = `bubble-body-${esc(m.id)}`;
    const bodyHtml = isCollapsible
      ? `<div id="${bodyId}" class="bubble-body-wrap"><div class="bubble-body">${renderMarkdown(m.text)}</div><div class="bubble-fade" aria-hidden="true"></div></div>
          <button type="button" class="bubble-expand-btn hidden" data-expand-id="${esc(m.id)}" aria-controls="${bodyId}" aria-expanded="false"><span class="expand-label">显示更多</span>${CHEVRON_SVG}</button>`
      : `<div class="bubble-body">${renderMarkdown(m.text)}</div>`;
    return `
      <div class="msg-row side-${isSup ? "supervisor" : "codex"}" data-row-id="${esc(m.id)}">
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
  }

  function applyBubbleCollapse(scopeEl, threadId) {
    if (!scopeEl || !threadId) return;
    const bubbles = Array.isArray(scopeEl)
      ? scopeEl
      : scopeEl.querySelectorAll('.bubble[data-collapsible="1"]');
    for (const bubble of bubbles) {
      const wrap = bubble.querySelector(".bubble-body-wrap");
      const body = wrap?.querySelector(".bubble-body");
      const btn = bubble.querySelector(".bubble-expand-btn");
      if (!wrap || !body || !btn) continue;
      // Clear any mid-flight animation inline styles before measuring/syncing
      const cancelAnim = bubbleAnimCleanups.get(wrap);
      if (cancelAnim) cancelAnim();
      const fullHeight = body.scrollHeight;
      const needsCollapse = fullHeight > COLLAPSE_MAX_PX;
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

  function markRowEntering(rowEl, delayMs = 0) {
    if (!rowEl || prefersReducedMotion()) return;
    if (delayMs > 0) rowEl.style.animationDelay = `${delayMs}ms`;
    rowEl.classList.add("is-entering");
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rowEl.classList.remove("is-entering");
      rowEl.style.animationDelay = "";
      rowEl.removeEventListener("animationend", cleanup);
    };
    rowEl.addEventListener("animationend", cleanup);
    setTimeout(cleanup, 460 + delayMs);
  }

  function markRowSettling(rowEl) {
    if (!rowEl || prefersReducedMotion()) return;
    rowEl.classList.add("is-settling");
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rowEl.classList.remove("is-settling");
      rowEl.removeEventListener("animationend", cleanup);
    };
    rowEl.addEventListener("animationend", cleanup);
    setTimeout(cleanup, 340);
  }

  function draftMatchesMessage(draft, draftItemIds, msg) {
    if (!msg || msg.side !== "codex") return false;
    if (Array.isArray(draftItemIds) && draftItemIds.length > 0 && msg.itemId) {
      return draftItemIds.includes(msg.itemId);
    }
    if (!draft) return false;
    const cleanDraft = String(draft)
      .replace(/\n?\.\.\.\[truncated \d+ chars;[^\]]*\]$/, "")
      .trim();
    if (!cleanDraft) return false;
    return String(msg.text || "").trim().startsWith(cleanDraft);
  }

  function sameRenderedMessage(a, b) {
    if (!a || !b) return false;
    return (
      String(a.id) === String(b.id) &&
      (a.side || "") === (b.side || "") &&
      (a.tier || "") === (b.tier || "") &&
      (a.badge || "") === (b.badge || "") &&
      (a.tone || "") === (b.tone || "") &&
      (a.sub || "") === (b.sub || "") &&
      (a.ts || "") === (b.ts || "") &&
      String(a.text || "") === String(b.text || "") &&
      String(a.detail || "") === String(b.detail || "")
    );
  }

  function rememberOpenDetails(list) {
    if (!state.renderedThreadId) return;
    for (const det of list.querySelectorAll("details[data-msg-id]")) {
      const key = state.renderedThreadId + ":" + det.dataset.msgId;
      if (det.open) state.openDetails.add(key);
      else state.openDetails.delete(key);
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
      cancelAutoScroll();
      rememberOpenDetails(list);
      dot.className = "dot dot-idle";
      chips.innerHTML = "";
      list.innerHTML = "";
      empty.classList.remove("hidden");
      liveBox.classList.add("hidden");
      state.lastListKey = "";
      state.renderedThreadId = "";
      state.renderedMode = "";
      state.renderedMsgs = [];
      state.liveVisible = false;
      state.lastLiveDraft = "";
      state.lastLiveDraftItemIds = [];
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
    if (meta.effort) chipItems.push(`<span class="chip" title="思考强度">${esc(meta.effort)}</span>`);
    if (meta.sandbox) chipItems.push(`<span class="chip" title="沙箱">${esc(meta.sandbox)}</span>`);
    chips.innerHTML = chipItems.join("");

    const filtered = (active.messages || []).filter((m) => messageVisibleInMode(m, state.detailMode));
    const listKey = `${meta.threadId}|${state.detailMode}|${meta.mtimeMs || 0}|${meta.size || 0}|${filtered.length}`;
    const wasSameThread = Boolean(state.renderedThreadId) && state.renderedThreadId === meta.threadId;
    const prevLiveVisible = wasSameThread && state.liveVisible;
    const prevLiveDraft = wasSameThread ? state.lastLiveDraft : "";
    const prevLiveDraftItemIds = wasSameThread ? state.lastLiveDraftItemIds : [];
    let appendedNew = false;

    if (listKey !== state.lastListKey) {
      const sameVisibleList =
        wasSameThread &&
        state.renderedMode === state.detailMode &&
        filtered.length > 0 &&
        filtered.length === state.renderedMsgs.length &&
        list.children.length === state.renderedMsgs.length &&
        state.renderedMsgs.every((prevMsg, i) => sameRenderedMessage(prevMsg, filtered[i]));

      const canAppend =
        !sameVisibleList &&
        wasSameThread &&
        state.renderedMode === state.detailMode &&
        state.renderedMsgs.length > 0 &&
        filtered.length > state.renderedMsgs.length &&
        list.children.length === state.renderedMsgs.length &&
        state.renderedMsgs.every((prevMsg, i) => sameRenderedMessage(prevMsg, filtered[i]));

      if (sameVisibleList) {
        // Hidden tool/meta log writes changed file size/mtime without altering visible bubbles; skip DOM rebuild
      } else if (canAppend) {
        const added = filtered.slice(state.renderedMsgs.length);
        const tpl = document.createElement("template");
        tpl.innerHTML = added.map((m) => buildMessageHtml(m, meta.threadId)).join("");
        const addedRows = Array.from(tpl.content.children);
        const animateStart = addedRows.length > 4 ? addedRows.length - 3 : 0;
        const addedBubbles = [];
        const hasUntrackedDraft =
          prevLiveDraftItemIds.length === 0 || prevLiveDraftItemIds.includes("_default");
        let settledFallbackUsed = false;
        let enterOrder = 0;
        for (let i = 0; i < addedRows.length; i++) {
          const row = addedRows[i];
          const msg = added[i];
          const isExactDraftMatch =
            prevLiveVisible &&
            Boolean(msg.itemId && msg.itemId !== "_default" && prevLiveDraftItemIds.includes(msg.itemId));
          const isFallbackDraftMatch =
            prevLiveVisible &&
            !isExactDraftMatch &&
            !settledFallbackUsed &&
            (hasUntrackedDraft || !msg.itemId) &&
            draftMatchesMessage(prevLiveDraft, [], msg);
          if (isExactDraftMatch || isFallbackDraftMatch) {
            if (isFallbackDraftMatch) settledFallbackUsed = true;
            markRowSettling(row);
          } else if (i >= animateStart) {
            markRowEntering(row, enterOrder * 38);
            enterOrder++;
          }
          const b = row.querySelector('.bubble[data-collapsible="1"]');
          if (b) addedBubbles.push(b);
        }
        list.appendChild(tpl.content);
        if (addedBubbles.length) applyBubbleCollapse(addedBubbles, meta.threadId);
        state.renderedMsgs = filtered;
        appendedNew = true;
      } else {
        // Save open <details> under the PREVIOUSLY rendered thread ID (never attribute to newly switched thread)
        rememberOpenDetails(list);
        const activeEl = document.activeElement;
        const focusedExpandId =
          wasSameThread &&
          activeEl instanceof HTMLElement &&
          activeEl.classList.contains("bubble-expand-btn") &&
          list.contains(activeEl)
            ? activeEl.dataset.expandId || null
            : null;

        for (const w of list.querySelectorAll(".bubble-body-wrap")) {
          const cancelAnim = bubbleAnimCleanups.get(w);
          if (cancelAnim) cancelAnim();
        }
        if (!filtered.length) {
          list.innerHTML = `<div class="empty-state"><div class="empty-desc">当前档位暂无可显示的对话消息${meta.processCount ? "（可切换右上角「默认 / 详细」查看过程说明与工具调用）" : ""}。</div></div>`;
        } else {
          list.innerHTML = filtered.map((m) => buildMessageHtml(m, meta.threadId)).join("");
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
        state.renderedMsgs = filtered;
      }
      state.lastListKey = listKey;
      state.renderedThreadId = meta.threadId;
      state.renderedMode = state.detailMode;
    }

    const liveModelSub = $("live-model-sub");
    const nextDraft = String(active.inFlightDraft || "");
    const showLiveBox = status === "running" && (Boolean(nextDraft) || !meta.activeTurnFinalized);
    let liveJustAppeared = false;
    let liveDraftUpdated = false;
    if (showLiveBox) {
      const wasHidden = liveBox.classList.contains("hidden");
      liveBox.classList.remove("hidden");
      if (wasHidden && wasSameThread) {
        liveJustAppeared = true;
        markRowEntering(liveBox, 0);
      }
      const mSub = "lastModelSub" in meta ? (meta.lastModelSub || "") : (meta.model || "");
      if (liveModelSub) {
        liveModelSub.textContent = mSub;
        liveModelSub.classList.toggle("hidden", !mSub);
      }
      if (!wasHidden && wasSameThread && nextDraft && nextDraft !== prevLiveDraft) {
        liveDraftUpdated = true;
      }
      liveDraft.innerHTML = nextDraft
        ? renderMarkdown(nextDraft)
        : `<p style="color:var(--cs-fg-muted)">Codex 正在执行任务…</p>`;
      state.liveVisible = true;
      state.lastLiveDraft = nextDraft;
      state.lastLiveDraftItemIds = Array.isArray(active.inFlightDraftItemIds) ? active.inFlightDraftItemIds : [];
    } else {
      liveBox.classList.add("hidden");
      state.liveVisible = false;
      state.lastLiveDraft = "";
      state.lastLiveDraftItemIds = [];
    }

    if (state.stickToBottom) {
      if ((appendedNew || liveJustAppeared || liveDraftUpdated) && !prefersReducedMotion()) {
        // Synchronize upward content push with the spring pop-in / streaming growth when pinned to bottom
        scheduleScrollToBottom(true);
      } else if (!state.autoScrolling) {
        scheduleScrollToBottom(false);
      }
    } else if (appendedNew || liveJustAppeared || liveDraftUpdated) {
      // User is reading history above: never push scroll position, only ensure scroll-to-bottom pill stays accurate
      syncScrollBtn();
    }
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
    cancelAutoScroll();
    state.detailMode = btn.dataset.mode;
    syncModeButtons();
    try {
      localStorage.setItem("codex_panel_detail_mode", state.detailMode);
    } catch {}
    if (state.data) renderActive(state.data);
  });

  const sessionPicker = $("session-picker");
  const sessionTrigger = $("session-trigger");
  const sessionMenu = $("session-menu");

  sessionTrigger.addEventListener("click", () => {
    if (state.sessionMenuOpen) closeSessionMenu(false);
    else openSessionMenu();
  });

  sessionTrigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!state.sessionMenuOpen) {
        const idx = e.key === "ArrowUp" ? state.sessions.length - 1 : 0;
        openSessionMenu(state.data?.activeThreadId || state.sessions[idx]?.threadId || null);
      }
    }
  });

  // Prevent pointerdown on options from pulling keyboard focus away from the listbox container
  sessionMenu.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".session-opt")) {
      e.preventDefault();
    }
  });

  sessionMenu.addEventListener("click", (e) => {
    const opt = e.target.closest(".session-opt");
    if (!opt || !opt.dataset.threadId) return;
    selectSession(opt.dataset.threadId);
  });

  sessionMenu.addEventListener("pointermove", (e) => {
    const opt = e.target.closest(".session-opt");
    if (!opt || !opt.dataset.threadId) return;
    if (opt.dataset.threadId !== state.highlightedThreadId) {
      state.highlightedThreadId = opt.dataset.threadId;
      syncMenuHighlight(false);
    }
  });

  sessionMenu.addEventListener("keydown", (e) => {
    if (!state.sessionMenuOpen) return;
    const len = state.sessions.length;
    if (!len) return;
    const curIdx = Math.max(0, state.sessions.findIndex((s) => s.threadId === state.highlightedThreadId));
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.highlightedThreadId = state.sessions[(curIdx + 1) % len].threadId;
      syncMenuHighlight(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.highlightedThreadId = state.sessions[(curIdx - 1 + len) % len].threadId;
      syncMenuHighlight(true);
    } else if (e.key === "Home") {
      e.preventDefault();
      state.highlightedThreadId = state.sessions[0].threadId;
      syncMenuHighlight(true);
    } else if (e.key === "End") {
      e.preventDefault();
      state.highlightedThreadId = state.sessions[len - 1].threadId;
      syncMenuHighlight(true);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectSession(state.highlightedThreadId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSessionMenu(true);
    } else if (e.key === "Tab") {
      closeSessionMenu(false);
    }
  });

  document.addEventListener("pointerdown", (e) => {
    if (state.sessionMenuOpen && !sessionPicker.contains(e.target)) {
      closeSessionMenu(false);
    }
  });

  window.addEventListener("blur", () => {
    if (state.sessionMenuOpen) closeSessionMenu(false);
  });

  $("refresh-btn").addEventListener("click", refresh);

  const scroller = $("chat-scroll");
  const scrollBtn = $("scroll-bottom-btn");
  const chatList = $("chat-list");

  function cancelAutoScroll() {
    if (state.pendingScrollRaf) {
      cancelAnimationFrame(state.pendingScrollRaf);
      state.pendingScrollRaf = 0;
    }
    if (state.autoScrollRaf) {
      cancelAnimationFrame(state.autoScrollRaf);
      state.autoScrollRaf = 0;
    }
    state.autoScrolling = false;
  }

  function scheduleScrollToBottom(smooth) {
    if (state.pendingScrollRaf) {
      cancelAnimationFrame(state.pendingScrollRaf);
      state.pendingScrollRaf = 0;
    }
    state.pendingScrollRaf = requestAnimationFrame(() => {
      state.pendingScrollRaf = 0;
      if (!state.stickToBottom) return;
      if (smooth) {
        smoothScrollToBottom();
      } else if (!state.autoScrolling) {
        scroller.scrollTop = scroller.scrollHeight;
        syncScrollBtn();
      }
    });
  }

  function syncScrollBtn() {
    if (state.autoScrolling) return;
    const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    state.stickToBottom = dist < 48;
    scrollBtn.classList.toggle("hidden", state.stickToBottom);
  }

  function smoothScrollToBottom(durationMs = 320) {
    cancelAutoScroll();
    const startTop = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (prefersReducedMotion() || Math.abs(maxTop - startTop) < 2) {
      scroller.scrollTop = maxTop;
      syncScrollBtn();
      return;
    }
    state.autoScrolling = true;
    state.stickToBottom = true;
    scrollBtn.classList.add("hidden");
    const t0 = performance.now();
    const step = (now) => {
      if (!state.autoScrolling) return;
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const t = Math.min(1, (now - t0) / durationMs);
      // Fast start, silky deceleration matching bubble pop-in rhythm (easeOutQuart)
      const eased = 1 - Math.pow(1 - t, 4);
      scroller.scrollTop = startTop + (target - startTop) * eased;
      if (t < 1) {
        state.autoScrollRaf = requestAnimationFrame(step);
      } else {
        state.autoScrollRaf = 0;
        state.autoScrolling = false;
        scroller.scrollTop = scroller.scrollHeight;
        syncScrollBtn();
      }
    };
    state.autoScrollRaf = requestAnimationFrame(step);
  }

  // User manual scroll input immediately cancels any queued or in-flight auto push-up animation
  const onUserScrollInterrupt = () => {
    state.userScrollGen += 1;
    if (state.autoScrolling || state.pendingScrollRaf) {
      cancelAutoScroll();
      syncScrollBtn();
    }
  };
  scroller.addEventListener("wheel", onUserScrollInterrupt, { passive: true });
  scroller.addEventListener("touchstart", onUserScrollInterrupt, { passive: true });
  scroller.addEventListener("pointerdown", onUserScrollInterrupt, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (state.sessionMenuOpen) return;
    if (e.key === " " && e.target instanceof HTMLElement && e.target.closest("button, summary, select, input, textarea")) {
      return;
    }
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
      onUserScrollInterrupt();
    }
  });

  scroller.addEventListener("scroll", syncScrollBtn);
  scrollBtn.addEventListener("click", () => {
    smoothScrollToBottom(280);
  });

  function anchorAfterCollapse(bubble, btn) {
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

  function animateBubbleToggle(bubble, wrap, body, btn, nextExpanded) {
    // Measure current visual height BEFORE clearing any in-flight animation styles so rapid reversal is seamless
    const startH = Math.round(wrap.getBoundingClientRect().height);
    const prevCancel = bubbleAnimCleanups.get(wrap);
    if (prevCancel) prevCancel();

    if (prefersReducedMotion()) {
      wrap.classList.toggle("is-collapsed", !nextExpanded);
      if (!nextExpanded) anchorAfterCollapse(bubble, btn);
      syncScrollBtn();
      return;
    }

    const scrollGenAtStart = state.userScrollGen;
    const targetH = nextExpanded ? body.scrollHeight : COLLAPSE_MAX_PX;
    const dur = Math.min(320, Math.max(190, Math.round(175 + Math.abs(targetH - startH) / 14)));

    wrap.style.maxHeight = `${startH}px`;
    wrap.classList.add("is-animating");
    wrap.classList.toggle("is-collapsed", !nextExpanded);
    wrap.style.transitionDuration = `${dur}ms`;
    // Force layout flush so the transition starts cleanly from startH
    void wrap.offsetHeight;
    wrap.style.maxHeight = `${targetH}px`;

    let done = false;
    let fallbackTimer = 0;
    const cleanup = (isComplete = false) => {
      if (done) return;
      done = true;
      clearTimeout(fallbackTimer);
      wrap.removeEventListener("transitionend", onEnd);
      bubbleAnimCleanups.delete(wrap);
      wrap.classList.remove("is-animating");
      wrap.style.maxHeight = "";
      wrap.style.transitionDuration = "";
      if (isComplete && bubble.isConnected && chatList.contains(bubble)) {
        if (!nextExpanded && state.userScrollGen === scrollGenAtStart) {
          anchorAfterCollapse(bubble, btn);
        }
        syncScrollBtn();
      }
    };
    const onEnd = (ev) => {
      if (ev.target === wrap && ev.propertyName === "max-height") cleanup(true);
    };
    wrap.addEventListener("transitionend", onEnd);
    fallbackTimer = setTimeout(() => cleanup(true), dur + 80);
    bubbleAnimCleanups.set(wrap, () => cleanup(false));
  }

  chatList.addEventListener("click", (e) => {
    const btn = e.target.closest(".bubble-expand-btn");
    if (!btn) return;
    const bubble = btn.closest('.bubble[data-collapsible="1"]');
    const wrap = bubble?.querySelector(".bubble-body-wrap");
    const body = wrap?.querySelector(".bubble-body");
    const tid = state.renderedThreadId;
    if (!bubble || !wrap || !body || !tid) return;

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

    cancelAutoScroll();
    setExpandButtonState(btn, nextExpanded);
    animateBubbleToggle(bubble, wrap, body, btn, nextExpanded);
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
        if (state.sessionMenuOpen) updateSessionMenuMaxHeight();
        const wasSticking = state.stickToBottom;
        if (widthChanged && state.renderedThreadId) {
          applyBubbleCollapse(chatList, state.renderedThreadId);
        }
        if (wasSticking) {
          cancelAutoScroll();
          scroller.scrollTop = scroller.scrollHeight;
        }
        syncScrollBtn();
      });
    });
    ro.observe(scroller);
  }

  return data => {
    state.data = data;
    if (state.renderedThreadId !== data.active?.meta.threadId) {
      closeSessionMenu(false);
      state.stickToBottom = true;
    }
    renderSessions(data.sessions, data.activeThreadId);
    renderActive(data);
  };
}

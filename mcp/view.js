function startPanel(host) {
  const $ = id => document.getElementById(id);
  const call = (name, args = {}) => host.call(name, args);
  const chat = chatRenderer(id => openThread(id));
  let lastBinding, lastHostThread, etag = "", selected = false;
  const controls = panelControls((name, args) => call(name.replace("-", "_"), args));
  let page = "standby", threadId, timer, updateTimer, generation = 0, update, target, busy = false;
  function show(next) {
    page = next;
    for (const id of ["standby", "thread", "prefs", "usage"]) $(id).hidden = id !== next;
    $("back").hidden = next === "standby";
    $("back").textContent = next === "thread" || !threadId ? "主页" : "返回会话";
    $("general-status").textContent = $("error").textContent = "";
    $(next === "prefs" ? "prefs-config" : "home-config").append($("selectors"));
    etag = "";
    clearTimeout(timer);
    refresh(++generation);
  }

  async function refresh(ticket) {
    try {
      if (page === "usage") {
        const data = await call("usage");
        if (ticket === generation) controls.renderUsage(data);
        return;
      }
      if (page === "prefs") return;
      if (page === "standby") {
        const home = await call("home", context());
        if (ticket !== generation) return;
        if (follow(home)) return;
        bridge(home.daemonOnline);
        $("version").textContent = "v" + home.version;
        $("sync").textContent = "项目自动同步 · " + (home.syncReady ? "已开启" : "待启动");
        const buttons = home.recent.map(row => {
          const button = document.createElement("button");
          const dot = document.createElement("i");
          dot.className = row.status;
          const title = document.createElement("span");
          title.textContent = row.name || row.threadId;
          const project = document.createElement("small");
          project.textContent = row.project;
          button.append(dot, title, project);
          button.onclick = () => openThread(row.threadId);
          return button;
        });
        $("recent").replaceChildren(...(buttons.length ? buttons : ["暂无监管会话"]));
      } else {
        const data = await call("read_thread", { threadId, etag, conversationId: host.conversation?.() });
        if (ticket !== generation || follow(data) || data.unchanged) return;
        etag = data.etag;
        bridge(data.daemonOnline);
        $("sync").textContent = "项目自动同步 · " + (data.syncReady ? "已开启" : "待启动");
        chat(data);
      }
    } catch (err) { if (ticket === generation) $("error").textContent = err.message; }
    finally {
      if (ticket === generation && !document.hidden && ["standby", "thread"].includes(page))
        timer = setTimeout(() => refresh(ticket), document.hidden || page === "standby" ? 6000 : 1500);
    }
  }
  function bridge(online) {
    $("lamp").classList.toggle("online", online);
    $("bridge-label").textContent = online ? "桥接就绪" : "待启动";
  }
  function context() {
    return { conversationId: host.conversation?.(), callId: host.callId?.() };
  }
  function follow(data) {
    const id = data.binding;
    const changed = id && id !== lastBinding && (lastBinding !== undefined || !selected);
    lastBinding = id || null;
    const initialCall = !selected && data.openedThread;
    if ((initialCall || changed) && (initialCall || id) !== threadId) {
      openThread(initialCall || id);
      return true;
    }
    return false;
  }
  function openThread(id) {
    selected = true;
    threadId = id;
    chat({ active: null, sessions: [] });
    show(id ? "thread" : "standby");
  }
  function hostThread(id, fromInput = false) {
    if (typeof id !== "string" || !id || (!fromInput && id === lastHostThread)) return;
    lastHostThread = id;
    if (page !== "thread" || threadId !== id) openThread(id);
  }
  $("back").onclick = () => page === "thread" ? openThread(null) : show(threadId ? "thread" : "standby");
  $("usage-nav").onclick = () => show("usage");
  $("prefs-nav").onclick = () => { show("prefs"); controls.loadGeneral(); };
  async function checkUpdate(manual = false) {
    try {
      update = await call("check_update", { manual });
      if (manual) $("check-status").textContent = update.available ? "发现可安装的更新" : "当前没有可安装的更新";
      $("version").textContent = "v" + update.local.version;
      $("update-btn").hidden = !update.available || update.ignored;
      if (manual && update.available && !dialog.open) showUpdate();
    } catch (err) { if (manual) $("check-status").textContent = err.message; else console.warn("更新检查失败", err.message); }
  }

  const dialog = $("update-dialog");
  function showUpdate() {
    target = update.remote;
    $("ignore").disabled = $("install").disabled = false;
    $("installed").textContent = "v" + update.local.version;
    $("latest").textContent = "v" + target.version;
    $("commit").textContent = [target.commitSha.slice(0, 8), target.summary].filter(Boolean).join(" · ");
    $("install-state").textContent = "";
    dialog.showModal();
  }
  $("update-btn").onclick = showUpdate;
  $("cancel").onclick = () => dialog.close();
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.onclick = event => {
    const r = dialog.getBoundingClientRect();
    if (!busy && event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
  };
  async function respond(install) {
    busy = true;
    let done = false;
    for (const b of dialog.querySelectorAll("button")) b.disabled = true;
    try {
      $("install-state").textContent = install ? "正在下载安装，请稍候…" : "";
      await call(install ? "install_update" : "ignore_update", { commitSha: target.commitSha });
      done = true;
      $("update-btn").hidden = true;
      if (install) $("install-state").textContent = "安装成功，请重启 Antigravity 生效。";
      else dialog.close();
    } catch (err) { $("install-state").textContent = err.message; }
    finally {
      busy = false;
      $("cancel").disabled = false;
      $("ignore").disabled = $("install").disabled = done;
    }
  }
  $("ignore").onclick = () => respond(false);
  $("install").onclick = () => respond(true);
  $("check-now").onclick = () => checkUpdate(true);
  function resumePolling() {
    clearTimeout(timer);
    if (!document.hidden) refresh(++generation);
  }
  document.addEventListener("visibilitychange", resumePolling);
  window.addEventListener("pagehide", () => {
    generation++;
    clearTimeout(timer);
    clearInterval(updateTimer);
  });
  function startUpdateTimer() {
    updateTimer = setInterval(() => { if (!document.hidden && !dialog.open) checkUpdate(); }, 600000);
  }
  window.addEventListener("pageshow", event => {
    if (event.persisted) { resumePolling(); startUpdateTimer(); }
  });
  return {
    hostThread,
    start() {
      if (!generation) show("standby");
      controls.loadGeneral();
      checkUpdate();
      startUpdateTimer();
    }
  };
}

(() => {
  const $ = id => document.getElementById(id);
  let release, checkPromise, page = "general";
  const api = async (name, body = {}) => {
    const url = new URL("api/" + name, window.location.href);
    const response = await window.sidecar.fetch(url.pathname, { method: "POST", body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  };
  const { loadGeneral, renderUsage } = panelControls(api);
  async function checkUpdate(manual) {
    if (checkPromise) return checkPromise;
    $("check-update").disabled = $("install-update").disabled = true;
    $("update-status").textContent = "正在检查…";
    checkPromise = api("update-check", { manual }).then(info => {
      release = info.remote;
      $("update-version").textContent = "当前版本 " + info.local.version + (info.local.commitSha ? " · " + info.local.commitSha.slice(0, 7) : "");
      $("update-status").textContent = info.ignored && !manual ? "已忽略该版本，可手动检查更新" : info.available ? "可更新至 " + release.version + " · " + release.commitSha.slice(0, 7) :
        info.published ? "当前已是最新" : "Fork 尚无可安装的发布包";
      $("install-update").disabled = !info.available || (info.ignored && !manual);
    }).catch(err => { release = null; $("update-status").textContent = err.message; })
      .finally(() => { checkPromise = null; $("check-update").disabled = false; });
    return checkPromise;
  }
  $("check-update").onclick = () => checkUpdate(true);
  $("install-update").onclick = async () => {
    $("check-update").disabled = $("install-update").disabled = true;
    $("update-status").textContent = "正在校验并安装…";
    try {
      const result = await api("update-install", { commitSha: release.commitSha });
      $("update-status").textContent = "已安装 " + result.version + "。请重新打开面板，重启 Antigravity 以加载新版 hooks 和 MCP。";
    } catch (err) {
      $("update-status").textContent = err.message;
      $("install-update").disabled = false;
    } finally { $("check-update").disabled = false; }
  };
  async function show(which) {
    page = which;
    $("settings-error").textContent = "";
    for (const btn of $("settings-nav").querySelectorAll("button")) {
      const active = btn.dataset.page === page;
      btn.setAttribute("aria-pressed", active);
      $("page-" + btn.dataset.page).hidden = !active;
    }
    try {
      if (page === "general") await loadGeneral();
      if (page === "usage") renderUsage(await api("usage"));
      if (page === "update") await checkUpdate(false);
    } catch (err) { $("settings-error").textContent = err.message; }
  }
  $("settings-nav").onclick = e => { if (e.target.dataset.page) show(e.target.dataset.page); };
  $("settings-btn").onclick = () => {
    const open = $("settings-panel").hidden;
    $("settings-panel").hidden = !open;
    document.querySelector(".shell").classList.toggle("settings-open", open);
    $("settings-btn").setAttribute("aria-expanded", open);
    $("settings-btn").textContent = open ? "返回会话" : "设置";
    if (open) { show(page); checkUpdate(false); }
  };
})();

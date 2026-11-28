function panelControls(api, saveSession) {
  const $ = id => document.getElementById(id);
  const millions = n => n === 0 ? "0M" : n < 10000 ? "<0.01M" : (n / 1000000).toFixed(2) + "M";
  let prefs, catalog, home, choiceKey, savingSession = false;
  function options(select, values, selected, follow = "跟随 Codex 本机配置") {
    select.replaceChildren(new Option(follow, ""));
    for (const [value, label] of values) select.add(new Option(label, value));
    if (selected && !Array.from(select.options).some(o => o.value === selected)) select.add(new Option(selected + "（当前未列出）", selected));
    select.value = selected;
  }
  function levels(modelId) {
    const id = modelId || catalog.configuredModel;
    const model = id ? catalog.models.find(m => m.id === id) : catalog.models.find(m => m.isDefault);
    return (model?.supportedReasoningEfforts || []).map(value => [value, value]);
  }
  function efforts(selected) {
    options($("effort-select"), levels($("model-select").value), selected);
  }
  function beam(box) {
    box.classList.remove("beam");
    void box.offsetWidth;
    box.classList.add("beam");
    clearTimeout(box.beamTimer);
    box.beamTimer = setTimeout(() => box.classList.remove("beam"), 550);
  }
  function drawSession() {
    if (!catalog || !home || savingSession) return;
    const { selection, defaults } = home;
    const current = home.suggested ? undefined : home.current;
    const model = selection.pending || !current ? selection.model || "" : current.model || "";
    const effort = selection.pending || !current ? selection.effort || "" : current.effort || "";
    const defaultModel = defaults.model || catalog.configuredModel;
    const defaultEffort = defaults.effort || catalog.configuredEffort;
    const effective = model || defaultModel;
    const key = JSON.stringify([model, effort, defaultModel, defaultEffort, catalog.models]);
    if (key !== choiceKey) {
      options($("session-model"), catalog.models.map(m => [m.id, m.displayName]), model,
        defaultModel ? "跟随默认（" + defaultModel + "）" : "跟随默认设置");
      options($("session-effort"), levels(effective), effort, defaultEffort ? "跟随默认（" + defaultEffort + "）" : "跟随默认设置");
      choiceKey = key;
    }
    $("session-model").disabled = $("session-effort").disabled = false;
    $("sync-badge").textContent = selection.pending && (selection.model || selection.effort) ? "已切换同步" :
      current && !selection.pending ? "同步自 Codex" : "跟随默认";
  }
  function syncSession(next) {
    if (savingSession) return;
    if (home?.current?.threadId === next.current?.threadId && home?.current?.model && next.current?.model && home.current.model !== next.current.model) {
      beam($("session-config"));
    }
    if (home?.selection.pending && !next.selection.pending && next.current) $("general-status").textContent = "";
    home = next;
    drawSession();
  }
  async function changeSession(event) {
    const patch = event.target === $("session-model") ? { model: event.target.value } : { effort: event.target.value };
    if (patch.model !== undefined && home.selection.effort && !levels(patch.model || home.defaults.model).some(([id]) => id === home.selection.effort)) patch.effort = "";
    savingSession = true;
    $("session-model").disabled = $("session-effort").disabled = true;
    try {
      home.selection = await saveSession(home, patch);
      $("general-status").textContent = "已保存，下一轮生效";
    } catch (err) { $("general-status").textContent = err.message; }
    finally { savingSession = false; choiceKey = null; drawSession(); }
  }
  $("session-model").onchange = $("session-effort").onchange = changeSession;
  function drawPrefs() {
    $("open-desktop").checked = prefs.openDesktop;
    if (!catalog) return;
    options($("model-select"), catalog.models.map(m => [m.id, m.displayName]), prefs.model);
    efforts(prefs.effort);
  }
  function lockGeneral(busy) {
    $("open-desktop").disabled = busy || !prefs;
    $("model-select").disabled = $("effort-select").disabled = busy || !catalog;
  }
  async function loadGeneral() {
    lockGeneral(true);
    try {
      prefs = await api("settings");
      drawPrefs();
      catalog = await api("models");
      drawPrefs();
      drawSession();
    } catch (err) { $("general-status").textContent = err.message; }
    finally { lockGeneral(false); }
  }
  async function save(event) {
    const changedModel = event.target.id === "model-select";
    if (changedModel) {
      const old = $("effort-select").value;
      efforts("");
      if ([...$("effort-select").options].some(o => o.value === old)) $("effort-select").value = old;
    }
    lockGeneral(true);
    try {
      const patch = event.target.id === "open-desktop" ? { openDesktop: $("open-desktop").checked } : { effort: $("effort-select").value };
      if (changedModel) patch.model = $("model-select").value;
      prefs = await api("save-settings", patch);
      drawPrefs();
      $("general-status").textContent = "已保存";
      if (changedModel) {
        beam($("model-feedback"));
      }
    } catch (err) { drawPrefs(); $("general-status").textContent = err.message; }
    finally { lockGeneral(false); }
  }
  for (const id of ["model-select", "effort-select", "open-desktop"]) $(id).addEventListener("change", save);

  function renderUsage(data) {
    $("usage-coverage").textContent = data.periods[3].partial ? "部分旧会话缺少接管时的累计值，只计入能确认的用量。" : "";
    $("usage-periods").replaceChildren(...data.periods.map((period, index) => {
      const card = document.createElement("article");
      const title = document.createElement("span");
      title.textContent = ["今天", "本周", "本月", "近一年"][index];
      const value = document.createElement("strong");
      value.textContent = millions(period.totalTokens);
      const cache = document.createElement("small");
      cache.textContent = "缓存命中 " + (period.hitRate == null ? "—" : (100 * period.hitRate).toFixed(1) + "%");
      card.append(title, value, cache);
      return card;
    }));
    const days = document.createDocumentFragment();
    const peak = Math.max(1, ...Object.values(data.days).map(day => day.totalTokens));
    const date = new Date(data.start + "T12:00:00");
    for (let i = 0; i < (date.getDay() + 6) % 7; i++) days.append(document.createElement("span"));
    for (let i = 0; i < 365; i++, date.setDate(date.getDate() + 1)) {
      const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
      const d = data.days[key];
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "heat-cell";
      cell.dataset.level = d?.totalTokens ? Math.min(4, Math.ceil(4 * Math.sqrt(d.totalTokens / peak))) : 0;
      const detail = key + (d ? " · 共 " + millions(d.totalTokens) + " · 输入 " + millions(d.inputTokens) +
        " · 缓存读取 " + (d.cacheSamples ? millions(d.cachedInputTokens) : "—") + " · 输出 " + millions(d.outputTokens) +
        " · 推理 " + (d.reasoningSamples ? millions(d.reasoningOutputTokens) : "—") : " · 无用量记录");
      cell.title = detail;
      cell.setAttribute("aria-label", detail);
      for (const event of ["mouseenter", "focus", "click"]) cell.addEventListener(event, () => { $("day-detail").textContent = detail; });
      days.append(cell);
    }
    $("heatmap").replaceChildren(days);
  }
  return { loadGeneral, renderUsage, syncSession };
}

function panelControls(api) {
  const $ = id => document.getElementById(id);
  const number = new Intl.NumberFormat("zh-CN");
  let prefs, catalog;
  function options(select, values, selected) {
    select.replaceChildren(new Option("跟随 Codex 本机配置", ""));
    for (const [value, label] of values) select.add(new Option(label, value));
    if (selected && !Array.from(select.options).some(o => o.value === selected)) select.add(new Option(selected + "（当前未列出）", selected));
    select.value = selected;
  }
  function efforts(selected) {
    const id = $("model-select").value || catalog.configuredModel;
    const model = id ? catalog.models.find(m => m.id === id) : catalog.models.find(m => m.isDefault);
    const levels = model?.supportedReasoningEfforts || [];
    options($("effort-select"), levels.map(v => [v, v]), selected);
  }
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
        const box = $("model-feedback");
        box.classList.remove("beam");
        void box.offsetWidth;
        box.classList.add("beam");
        setTimeout(() => box.classList.remove("beam"), 600);
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
      value.textContent = number.format(period.totalTokens);
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
      const detail = key + (d ? " · 共 " + number.format(d.totalTokens) + " · 输入 " + number.format(d.inputTokens) +
        " · 缓存读取 " + (d.cacheSamples ? number.format(d.cachedInputTokens) : "—") + " · 输出 " + number.format(d.outputTokens) +
        " · 推理 " + (d.reasoningSamples ? number.format(d.reasoningOutputTokens) : "—") : " · 无用量记录");
      cell.title = detail;
      cell.setAttribute("aria-label", detail);
      for (const event of ["mouseenter", "focus", "click"]) cell.addEventListener(event, () => { $("day-detail").textContent = detail; });
      days.append(cell);
    }
    $("heatmap").replaceChildren(days);
  }
  return { loadGeneral, renderUsage };
}

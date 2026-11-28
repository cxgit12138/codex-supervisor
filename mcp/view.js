const app = new SupervisorSDK.App({ name: "Codex Supervisor", version: "1.0.0" }, {});
const $ = id => document.getElementById(id);
async function call(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent;
}
const controls = panelControls((name, args) => call(name.replace("-", "_"), args));
let page = "standby", threadId, timer, generation = 0, update, target, busy = false;
function show(next) {
  page = next;
  for (const id of ["standby", "thread", "prefs", "usage"]) $(id).hidden = id !== next;
  $("back").hidden = next === "standby";
  $("back").textContent = next === "thread" || !threadId ? "返回待机页" : "返回会话";
  $("general-status").textContent = $("error").textContent = "";
  $(next === "prefs" ? "prefs-config" : "home-config").append($("selectors"));
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
      const home = await call("home");
      if (ticket !== generation) return;
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
      const data = await call("read_thread", { threadId });
      if (ticket !== generation) return;
      bridge(data.daemonOnline);
      $("sync").textContent = "项目自动同步 · " + (data.syncReady ? "已开启" : "待启动");
      $("title").textContent = data.title || threadId;
      $("status").textContent = [data.model, ({ running: "执行中", idle: "已就绪", waiting_input: "等待回复", error: "出错" })[data.status]].filter(Boolean).join(" · ");
      const messages = data.draft ? [...data.messages, { side: "codex", text: data.draft }] : data.messages;
      const follow = scrollY + innerHeight >= document.documentElement.scrollHeight - 40;
      $("messages").replaceChildren(...messages.map(m => {
        const p = document.createElement("p");
        p.className = "bubble " + (m.side === "supervisor" ? "bubble-supervisor" : "bubble-codex");
        p.textContent = m.text;
        return p;
      }));
      if (follow) scrollTo(0, document.documentElement.scrollHeight);
    }
  } catch (err) { if (ticket === generation) $("error").textContent = err.message; }
  finally {
    if (ticket === generation && ["standby", "thread"].includes(page))
      timer = setTimeout(() => refresh(ticket), document.hidden || page === "standby" ? 6000 : 1500);
  }
}
function bridge(online) {
  $("lamp").classList.toggle("online", online);
  $("bridge-label").textContent = online ? "桥接就绪" : "待启动";
}
function openThread(id) {
  threadId = id;
  $("messages").replaceChildren();
  $("title").textContent = id || "";
  show(id ? "thread" : "standby");
}
$("back").onclick = () => page === "thread" ? openThread(null) : show(threadId ? "thread" : "standby");
$("usage-nav").onclick = () => show("usage");
$("prefs-nav").onclick = () => { show("prefs"); controls.loadGeneral(); };
app.ontoolresult = result => openThread(result.structuredContent?.threadId);

function applyTheme(context) {
  if (context?.theme === "light" || context?.theme === "dark") document.documentElement.dataset.theme = context.theme;
}
app.onhostcontextchanged = applyTheme;
async function checkUpdate() {
  try {
    update = await call("check_update");
    $("version").textContent = "v" + update.local.version;
    $("update-btn").hidden = !update.available || update.ignored;
  } catch (err) { console.warn("更新检查失败", err.message); }
}

const dialog = $("update-dialog");
$("update-btn").onclick = () => {
  target = update.remote;
  $("ignore").disabled = $("install").disabled = false;
  $("installed").textContent = "v" + update.local.version;
  $("latest").textContent = "v" + target.version;
  $("commit").textContent = [target.commitSha.slice(0, 8), target.summary].filter(Boolean).join(" · ");
  $("install-state").textContent = "";
  dialog.showModal();
};
$("cancel").onclick = () => dialog.close();
dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
dialog.onclick = event => {
  const r = dialog.getBoundingClientRect();
  if (!busy && event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
};
async function respond(install) {
  busy = true;
  for (const b of dialog.querySelectorAll("button")) b.disabled = true;
  try {
    $("install-state").textContent = install ? "正在下载安装，请稍候…" : "";
    await call(install ? "install_update" : "ignore_update", { commitSha: target.commitSha });
    $("update-btn").hidden = true;
    if (install) $("install-state").textContent = "安装成功，请重启 Antigravity 生效。";
    else dialog.close();
  } catch (err) { $("install-state").textContent = err.message; }
  finally {
    busy = false;
    $("cancel").disabled = false;
    $("ignore").disabled = $("install").disabled = $("update-btn").hidden;
  }
}
$("ignore").onclick = () => respond(false);
$("install").onclick = () => respond(true);
app.connect().then(() => {
  applyTheme(app.getHostContext?.());
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (!generation) show("standby");
  controls.loadGeneral();
  checkUpdate();
  setInterval(() => { if (!document.hidden && !dialog.open) checkUpdate(); }, 600000);
}).catch(err => { $("error").textContent = err.message; });

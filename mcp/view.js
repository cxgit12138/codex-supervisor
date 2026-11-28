const app = new SupervisorSDK.App({ name: "Codex Supervisor", version: "1.0.0" }, {});
const statusLine = document.getElementById("status");
let threadId, generation = 0, timer;
async function refresh(ticket) {
  if (!threadId || ticket !== generation) return;
  try {
    const result = await app.callServerTool({ name: "read_thread", arguments: { threadId } });
    if (ticket !== generation) return;
    if (result.isError) throw new Error(result.content[0].text);
    const data = result.structuredContent;
    document.getElementById("title").textContent = data.title || threadId;
    statusLine.textContent = [data.model, ({ running: "执行中", idle: "已就绪", waiting_input: "等待回复", error: "出错" })[data.status]].filter(Boolean).join(" · ");
    const messages = data.messages.slice();
    if (data.draft) messages.push({ side: "codex", text: data.draft });
    const list = document.getElementById("messages");
    const follow = window.scrollY + innerHeight >= document.documentElement.scrollHeight - 40;
    list.replaceChildren(...messages.map(message => {
      const p = document.createElement("p");
      p.className = "bubble " + (message.side === "supervisor" ? "bubble-supervisor" : "bubble-codex");
      p.style.whiteSpace = "pre-wrap";
      p.textContent = message.text;
      return p;
    }));
    if (follow) window.scrollTo(0, document.documentElement.scrollHeight);
  } catch (err) {
    if (ticket === generation) statusLine.textContent = err.message;
  } finally {
    if (ticket === generation) timer = setTimeout(() => refresh(ticket), document.hidden ? 6000 : 1500);
  }
}
app.ontoolresult = result => {
  threadId = result.structuredContent?.threadId;
  clearTimeout(timer);
  generation++;
  document.getElementById("messages").replaceChildren();
  if (threadId) refresh(generation);
  else statusLine.textContent = "当前对话尚未派单。默认模型 " + (result.structuredContent?.defaultModel || "跟随 Codex") +
    "，思考强度 " + (result.structuredContent?.defaultEffort || "跟随 Codex");
};
app.onhostcontextchanged = context => { document.documentElement.dataset.theme = context.theme; };
app.connect().catch(err => { statusLine.textContent = err.message; });

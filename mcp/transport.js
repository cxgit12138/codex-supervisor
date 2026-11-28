const app = new SupervisorSDK.App({ name: "Codex Supervisor", version: "1.0.0" }, {});
const panel = startPanel({
  conversation: () => app.getHostContext()?.conversationId,
  callId: () => app.getHostContext()?.toolInfo?.id,
  call: async (name, args) => {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent;
  }
});

// 先接收工具参数，再握手。空的结果不能撤销已经选中的线程。
app.ontoolinput = ({ arguments: args }) => panel.hostThread(args?.threadId ?? args?.Arguments?.threadId, true);
app.ontoolresult = result => {
  let id = result.structuredContent?.threadId;
  for (const block of result.content || []) {
    if (id || block.type !== "text") continue;
    const text = block.text.trim();
    id = /^已选择监管线程 ([\w-]+)$/.exec(text)?.[1];
    if (!id && text.startsWith("{")) {
      try { id = JSON.parse(text).structuredContent?.threadId; }
      catch (err) { if (!(err instanceof SyntaxError)) throw err; }
    }
  }
  panel.hostThread(id);
};
function applyTheme(context) {
  if (context?.theme === "light" || context?.theme === "dark") document.documentElement.dataset.theme = context.theme;
}
app.onhostcontextchanged = applyTheme;
app.connect().then(() => {
  applyTheme(app.getHostContext());
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  panel.start();
}).catch(err => { document.getElementById("error").textContent = err.message; });

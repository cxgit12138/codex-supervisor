const app = new SupervisorSDK.App({ name: "Codex Supervisor", version: "1.0.0" }, {});
let invocationConversation;
const viewKey = crypto.randomUUID();
const panel = startPanel({
  conversation: () => app.getHostContext()?.conversationId || invocationConversation,
  sessionKey: viewKey,
  handoff: () => app.updateModelContext({ content: [{ type: "text", text:
    "此对话已选择 Supervisor 会话设置。首次使用 codex-ctl start 时传 --session-key " + viewKey + "，取得 threadId 后正常续聊。" }] }),
  callId: () => app.getHostContext()?.toolInfo?.id,
  call: async (name, args) => {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent;
  }
});

// 先接收工具参数，再握手。空的结果不能撤销已经选中的线程。
app.ontoolinput = ({ arguments: args }) => {
  const input = args?.Arguments || args;
  invocationConversation = input?.conversationId || invocationConversation;
  panel.hostThread(input?.threadId, true);
};
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

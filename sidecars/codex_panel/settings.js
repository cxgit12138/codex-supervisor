// Sidecar 从宿主取得对话 ID，其他页面逻辑与 MCP 共用。
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

startPanel({
  conversation: () => window.sidecar.conversationId,
  call: async (name, args = {}) => {
    const url = new URL("api/" + name, location.href);
    const res = await window.sidecar.fetch(url.pathname, { method: "POST", body: JSON.stringify(args) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  }
}).start();

export function cobrowseSocketUrl(requestUrl, env = process.env) {
  const configured = env.COBROWSE_WS_BASE_URL || env.WS_BASE_URL || env.STREAMING_WS_URL;
  let base;
  if (configured) {
    base = new URL(configured);
    if (!["ws:", "wss:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error("Invalid co-browse WebSocket base URL");
  } else {
    const app = new URL(requestUrl);
    base = new URL(app.origin);
    base.protocol = app.protocol === "https:" ? "wss:" : "ws:";
    if (["localhost", "127.0.0.1"].includes(base.hostname))
      base.port = String(env.STREAMING_WS_PORT || Number(app.port || 3000) + 1);
    else base.pathname = "/ws";
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/cobrowse`;
  return base.href;
}

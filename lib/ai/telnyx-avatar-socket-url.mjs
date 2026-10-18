const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function loopbackOrigin(origin) {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && LOOPBACK_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * WebSocket URL of this deployment's assistant/avatar relay for a browser page.
 *
 * WS_BASE_URL (or STREAMING_WS_URL) is the public relay address; in development
 * it is often a tunnel. A page opened on this machine (pageOrigin on localhost,
 * 127.0.0.1 or [::1]) always gets this machine's relay instead: the relay must
 * verify tokens signed here, and a tunnel may be down or lead to another
 * Contact Center instance (which answers "Could not authorize this call").
 */
export function telnyxAvatarSocketUrl(requestUrl, env = process.env, { pageOrigin } = {}) {
  const app = new URL(requestUrl);
  const localPage = loopbackOrigin(pageOrigin);
  const configured = localPage ? null : env.WS_BASE_URL || env.STREAMING_WS_URL;
  const page = localPage || app;
  const base = configured ? new URL(configured) : new URL(page.origin);
  if (!configured) {
    base.protocol = page.protocol === "https:" ? "wss:" : "ws:";
    if (LOOPBACK_HOSTS.has(base.hostname)) base.port = String(parseInt(env.STREAMING_WS_PORT || "0", 10) || parseInt(env.PORT || page.port || "3000", 10) + 1);
    else base.pathname = "/ws";
  }
  if (!["ws:", "wss:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || (page.protocol === "https:" && base.protocol !== "wss:")) throw new Error("Configure a secure avatar WebSocket URL");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/widget-avatar`;
  return base.href;
}

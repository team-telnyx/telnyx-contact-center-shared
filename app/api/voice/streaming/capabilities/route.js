/**
 * Returns the WebSocket streaming server URL/port for the flow editor.
 * Used by StreamingStartNodeEditor to build correct ws:// URLs.
 */
export const runtime = "nodejs";

export async function GET() {
  const mainPort = parseInt(process.env.PORT || "3000", 10);
  const wsPort = parseInt(
    process.env.STREAMING_WS_PORT || String(mainPort + 1),
    10
  );

  // Match the runtime resolver used by voice-flow-engine.js. WS_BASE_URL is the
  // canonical public reverse-proxy URL in production; STREAMING_WS_URL is kept
  // as a legacy/alternate explicit override.
  const configuredWsUrl = process.env.WS_BASE_URL || process.env.STREAMING_WS_URL;

  let resolvedPort = wsPort;
  if (configuredWsUrl) {
    try {
      const parsed = new URL(configuredWsUrl);
      if (parsed.port) resolvedPort = parseInt(parsed.port, 10);
    } catch (_) {}
  }

  return Response.json({
    wsPort: resolvedPort,
    // wsUrl is returned only when explicitly configured (e.g. behind a reverse proxy)
    ...(configuredWsUrl ? { wsUrl: configuredWsUrl } : {}),
  });
}

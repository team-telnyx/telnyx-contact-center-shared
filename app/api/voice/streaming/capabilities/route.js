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

  // If STREAMING_WS_URL is explicitly set, parse the port from it
  let resolvedPort = wsPort;
  if (process.env.STREAMING_WS_URL) {
    try {
      const parsed = new URL(process.env.STREAMING_WS_URL);
      if (parsed.port) resolvedPort = parseInt(parsed.port, 10);
    } catch (_) {}
  }

  return Response.json({
    wsPort: resolvedPort,
    // wsUrl is returned only when explicitly configured (e.g. behind a reverse proxy)
    ...(process.env.STREAMING_WS_URL
      ? { wsUrl: process.env.STREAMING_WS_URL }
      : {}),
  });
}

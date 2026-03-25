/**
 * Streaming WebSocket server for contact-center.
 * Runs on a separate port (default: main + 1 = 3001).
 * 
 * Routes:
 *   /streaming/google  → Google Gemini Live handler
 *   /streaming/openai  → OpenAI Realtime handler
 *   /streaming/azure   → Azure Speech Transcription + Translation handler
 * 
 * Auth: STREAMING_SECRET query param (optional — if not set, allows all)
 * 
 * ESM module — loaded via await import() from instrumentation.js
 */

import { WebSocketServer } from "ws";

const STREAMING_WS_PORT = parseInt(process.env.STREAMING_WS_PORT || "0", 10); // 0 = auto (main + 1)

export function initStreamingWSServer() {
  // Check if existing WS server is still alive
  if (globalThis.__streamingWss) {
    try {
      const addr = globalThis.__streamingWss.address();
      if (addr) {
        console.log(`[Streaming WS] Already running on port ${addr.port} — skipping init`);
        return;
      }
    } catch (_) {}
    // Dead — clean up
    globalThis.__streamingWss = null;
    globalThis.__streamingWsPort = null;
  }

  const port = STREAMING_WS_PORT || (parseInt(process.env.PORT || "3000", 10) + 1);
  startServer(port);
}

function startServer(port) {
  const wss = new WebSocketServer({ port, host: "0.0.0.0" });
  globalThis.__streamingWss = wss;

  wss.on("listening", () => {
    const addr = wss.address();
    globalThis.__streamingWsPort = addr.port;
    const secret = process.env.STREAMING_SECRET ? " (secret auth enabled)" : " (no auth — set STREAMING_SECRET)";
    console.log(`[Streaming WS] ✅ Listening on port ${addr.port}${secret}`);
    console.log(`[Streaming WS] Routes: /streaming/google | /streaming/openai | /streaming/azure`);
  });

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[Streaming WS] Port ${port} already in use — assuming existing server`);
    } else {
      console.error("[Streaming WS] Server error:", err.message);
    }
  });

  wss.on("connection", (clientWs, request) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;

    // Auth: check STREAMING_SECRET query param
    const streamingSecret = process.env.STREAMING_SECRET;
    if (streamingSecret) {
      const incomingSecret = url.searchParams.get("secret");
      if (incomingSecret !== streamingSecret) {
        console.warn(`[Streaming WS] Rejected unauthorized connection (path=${path})`);
        try { clientWs.send(JSON.stringify({ type: "error", error: "Unauthorized" })); } catch (_) {}
        clientWs.close(4001, "Unauthorized");
        return;
      }
    }

    if (path.startsWith("/streaming/")) {
      const rawProvider = path.split("/streaming/")[1]?.split("/")[0] || "";
      const provider = rawProvider.split("?")[0];

      if (provider === "azure") {
        handleAzureConnection(clientWs, request);
      } else if (provider === "google" || provider === "openai" || provider === "test") {
        handleAIStreamingConnection(clientWs, request, provider);
      } else {
        console.warn(`[Streaming WS] Unknown provider: ${provider}`);
        try { clientWs.send(JSON.stringify({ type: "error", error: `Unknown provider: ${provider}` })); } catch (_) {}
        clientWs.close(1008, "Unknown provider");
      }
    } else {
      console.warn(`[Streaming WS] Unknown path: ${path}`);
      clientWs.close(1008, "Unknown path");
    }
  });
}

/**
 * Route to Google/OpenAI AI streaming handler (ESM module)
 */
function handleAIStreamingConnection(clientWs, request, provider) {
  import("../app/api/voice/streaming/ws-handler.js")
    .then(({ handleWebSocketConnection }) => {
      handleWebSocketConnection(clientWs, request, provider);
    })
    .catch((err) => {
      console.error(`[Streaming WS] Failed to load AI handler for provider "${provider}":`, err.message);
      try { clientWs.close(1011, "Handler load failed"); } catch (_) {}
    });
}

/**
 * Route to Azure Speech Transcription handler (ESM module)
 */
function handleAzureConnection(clientWs, request) {
  import("./azure-speech-handler.mjs")
    .then(({ handleWebSocketConnection }) => {
      handleWebSocketConnection(clientWs, request);
    })
    .catch((err) => {
      console.error(`[Streaming WS] Failed to load Azure handler:`, err.message);
      try { clientWs.close(1011, "Azure handler load failed"); } catch (_) {}
    });
}

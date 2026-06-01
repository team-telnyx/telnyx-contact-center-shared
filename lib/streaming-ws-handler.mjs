/**
 * Streaming WebSocket server for contact-center.
 * Runs on a separate port (default: main + 1 = 3001).
 * 
 * Routes:
 *   /streaming/google  → Google Gemini Live handler
 *   /streaming/openai  → OpenAI Realtime handler
 *   /streaming/azure   → Azure Speech Transcription + Translation handler
 *   /streaming/telnyx-stt → Telnyx standalone Speech-to-Text WebSocket bridge
 * 
 * Auth: STREAMING_SECRET query param (optional — if not set, allows all)
 * 
 * ESM module — loaded via await import() from instrumentation.js
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const STREAMING_WS_PORT = parseInt(process.env.STREAMING_WS_PORT || "0", 10); // 0 = auto (main + 1)

export function initStreamingWSServer() {
  installStreamingShutdownHandlers();

  // Check if existing WS server is still alive
  if (globalThis.__streamingWss) {
    try {
      const addr = globalThis.__streamingHttpServer?.address?.();
      if (addr) {
        console.log(`[Streaming WS] Already running on port ${addr.port} — skipping init`);
        return;
      }
    } catch (_) {}
    // Dead — clean up
    resetStreamingServerGlobals();
  }

  const port = STREAMING_WS_PORT || (parseInt(process.env.PORT || "3000", 10) + 1);
  startServer(port);
}

export async function shutdownStreamingWSServer({ signal = null, exit = false } = {}) {
  const server = globalThis.__streamingHttpServer;
  const wss = globalThis.__streamingWss;

  if (!server && !wss) {
    resetStreamingServerGlobals();
    if (exit && signal) process.exit(signalToExitCode(signal));
    return;
  }

  const port = globalThis.__streamingWsPort || server?.address?.()?.port || "unknown";
  if (signal) {
    console.log(`[Streaming WS] ${signal} received — closing WebSocket server on port ${port}...`);
  } else {
    console.log(`[Streaming WS] Closing WebSocket server on port ${port}...`);
  }

  if (wss) {
    for (const client of wss.clients || []) {
      try {
        client.close(1001, "Server shutting down");
      } catch (_) {}
      setTimeout(() => {
        try {
          if (client.readyState !== client.CLOSED) client.terminate();
        } catch (_) {}
      }, 250).unref?.();
    }
  }

  const closeWss = wss
    ? new Promise((resolve) => {
        try {
          wss.close(() => resolve());
        } catch (_) {
          resolve();
        }
      })
    : Promise.resolve();

  const closeServer = server
    ? new Promise((resolve) => {
        try {
          server.close((err) => {
            if (err) console.warn(`[Streaming WS] Error while closing HTTP server: ${err.message}`);
            resolve();
          });
        } catch (_) {
          resolve();
        }
      })
    : Promise.resolve();

  await Promise.all([closeWss, closeServer]);
  resetStreamingServerGlobals();
  console.log("[Streaming WS] Closed");

  if (exit && signal) process.exit(signalToExitCode(signal));
}

function installStreamingShutdownHandlers() {
  if (globalThis.__streamingShutdownHandlersInstalled) return;

  const handleShutdownSignal = (signal) => {
    shutdownStreamingWSServer({ signal, exit: true }).catch((err) => {
      console.error(`[Streaming WS] Failed to close on ${signal}:`, err.message);
      process.exit(signalToExitCode(signal));
    });
  };

  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);
  globalThis.__streamingShutdownHandlersInstalled = true;
}

function signalToExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function resetStreamingServerGlobals() {
  globalThis.__streamingHttpServer = null;
  globalThis.__streamingWss = null;
  globalThis.__streamingWsPort = null;
}

function startServer(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && (url.pathname === "/api/health" || url.pathname === "/health")) {
      const payload = {
        status: "healthy",
        service: "streaming-websocket",
        port: globalThis.__streamingWsPort || port,
        websocket: "listening",
        timestamp: new Date().toISOString(),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });

  const wss = new WebSocketServer({ server });
  globalThis.__streamingHttpServer = server;
  globalThis.__streamingWss = wss;

  server.on("listening", () => {
    const addr = server.address();
    globalThis.__streamingWsPort = addr.port;
    const secret = process.env.STREAMING_SECRET ? " (secret auth enabled)" : " (no auth — set STREAMING_SECRET)";
    console.log(`[Streaming WS] ✅ Listening on port ${addr.port}${secret}`);
    console.log(`[Streaming WS] HTTP health: /api/health | Routes: /streaming/google | /streaming/openai | /streaming/azure | /streaming/telnyx-stt`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[Streaming WS] Port ${port} already in use — assuming existing server`);
      resetStreamingServerGlobals();
      try { wss.close(); } catch (_) {}
      try { server.close(); } catch (_) {}
    } else {
      console.error("[Streaming WS] Server error:", err.message);
    }
  });

  server.listen(port, "0.0.0.0");

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
      } else if (provider === "telnyx-stt") {
        handleTelnyxSttConnection(clientWs, request);
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

/**
 * Route to Telnyx standalone STT WebSocket bridge (ESM module)
 */
function handleTelnyxSttConnection(clientWs, request) {
  import("./telnyx-stt-handler.mjs")
    .then(({ handleWebSocketConnection }) => {
      handleWebSocketConnection(clientWs, request);
    })
    .catch((err) => {
      console.error(`[Streaming WS] Failed to load Telnyx STT handler:`, err.message);
      try { clientWs.close(1011, "Telnyx STT handler load failed"); } catch (_) {}
    });
}

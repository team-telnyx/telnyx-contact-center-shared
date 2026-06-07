import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const streamingLogger = createDiagnosticLogger("telnyx.streaming");
const platformLogger = createDiagnosticLogger("platform.app");

/**
 * Streaming WebSocket server for contact-center.
 * Runs on a separate port (default: main + 1 = 3001).
 *
 * Routes:
 *   /streaming/google  → Google Gemini Live handler
 *   /streaming/openai  → OpenAI Realtime handler
 *   /streaming/telnyx-stt → Telnyx standalone Speech-to-Text WebSocket bridge
 *
 * Auth: STREAMING_SECRET query param (optional — if not set, allows all)
 *
 * ESM module — loaded via await import() from instrumentation.js
 */

const STREAMING_WS_PORT = parseInt(process.env.STREAMING_WS_PORT || "0", 10); // 0 = auto (main + 1)
const SHUTDOWN_CLOSE_CODE = 1001;
const SHUTDOWN_CLOSE_REASON = "Streaming server shutting down";
const DEFAULT_CLIENT_CLOSE_TIMEOUT_MS = 500;
const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 1000;

function getStreamingState() {
  if (!globalThis.__streamingWsState) {
    globalThis.__streamingWsState = {
      httpServer: null,
      wss: null,
      port: null,
      closing: false,
      starting: false,
      shutdownPromise: null,
      handlersRegistered: false,
      signalHandlers: null
    };
  }
  return globalThis.__streamingWsState;
}

function getDefaultStreamingPort() {
  return STREAMING_WS_PORT || parseInt(process.env.PORT || "3000", 10) + 1;
}

function isHttpServerListening(server) {
  return Boolean(server?.listening && server.address());
}

function syncLegacyGlobals(state) {
  globalThis.__streamingHttpServer = state.httpServer;
  globalThis.__streamingWss = state.wss;
  globalThis.__streamingWsPort = state.port;
}

function clearStreamingStateIfCurrent(state, server, wss) {
  if (state.httpServer === server) {
    state.httpServer = null;
    state.port = null;
  }
  if (state.wss === wss) {
    state.wss = null;
  }
  state.closing = false;
  state.starting = false;
  state.shutdownPromise = null;
  syncLegacyGlobals(state);
}

function registerProcessShutdownHandlers() {
  const state = getStreamingState();
  if (state.handlersRegistered) return;

  const shutdownForSignal = (signal) => {
    shutdownStreamingWSServer({ reason: `process_${signal}` }).
    catch((err) => {
      streamingLogger.warn("streaming_ws_shutdown_failed");
    }).
    finally(() => {
      process.exit(0);
    });
  };

  const onSigint = () => shutdownForSignal("SIGINT");
  const onSigterm = () => shutdownForSignal("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  state.signalHandlers = { onSigint, onSigterm };
  state.handlersRegistered = true;
}

export function initStreamingWSServer(options = {}) {
  const state = getStreamingState();

  if (state.closing) {
    streamingLogger.info("streaming_ws_shutdown_in_progress");
    return state;
  }

  // Existing sidecar is either already listening or still binding; do not start
  // another listener during Next.js instrumentation/hot-reload re-entry.
  if (state.httpServer && state.wss && !state.closing) {
    if (isHttpServerListening(state.httpServer)) {
      const addr = state.httpServer.address();
      streamingLogger.info("streaming_ws_already_running");
    } else if (state.starting) {
      streamingLogger.info("streaming_ws_startup_in_progress");
    } else {
      // Server object exists but is neither listening nor starting: stale state.
      state.httpServer = null;
      state.wss = null;
      state.port = null;
      syncLegacyGlobals(state);
    }

    if (state.httpServer && state.wss) {
      syncLegacyGlobals(state);
      return state;
    }
  }

  // Dead/stale singleton from hot reload or a failed bind — clean it before starting.
  state.httpServer = null;
  state.wss = null;
  state.port = null;
  state.closing = false;
  state.starting = false;
  state.shutdownPromise = null;
  syncLegacyGlobals(state);

  const port = options.port ?? getDefaultStreamingPort();
  startServer(port, options);
  return state;
}

function startServer(port, options = {}) {
  const state = getStreamingState();
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && (url.pathname === "/api/health" || url.pathname === "/health")) {
      const payload = {
        status: "healthy",
        service: "streaming-websocket",
        port: state.port || port,
        websocket: state.wss && !state.closing ? "listening" : "stopped",
        timestamp: new Date().toISOString()
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });

  const wss = new WebSocketServer({ server });
  wss.on("error", (err) => {
    streamingLogger.warn("streaming_ws_server_error");
  });

  state.httpServer = server;
  state.wss = wss;
  state.port = port;
  state.closing = false;
  state.starting = true;
  state.shutdownPromise = null;
  syncLegacyGlobals(state);

  server.on("listening", () => {
    const addr = server.address();
    state.port = typeof addr === "object" && addr ? addr.port : port;
    state.starting = false;
    syncLegacyGlobals(state);
    platformLogger.info("streaming_ws_listening", {
      port: state.port,
      friendlyMessage: `Streaming WS listening on port ${state.port}`,
    });
    platformLogger.info("streaming_ws_routes_ready", {
      port: state.port,
      friendlyMessage: `Streaming WS routes ready on port ${state.port}`,
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      streamingLogger.warn("streaming_ws_port_in_use");
    } else {
      streamingLogger.error("streaming_ws_server_error");
    }

    try {
      for (const client of wss.clients || []) {
        client.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
      }
      wss.close();
    } catch (_) {}
    try {
      server.close();
    } catch (_) {}
    clearStreamingStateIfCurrent(state, server, wss);
  });

  server.listen(port, "0.0.0.0");

  if (options.registerProcessHandlers !== false) {
    registerProcessShutdownHandlers();
  }

  wss.on("connection", (clientWs, request) => {
    if (state.closing) {
      try { clientWs.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON); } catch (_) {}
      return;
    }

    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;

    // Auth: check STREAMING_SECRET query param
    const streamingSecret = process.env.STREAMING_SECRET;
    if (streamingSecret) {
      const incomingSecret = url.searchParams.get("secret");
      if (incomingSecret !== streamingSecret) {
        streamingLogger.warn("streaming_ws_connection_rejected");
        try {clientWs.send(JSON.stringify({ type: "error", error: "Unauthorized" }));} catch (_) {}
        clientWs.close(4001, "Unauthorized");
        return;
      }
    }

    if (path.startsWith("/streaming/")) {
      const rawProvider = path.split("/streaming/")[1]?.split("/")[0] || "";
      const provider = rawProvider.split("?")[0];

      if (provider === "telnyx-stt") {
        handleTelnyxSttConnection(clientWs, request);
      } else if (provider === "google" || provider === "openai" || provider === "test") {
        handleAIStreamingConnection(clientWs, request, provider);
      } else {
        streamingLogger.warn("streaming_ws_unknown_provider");
        try {clientWs.send(JSON.stringify({ type: "error", error: `Unknown provider: ${provider}` }));} catch (_) {}
        clientWs.close(1008, "Unknown provider");
      }
    } else {
      streamingLogger.warn("streaming_ws_unknown_path");
      clientWs.close(1008, "Unknown path");
    }
  });
}

export async function waitForStreamingWSServerReady(timeoutMs = 1000) {
  const state = getStreamingState();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isHttpServerListening(state.httpServer)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Streaming WebSocket server did not start before timeout");
}

export async function shutdownStreamingWSServer(options = {}) {
  const state = getStreamingState();
  const server = state.httpServer;
  const wss = state.wss;

  if (!server && !wss) {
    state.closing = false;
    state.starting = false;
    state.port = null;
    state.shutdownPromise = null;
    syncLegacyGlobals(state);
    return { stopped: false, reason: "not_running" };
  }

  if (state.closing && state.shutdownPromise) {
    return state.shutdownPromise;
  }

  state.closing = true;
  state.starting = false;
  const reason = options.reason || SHUTDOWN_CLOSE_REASON;
  const clientCloseTimeoutMs = options.clientCloseTimeoutMs ?? DEFAULT_CLIENT_CLOSE_TIMEOUT_MS;
  const serverCloseTimeoutMs = options.serverCloseTimeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS;

  state.shutdownPromise = (async () => {
    const wssClosePromise = new Promise((resolve) => {
      if (!wss) return resolve();
      const timer = setTimeout(() => resolve(), serverCloseTimeoutMs);
      timer.unref?.();
      try {
        // Stop accepting upgraded sockets before taking the client snapshot.
        // Existing clients still need the explicit close/terminate deadline below.
        wss.close(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch (_) {
        clearTimeout(timer);
        resolve();
      }
    });

    if (wss) {
      const clients = Array.from(wss.clients || []);
      await Promise.allSettled(
        clients.map((client) =>
        new Promise((resolve) => {
          if (client.readyState === client.CLOSED) return resolve();

          const timer = setTimeout(() => {
            try {
              if (client.readyState !== client.CLOSED) {
                client.terminate();
              }
            } catch (_) {}
            resolve();
          }, clientCloseTimeoutMs);
          timer.unref?.();

          client.once("close", () => {
            clearTimeout(timer);
            resolve();
          });

          try {
            client.close(SHUTDOWN_CLOSE_CODE, reason);
          } catch (_) {
            clearTimeout(timer);
            resolve();
          }
        })
        )
      );
    }

    await Promise.allSettled([
    wssClosePromise,
    new Promise((resolve) => {
      if (!server) return resolve();
      const timer = setTimeout(() => resolve(), serverCloseTimeoutMs);
      timer.unref?.();
      try {
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch (_) {
        clearTimeout(timer);
        resolve();
      }
    })]
    );

    clearStreamingStateIfCurrent(state, server, wss);
    streamingLogger.info("streaming_ws_shutdown_completed");
    return { stopped: true, reason };
  })();

  return state.shutdownPromise;
}

/**
 * Route to Google/OpenAI AI streaming handler (ESM module)
 */
function handleAIStreamingConnection(clientWs, request, provider) {
  import("../app/api/voice/streaming/ws-handler.js").
  then(({ handleWebSocketConnection }) => {
    handleWebSocketConnection(clientWs, request, provider);
  }).
  catch((err) => {
    streamingLogger.error("streaming_ws_ai_handler_load_failed");
    try {clientWs.close(1011, "Handler load failed");} catch (_) {}
  });
}


/**
 * Route to Telnyx standalone STT WebSocket bridge (ESM module)
 */
function handleTelnyxSttConnection(clientWs, request) {
  import("./telnyx-stt-handler.mjs").
  then(({ handleWebSocketConnection }) => {
    handleWebSocketConnection(clientWs, request);
  }).
  catch((err) => {
    streamingLogger.error("streaming_ws_telnyx_stt_handler_load_failed");
    try {clientWs.close(1011, "Telnyx STT handler load failed");} catch (_) {}
  });
}

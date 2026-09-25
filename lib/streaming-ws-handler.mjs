import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  listHardphoneBridges,
  readJsonRequest,
  registerBridgeConnection as handleHardphoneBridgeConnection,
  requireBridgeAdminToken,
  sendBridgeCommand,
  writeJsonResponse,
} from "./hardphones/bridge-relay.mjs";

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
      cobrowseWss: null,
      cobrowseSweep: null,
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
    state.cobrowseWss = null;
  }
  state.closing = false;
  state.starting = false;
  state.shutdownPromise = null;
  if (state.cobrowseSweep) clearInterval(state.cobrowseSweep);
  state.cobrowseSweep = null;
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
      state.cobrowseWss = null;
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
  state.cobrowseWss = null;
  if (state.cobrowseSweep) clearInterval(state.cobrowseSweep);
  state.cobrowseSweep = null;
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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && (url.pathname === "/api/health" || url.pathname === "/health")) {
      const cobrowseReady = Number(process.env.COBROWSE_RELAY_REPLICAS || 1) === 1;
      let cobrowse = { sessions: 0, frames: 0, bytes: 0, drops: 0, errors: 0 };
      try { cobrowse = (await import("./cobrowse/relay.mjs")).relayMetrics(); } catch { /* health remains available before schema startup */ }
      const payload = {
        status: "healthy",
        service: "streaming-websocket",
        port: state.port || port,
        websocket: state.wss && !state.closing ? "listening" : "stopped",
        hardphone_bridges: listHardphoneBridges(),
        cobrowse: { ready: cobrowseReady, ...cobrowse },
        timestamp: new Date().toISOString()
      };
      // Co-browsing readiness is feature-specific; it must not take voice/STT
      // out of service when this shared sidecar remains otherwise healthy.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === "/api/hardphone-bridge/bridges" && req.method === "GET") {
      if (!requireBridgeAdminToken(req, res)) return;
      writeJsonResponse(res, 200, { ok: true, bridges: listHardphoneBridges() });
      return;
    }

    if (url.pathname === "/api/hardphone-bridge/command" && req.method === "POST") {
      if (!requireBridgeAdminToken(req, res)) return;
      try {
        const body = await readJsonRequest(req);
        const result = await sendBridgeCommand({
          bridge_id: body.bridge_id,
          phone_id: body.phone_id || null,
          vendor: body.vendor,
          host: body.host,
          action: body.action,
          payload: body.payload || {},
          timeoutMs: body.timeoutMs,
        });
        writeJsonResponse(res, result.ok ? 200 : 502, result);
      } catch (err) {
        writeJsonResponse(res, 400, { ok: false, error: err?.message || "invalid_command" });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });

  // Co-browse uses a separate WebSocket receiver so its decompressed-frame
  // limit cannot change voice/STT provider limits on this shared sidecar.
  const wss = new WebSocketServer({ noServer: true });
  const cobrowseWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: true });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    const target = path === "/cobrowse" ? cobrowseWss : wss;
    target.handleUpgrade(request, socket, head, (client) => target.emit("connection", client, request));
  });
  cobrowseWss.on("connection", async (clientWs, request) => {
    if (state.closing) return clientWs.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
    try { (await import("./cobrowse/relay.mjs")).registerCobrowseConnection(clientWs, request); }
    catch { clientWs.close(1011, "Co-browse unavailable"); }
  });
  wss.on("error", (err) => {
    streamingLogger.warn("streaming_ws_server_error");
  });

  state.httpServer = server;
  state.wss = wss;
  state.cobrowseWss = cobrowseWss;
  state.cobrowseSweep = setInterval(async () => {
    if (state.closing || Number(process.env.COBROWSE_RELAY_REPLICAS || 1) !== 1) return;
    try {
      const [{ getPostgresPool }, { sweepCobrowseSessions }] = await Promise.all([
        import("./postgres.mjs"), import("./cobrowse/lifecycle.mjs"),
      ]);
      const pool = getPostgresPool();
      if (pool) await sweepCobrowseSessions(pool);
    } catch { /* Database startup is independent of the WebSocket listener. */ }
  }, 30_000);
  state.cobrowseSweep.unref?.();
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
      cobrowseWss.close();
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

  wss.on("connection", async (clientWs, request) => {
    if (state.closing) {
      try { clientWs.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON); } catch (_) {}
      return;
    }

    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;

    if (path === "/hardphone-bridge") {
      await handleHardphoneBridgeConnection(clientWs, request);
      return;
    }

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
  const cobrowseWss = state.cobrowseWss;

  if (!server && !wss && !cobrowseWss) {
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
    const closePromises = [wss, cobrowseWss].map((instance) => new Promise((resolve) => {
      if (!instance) return resolve();
      const timer = setTimeout(resolve, serverCloseTimeoutMs);
      try { instance.close(() => { clearTimeout(timer); resolve(); }); }
      catch { clearTimeout(timer); resolve(); }
    }));

    for (const instance of [wss, cobrowseWss]) if (instance) {
      const clients = Array.from(instance.clients || []);
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
    ...closePromises,
    new Promise((resolve) => {
      if (!server) return resolve();
      const timer = setTimeout(() => resolve(), serverCloseTimeoutMs);
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

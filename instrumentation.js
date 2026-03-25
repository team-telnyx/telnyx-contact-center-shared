export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Only run on server-side
    try {
      const { ensurePostgresSchema } = await import(
        "./lib/postgres-schema.mjs"
      );

      // Ensure schema is created/updated on startup
      // This runs once when the server starts
      console.log("[Instrumentation] Ensuring PostgreSQL schema...");
      const success = await ensurePostgresSchema();

      if (success) {
        console.log("[Instrumentation] PostgreSQL schema ensured successfully");
      } else {
        console.warn("[Instrumentation] Failed to ensure PostgreSQL schema");
      }

      // Clean up ghost calls after schema is ensured
      try {
        const { cleanupGhostCalls } = await import(
          "./lib/contact-center/ghost-call-cleanup.mjs"
        );
        console.log("[Instrumentation] Starting ghost call cleanup...");
        const cleanupResult = await cleanupGhostCalls();
        console.log(
          `[Instrumentation] Ghost call cleanup completed:`,
          cleanupResult
        );
      } catch (cleanupError) {
        // Don't fail startup if cleanup fails
        console.warn(
          "[Instrumentation] Ghost call cleanup failed:",
          cleanupError.message
        );
      }
    } catch (error) {
      // Don't fail startup if schema initialization fails
      // It might fail if PostgreSQL is not available yet
      console.warn(
        "[Instrumentation] Error ensuring PostgreSQL schema:",
        error.message
      );
    }

    // Start Streaming WebSocket server on separate port (default: main + 1 = 3001)
    // Used for Google Gemini Live, OpenAI Realtime, and Azure Speech Transcription
    try {
      const mainPort = parseInt(process.env.PORT || "3000", 10);
      const wsPort = parseInt(process.env.STREAMING_WS_PORT || String(mainPort + 1), 10);
      console.log(`[Streaming WS] Starting WebSocket server on port ${wsPort}...`);
      const { initStreamingWSServer } = await import("./lib/streaming-ws-handler.mjs");
      initStreamingWSServer();
    } catch (err) {
      console.warn("[Streaming WS] Could not start:", err.message);
    }
  }
}

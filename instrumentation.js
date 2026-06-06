export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { createDiagnosticLogger } = await import("./lib/diagnostic-logger.mjs");
    const { getRuntimeLoggingConfig } = await import("./lib/logger/runtime-config.mjs");
    const { checkPostgresStatus } = await import("./lib/postgres.mjs");

    const bootstrapFileEnabled = !["0", "false", "no", "off"].includes(
      String(process.env.LOG_FILE_ENABLED || "").toLowerCase(),
    );
    const bootstrapLoggingConfig = {
      fileEnabled: bootstrapFileEnabled,
      logDir:
        process.env.LOG_DIR ||
        process.env.LOG_FILE_DIR ||
        (process.env.NODE_ENV === "production" ? "/app/logs" : `${process.cwd()}/logs`),
      logFilePath: process.env.LOG_FILE_PATH || "",
      rotationMode: process.env.LOG_ROTATION_MODE || "daily",
    };

    let runtimeLoggingConfig = null;
    const appLogger = createDiagnosticLogger("app", { config: bootstrapLoggingConfig });
    const dbLogger = createDiagnosticLogger("db", { config: bootstrapLoggingConfig });
    const streamingLogger = createDiagnosticLogger("telnyx.streaming", { config: bootstrapLoggingConfig });

    appLogger.info("application_starting", {
      nodeEnv: process.env.NODE_ENV || "development",
      nextRuntime: process.env.NEXT_RUNTIME,
      pid: process.pid,
      port: process.env.PORT || "3000",
    });

    // Only run on server-side
    try {
      const { ensurePostgresSchema } = await import(
        "./lib/postgres-schema.mjs"
      );

      // Ensure schema is created/updated on startup
      // This runs once when the server starts
      appLogger.info("postgres_schema_ensure_start", {});
      const success = await ensurePostgresSchema();

      if (success) {
        appLogger.info("postgres_schema_ensure_ok", {});
      } else {
        appLogger.warn("postgres_schema_ensure_failed", {});
      }

      try {
        runtimeLoggingConfig = await getRuntimeLoggingConfig({ forceRefresh: true });
        const runtimeLogger = createDiagnosticLogger("app", { config: runtimeLoggingConfig });
        runtimeLogger.info("runtime_logging_config_loaded", {
          consoleEnabled: runtimeLoggingConfig.consoleEnabled,
          consolePretty: runtimeLoggingConfig.consolePretty,
          fileEnabled: runtimeLoggingConfig.fileEnabled,
          logDir: runtimeLoggingConfig.logDir,
          rotationMode: runtimeLoggingConfig.rotationMode,
          retentionDays: runtimeLoggingConfig.retentionDays,
        });
      } catch (loggingConfigError) {
        appLogger.warn("runtime_logging_config_load_failed", {
          error: loggingConfigError?.message || String(loggingConfigError),
        });
      }

      try {
        const status = await checkPostgresStatus();
        const runtimeDbLogger = createDiagnosticLogger("db", runtimeLoggingConfig ? { config: runtimeLoggingConfig } : {});
        runtimeDbLogger[status.ready ? "info" : "error"]("postgres_startup_status", status);
      } catch (statusError) {
        dbLogger.error("postgres_startup_status_failed", {
          error: statusError?.message || String(statusError),
        });
      }

      // Clean up ghost calls after schema is ensured
      try {
        const { cleanupGhostCalls } = await import(
          "./lib/contact-center/ghost-call-cleanup.mjs"
        );
        appLogger.info("ghost_call_cleanup_start", {});
        const cleanupResult = await cleanupGhostCalls();
        appLogger.info("ghost_call_cleanup_completed", cleanupResult);
      } catch (cleanupError) {
        // Don't fail startup if cleanup fails
        appLogger.warn("ghost_call_cleanup_failed", {
          error: cleanupError?.message || String(cleanupError),
        });
      }
    } catch (error) {
      // Don't fail startup if schema initialization fails
      // It might fail if PostgreSQL is not available yet
      appLogger.warn("postgres_schema_startup_error", {
        error: error?.message || String(error),
      });
    }

    // Start Streaming WebSocket server on separate port (default: main + 1 = 3001)
    // Used for Google Gemini Live, OpenAI Realtime, and Telnyx STT
    try {
      const mainPort = parseInt(process.env.PORT || "3000", 10);
      const wsPort = parseInt(process.env.STREAMING_WS_PORT || String(mainPort + 1), 10);
      streamingLogger.info("streaming_ws_starting", { port: wsPort, mainPort });
      const { initStreamingWSServer } = await import("./lib/streaming-ws-handler.mjs");
      initStreamingWSServer();
      streamingLogger.info("streaming_ws_start_requested", { port: wsPort });
    } catch (err) {
      streamingLogger.warn("streaming_ws_start_failed", {
        error: err?.message || String(err),
      });
    }

    appLogger.info("application_startup_completed", { pid: process.pid });
  }
}

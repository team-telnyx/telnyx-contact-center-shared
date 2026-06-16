#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import nextEnv from "@next/env";
import { createDiagnosticLogger } from "../lib/diagnostic-logger.mjs";
import { renderStructuredLogLineForConsole } from "../lib/logger/index.mjs";
import {
  getRuntimeLoggingConfig,
  tryLoadRuntimeLoggingConfigEarly,
} from "../lib/logger/runtime-config.mjs";
import {
  allowsStreamingRole,
  allowsWebRole,
  allowsWorkerRole,
  getProcessRole,
} from "../lib/runtime/process-role.mjs";

const { loadEnvConfig } = nextEnv;
const originalEnv = { ...process.env };
const nodeEnv = originalEnv.NODE_ENV || "production";
process.env.NODE_ENV = nodeEnv;
loadEnvConfig(process.cwd(), nodeEnv !== "production");

const processRole = getProcessRole();
let runtimeLoggingConfig = await tryLoadRuntimeLoggingConfigEarly();
let runtimeLoggingConfigRefreshAt = Date.now();
let runtimeLoggingConfigRefreshInFlight = false;
const RUNTIME_LOGGING_CONFIG_REFRESH_MS = 5000;

function refreshRuntimeLoggingConfigIfStale() {
  const now = Date.now();
  if (runtimeLoggingConfigRefreshInFlight) return;
  if (now - runtimeLoggingConfigRefreshAt < RUNTIME_LOGGING_CONFIG_REFRESH_MS) return;
  runtimeLoggingConfigRefreshInFlight = true;
  runtimeLoggingConfigRefreshAt = now;
  getRuntimeLoggingConfig({ forceRefresh: true })
    .then((config) => {
      runtimeLoggingConfig = config;
    })
    .catch(() => {})
    .finally(() => {
      runtimeLoggingConfigRefreshInFlight = false;
    });
}

const logger = createDiagnosticLogger("platform.app", {
  config: {
    fileEnabled: process.env.LOG_FILE_ENABLED !== "0",
    logDir: process.env.LOG_DIR || process.env.LOG_FILE_DIR || (nodeEnv === "production" ? "/app/logs" : "logs"),
  },
  getConfig: () => runtimeLoggingConfig,
});

logger.info("process_role_runtime_starting", {
  processRole,
  allowsWeb: allowsWebRole(processRole),
  allowsWorker: allowsWorkerRole(processRole),
  allowsStreaming: allowsStreamingRole(processRole),
  pid: process.pid,
});

async function waitUntilShutdown() {
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        logger.info("process_role_runtime_shutdown_signal", { signal, processRole });
        resolve(signal);
      });
    }
  });
}

async function startStreamingOnlyRuntime() {
  const mainPort = parseInt(process.env.PORT || "3000", 10);
  const wsPort = parseInt(process.env.STREAMING_WS_PORT || String(mainPort + 1), 10);
  logger.info("web_server_skipped_for_process_role", { processRole });
  logger.info("streaming_only_runtime_starting", {
    processRole,
    port: wsPort,
    message: `Streaming-only runtime starting on port ${wsPort}`,
  });
  const { initStreamingWSServer } = await import("../lib/streaming-ws-handler.mjs");
  initStreamingWSServer();
  await waitUntilShutdown();
}

async function startWorkerOnlyRuntime() {
  logger.info("web_server_skipped_for_process_role", { processRole });
  logger.info("worker_only_runtime_starting", { processRole });
  const { startCoordinator, stopCoordinator } = await import("../lib/contact-center/coordinator.js");
  const started = await startCoordinator();
  logger.info("worker_only_coordinator_start_requested", { processRole, started });
  await waitUntilShutdown();
  await stopCoordinator();
}

function startWebRuntime() {
  const hostname = process.env.HOSTNAME || "0.0.0.0";
  const port = process.env.PORT || "3000";
  const args = ["next", "start", "--hostname", hostname, "--port", port];

  logger.info("web_server_starting", {
    command: "next start",
    hostname,
    port,
    nodeEnv: process.env.NODE_ENV || "production",
    processRole,
    pid: process.pid,
    message: `Web server starting on port ${port}`,
  });

  const child = spawn("yarn", args, {
    env: { ...process.env, NODE_ENV: nodeEnv },
    stdio: ["inherit", "pipe", "pipe"],
  });

  let readyLogged = false;
  let startingSuppressed = false;
  let bannerBlankSuppressed = false;

  function forwardLine(line, stream) {
    refreshRuntimeLoggingConfigIfStale();
    const trimmed = line.trim();
    if (/^▲\s+Next\.js\b/.test(trimmed)) {
      logger.info("web_server_next_runtime", { version: trimmed.replace(/^▲\s+/, "") });
      bannerBlankSuppressed = true;
      return;
    }
    const localMatch = /^-\s+Local:\s+(.+)$/.exec(trimmed);
    if (localMatch) {
      logger.info("web_server_endpoint", { type: "local", url: localMatch[1] });
      bannerBlankSuppressed = true;
      return;
    }
    const networkMatch = /^-\s+Network:\s+(.+)$/.exec(trimmed);
    if (networkMatch) {
      logger.info("web_server_endpoint", { type: "network", url: networkMatch[1] });
      bannerBlankSuppressed = true;
      return;
    }
    if (bannerBlankSuppressed && trimmed === "") {
      bannerBlankSuppressed = false;
      return;
    }
    if (/^✓\s+Starting\.\.\.$/.test(trimmed)) {
      startingSuppressed = true;
      return;
    }
    const readyMatch = /^✓\s+Ready in\s+(.+)$/.exec(trimmed);
    if (readyMatch) {
      readyLogged = true;
      logger.info("web_server_ready", {
        hostname,
        port,
        readyIn: readyMatch[1],
        nextCliStartingLineSuppressed: startingSuppressed,
        message: `Web server ready on port ${port}`,
      });
      return;
    }
    const rendered = renderStructuredLogLineForConsole(line, runtimeLoggingConfig || {});
    if (rendered === null) return;
    if (rendered !== undefined) {
      stream.write(`${rendered}\n`);
      return;
    }
    stream.write(`${line}\n`);
  }

  createInterface({ input: child.stdout }).on("line", (line) => forwardLine(line, process.stdout));
  createInterface({ input: child.stderr }).on("line", (line) => forwardLine(line, process.stderr));

  child.on("error", (error) => {
    logger.error("web_server_start_failed", { error: error?.message || String(error), processRole });
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    const payload = { code, signal, readyLogged, processRole };
    if (code === 0) {
      logger.info("web_server_exited", payload);
    } else {
      logger.error("web_server_exited", payload);
    }
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      logger.info("web_server_shutdown_signal", { signal, processRole });
      child.kill(signal);
    });
  }
}

if (allowsWebRole(processRole)) {
  startWebRuntime();
} else if (allowsStreamingRole(processRole)) {
  await startStreamingOnlyRuntime();
} else if (allowsWorkerRole(processRole)) {
  await startWorkerOnlyRuntime();
} else {
  logger.warn("process_role_runtime_noop", { processRole });
  await waitUntilShutdown();
}

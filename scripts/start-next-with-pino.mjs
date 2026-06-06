#!/usr/bin/env node

import "dotenv/config";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createDiagnosticLogger } from "../lib/diagnostic-logger.mjs";

const logger = createDiagnosticLogger("app", {
  config: {
    fileEnabled: process.env.LOG_FILE_ENABLED !== "0",
    logDir: process.env.LOG_DIR || process.env.LOG_FILE_DIR || (process.env.NODE_ENV === "production" ? "/app/logs" : "logs"),
  },
});

const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = process.env.PORT || "3000";
const args = ["next", "start", "--hostname", hostname, "--port", port];

logger.info("web_server_starting", {
  command: "next start",
  hostname,
  port,
  nodeEnv: process.env.NODE_ENV || "production",
  pid: process.pid,
});

const child = spawn("yarn", args, {
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
  stdio: ["inherit", "pipe", "pipe"],
});

let readyLogged = false;
let startingSuppressed = false;
let bannerBlankSuppressed = false;

function forwardLine(line, stream) {
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
    });
    return;
  }
  stream.write(`${line}\n`);
}

createInterface({ input: child.stdout }).on("line", (line) => forwardLine(line, process.stdout));
createInterface({ input: child.stderr }).on("line", (line) => forwardLine(line, process.stderr));

child.on("error", (error) => {
  logger.error("web_server_start_failed", { error: error?.message || String(error) });
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  const payload = { code, signal, readyLogged };
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
    logger.info("web_server_shutdown_signal", { signal });
    child.kill(signal);
  });
}

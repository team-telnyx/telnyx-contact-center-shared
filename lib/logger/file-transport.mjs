import fs from "node:fs";
import path from "node:path";

function isoDate(now) {
  return now.toISOString().slice(0, 10);
}

function safeTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function safeRunId(runId) {
  return String(runId || "run").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
}

export function buildLogFilePath({
  logDir = process.env.LOG_DIR || process.env.LOG_FILE_DIR || "/app/logs",
  rotationMode = process.env.LOG_ROTATION_MODE || "daily",
  now = new Date(),
  runId,
} = {}) {
  const directory = path.resolve(logDir);
  if (rotationMode === "startup") {
    return path.join(directory, `app-${safeTimestamp(now)}-${safeRunId(runId)}.jsonl`);
  }
  return path.join(directory, `app-${isoDate(now)}.jsonl`);
}

export function createJsonlFileWriter({ filePath, onError } = {}) {
  const target = filePath;
  return {
    write(line) {
      if (!target) return;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, line.endsWith("\n") ? line : `${line}\n`, "utf8");
      } catch (error) {
        onError?.(error);
      }
    },
    flush() {},
  };
}

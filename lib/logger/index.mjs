import pino from "pino";
import pinoPretty from "pino-pretty";
import { buildLogFilePath, createJsonlFileWriter } from "./file-transport.mjs";
import { sanitizeDiagnosticUrl, sanitizeLogPayload } from "./redaction.mjs";

const LEVEL_VALUES = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const DEFAULT_CONFIG = Object.freeze({
  globalLevel: "info",
  consoleEnabled: true,
  consolePretty: ["1", "true", "yes", "on"].includes(String(process.env.LOG_CONSOLE_PRETTY || "").toLowerCase()),
  fileEnabled: ["1", "true", "yes", "on"].includes(String(process.env.LOG_FILE_ENABLED || "").toLowerCase()) || Boolean(process.env.LOG_FILE_PATH),
  logDir: process.env.LOG_DIR || process.env.LOG_FILE_DIR || "/app/logs",
  logFilePath: process.env.LOG_FILE_PATH || "",
  rotationMode: process.env.LOG_ROTATION_MODE || "daily",
  topicLevels: {},
  topicEnabled: {},
  redactionEnabled: true,
});

const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "")}-pid${process.pid}`;
const PINO_RESERVED_FIELDS = new Set(["level", "time", "topic", "runId", "msg"]);

function normalizeLevel(level, fallback = "info") {
  const candidate = String(level || fallback).toLowerCase();
  return LEVEL_VALUES[candidate] ? candidate : fallback;
}

function isTopicEnabled(topic, config) {
  const topicEnabled = config.topicEnabled || {};
  if (Object.prototype.hasOwnProperty.call(topicEnabled, topic)) return topicEnabled[topic] !== false;
  const parts = topic.split(".");
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join(".");
    if (Object.prototype.hasOwnProperty.call(topicEnabled, parent)) return topicEnabled[parent] !== false;
  }
  return true;
}

function levelForTopic(topic, config) {
  const topicLevels = config.topicLevels || {};
  if (topicLevels[topic]) return normalizeLevel(topicLevels[topic], config.globalLevel);
  const parts = topic.split(".");
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join(".");
    if (topicLevels[parent]) return normalizeLevel(topicLevels[parent], config.globalLevel);
  }
  return normalizeLevel(config.globalLevel, "info");
}

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    topicLevels: { ...DEFAULT_CONFIG.topicLevels, ...(config.topicLevels || {}) },
    topicEnabled: { ...DEFAULT_CONFIG.topicEnabled, ...(config.topicEnabled || {}) },
  };
}

function createNoopLogger() {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => createNoopLogger(),
    flush: async () => {},
  };
}

function stripReservedFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  for (const reserved of PINO_RESERVED_FIELDS) delete value[reserved];
  return value;
}

function normalizeLogArgs(args, redactionEnabled) {
  if (args.length === 0) return args;
  const [first, ...rest] = args;
  if (first && typeof first === "object") {
    const sanitized = redactionEnabled ? sanitizeLogPayload(first) : { ...first };
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
      stripReservedFields(sanitized);
    }
    return [sanitized, ...rest.map((item) => (redactionEnabled && typeof item === "string") ? sanitizeLogPayload(item) : item)];
  }
  if (!redactionEnabled) return args;
  return args.map((item) => typeof item === "string" ? sanitizeLogPayload(item) : item);
}

function wrapLogger(logger, config) {
  const wrapped = {
    child(bindings = {}) {
      const safeBindings = stripReservedFields(config.redactionEnabled ? sanitizeLogPayload(bindings) : { ...bindings });
      return wrapLogger(logger.child(safeBindings), config);
    },
    flush: async () => logger.flush?.(),
  };
  for (const level of Object.keys(LEVEL_VALUES)) {
    wrapped[level] = (...args) => logger[level](...normalizeLogArgs(args, config.redactionEnabled));
  }
  return wrapped;
}

function createPrettyWriter(stdout) {
  const pretty = pinoPretty.prettyFactory(buildPrettyTransportOptions({ colorize: !stdout }));
  return {
    write(line) {
      const text = pretty(JSON.parse(line));
      if (!text) return;
      if (stdout) stdout(text.trimEnd());
      else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    flush() {},
  };
}

function createLineWriter({ stdout, fileWriter, consoleEnabled, consolePretty, fileEnabled }) {
  const prettyWriter = consoleEnabled && consolePretty ? createPrettyWriter(stdout) : null;
  return {
    write(line) {
      if (consoleEnabled) {
        if (prettyWriter) prettyWriter.write(line);
        else if (stdout) stdout(line.trimEnd());
        else process.stdout.write(line);
      }
      if (fileEnabled) fileWriter?.write(line);
    },
    flush() {
      prettyWriter?.flush?.();
      fileWriter?.flush?.();
    },
  };
}

export function buildPrettyTransportOptions(options = {}) {
  return {
    colorize: options.colorize !== false,
    translateTime: options.translateTime || "SYS:standard",
    ignore: options.ignore || "pid,hostname",
    singleLine: options.singleLine === true,
  };
}

export function createLogger({
  topic = "app",
  config: rawConfig = {},
  stdout,
  now = new Date(),
  runId = RUN_ID,
} = {}) {
  const config = mergeConfig(rawConfig);
  if (!isTopicEnabled(topic, config)) return createNoopLogger();

  const level = levelForTopic(topic, config);
  const filePath = config.fileEnabled
    ? (config.logFilePath || buildLogFilePath({ logDir: config.logDir, rotationMode: config.rotationMode, now, runId }))
    : null;
  const fileWriter = config.fileEnabled
    ? createJsonlFileWriter({
        filePath,
        onError: (error) => {
          process.stderr.write(JSON.stringify({
            time: new Date().toISOString(),
            level: "error",
            topic: "logger",
            msg: "file_sink_failed",
            error: error?.message || String(error),
          }) + "\n");
        },
      })
    : null;

  const stream = createLineWriter({
    stdout,
    fileWriter,
    consoleEnabled: config.consoleEnabled !== false,
    consolePretty: config.consolePretty === true,
    fileEnabled: config.fileEnabled === true,
  });

  const logger = pino({
    level,
    base: null,
    timestamp: () => `,"time":"${(typeof now === "function" ? now() : now).toISOString()}"`,
    formatters: {
      level(label) {
        return { level: label };
      },
      bindings() {
        return {};
      },
    },
  }, stream).child({ topic, runId });

  const wrapped = wrapLogger(logger, config);
  wrapped.flush = async () => {
    stream.flush?.();
    logger.flush?.();
  };
  return wrapped;
}

export function getLogger(topic = "app", options = {}) {
  return createLogger({ topic, ...options });
}

export {
  buildLogFilePath,
  createJsonlFileWriter,
  sanitizeDiagnosticUrl,
  sanitizeLogPayload,
};

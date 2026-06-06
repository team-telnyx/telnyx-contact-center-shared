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

function mergeRuntimeConfig(baseConfig, runtimeConfig) {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return mergeConfig(baseConfig);
  const mergedRuntime = { ...runtimeConfig };
  const runtimeControlsFileSink = Object.prototype.hasOwnProperty.call(runtimeConfig, "fileEnabled")
    || Object.prototype.hasOwnProperty.call(runtimeConfig, "logDir")
    || Object.prototype.hasOwnProperty.call(runtimeConfig, "rotationMode");
  if (runtimeControlsFileSink && !Object.prototype.hasOwnProperty.call(runtimeConfig, "logFilePath")) {
    mergedRuntime.logFilePath = "";
  }
  return mergeConfig({ ...baseConfig, ...mergedRuntime });
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

function shouldEmit(level, topic, config) {
  if (config.enabled === false) return false;
  if (!isTopicEnabled(topic, config)) return false;
  const topicLevel = levelForTopic(topic, config);
  return LEVEL_VALUES[level] >= LEVEL_VALUES[topicLevel];
}

function wrapLogger(logger, config, { topic, getConfig }) {
  function currentConfig() {
    return mergeRuntimeConfig(config, typeof getConfig === "function" ? getConfig() : null);
  }

  const wrapped = {
    child(bindings = {}) {
      const activeConfig = currentConfig();
      const safeBindings = stripReservedFields(activeConfig.redactionEnabled ? sanitizeLogPayload(bindings) : { ...bindings });
      return wrapLogger(logger.child(safeBindings), config, { topic, getConfig });
    },
    flush: async () => logger.flush?.(),
  };
  for (const level of Object.keys(LEVEL_VALUES)) {
    wrapped[level] = (...args) => {
      const activeConfig = currentConfig();
      if (!shouldEmit(level, topic, activeConfig)) return;
      logger[level](...normalizeLogArgs(args, activeConfig.redactionEnabled));
    };
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

function createLineWriter({ stdout, resolveConfig, getFileWriter }) {
  let prettyWriter = null;
  return {
    write(line) {
      const activeConfig = resolveConfig();
      const consoleEnabled = activeConfig.consoleEnabled !== false;
      const consolePretty = activeConfig.consolePretty === true;
      const fileEnabled = activeConfig.fileEnabled === true;
      if (consoleEnabled) {
        if (consolePretty && !prettyWriter) prettyWriter = createPrettyWriter(stdout);
        if (consolePretty && prettyWriter) prettyWriter.write(line);
        else if (stdout) stdout(line.trimEnd());
        else process.stdout.write(line);
      }
      if (fileEnabled) getFileWriter(activeConfig)?.write(line);
    },
    flush() {
      prettyWriter?.flush?.();
      getFileWriter()?.flush?.();
    },
  };
}

function currentNow(now) {
  return typeof now === "function" ? now() : now;
}

function createFileWriter({ config, now, runId, onError }) {
  if (!config.fileEnabled) return null;
  if (config.logFilePath || config.rotationMode !== "daily") {
    return createJsonlFileWriter({
      filePath: config.logFilePath || buildLogFilePath({ logDir: config.logDir, rotationMode: config.rotationMode, now: currentNow(now), runId }),
      onError,
    });
  }

  return {
    write(line) {
      let entryTime = currentNow(now);
      try {
        const parsed = JSON.parse(line);
        if (parsed?.time) entryTime = new Date(parsed.time);
      } catch {}
      createJsonlFileWriter({
        filePath: buildLogFilePath({ logDir: config.logDir, rotationMode: config.rotationMode, now: entryTime, runId }),
        onError,
      }).write(line);
    },
    flush() {},
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
  now = () => new Date(),
  runId = RUN_ID,
  getConfig,
} = {}) {
  const config = mergeConfig(rawConfig);
  const resolveConfig = () => mergeRuntimeConfig(config, typeof getConfig === "function" ? getConfig() : null);
  const fileWriters = new Map();
  const onFileError = (error) => {
    process.stderr.write(JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      topic: "logger",
      msg: "file_sink_failed",
      error: error?.message || String(error),
    }) + "\n");
  };
  const getFileWriter = (activeConfig = resolveConfig()) => {
    if (activeConfig.fileEnabled !== true) return null;
    const key = JSON.stringify({
      logFilePath: activeConfig.logFilePath || "",
      logDir: activeConfig.logDir,
      rotationMode: activeConfig.rotationMode,
    });
    if (!fileWriters.has(key)) {
      fileWriters.set(key, createFileWriter({
        config: activeConfig,
        now,
        runId,
        onError: onFileError,
      }));
    }
    return fileWriters.get(key);
  };

  const stream = createLineWriter({
    stdout,
    resolveConfig,
    getFileWriter,
  });

  const logger = pino({
    level: "trace",
    base: null,
    timestamp: () => `,"time":"${currentNow(now).toISOString()}"`,
    formatters: {
      level(label) {
        return { level: label };
      },
      bindings() {
        return {};
      },
    },
  }, stream).child({ topic, runId });

  const wrapped = wrapLogger(logger, config, { topic, getConfig });
  wrapped.flush = async () => {
    stream.flush?.();
    for (const writer of fileWriters.values()) writer.flush?.();
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

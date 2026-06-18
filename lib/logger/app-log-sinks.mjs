import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { getPostgresPool } from "../postgres.mjs";
import { sanitizeLogPayload } from "./redaction.mjs";
import { writeLiveLogEvent, pruneLiveLogEvents } from "./live-store.mjs";
import { enqueueArchiveLogEvent, flushArchiveBatch } from "./object-archive.mjs";

const DEFAULT_MAX_QUEUE = 1000;
let lastLivePruneAt = 0;
let sinkQueue = [];
let draining = false;
let drainPromise = null;

function safeLogDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function maxQueueSize(config = {}) {
  const parsed = Number.parseInt(String(config.sinkMaxQueuedEvents || process.env.LOG_SINK_MAX_QUEUE || DEFAULT_MAX_QUEUE), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_QUEUE;
  return Math.max(100, Math.min(10000, parsed));
}

function spoolFilePath(config = {}, entry = {}) {
  const dir = process.env.LOG_SPOOL_DIR || config.spoolDir || "/app/log-spool";
  const date = safeLogDate(entry.time || entry.ts || entry.timestamp);
  const node = String(entry.nodeName || entry.nodeId || "node").replace(/[^A-Za-z0-9_.-]/g, "-");
  return path.join(dir, `app-${date}-${node}.jsonl`);
}

async function writeSpool(entry, config) {
  const safeEntry = sanitizeLogPayload(entry);
  const target = spoolFilePath(config, safeEntry);
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(safeEntry)}\n`, "utf8");
}

export async function writeApplicationLogSinks(entry, config = {}, { pool = getPostgresPool(), now = new Date() } = {}) {
  const tasks = [];
  if (config.liveEnabled === true) {
    tasks.push(writeLiveLogEvent({ pool, event: entry, now }).catch(() => null));
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    if (nowMs - lastLivePruneAt > 60000) {
      lastLivePruneAt = nowMs;
      tasks.push(pruneLiveLogEvents({ pool, ttlMinutes: config.liveTtlMinutes, now }).catch(() => null));
    }
  }
  if (config.spoolEnabled === true) {
    tasks.push(writeSpool(entry, config).catch(() => null));
  }
  if (config.archiveEnabled === true) {
    enqueueArchiveLogEvent({ event: entry, config });
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

async function drainSinkQueue(options = {}) {
  if (draining) return drainPromise;
  draining = true;
  drainPromise = (async () => {
    try {
      while (sinkQueue.length) {
        const item = sinkQueue.shift();
        await writeApplicationLogSinks(item.entry, item.config, options);
      }
    } finally {
      draining = false;
      drainPromise = null;
    }
  })();
  return drainPromise;
}

export function enqueueApplicationLogSinks(entry, config = {}, options = {}) {
  const safeEntry = sanitizeLogPayload(entry);
  sinkQueue.push({ entry: safeEntry, config: { ...config } });
  const max = maxQueueSize(config);
  if (sinkQueue.length > max) sinkQueue.splice(0, sinkQueue.length - max);
  void drainSinkQueue(options).catch(() => null);
  return { queued: sinkQueue.length };
}

export function fireAndForgetApplicationLogSinks(entry, config, options = {}) {
  enqueueApplicationLogSinks(entry, config, options);
}

export async function flushApplicationLogSinks(options = {}) {
  await drainSinkQueue(options);
  await flushArchiveBatch(options).catch(() => null);
}

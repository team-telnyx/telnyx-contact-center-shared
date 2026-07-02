import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sanitizeLogPayload } from "./redaction.mjs";

let defaultS3Client = null;
let sequenceCounter = 0;
let batchTimer = null;
let pendingBatch = [];
let flushing = false;

const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_FLUSH_MS = 5000;
const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

function safeSegment(value, fallback = "unknown") {
  const text = String(value || fallback).trim().replace(/[^A-Za-z0-9_.=-]/g, "-").replace(/-+/g, "-");
  return text || fallback;
}

function nextSequence() {
  sequenceCounter += 1;
  return String(sequenceCounter).padStart(6, "0");
}

function eventDate(event = {}) {
  const date = new Date(event.time || event.ts || event.timestamp || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function numericConfig(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function buildArchiveObjectKey({ prefix = "logs", event = {}, sequence = nextSequence() } = {}) {
  const cleanPrefix = String(prefix || "logs").replace(/^\/+|\/+$/g, "") || "logs";
  const date = eventDate(event);
  const node = safeSegment(event.nodeName || event.nodeId, "node");
  const run = safeSegment(event.runId, "run");
  const part = safeSegment(sequence, nextSequence());
  return `${cleanPrefix}/date=${date}/node=${node}/run=${run}/part-${part}.jsonl`;
}

function getS3Client(config = {}) {
  if (defaultS3Client) return defaultS3Client;
  defaultS3Client = new S3Client({
    region: config.archiveRegion || process.env.LOG_ARCHIVE_REGION || process.env.AWS_REGION || process.env.STORAGE_REGION || "us-east-2",
    endpoint: config.archiveEndpoint || process.env.LOG_ARCHIVE_ENDPOINT || undefined,
    forcePathStyle: String(config.archiveForcePathStyle || process.env.LOG_ARCHIVE_FORCE_PATH_STYLE || "").toLowerCase() === "true",
  });
  return defaultS3Client;
}

async function putArchiveChunk({ events, config = {}, s3Client, sequence } = {}) {
  if (!events?.length || config.archiveEnabled !== true || config.archiveProvider !== "s3" || !config.archiveBucket) return null;
  const first = events[0];
  const key = buildArchiveObjectKey({ prefix: config.archivePrefix, event: first, sequence });
  const body = `${events.map((event) => JSON.stringify(sanitizeLogPayload(event))).join("\n")}\n`;
  const client = s3Client || getS3Client(config);
  await client.send(new PutObjectCommand({
    Bucket: config.archiveBucket,
    Key: key,
    Body: body,
    ContentType: "application/x-ndjson",
  }));
  return { bucket: config.archiveBucket, key, count: events.length };
}

export async function writeArchiveLogEvent({ event, config = {}, s3Client, sequence } = {}) {
  if (config.archiveEnabled !== true || config.archiveProvider !== "s3" || !config.archiveBucket) return null;
  const safeEvent = sanitizeLogPayload(event);
  return putArchiveChunk({ events: [safeEvent], config, s3Client, sequence });
}

export async function flushArchiveBatch({ s3Client } = {}) {
  if (flushing || !pendingBatch.length) return null;
  flushing = true;
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  const batch = pendingBatch;
  pendingBatch = [];
  try {
    const grouped = new Map();
    for (const item of batch) {
      const key = JSON.stringify({ bucket: item.config.archiveBucket, prefix: item.config.archivePrefix || "logs", provider: item.config.archiveProvider || "s3" });
      const group = grouped.get(key) || { config: item.config, events: [] };
      group.events.push(item.event);
      grouped.set(key, group);
    }
    const results = [];
    for (const group of grouped.values()) {
      results.push(await putArchiveChunk({ events: group.events, config: group.config, s3Client }));
    }
    return results.filter(Boolean);
  } catch (error) {
    const maxBuffered = numericConfig(batch[0]?.config?.archiveMaxBufferedEvents || process.env.LOG_ARCHIVE_MAX_BUFFERED_EVENTS, DEFAULT_MAX_BUFFERED_EVENTS, 100, 10000);
    pendingBatch = [...batch, ...pendingBatch].slice(-maxBuffered);
    throw error;
  } finally {
    flushing = false;
  }
}

export function enqueueArchiveLogEvent({ event, config = {} } = {}) {
  if (config.archiveEnabled !== true || config.archiveProvider !== "s3" || !config.archiveBucket) return null;
  const safeEvent = sanitizeLogPayload(event);
  const maxBuffered = numericConfig(config.archiveMaxBufferedEvents || process.env.LOG_ARCHIVE_MAX_BUFFERED_EVENTS, DEFAULT_MAX_BUFFERED_EVENTS, 100, 10000);
  const maxBatchSize = numericConfig(config.archiveBatchSize || process.env.LOG_ARCHIVE_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE, 10, 1000);
  const flushMs = numericConfig(config.archiveFlushMs || process.env.LOG_ARCHIVE_FLUSH_MS, DEFAULT_FLUSH_MS, 250, 60000);

  pendingBatch.push({ event: safeEvent, config: { ...config } });
  if (pendingBatch.length > maxBuffered) pendingBatch.splice(0, pendingBatch.length - maxBuffered);
  if (pendingBatch.length >= maxBatchSize) {
    void flushArchiveBatch().catch(() => null);
  } else if (!batchTimer) {
    batchTimer = setTimeout(() => {
      batchTimer = null;
      void flushArchiveBatch().catch(() => null);
    }, flushMs);
    batchTimer.unref?.();
  }
  return { queued: pendingBatch.length };
}

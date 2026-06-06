import { open, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sanitizeLogPayload } from "./redaction.mjs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 20 * 1024 * 1024;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const SAFE_LOG_FILE_RE = /^app-[A-Za-z0-9_.:-]+\.jsonl$/;

function safeLimit(value) {
  const parsed = Number(value || DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

function parseTime(value) {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function parseRequiredTime(label, value) {
  if (!value) return null;
  const millis = parseTime(value);
  if (millis === null) throw new Error(`Invalid ${label} timestamp`);
  return millis;
}

function normalizeLevel(value) {
  return value ? String(value).toLowerCase() : "";
}

function normalizeString(value) {
  return value == null ? "" : String(value);
}

function isSafeLogFileName(name) {
  return typeof name === "string" && SAFE_LOG_FILE_RE.test(name) && path.basename(name) === name;
}

function entryTimeMillis(entry) {
  return parseTime(entry?.time || entry?.ts || entry?.timestamp) || 0;
}

function matchesFilters(entry, filters) {
  if (filters.fromMillis != null && entryTimeMillis(entry) < filters.fromMillis) return false;
  if (filters.toMillis != null && entryTimeMillis(entry) > filters.toMillis) return false;
  if (filters.level && normalizeLevel(entry.level) !== filters.level) return false;
  if (filters.topic && normalizeString(entry.topic || entry.scope) !== filters.topic) return false;
  if (filters.runId && normalizeString(entry.runId) !== filters.runId) return false;
  if (filters.search) {
    const haystack = JSON.stringify(entry).toLowerCase();
    if (!haystack.includes(filters.search)) return false;
  }
  return true;
}

export async function listLogFiles({ logDir, limit = 30 } = {}) {
  if (!logDir) return [];
  const names = await readdir(logDir).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!isSafeLogFileName(name)) continue;
    const fullPath = path.join(logDir, name);
    const linkInfo = await lstat(fullPath).catch(() => null);
    if (!linkInfo?.isFile()) continue;
    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({ name, size: info.size, mtime: info.mtime.toISOString() });
  }
  files.sort((a, b) => String(b.name).localeCompare(String(a.name)) || String(b.mtime).localeCompare(String(a.mtime)));
  return files.slice(0, safeLimit(limit));
}

async function readLogFile({ logDir, name }) {
  if (!isSafeLogFileName(name)) throw new Error("Invalid log file");
  const fullPath = path.resolve(logDir, name);
  const resolvedDir = path.resolve(logDir);
  if (!fullPath.startsWith(`${resolvedDir}${path.sep}`)) throw new Error("Invalid log file");
  const linkInfo = await lstat(fullPath).catch(() => null);
  if (!linkInfo?.isFile()) throw new Error("Invalid log file");
  const [realDir, realFile] = await Promise.all([realpath(resolvedDir), realpath(fullPath)]);
  if (!realFile.startsWith(`${realDir}${path.sep}`)) throw new Error("Invalid log file");
  const info = await stat(realFile).catch(() => null);
  if (!info?.isFile()) throw new Error("Log file not found");
  if (info.size > MAX_FILE_BYTES) return { content: await readLogFileTail(realFile, info.size), truncated: true };
  return { content: await readFile(realFile, "utf8"), truncated: false };
}

async function readLogFileTail(filePath, size) {
  const start = Math.max(0, size - MAX_FILE_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    if (start === 0) return content;
    const firstNewline = content.indexOf("\n");
    return firstNewline === -1 ? "" : content.slice(firstNewline + 1);
  } finally {
    await handle.close();
  }
}

function addBoundedNewest(entries, entry, maxEntries) {
  entries.push(entry);
  entries.sort((a, b) => entryTimeMillis(b) - entryTimeMillis(a));
  if (entries.length > maxEntries) entries.length = maxEntries;
}

export async function queryLogEntries({
  logDir,
  file,
  level,
  topic,
  runId,
  search,
  from,
  to,
  limit,
} = {}) {
  const effectiveLimit = safeLimit(limit);
  const filters = {
    level: normalizeLevel(level),
    topic: normalizeString(topic),
    runId: normalizeString(runId),
    search: normalizeString(search).trim().toLowerCase(),
    fromMillis: parseRequiredTime("from", from),
    toMillis: parseRequiredTime("to", to),
  };

  const files = file
    ? [{ name: file }]
    : await listLogFiles({ logDir, limit: 10 });

  const entries = [];
  let skippedInvalid = 0;
  let bytesRead = 0;
  let truncatedByFileSize = false;

  for (const item of files) {
    const { content, truncated } = await readLogFile({ logDir, name: item.name });
    truncatedByFileSize = truncatedByFileSize || truncated;
    bytesRead += Buffer.byteLength(content);
    if (bytesRead > MAX_AGGREGATE_BYTES) throw new Error("Log query too large");
    const lines = content.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        skippedInvalid += 1;
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        skippedInvalid += 1;
        continue;
      }
      const sanitized = sanitizeLogPayload(entry);
      if (!matchesFilters(sanitized, filters)) continue;
      addBoundedNewest(entries, sanitized, effectiveLimit + 1);
    }
  }

  const truncated = truncatedByFileSize || entries.length > effectiveLimit;
  return {
    entries: entries.slice(0, effectiveLimit),
    files: files.map((item) => item.name),
    skippedInvalid,
    truncated,
  };
}

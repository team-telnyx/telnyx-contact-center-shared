import { NextResponse } from "next/server";
import { getRuntimeLoggingConfig } from "@/lib/logger/runtime-config.mjs";
import { listLogFiles, queryLogEntries } from "@/lib/logger/log-reader.mjs";
import { queryLiveLogEvents } from "@/lib/logger/live-store.mjs";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";


function noStore(payload, init = {}) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

function queryParam(request, key) {
  return new URL(request.url).searchParams.get(key) || undefined;
}

function queryParams(request, key) {
  return new URL(request.url).searchParams.getAll(key).filter(Boolean);
}

async function GET_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const config = await getRuntimeLoggingConfig({ forceRefresh: true });
    const logDir = config.logDir;
    const mode = queryParam(request, "mode") || "entries";
    if (mode === "files") {
      const files = await listLogFiles({ logDir, limit: queryParam(request, "limit") || 30 });
      return noStore({ ok: true, files });
    }
    if (mode === "live") {
      const result = await queryLiveLogEvents({
        env: queryParam(request, "env"),
        nodeName: queryParam(request, "nodeName"),
        level: queryParam(request, "level"),
        topic: queryParam(request, "topic"),
        topics: queryParams(request, "topics"),
        runId: queryParam(request, "runId"),
        search: queryParam(request, "search"),
        from: queryParam(request, "from"),
        to: queryParam(request, "to"),
        limit: queryParam(request, "limit") || 100,
        ttlMinutes: config.liveTtlMinutes,
      });
      return noStore({ ok: true, ...result });
    }

    const latestOnly = queryParam(request, "latest") === "1";
    const [latestFile] = latestOnly && !queryParam(request, "file") ? await listLogFiles({ logDir, limit: 1 }) : [];
    const result = await queryLogEntries({
      logDir,
      file: queryParam(request, "file") || latestFile?.name,
      level: queryParam(request, "level"),
      topic: queryParam(request, "topic"),
      topics: queryParams(request, "topics"),
      nodeName: queryParam(request, "nodeName"),
      runId: queryParam(request, "runId"),
      search: queryParam(request, "search"),
      from: queryParam(request, "from"),
      to: queryParam(request, "to"),
      limit: queryParam(request, "limit") || 100,
    });
    return noStore({ ok: true, ...result });
  } catch (error) {
    const message = error?.message || "Failed to read logs";
    const isClientError = /Invalid log file|Invalid .* timestamp|too large/i.test(message);
    return noStore({ ok: false, error: isClientError ? message : "Failed to read logs" }, { status: isClientError ? 400 : 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("logging:read", GET_handler, { route: "/api/admin/logging/logs" });

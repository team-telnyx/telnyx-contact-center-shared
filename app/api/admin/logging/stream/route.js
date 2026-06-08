import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { getRuntimeLoggingConfig } from "@/lib/logger/runtime-config.mjs";
import { listLogFiles, queryLogEntries } from "@/lib/logger/log-reader.mjs";

export const dynamic = "force-dynamic";

const POLL_MS = 1000;

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user || !isAdmin(user)) return null;
  return user;
}

function queryParam(request, key) {
  return new URL(request.url).searchParams.get(key) || undefined;
}

function queryParams(request, key) {
  return new URL(request.url).searchParams.getAll(key).filter(Boolean);
}

function entryKey(entry) {
  return JSON.stringify({
    time: entry?.time || entry?.ts || entry?.timestamp || "",
    runId: entry?.runId || "",
    topic: entry?.topic || entry?.scope || "",
    level: entry?.level || entry?.severity || "",
    message: entry?.msg || entry?.message || entry?.event || "",
    payload: entry,
  });
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });

  const config = await getRuntimeLoggingConfig({ forceRefresh: true });
  const logDir = config.logDir;
  const encoder = new TextEncoder();

  let pollTimer = null;
  let latestFileName = null;
  let seen = new Set();
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
          return true;
        } catch (error) {
          cleanup();
          return false;
        }
      };

      const poll = async () => {
        try {
          const [latestFile] = await listLogFiles({ logDir, limit: 1 });
          if (!latestFile?.name) {
            send("heartbeat", { ok: true, file: null });
            return;
          }
          if (latestFile.name !== latestFileName) {
            latestFileName = latestFile.name;
            seen = new Set();
            const initial = await queryLogEntries({
              logDir,
              file: latestFile.name,
              level: queryParam(request, "level"),
              topic: queryParam(request, "topic"),
              topics: queryParams(request, "topics"),
              runId: queryParam(request, "runId"),
              search: queryParam(request, "search"),
              from: queryParam(request, "from"),
              to: queryParam(request, "to"),
              limit: queryParam(request, "limit") || 100,
            });
            initial.entries.forEach((entry) => seen.add(entryKey(entry)));
            send("ready", { ok: true, file: latestFile.name, entries: initial.entries });
            return;
          }

          const result = await queryLogEntries({
            logDir,
            file: latestFile.name,
            level: queryParam(request, "level"),
            topic: queryParam(request, "topic"),
            topics: queryParams(request, "topics"),
            runId: queryParam(request, "runId"),
            search: queryParam(request, "search"),
            from: queryParam(request, "from"),
            to: queryParam(request, "to"),
            limit: queryParam(request, "limit") || 100,
          });
          for (let index = result.entries.length - 1; index >= 0; index -= 1) {
            const entry = result.entries[index];
            const key = entryKey(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            if (!send("log", entry)) break;
          }
        } catch (error) {
          send("error", { error: "Failed to stream logs", detail: error?.message || String(error) });
        }
      };

      await poll();
      pollTimer = setInterval(poll, POLL_MS);

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch (_) {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

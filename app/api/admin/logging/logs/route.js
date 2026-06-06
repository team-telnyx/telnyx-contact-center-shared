import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { getRuntimeLoggingConfig } from "@/lib/logger/runtime-config.mjs";
import { listLogFiles, queryLogEntries } from "@/lib/logger/log-reader.mjs";

export const dynamic = "force-dynamic";

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

function noStore(payload, init = {}) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

function queryParam(request, key) {
  return new URL(request.url).searchParams.get(key) || undefined;
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return noStore({ ok: false, error: "Forbidden" }, { status: 403 });

  try {
    const config = await getRuntimeLoggingConfig({ forceRefresh: true });
    const logDir = config.logDir;
    const mode = queryParam(request, "mode") || "entries";
    if (mode === "files") {
      const files = await listLogFiles({ logDir, limit: queryParam(request, "limit") || 30 });
      return noStore({ ok: true, files });
    }

    const latestOnly = queryParam(request, "latest") === "1";
    const [latestFile] = latestOnly && !queryParam(request, "file") ? await listLogFiles({ logDir, limit: 1 }) : [];
    const result = await queryLogEntries({
      logDir,
      file: queryParam(request, "file") || latestFile?.name,
      level: queryParam(request, "level"),
      topic: queryParam(request, "topic"),
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

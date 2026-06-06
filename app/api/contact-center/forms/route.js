export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";

function mapRow(row) {
  return row ? { ...row, queue_ids: row.queue_ids || [], queue_names: row.queue_names || [] } : null;
}

export async function GET(request) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  const queueName = searchParams.get("queueName");
  const queueId = searchParams.get("queueId");
  const formIds = (searchParams.get("formIds") || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const args = [];
  let i = 1;
  const filters = ["status = 'published'"];
  const visibility = [];
  let explicitFormIdsArg = null;

  if (queueName || queueId) {
    const queueClauses = ["(cardinality(queue_names)=0 AND cardinality(queue_ids)=0)"];
    if (queueName) {
      queueClauses.push(`$${i++} = ANY(queue_names)`);
      args.push(queueName);
    }
    if (queueId) {
      queueClauses.push(`$${i++} = ANY(queue_ids)`);
      args.push(queueId);
    }
    visibility.push(`(${queueClauses.join(" OR ")})`);
  }

  if (formIds.length) {
    explicitFormIdsArg = i++;
    visibility.push(`id = ANY($${explicitFormIdsArg}::uuid[])`);
    args.push(formIds);
  }

  if (visibility.length) filters.push(`(${visibility.join(" OR ")})`);

  const explicitOrder = explicitFormIdsArg
    ? `CASE WHEN id = ANY($${explicitFormIdsArg}::uuid[]) THEN 0 ELSE 1 END, array_position($${explicitFormIdsArg}::uuid[], id),`
    : "";

  const { rows } = await pool.query(
    `SELECT * FROM form_definitions WHERE ${filters.join(" AND ")} ORDER BY ${explicitOrder} auto_open DESC, name ASC`,
    args,
  );

  return NextResponse.json({ ok: true, forms: rows.map(mapRow) });
}

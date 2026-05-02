import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
function mapRow(row) { return row ? { ...row, queue_ids: row.queue_ids || [], queue_names: row.queue_names || [] } : null; }
export async function GET(request) {
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const pool = getPostgresPool(); if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url); const queueName = searchParams.get("queueName"); const queueId = searchParams.get("queueId"); const formIds = (searchParams.get("formIds") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const where = ["status = 'published'"]; const args = []; let i = 1;
  if (queueName || queueId) { where.push(`((cardinality(queue_names)=0 AND cardinality(queue_ids)=0) OR ${queueName ? `$${i++} = ANY(queue_names)` : "false"} OR ${queueId ? `$${i++} = ANY(queue_ids)` : "false"})`); if (queueName) args.push(queueName); if (queueId) args.push(queueId); }
  if (formIds.length) { where.push(`id = ANY($${i++}::uuid[])`); args.push(formIds); }
  const { rows } = await pool.query(`SELECT * FROM form_definitions WHERE ${where.join(" AND ")} ORDER BY auto_open DESC, name ASC`, args);
  return NextResponse.json({ ok: true, forms: rows.map(mapRow) });
}

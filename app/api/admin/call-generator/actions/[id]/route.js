import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { normalizeSteps } from "@/lib/call-generator/actions.mjs";
import { DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT, DEFAULT_WORKFLOW_TESTING_VOICE, WORKFLOW_TESTING_ACTION_ID, normalizePersona, normalizeMaxSlotsPerTurn } from "@/lib/call-generator/workflow-testing.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const body = await request.json();
    const columns = [];
    const values = [];
    let idx = 1;
    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (!name) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      columns.push(`name = $${idx++}`);
      values.push(String(id) === WORKFLOW_TESTING_ACTION_ID ? "Workflow Testing" : name);
    }
    if (body.description !== undefined) { columns.push(`description = $${idx++}`); values.push(String(id) === WORKFLOW_TESTING_ACTION_ID ? "Protected call-generator action used by Test Workflow targets. Only the TTS voice and preview sample text are editable." : (String(body.description || "").trim() || null)); }
    if (body.steps !== undefined) {
      const steps = normalizeSteps(body.steps);
      const safeSteps = String(id) === WORKFLOW_TESTING_ACTION_ID
        ? [(() => {
            const wt = steps.find((step) => step.type === "workflow_testing") || {};
            const maxSlots = normalizeMaxSlotsPerTurn(wt.max_slots_per_turn);
            return {
              type: "workflow_testing",
              voice: wt.voice || DEFAULT_WORKFLOW_TESTING_VOICE,
              sample_text: wt.sample_text || DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT,
              persona: normalizePersona(wt.persona),
              max_slots_per_turn: maxSlots,
              // randomize only has meaning when more than one slot is allowed.
              randomize_slots: maxSlots > 1 ? wt.randomize_slots === true : false,
              // normalizeSteps already forces expressive off for voices that
              // don't support it (non-Ultra / non-xAI), so carry it through.
              expressive: wt.expressive === true,
            };
          })()]
        : steps;
      columns.push(`steps = $${idx++}`);
      values.push(JSON.stringify(safeSteps));
    }
    if (!columns.length) return NextResponse.json({ error: "No changes" }, { status: 400 });
    values.push(id);
    await pool.query(`UPDATE cg_actions SET ${columns.join(", ")} WHERE id = $${idx}`, values);
    const { rows } = await pool.query(`SELECT * FROM cg_actions WHERE id = $1`, [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ action: rows[0] });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_action_update_failed", runtimePayload({ error: err, operation: "cg_action_update" }));
    return NextResponse.json({ error: "Failed to update action" }, { status: 500 });
  }
}

export async function DELETE(_request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    if (String(id) === WORKFLOW_TESTING_ACTION_ID) {
      return NextResponse.json({ error: "Workflow Testing is a protected system action and cannot be deleted" }, { status: 409 });
    }
    await pool.query(`DELETE FROM cg_actions WHERE id = $1`, [id]);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildFormContext } from "@/lib/forms/form-context";
import { createFormSubmission } from "@/lib/forms/form-submissions";
import { executeFormDataAction } from "@/lib/forms/form-data-actions";
import { findWorkItemByReference } from "@/lib/acd/work-item-repository.mjs";
import { withPermission } from "@/lib/authz/guard";
async function GET_handler(request, context, authz) {
  const user = authz.user;
  const { id } = await context.params;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json(
      { ok: false, error: "Server not ready" },
      { status: 500 },
    );
  const { searchParams } = new URL(request.url);
  const interactionId = searchParams.get("interactionId");
  const args = [id];
  let where = "form_id=$1";
  if (interactionId) {
    args.push(interactionId);
    where += ` AND work_item_id::text=$2`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM form_submissions WHERE ${where} ORDER BY created_at DESC LIMIT 50`,
    args,
  );
  return NextResponse.json({ ok: true, submissions: rows });
}
async function POST_handler(request, context, authz) {
  const user = authz.user;
  const { id } = await context.params;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json(
      { ok: false, error: "Server not ready" },
      { status: 500 },
    );
  const body = await request.json();
  const { rows } = await pool.query(
    `SELECT * FROM form_definitions WHERE id=$1 AND status='published'`,
    [id],
  );
  const form = rows[0];
  if (!form)
    return NextResponse.json(
      { ok: false, error: "Form not found" },
      { status: 404 },
    );
  let interaction = null;
  if (body.interactionId) {
    interaction = await findWorkItemByReference(pool, body.interactionId);
    if (!interaction) {
      return NextResponse.json({ ok: false, error: "Interaction not found" }, { status: 404 });
    }
  }
  const contextObj = body.context || buildFormContext(interaction || {});
  const result = await createFormSubmission(pool, {
    form,
    data: body.data || {},
    context: contextObj,
    interaction: interaction || { agent_username: user.username || user.email },
    status: body.status || "submitted",
  });
  if (!result.validation.ok)
    return NextResponse.json({ ok: false, ...result }, { status: 400 });

  const dataActionFlowId =
    body.dataActionFlowId ||
    body.dataActionId ||
    body.button?.props?.dataActionFlowId ||
    "";
  let dataAction = null;
  if (dataActionFlowId) {
    dataAction = await executeFormDataAction({
      flowId: dataActionFlowId,
      submission: result.submission,
      form,
      values: body.data || {},
      contextObj,
      interaction: interaction || {},
      button: body.button || null,
    });
  }

  const ok = dataAction ? dataAction.ok !== false : true;
  return NextResponse.json(
    { ok, ...result, dataAction },
    { status: ok ? 200 : 400 },
  );
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("forms:read", GET_handler, { route: "/api/contact-center/forms/[id]/submissions" });
export const POST = withPermission(["agent:self", "forms:create"], POST_handler, { route: "/api/contact-center/forms/[id]/submissions" });

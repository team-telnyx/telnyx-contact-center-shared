import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { executeFormDataAction } from "@/lib/forms/form-data-actions";

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeDataActionButtons(buttons) {
  return Array.isArray(buttons) ? buttons : [];
}

function basicCallPayload(interaction) {
  return {
    interaction_id: interaction?.id || "",
    call_control_id: interaction?.call_control_id || "",
    call_session_id: interaction?.call_session_id || "",
    direction: interaction?.direction || "",
    state: interaction?.state || "",
    from_number: interaction?.from_number || "",
    to_number: interaction?.to_number || "",
    from_name: interaction?.from_name || "",
    to_name: interaction?.to_name || "",
    queue_id: interaction?.queue_id || "",
    queue_name: interaction?.queue_name || "",
    agent_username: interaction?.agent_username || "",
  };
}

function basicWorkflowPayload({ session, workflow }) {
  return {
    workflow_id: workflow?.id || session?.workflow_id || "",
    workflow_name: workflow?.name || "",
    workflow_session_id: session?.id || "",
  };
}

async function loadWorkflowSlotValues(pool, sessionId, workflowId) {
  const { rows } = await pool.query(
    `SELECT wi.id, wi.slot_name, wis.extracted_value
     FROM aa_workflow_items wi
     JOIN aa_workflow_stages ws ON wi.stage_id = ws.id
     LEFT JOIN aa_workflow_item_status wis
       ON wis.item_id = wi.id AND wis.session_id = $1
     WHERE ws.workflow_id = $2
       AND wi.type = 'slot'
       AND wi.slot_name IS NOT NULL
       AND wi.slot_name <> ''
     ORDER BY ws.order_index, wi.order_index`,
    [sessionId, workflowId],
  );
  return rows.reduce((slots, row) => {
    slots[row.slot_name] = row.extracted_value ?? "";
    return slots;
  }, {});
}

function buildWorkflowValues({ call, workflow, slots }) {
  return {
    ...call,
    ...workflow,
    ...slots,
  };
}

function buildSyntheticWorkflowForm({ workflow, values }) {
  const fields = Object.keys(values || {}).map((key) => ({
    id: key,
    type: "hidden",
    label: key,
    variableName: key,
  }));
  return {
    id: `workflow:${workflow?.id || "unknown"}`,
    name: workflow?.name || "Workflow Data Action",
    slug: `workflow-${workflow?.id || "unknown"}`,
    schema: { pages: [{ id: "workflow", title: "Workflow", fields: fields.map((field) => field.id) }], fields },
  };
}

export async function POST(request) {
  const sessionUser = await getServerSession(authOptions);
  if (!sessionUser?.user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 503 });

  const body = await request.json();
  const sessionId = body.sessionId || body.workflowSessionId;
  const buttonId = body.buttonId || body.button?.id;
  if (!sessionId || !buttonId) {
    return NextResponse.json({ ok: false, status: "error", message: "Missing workflow session or button." }, { status: 400 });
  }

  const { rows: [workflowSession] } = await pool.query(
    `SELECT * FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId],
  );
  if (!workflowSession) return NextResponse.json({ ok: false, status: "error", message: "Workflow session not found." }, { status: 404 });

  const { rows: [workflow] } = await pool.query(
    `SELECT * FROM aa_workflows WHERE id = $1`,
    [workflowSession.workflow_id],
  );
  if (!workflow) return NextResponse.json({ ok: false, status: "error", message: "Workflow not found." }, { status: 404 });

  const buttons = normalizeDataActionButtons(workflow.data_action_buttons);
  const configuredButton = buttons.find((item) => String(item.id) === String(buttonId));
  if (!configuredButton) return NextResponse.json({ ok: false, status: "error", message: "Workflow data action button not found." }, { status: 404 });

  const flowId = configuredButton.data_action_flow_id || configuredButton.dataActionFlowId || configuredButton.flow_id || configuredButton.flowId;
  if (!flowId) return NextResponse.json({ ok: false, status: "error", message: "Workflow data action button has no call flow assigned." }, { status: 400 });

  let interaction = null;
  if (workflowSession.interaction_id) {
    const { rows } = await pool.query(`SELECT * FROM cc_interactions WHERE id = $1`, [workflowSession.interaction_id]);
    interaction = rows[0] || null;
  }

  const slots = await loadWorkflowSlotValues(pool, workflowSession.id, workflow.id);
  const call = basicCallPayload(interaction || { id: workflowSession.interaction_id });
  const workflowInfo = basicWorkflowPayload({ session: workflowSession, workflow });
  const values = buildWorkflowValues({ call, workflow: workflowInfo, slots });
  const form = buildSyntheticWorkflowForm({ workflow, values });
  const button = {
    id: configuredButton.id,
    label: configuredButton.label,
    type: "workflow_data_action",
    props: {
      dataActionFlowId: flowId,
      dataActionLabel: configuredButton.data_action_label || configuredButton.dataActionLabel || "",
      one_click: configuredButton.one_click === true,
    },
  };
  const compactPayload = {
    call,
    workflow: workflowInfo,
    slots,
    ...slots,
  };
  const contextObj = { call, workflow: workflowInfo, slots };

  const dataAction = await executeFormDataAction({
    flowId,
    submission: { id: `workflow:${workflowSession.id}:${button.id}:${Date.now()}`, status: "submitted", created_at: new Date().toISOString() },
    form,
    values,
    contextObj,
    interaction: interaction || { id: workflowSession.interaction_id },
    button,
    formSubmitPayloadOverride: compactPayload,
  });

  const ok = dataAction ? dataAction.ok !== false : true;
  return NextResponse.json({ ok, dataAction }, { status: ok ? 200 : 400 });
}

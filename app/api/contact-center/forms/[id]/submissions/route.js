import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildFormContext } from "@/lib/forms/form-context";
import { createFormSubmission } from "@/lib/forms/form-submissions";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import { determineNextNodes, executeFlowNode } from "@/lib/voice-flow-engine";

const FORM_DATA_ACTION_NODE_TYPES = new Set([
  "form_submit",
  "set_variable",
  "condition",
  "switch",
  "logic_gate",
  "http_request_action",
  "data_action",
  "form_submit_status",
  "flow_end",
]);

function safeJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function executeFormDataAction({ flowId, submission, form, values, contextObj, interaction, button }) {
  if (!flowId) return null;
  const flowRow = await VoiceFlowDb.getFlowById(flowId, null);
  if (!flowRow) return { ok: false, success: false, status: "error", message: "Data action flow not found." };

  const flow = {
    ...flowRow,
    nodes: safeJson(flowRow.nodes, []),
    edges: safeJson(flowRow.edges, []),
    variables: safeJson(flowRow.variables, {}),
  };
  const startNode = flow.nodes.find((node) => node?.data?.nodeType === "form_submit");
  if (!startNode) return { ok: false, success: false, status: "error", message: "Selected flow is not a Form Submit data action." };

  const callControlId = `form:${submission?.id || Date.now()}`;
  const event = {
    data: {
      event_type: "form.submit",
      payload: {
        form_id: form.id,
        form_name: form.name,
        submission_id: submission?.id,
        button_id: button?.id || null,
        button_label: button?.label || null,
        data: values,
        context: contextObj,
        interaction_id: interaction?.id || null,
      },
    },
  };
  const executionState = {
    flowId,
    callControlId,
    variables: {
      form_id: form.id,
      form_name: form.name,
      submission_id: submission?.id,
      button_id: button?.id || "",
      button_label: button?.label || "",
      form_data: values || {},
      form_context: contextObj || {},
      interaction: interaction || {},
    },
    globalVariables: flow.variables || {},
    lastOutput: 0,
  };

  let queue = determineNextNodes(flow, startNode, event, executionState);
  let status = null;
  let finalResult = { success: true, output: 0, variables: {} };
  let steps = 0;

  while (queue.length && steps < 25) {
    const node = queue.shift();
    steps += 1;
    const nodeType = node?.data?.nodeType || node?.type;
    if (!FORM_DATA_ACTION_NODE_TYPES.has(nodeType)) {
      return { ok: false, success: false, status: "error", message: `Unsupported node in form data action: ${nodeType}` };
    }
    const result = await executeFlowNode(node, callControlId, event, executionState);
    finalResult = result || finalResult;
    if (result?.variables) executionState.variables = { ...executionState.variables, ...result.variables };
    executionState.lastOutput = Number.isInteger(result?.output) ? result.output : (result?.success === false ? 1 : 0);
    if (result?.formSubmitStatus) {
      status = result.formSubmitStatus;
      break;
    }
    if (nodeType === "flow_end") break;
    queue.push(...determineNextNodes(flow, node, event, executionState));
  }

  if (!status) {
    status = finalResult?.success === false
      ? { status: "error", success: false, message: finalResult.error || "Data action failed." }
      : { status: "success", success: true, message: "Data action completed." };
  }
  return { ok: status.success !== false, ...status, variables: executionState.variables };
}

export async function GET(request, context) {
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url); const interactionId = searchParams.get("interactionId"); const args = [id]; let where = "form_id=$1"; if (interactionId) { args.push(interactionId); where += ` AND interaction_id=$2`; }
  const { rows } = await pool.query(`SELECT * FROM form_submissions WHERE ${where} ORDER BY created_at DESC LIMIT 50`, args); return NextResponse.json({ ok: true, submissions: rows });
}
export async function POST(request, context) {
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
  const body = await request.json(); const { rows } = await pool.query(`SELECT * FROM form_definitions WHERE id=$1 AND status='published'`, [id]); const form = rows[0]; if (!form) return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
  let interaction = null; if (body.interactionId) { const res = await pool.query(`SELECT * FROM cc_interactions WHERE id=$1`, [body.interactionId]); interaction = res.rows[0] || null; }
  const contextObj = body.context || buildFormContext(interaction || {}); const result = await createFormSubmission(pool, { form, data: body.data || {}, context: contextObj, interaction: interaction || { agent_username: user.username || user.email }, status: body.status || "submitted" });
  if (!result.validation.ok) return NextResponse.json({ ok: false, ...result }, { status: 400 });

  const dataActionFlowId = body.dataActionFlowId || body.dataActionId || body.button?.props?.dataActionFlowId || "";
  let dataAction = null;
  if (dataActionFlowId) {
    dataAction = await executeFormDataAction({ flowId: dataActionFlowId, submission: result.submission, form, values: body.data || {}, contextObj, interaction: interaction || {}, button: body.button || null });
  }

  const ok = dataAction ? dataAction.ok !== false : true;
  return NextResponse.json({ ok, ...result, dataAction }, { status: ok ? 200 : 400 });
}

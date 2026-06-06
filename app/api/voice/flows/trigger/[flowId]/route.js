import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { VoiceFlowDb } from "@/lib/pgdb-voice-flows.js";
import {
  determineNextNodes,
  executeFlowNode,
} from "@/lib/voice-flow-engine.js";
import { addNodeActivation, addNodeExecutionEvent, addWebhookEvent } from "@/lib/call-monitor-store.js";
import {
  DEFAULT_HTTP_REQUEST_PAYLOAD_VARIABLE,
  validateVariableName,
} from "@/lib/variable-utils.js";

const MAX_HTTP_TRIGGER_STEPS = 50;
const HTTP_TRIGGER_EVENT_TYPE = "http.request";

function normalizeFlow(flow) {
  if (!flow) return null;
  return {
    ...flow,
    nodes: Array.isArray(flow.nodes) ? flow.nodes : JSON.parse(flow.nodes || "[]"),
    edges: Array.isArray(flow.edges) ? flow.edges : JSON.parse(flow.edges || "[]"),
    variables:
      flow.variables && typeof flow.variables === "object"
        ? flow.variables
        : JSON.parse(flow.variables || "{}"),
  };
}

function headersToObject(request) {
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function queryToObject(request) {
  const url = new URL(request.url);
  const query = {};
  url.searchParams.forEach((value, key) => {
    if (query[key] === undefined) {
      query[key] = value;
    } else if (Array.isArray(query[key])) {
      query[key].push(value);
    } else {
      query[key] = [query[key], value];
    }
  });
  return query;
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getPayloadVariable(startNode) {
  const candidate =
    startNode?.data?.config?.payloadVariable ||
    startNode?.data?.config?.payloadVariableName ||
    DEFAULT_HTTP_REQUEST_PAYLOAD_VARIABLE;
  const trimmed = String(candidate || "").trim();
  return validateVariableName(trimmed).valid
    ? trimmed
    : DEFAULT_HTTP_REQUEST_PAYLOAD_VARIABLE;
}

function isAuthorized(request, startNode) {
  const config = startNode?.data?.config || {};
  if (!config.auth_required) return true;

  const expected = config.auth_token || config.authToken || config.bearer_token || null;
  if (!expected) return false;

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : authorization.trim();
  const headerToken = request.headers.get("x-flow-token") || request.headers.get("x-api-key") || "";
  return bearer === expected || headerToken === expected;
}

async function runHttpRequestFlow(request, context, method) {
  const { flowId } = await context.params;
  if (!flowId) {
    return NextResponse.json({ ok: false, error: "Flow ID is required" }, { status: 400 });
  }

  const flow = normalizeFlow(await VoiceFlowDb.getFlowById(flowId, null));
  if (!flow) {
    return NextResponse.json({ ok: false, error: "Flow not found" }, { status: 404 });
  }

  const startNode = flow.nodes?.find((node) => node.data?.nodeType === "http_request");
  if (!startNode) {
    return NextResponse.json(
      { ok: false, error: "Flow does not have an HTTP Request initiator" },
      { status: 400 },
    );
  }

  const configuredMethod = String(startNode.data?.config?.http_method || "POST").toUpperCase();
  if (configuredMethod !== method) {
    return NextResponse.json(
      { ok: false, error: `HTTP Request initiator expects ${configuredMethod}` },
      { status: 405 },
    );
  }

  if (!isAuthorized(request, startNode)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const query = queryToObject(request);
  const headers = headersToObject(request);
  const body = method === "GET" ? {} : await readJsonBody(request);
  const requestPayload = {
    ...(method === "GET" ? query : body && typeof body === "object" && !Array.isArray(body) ? body : { body }),
    method,
    query,
    body,
    headers,
  };
  const payloadVariable = getPayloadVariable(startNode);
  const event = {
    data: {
      event_type: HTTP_TRIGGER_EVENT_TYPE,
      payload: requestPayload,
    },
  };
  const callControlId =
    request.headers.get("x-call-control-id") ||
    `http-${flowId}-${randomUUID()}`;
  const variables = {
    event_type: HTTP_TRIGGER_EVENT_TYPE,
    trigger_type: "http_request",
    flow_id: flowId,
    http_method: method,
    query,
    payload: requestPayload,
  };
  variables[payloadVariable] = requestPayload;

  const executionState = {
    flowId,
    callControlId,
    variables,
    globalVariables: flow.variables || {},
    lastOutput: 0,
  };

  addWebhookEvent(callControlId, HTTP_TRIGGER_EVENT_TYPE, event, flowId);
  addNodeActivation(flowId, startNode.id, callControlId);
  addNodeExecutionEvent(
    callControlId,
    "http_request",
    startNode.id,
    startNode.data?.label || "HTTP Request",
    {
      payload_variable: payloadVariable,
      payload: requestPayload,
      output_path: "Request Received (0)",
    },
    true,
    0,
    flowId,
  );

  let queue = determineNextNodes(flow, startNode, event, executionState);
  let finalResult = { success: true, output: 0, variables: {} };
  let steps = 0;

  while (queue.length && steps < MAX_HTTP_TRIGGER_STEPS) {
    const node = queue.shift();
    steps += 1;
    const result = await executeFlowNode(node, callControlId, event, executionState);
    finalResult = result || finalResult;
    if (result?.variables) {
      executionState.variables = {
        ...executionState.variables,
        ...result.variables,
      };
    }
    executionState.lastOutput = Number.isInteger(result?.output)
      ? result.output
      : result?.success === false
        ? 1
        : 0;
    if (node?.data?.nodeType === "flow_end") break;
    queue.push(...determineNextNodes(flow, node, event, executionState));
  }

  return NextResponse.json({
    ok: finalResult?.success !== false,
    success: finalResult?.success !== false,
    output: executionState.lastOutput,
    variables: executionState.variables,
    steps,
  });
}

export async function POST(request, context) {
  return runHttpRequestFlow(request, context, "POST");
}

export async function GET(request, context) {
  return runHttpRequestFlow(request, context, "GET");
}

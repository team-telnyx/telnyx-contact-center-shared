import { NextResponse } from "next/server";
import { buildMcpToolArguments, callMcpTool } from "@/lib/mcp/mcp-tool-runner";
import { getMcpResponseVariablePayload } from "@/lib/mcp/mcp-argument-builder";
import { unwrapMcpResultEnvelope } from "@/lib/agent-assist/slot-mcp-runner.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

function getMcpErrorStatus(error) {
  const rawStatus = Number(error?.status || error?.statusCode || error?.code || 0);
  return rawStatus >= 400 && rawStatus < 600 ? rawStatus : 502;
}

function buildMcpErrorResponse(error, requestPayload = null) {
  const status = getMcpErrorStatus(error);
  const message = error?.message || "Failed to test MCP tool";
  return {
    success: false,
    error: message,
    request: requestPayload || undefined,
    response: {
      raw: {
        error: message,
        status,
        code: error?.code || error?.status || error?.statusCode || undefined,
      },
      content: [],
      text: message,
      structuredContent: {},
      isError: true,
      body: {
        error: message,
        status,
        code: error?.code || error?.status || error?.statusCode || undefined,
      },
    },
  };
}

async function POST_handler(request, _context, authz) {
  let requestPayload = null;
  try {
    const user = authz.user;

    const payload = await request.json();
    const {
      serverId,
      toolName,
      input,
      testVariables = {},
    } = payload || {};

    if (!serverId) {
      return NextResponse.json({ success: false, error: "MCP server is required" }, { status: 400 });
    }
    if (!toolName) {
      return NextResponse.json({ success: false, error: "MCP tool is required" }, { status: 400 });
    }

    const cookie = request.headers.get("cookie");
    const authorization = request.headers.get("authorization");
    void cookie;
    void authorization;

    const argumentsPayload = buildMcpToolArguments({
      input,
      variables: testVariables,
    });
    requestPayload = {
      serverId,
      toolName,
      arguments: argumentsPayload,
    };

    const response = await callMcpTool({
      serverId,
      toolName,
      input: argumentsPayload,
      variables: testVariables,
    });
    // Codex review (0cbf7ffc, P2): mirrors executeMcpToolNode's MCP result envelope
    // handling (mcp-tool-runner.js) — without this, a the reference workflow tool that returns
    // {result: null, error: "..."} (a 200/non-isError MCP response reporting
    // a business-level failure) was reported here as success:true and its
    // envelope persisted as the node's saved testResponse.body, contradicting
    // what the SAME call now does at live execution (routes to the error
    // output). Applying the identical unwrap keeps Test and live execution
    // in agreement, and stores the same flat shape live execution produces.
    const rawResponsePayload = getMcpResponseVariablePayload(response);
    const { payload: responsePayload, error: envelopeError } = unwrapMcpResultEnvelope(rawResponsePayload);
    const isError = Boolean(response.isError) || Boolean(envelopeError);
    const errorMessage = response.isError
      ? response.text || "MCP tool returned an error"
      : envelopeError || undefined;

    return NextResponse.json({
      success: !isError,
      error: isError ? errorMessage : undefined,
      request: requestPayload,
      response: {
        ...response,
        body: isError ? rawResponsePayload : responsePayload,
      },
    }, { status: isError ? 502 : 200 });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    const errorPayload = buildMcpErrorResponse(error, requestPayload);
    return NextResponse.json(errorPayload, { status: getMcpErrorStatus(error) });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("call_flows:test", POST_handler, { route: "/api/voice/flows/test-mcp-tool" });

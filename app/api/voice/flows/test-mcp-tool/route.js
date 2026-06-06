export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isAdmin } from "@/lib/role-utils";
import { buildMcpToolArguments, callMcpTool } from "@/lib/mcp/mcp-tool-runner";
import { getMcpResponseVariablePayload } from "@/lib/mcp/mcp-argument-builder";

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

export async function POST(request) {
  let requestPayload = null;
  try {
    const user = await getAuthenticatedUser(request.url);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!isAdmin(user)) {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

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
    const responsePayload = getMcpResponseVariablePayload(response);

    return NextResponse.json({
      success: !response.isError,
      error: response.isError ? response.text || "MCP tool returned an error" : undefined,
      request: requestPayload,
      response: {
        ...response,
        body: responsePayload,
      },
    }, { status: response.isError ? 502 : 200 });
  } catch (error) {
    console.error("[test-mcp-tool] Error:", error);
    const errorPayload = buildMcpErrorResponse(error, requestPayload);
    return NextResponse.json(errorPayload, { status: getMcpErrorStatus(error) });
  }
}

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isAdmin } from "@/lib/role-utils";
import { buildMcpToolArguments, callMcpTool } from "@/lib/mcp/mcp-tool-runner";

export async function POST(request) {
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

    const response = await callMcpTool({
      serverId,
      toolName,
      input: argumentsPayload,
      variables: testVariables,
    });

    return NextResponse.json({
      success: !response.isError,
      error: response.isError ? response.text || "MCP tool returned an error" : undefined,
      request: {
        serverId,
        toolName,
        arguments: argumentsPayload,
      },
      response,
    }, { status: response.isError ? 502 : 200 });
  } catch (error) {
    console.error("[test-mcp-tool] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to test MCP tool" },
      { status: 500 },
    );
  }
}

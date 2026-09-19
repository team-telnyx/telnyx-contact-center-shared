import { NextResponse } from "next/server";
import { discoverMcpToolsForServer } from "@/lib/mcp/mcp-tool-runner";
import { getMcpServer, listMcpServerTools, upsertMcpServerTools } from "@/lib/mcp/mcp-server-registry";
import { withPermission } from "@/lib/authz/guard";


async function getId(context) {
  const { params } = await context;
  const { id } = await params;
  return id;
}

function sanitizeMcpServerAuthInput(body = {}) {
  const auth_type = String(body.auth_type || (body.api_key_ref || body.auth_secret_name ? "bearer" : "none")).trim();
  const sanitized =
    auth_type === "none"
      ? {
          auth_type,
          auth_header_name: null,
          auth_scheme: null,
          auth_secret_name: null,
        }
      : {
          auth_type,
          auth_header_name: body.auth_header_name || null,
          auth_scheme: body.auth_scheme || null,
          auth_secret_name: body.auth_secret_name || body.api_key_ref || null,
        };
  if (Object.prototype.hasOwnProperty.call(body, "headers")) {
    sanitized.headers = body.headers || {};
  }
  return sanitized;
}

async function GET_handler(request, context, authz) {
  const user = authz.user;
  const id = await getId(context);
  if (!id || id === "new") return NextResponse.json({ tools: [] });

  try {
    const tools = await listMcpServerTools(id);
    return NextResponse.json({ tools });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to fetch tools" }, { status: 500 });
  }
}

async function POST_handler(request, context, authz) {
  const user = authz.user;
  let server = null;

  try {
    const id = await getId(context);
    const body = await request.json().catch(() => ({}));

    if (id && id !== "new") server = await getMcpServer(id);
    const authInput = sanitizeMcpServerAuthInput(body);
    if (!server) {
      const { type, url } = body;
      if (!type || !url) {
        return NextResponse.json({ error: "Type and URL are required" }, { status: 400 });
      }
      server = {
        id: id || "new",
        name: body.name || "Unsaved MCP Server",
        type: String(type).trim(),
        url: String(url).trim(),
        ...authInput,
      };
    } else if (body && Object.keys(body).length > 0) {
      server = { ...server, ...body, ...authInput };
    }

    const tools = await discoverMcpToolsForServer(server);
    if (server.id && server.id !== "new") {
      await upsertMcpServerTools(server.id, tools);
    }
    return NextResponse.json({ tools });
  } catch (error) {
    const rawMessage = error?.message || "Failed to connect to MCP server";
    const shouldSuggestOauthReconnect =
      server?.auth_type === "oauth_authorization_code" && /invalid_client|invalid_grant/i.test(rawMessage);
    const message = shouldSuggestOauthReconnect
      ? "OAuth session is expired or invalid. Reconnect OAuth for this MCP server, then refresh tools again."
      : rawMessage;
    return NextResponse.json(
      { error: message, connectionError: true, oauthReconnectRequired: shouldSuggestOauthReconnect },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("mcp_servers:read", GET_handler, { route: "/api/admin/mcp-servers/[id]/tools" });
export const POST = withPermission("mcp_servers:create", POST_handler, { route: "/api/admin/mcp-servers/[id]/tools" });

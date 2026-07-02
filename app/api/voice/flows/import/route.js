import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import { validateFlow } from "@/lib/voice-flow-validator";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

export const dynamic = "force-dynamic";

function getBaseUrl(request) {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;

  try {
    return new URL(request.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function extractFlowIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const flowIdPattern =
    /\/api\/voice\/(?:flows\/trigger|webhook\/(?:flows|incoming))\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const match = url.match(flowIdPattern);
  return match ? match[1] : null;
}

function updateUrl(url, oldFlowId, newFlowId, newBaseUrl) {
  if (!url || typeof url !== "string") return url;

  const urlMatch = url.match(/^(https?:\/\/[^/]+)(\/.*)$/);
  if (!urlMatch) {
    return oldFlowId && url.includes(oldFlowId)
      ? url.replace(new RegExp(oldFlowId, "gi"), newFlowId)
      : url;
  }

  const path = oldFlowId
    ? urlMatch[2].replace(new RegExp(oldFlowId, "gi"), newFlowId)
    : urlMatch[2];
  return `${newBaseUrl}${path}`;
}

function updateNodeConfigs(nodes, oldFlowId, newFlowId, newBaseUrl) {
  return nodes.map((node) => {
    const nodeType = node.data?.nodeType || node.type;
    const config = node.data?.config || {};
    const updatedConfig = { ...config };

    if (["http_request", "http_request_action"].includes(nodeType) && config.endpoint_path) {
      updatedConfig.endpoint_path = updateUrl(
        config.endpoint_path,
        oldFlowId,
        newFlowId,
        newBaseUrl,
      );
    }

    if (["dial", "incoming_call"].includes(nodeType) && config.webhook_url) {
      updatedConfig.webhook_url = updateUrl(
        config.webhook_url,
        oldFlowId,
        newFlowId,
        newBaseUrl,
      );
    }

    return {
      ...node,
      data: {
        ...node.data,
        config: updatedConfig,
      },
    };
  });
}

function findOldFlowId(nodes) {
  for (const node of nodes) {
    const config = node.data?.config || {};
    const candidates = [config.endpoint_path, config.webhook_url];
    for (const candidate of candidates) {
      const flowId = extractFlowIdFromUrl(candidate);
      if (flowId) return flowId;
    }
  }
  return null;
}

/**
 * POST /api/voice/flows/import
 * Import a call flow JSON bundle as a new flow.
 */
export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const username = session.user.email;
    const body = await request.json();

    if (!body.version) {
      return NextResponse.json(
        { ok: false, error: "Invalid flow format: missing version" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.nodes)) {
      return NextResponse.json(
        { ok: false, error: "Invalid flow format: missing or invalid nodes" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.edges)) {
      return NextResponse.json(
        { ok: false, error: "Invalid flow format: missing or invalid edges" },
        { status: 400 },
      );
    }

    const newFlowId = randomUUID();
    const oldFlowId = findOldFlowId(body.nodes);
    const nodes = updateNodeConfigs(body.nodes, oldFlowId, newFlowId, getBaseUrl(request));
    const edges = body.edges;
    const variables = body.globalVariables || body.variables || {};

    const validation = validateFlow({ nodes, edges });
    if (!validation.valid) {
      return NextResponse.json(
        { ok: false, error: validation.errors.join("\n"), validation },
        { status: 400 },
      );
    }

    const flow = await VoiceFlowDb.createFlow(username, {
      id: newFlowId,
      name: body.name || "Imported Flow",
      description: body.description || "",
      nodes,
      edges,
      variables,
      metadata: {
        ...(body.metadata || {}),
        imported_at: new Date().toISOString(),
        original_exported_at: body.exported_at || null,
        original_flow_id: oldFlowId,
      },
    });

    const updatedFlow = await VoiceFlowDb.getFlowById(flow.id, username);

    return NextResponse.json({ ok: true, flow: updatedFlow });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to import flow" },
      { status: 500 },
    );
  }
}

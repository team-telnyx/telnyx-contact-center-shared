import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx.js";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { analyzeFlowForWorkflowTesting, ensureWorkflowTestingAction } from "@/lib/call-generator/workflow-testing.mjs";
import { withPermission } from "@/lib/authz/guard";


async function loadAudioMedia() {
  if (!process.env.TELNYX_API_KEY) return [];
  try {
    const items = [];
    for (let page = 1; page <= 5; page += 1) {
      const params = new URLSearchParams();
      params.set("page[number]", String(page));
      params.set("page[size]", "100");
      const res = await fetch(`${buildTelnyxV2Url("/media")}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) break;
      const data = await res.json();
      const rows = Array.isArray(data?.data) ? data.data : [];
      if (!rows.length) break;
      items.push(...rows);
      const totalPages = Number(data?.meta?.page?.total_pages || 1);
      if (page >= totalPages) break;
    }
    return items
      .filter((item) => {
        const contentType = String(item.content_type || "").toLowerCase();
        const mediaName = String(item.media_name || "").toLowerCase();
        const isAudio = contentType.includes("audio/") || contentType.includes("mpeg") || contentType.includes("mp3") || contentType.includes("wav");
        const hasAudioExt = mediaName.endsWith(".mp3") || mediaName.endsWith(".wav") || mediaName.endsWith(".m4a") || mediaName.endsWith(".ogg");
        const isNonAudio = contentType.includes("image/") || contentType.includes("video/") || contentType.includes("text/");
        return (isAudio || hasAudioExt) && !isNonAudio;
      })
      .map((item) => ({ media_name: item.media_name, content_type: item.content_type || null }));
  } catch (err) {
    adminRuntimeLogger.warn("call_generator_media_load_failed", runtimePayload({ error: err, operation: "cg_resources_media" }));
    return [];
  }
}

// GET — selector resources for the Call Generator UI:
// call flows (Target Flow dropdown), audio media (play_media steps), actions.
async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    await ensureWorkflowTestingAction(pool);
    const [flowsResult, actionsResult, workflowsResult, media] = await Promise.all([
      pool.query(`SELECT id, name, description, nodes FROM voice_flows ORDER BY updated_at DESC NULLS LAST, name ASC LIMIT 300`),
      pool.query(`SELECT id, name, description, steps FROM cg_actions ORDER BY updated_at DESC LIMIT 200`),
      pool.query(`SELECT id, name FROM aa_workflows ORDER BY updated_at DESC NULLS LAST, name ASC LIMIT 500`),
      loadAudioMedia(),
    ]);
    const workflowById = Object.fromEntries(workflowsResult.rows.map((workflow) => [workflow.id, workflow]));
    return NextResponse.json({
      flows: flowsResult.rows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        description: flow.description,
        workflow_testing: analyzeFlowForWorkflowTesting(flow, workflowById),
      })),
      actions: actionsResult.rows,
      media,
    });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_resources_failed", runtimePayload({ error: err, operation: "cg_resources" }));
    return NextResponse.json({ error: "Failed to load resources" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_generator:read", GET_handler, { route: "/api/admin/call-generator/resources" });

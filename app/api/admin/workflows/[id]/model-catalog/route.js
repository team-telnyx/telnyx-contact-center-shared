import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { chatCopilotCatalog } from "@/lib/contact-center/chat-copilot";
import { resolveOperationModel, platformDefaultModel } from "@/lib/ai-operations/runtime.mjs";

/**
 * GET /api/admin/workflows/[id]/model-catalog
 *
 * Data for the "Test AI Agent" model pickers:
 * - `models`: the same Telnyx catalogue as Admin → AI Copilot (`/ai/models`,
 *   cached for 60 s), exposed under the workflow testing permission.
 * - `defaults`: the model each test operation uses when the tester does not
 *   pick one, and where it comes from:
 *     analysis: workflow model (override) > AI Copilot "Workflow analysis" > platform default
 *     caller:   AI Copilot "Simulated customer" > platform default (never the workflow model)
 * - `platformDefault`: Admin → AI Copilot default model, else TELNYX_AI_DEFAULT_MODEL.
 */
const headers = { "Cache-Control": "no-store" };

export const GET = withPermission("workflows:ai", async (_request, context) => {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database not configured" }, { status: 503, headers });
  const { id } = await context.params;
  const { rows: [workflow] } = await pool.query("SELECT id, llm_model FROM aa_workflows WHERE id = $1", [id]);
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404, headers });

  // A missing model configuration is reported, not thrown: the pickers still load.
  const resolve = (id, options) => resolveOperationModel(id, { ...options, pool }).catch(() => ({ model: "", source: null }));
  const [catalog, analysis, caller, inheritedAnalysis, platform] = await Promise.all([
    chatCopilotCatalog().catch(() => ({ models: [], error: "The Telnyx model list could not be loaded. Retry to refresh it." })),
    resolve("workflow-analysis", { preferredModel: workflow.llm_model }),
    resolve("test-caller"),
    resolve("workflow-analysis"),
    platformDefaultModel({ pool }),
  ]);
  return NextResponse.json(
    {
      models: catalog.models || [],
      defaults: { analysis, caller },
      // What the workflow uses when it has no model of its own (shown by the editor).
      inherited: { analysis: inheritedAnalysis },
      platformDefault: platform,
      ...(catalog.error ? { error: catalog.error } : {}),
    },
    { headers },
  );
}, { route: "/api/admin/workflows/[id]/model-catalog" });

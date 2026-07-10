import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";
import { DEFAULT_CALL_FLOW_TEMPLATE } from "./default-call-flow-template.mjs";

const seedLogger = createDiagnosticLogger("platform.app");

// Fixed, well-known ID for the seeded flow so every deployment (local docker
// AND cloud) ends up with the exact same flow id, and so re-runs (container
// restart, `cc update`, a second `ensurePostgresSchema()` call) always find
// the same row instead of creating a new one every time — required for
// idempotency since there's no other natural unique key here (unlike
// find-by-name for Telnyx resources).
//
// This is also what makes the webhook URL knowable BEFORE the app ever
// starts: deploy/cli/lib/telnyx-bootstrap-orchestrator.mjs computes
// `${baseUrl}/api/voice/webhook/incoming/${SEEDED_DEFAULT_FLOW_ID}` and
// creates the dedicated Telnyx voice app pointing at it during Telnyx
// provisioning (before the container is even built) — this module then just
// has to write the matching DB row when the app boots.
export const SEEDED_DEFAULT_FLOW_ID = "00000000-cc00-4000-8000-000000000001";

/**
 * Seeds the Default Call Flow row (+ its phone-number assignment, when a
 * number is known) into `voice_flows` / `voice_flow_phone_numbers`.
 *
 * Runs on every app boot (called from ensurePostgresSchema(), same as
 * seed-default-owner.mjs / seed-app-settings.mjs) — for BOTH the Local
 * target and every cloud target (AWS RDS included), since the app is always
 * running right next to its own database wherever it's deployed. This
 * replaces the old deploy/cli/lib/call-flow.mjs, which only worked for Local
 * because it connected to Postgres directly from the operator's own machine
 * (impossible against AWS RDS's private-subnet-only access).
 *
 * Deliberately does NOT talk to the Telnyx API at all — the dedicated voice
 * app for this flow is created earlier, during Telnyx provisioning (see
 * telnyx-bootstrap-orchestrator.mjs's ensureCoreTelnyxObjects), because that
 * step runs on the OPERATOR's machine where Telnyx's public API is always
 * reachable, unlike Postgres for cloud targets. This module only owns the
 * DB-side rows, reading the already-provisioned ids from env:
 *   - TELNYX_DEFAULT_FLOW_VOICE_APP_ID — the flow's dedicated voice app id
 *   - TELNYX_MAIN_FROM_NUMBER / TELNYX_MAIN_FROM_NUMBER_ID — the purchased
 *     number + its Telnyx resource id, already assigned to that voice app
 *     by Telnyx provisioning; this just records the CC-side join row so the
 *     Call Flow Builder UI shows "this number rings this flow".
 *
 * Idempotent: ON CONFLICT (id) DO NOTHING on voice_flows preserves any
 * in-app edits the user has made to the seeded flow; ON CONFLICT DO UPDATE
 * on voice_flow_phone_numbers keeps the assignment row fresh without erroring
 * on repeat boots.
 */
export async function seedDefaultCallFlow() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      seedLogger.error("seed_call_flow_db_unavailable");
      return false;
    }

    const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const voiceApplicationId = process.env.TELNYX_DEFAULT_FLOW_VOICE_APP_ID || "";
    const ownerEmail = (process.env.DEFAULT_OWNER_EMAIL || "").toLowerCase();

    if (!baseUrl || !voiceApplicationId || !ownerEmail) {
      // Not fully provisioned yet (e.g. Telnyx bootstrap hasn't run, or this
      // is a bare `docker compose up` with no wizard involved at all) —
      // nothing to seed. Not an error: the app still comes up fine without
      // a Default Call Flow, the user just has none until they create one.
      seedLogger.info("seed_call_flow_skipped_not_configured");
      return true;
    }

    const webhookUrl = `${baseUrl}/api/voice/webhook/incoming/${SEEDED_DEFAULT_FLOW_ID}`;
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '5s'");

      const existing = await client.query(
        "SELECT id FROM voice_flows WHERE id = $1",
        [SEEDED_DEFAULT_FLOW_ID]
      );

      if (existing.rows.length === 0) {
        const template = DEFAULT_CALL_FLOW_TEMPLATE;
        const nodes = (template.nodes || []).map((node) => {
          if (node?.data?.nodeType !== "incoming_call") return node;
          return {
            ...node,
            data: {
              ...node.data,
              config: {
                ...node.data.config,
                webhook_url: webhookUrl,
                voice_application_id: voiceApplicationId,
              },
            },
          };
        });

        await client.query(
          `INSERT INTO voice_flows (
            id, username, name, description, telnyx_voice_app_id, webhook_url, nodes, edges, variables, metadata, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()
          )
          ON CONFLICT (id) DO NOTHING`,
          [
            SEEDED_DEFAULT_FLOW_ID,
            ownerEmail,
            template.name || "Default Call Flow",
            template.description || "",
            voiceApplicationId,
            webhookUrl,
            JSON.stringify(nodes),
            JSON.stringify(template.edges || []),
            JSON.stringify(template.variables || template.globalVariables || {}),
            JSON.stringify({ ...(template.metadata || {}), seeded_by: "app-boot", seeded_at: new Date().toISOString() }),
          ]
        );
        seedLogger.info("seed_call_flow_created");
      } else {
        seedLogger.info("seed_call_flow_exists");
      }

      // Phone-number assignment: the CC-side join row only. The Telnyx-side
      // connection_id assignment already happened during Telnyx provisioning
      // (ensureCoreTelnyxObjects buys/assigns the number straight to this
      // flow's voice app — no separate "buy against main app, then re-point"
      // step anymore). This just makes the Call Flow Builder UI aware of it.
      const phoneNumber = process.env.TELNYX_MAIN_FROM_NUMBER || "";
      const phoneNumberId = process.env.TELNYX_MAIN_FROM_NUMBER_ID || "";
      if (phoneNumber && phoneNumberId) {
        await client.query(
          `INSERT INTO voice_flow_phone_numbers (
            id, flow_id, phone_number_id, phone_number, assigned_by, assigned_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW(), NOW()
          )
          ON CONFLICT (flow_id, phone_number_id) DO UPDATE SET updated_at = NOW()`,
          [SEEDED_DEFAULT_FLOW_ID, phoneNumberId, phoneNumber, "app-boot"]
        );
        seedLogger.info("seed_call_flow_number_assigned");
      }

      return true;
    } finally {
      try {
        await client.query("RESET statement_timeout");
      } catch {
        // Ignore reset errors
      }
      client.release();
    }
  } catch (error) {
    if (error.code === "57014") {
      seedLogger.info("seed_call_flow_timeout");
    } else {
      seedLogger.error("seed_call_flow_failed");
    }
    return false;
  }
}

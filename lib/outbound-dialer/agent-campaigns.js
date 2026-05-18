import crypto from "crypto";
import { startCampaignRun } from "./execution.js";
import {
  AGENT_CAMPAIGN_ACTIVATION_STATUSES,
  agentCampaignStatusBadgeClass,
  normalizeCampaignPriority,
  priorityDistributionCursor,
} from "./agent-campaigns-view-model.js";

const PREVIEW_PROGRESSIVE_MODES = new Set(["preview", "progressive"]);
const AGENT_CAMPAIGN_ACTIVATION_STATUS_SET = new Set(AGENT_CAMPAIGN_ACTIVATION_STATUSES);
const CLAIM_LEASE_SECONDS = 10 * 60;
const PROGRESSIVE_COUNTDOWN_SECONDS = 30;

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeE164Like(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.startsWith("+")
    ? `+${raw.slice(1).replace(/\D/g, "")}`
    : raw.replace(/\D/g, "");
  if (!/^\+?[1-9]\d{6,15}$/.test(normalized)) return null;
  return normalized.startsWith("+") ? normalized : `+${normalized}`;
}

export function isPreviewProgressiveMode(mode) {
  return PREVIEW_PROGRESSIVE_MODES.has(String(mode || "").toLowerCase());
}

export function campaignAgentAssistConfig(campaign = {}) {
  const metadata = parseJson(campaign.metadata, {});
  const workflowId = campaign.attached_workflow_id || metadata.attached_workflow_id || metadata.workflow_id || null;
  const formId = campaign.attached_form_id || metadata.attached_form_id || metadata.form_id || null;
  if (workflowId) {
    return {
      enabled: true,
      assist_type: "workflows",
      workflow_id: workflowId,
      auto_start: true,
      source: "outbound_campaign",
    };
  }
  if (formId) {
    return {
      enabled: true,
      assist_type: "forms",
      form_ids: [formId],
      auto_open_forms: true,
      source: "outbound_campaign",
    };
  }
  return {
    enabled: true,
    assist_type: "kb_articles",
    kb_auto_suggest: true,
    kb_max_suggestions: 3,
    source: "outbound_campaign",
  };
}

export function resolveCampaignContactPhone(campaign = {}, contact = {}) {
  const metadata = parseJson(campaign.metadata, {});
  const rowData = parseJson(contact.row_data, {});
  const methods = parseJson(contact.contact_methods, {});
  const preferredFields = Array.isArray(metadata.contact_list_numbers)
    ? metadata.contact_list_numbers.filter((field) => typeof field === "string" && field.trim())
    : [];
  for (const field of preferredFields) {
    const normalized = normalizeE164Like(rowData[field]);
    if (normalized) return normalized;
  }
  const methodNumbers = [
    ...Object.values(methods?.number || {}),
    ...Object.values(methods?.voice || {}),
    ...Object.values(methods?.whatsapp || {}),
  ];
  const rowCandidates = [rowData.phone_number, rowData.phone, rowData.mobile, rowData.msisdn, rowData.tel];
  for (const candidate of [...methodNumbers, ...rowCandidates]) {
    const normalized = normalizeE164Like(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export function campaignAssignmentPayload({ campaign, ledger, contact, now = new Date() }) {
  if (!campaign || !ledger || !contact) return null;
  const metadata = parseJson(ledger.metadata, {});
  const mode = String(campaign.mode || "preview").toLowerCase();
  const assignedAt = metadata.assigned_at || ledger.created_at || now.toISOString();
  const autoDialAt = mode === "progressive"
    ? metadata.auto_dial_at || new Date(new Date(assignedAt).getTime() + PROGRESSIVE_COUNTDOWN_SECONDS * 1000).toISOString()
    : null;
  const rowData = parseJson(contact.row_data, {});
  const contactMethods = parseJson(contact.contact_methods, {});
  return {
    id: ledger.id,
    attempt_id: ledger.id,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    campaign_mode: mode,
    contact_record_id: contact.id,
    contact_record: rowData,
    contact_methods: contactMethods,
    to_number: metadata.to_number || resolveCampaignContactPhone(campaign, contact),
    assigned_at: assignedAt,
    auto_dial_at: autoDialAt,
    auto_dial_seconds: mode === "progressive" ? PROGRESSIVE_COUNTDOWN_SECONDS : null,
    agent_assist_config: campaignAgentAssistConfig(campaign),
  };
}

export async function ensureAgentCampaignAssignmentsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outbound_campaign_agent_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
      agent_username TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (campaign_id, agent_username)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outbound_campaign_agent_assignments_agent ON outbound_campaign_agent_assignments (agent_username, enabled)`);
}

export async function listAgentCampaigns(pool, agentUsername) {
  await ensureAgentCampaignAssignmentsTable(pool);
  const { rows } = await pool.query(
    `SELECT
       c.id,
       c.name,
       c.mode,
       c.status,
       c.attached_form_id,
       c.metadata,
       f.name AS attached_form_name,
       a.enabled AS activated,
       a.updated_at AS activated_at
     FROM outbound_campaigns c
     LEFT JOIN form_definitions f ON f.id = c.attached_form_id
     LEFT JOIN outbound_campaign_agent_assignments a
       ON a.campaign_id = c.id AND a.agent_username = $1
     WHERE c.status = ANY($2::text[])
       AND c.mode IN ('preview', 'progressive')
     ORDER BY CASE c.status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'stopped' THEN 2 ELSE 3 END, c.name ASC`,
    [agentUsername, AGENT_CAMPAIGN_ACTIVATION_STATUSES],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    mode: row.mode,
    status: row.status,
    statusBadgeClass: agentCampaignStatusBadgeClass(row.status),
    priority: normalizeCampaignPriority(row),
    activated: row.activated === true,
    activated_at: row.activated_at || null,
    attached_form_id: row.attached_form_id || null,
    attached_form_name: row.attached_form_name || null,
    attached_workflow_id: row.metadata?.attached_workflow_id || row.metadata?.workflow_id || null,
  }));
}

export async function setAgentCampaignActivation(pool, agentUsername, campaignIdsOrId) {
  await ensureAgentCampaignAssignmentsTable(pool);
  const campaignIds = Array.isArray(campaignIdsOrId)
    ? campaignIdsOrId.filter(Boolean).map(String)
    : campaignIdsOrId
      ? [String(campaignIdsOrId)]
      : [];

  if (campaignIds.length === 0) {
    await pool.query(
      `UPDATE outbound_campaign_agent_assignments
       SET enabled = false, updated_at = NOW()
       WHERE agent_username = $1 AND enabled = true`,
      [agentUsername],
    );
    return [];
  }

  const { rows: campaignRows } = await pool.query(
    `SELECT id, name, mode, status, metadata
     FROM outbound_campaigns
     WHERE id = ANY($1::uuid[])
       AND status = ANY($2::text[])
       AND mode IN ('preview','progressive')`,
    [campaignIds, AGENT_CAMPAIGN_ACTIVATION_STATUSES],
  );
  const foundIds = new Set(campaignRows.map((campaign) => String(campaign.id)));
  const missingIds = campaignIds.filter((campaignId) => !foundIds.has(String(campaignId)));
  if (missingIds.length > 0) {
    throw new Error("Campaign not found or not available for agent activation");
  }

  await pool.query(
    `UPDATE outbound_campaign_agent_assignments
     SET enabled = false, updated_at = NOW()
     WHERE agent_username = $1
       AND NOT (campaign_id = ANY($2::uuid[]))`,
    [agentUsername, campaignIds],
  );

  const activated = [];
  for (const campaignId of campaignIds) {
    const { rows } = await pool.query(
      `INSERT INTO outbound_campaign_agent_assignments (campaign_id, agent_username, enabled)
       VALUES ($1, $2, true)
       ON CONFLICT (campaign_id, agent_username)
       DO UPDATE SET enabled = true, updated_at = NOW()
       RETURNING *`,
      [campaignId, agentUsername],
    );
    if (rows[0]) activated.push(rows[0]);
  }
  return activated;
}

async function loadActiveAgentCampaigns(pool, agentUsername) {
  await ensureAgentCampaignAssignmentsTable(pool);
  const { rows } = await pool.query(
    `SELECT c.*, a.metadata AS assignment_metadata, a.updated_at AS assignment_updated_at
     FROM outbound_campaign_agent_assignments a
     JOIN outbound_campaigns c ON c.id = a.campaign_id
     WHERE a.agent_username = $1
       AND a.enabled = true
       AND c.status = 'running'
       AND c.mode IN ('preview','progressive')
     ORDER BY COALESCE((c.metadata->>'agent_priority')::int, (c.metadata->>'priority')::int, 3) DESC,
       a.updated_at ASC,
       c.name ASC`,
    [agentUsername],
  );
  return rows;
}

async function loadClaimPayload(pool, ledgerId) {
  const { rows } = await pool.query(
    `SELECT
       l.*,
       c.id AS campaign_id,
       c.name AS campaign_name,
       c.mode AS campaign_mode,
       c.attached_form_id,
       c.metadata AS campaign_metadata,
       r.id AS record_id,
       r.row_data,
       r.contact_methods
     FROM outbound_attempt_ledger l
     JOIN outbound_campaigns c ON c.id = l.campaign_id
     JOIN outbound_contact_records r ON r.id = l.contact_record_id
     WHERE l.id = $1
     LIMIT 1`,
    [ledgerId],
  );
  const row = rows[0];
  if (!row) return null;
  return campaignAssignmentPayload({
    campaign: {
      id: row.campaign_id,
      name: row.campaign_name,
      mode: row.campaign_mode,
      attached_form_id: row.attached_form_id,
      metadata: row.campaign_metadata,
    },
    ledger: row,
    contact: { id: row.record_id, row_data: row.row_data, contact_methods: row.contact_methods },
  });
}

async function findExistingAgentClaim(pool, campaignId, agentUsername) {
  const { rows } = await pool.query(
    `SELECT id
     FROM outbound_attempt_ledger
     WHERE campaign_id = $1
       AND status = 'claimed'
       AND metadata->>'assigned_agent' = $2
       AND COALESCE(lease_expires_at, NOW() + INTERVAL '1 second') > NOW()
     ORDER BY created_at ASC
     LIMIT 1`,
    [campaignId, agentUsername],
  );
  return rows[0]?.id || null;
}

async function setAgentOnCampaignCall(pool, agentUsername, ledgerId) {
  if (!agentUsername || !ledgerId) return;
  const { rows } = await pool.query(
    `SELECT id, agent_status FROM users WHERE email = $1 OR username = $1 LIMIT 1`,
    [agentUsername],
  );
  const user = rows[0];
  if (!user?.id) return;
  const previousStatus = user.agent_status || null;

  await pool.query(`UPDATE users SET agent_status = 'On Campaign Call', updated_at = NOW() WHERE id = $1`, [user.id]);
  await pool.query(
    `INSERT INTO cc_agent_state (user_id, username, agent_status, last_status_change, last_activity, available_since)
     VALUES ($1, $2, 'On Campaign Call', NOW(), NOW(), NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       username = EXCLUDED.username,
       agent_status = EXCLUDED.agent_status,
       last_status_change = NOW(),
       last_activity = NOW(),
       available_since = NULL`,
    [String(user.id), agentUsername],
  );
  await pool.query(
    `UPDATE outbound_attempt_ledger
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
       'previous_agent_status', $2::text,
       'status_set_by', 'campaign_assignment',
       'status_set_at', NOW()::text
     ), updated_at = NOW()
     WHERE id = $1`,
    [ledgerId, previousStatus],
  );
}

export async function claimNextAgentCampaignRecord(pool, agentUsername) {
  const campaigns = await loadActiveAgentCampaigns(pool, agentUsername);
  if (!campaigns.length) return null;

  for (const campaign of campaigns) {
    const existingClaimId = await findExistingAgentClaim(pool, campaign.id, agentUsername);
    if (existingClaimId) {
      await setAgentOnCampaignCall(pool, agentUsername, existingClaimId);
      return loadClaimPayload(pool, existingClaimId);
    }
  }

  let candidates = [...campaigns];
  while (candidates.length > 0) {
    const campaign = priorityDistributionCursor(candidates);
    if (!campaign) break;
    candidates = candidates.filter((item) => String(item.id) !== String(campaign.id));
    const runResult = await pool.query(
      `SELECT * FROM outbound_campaign_runs
       WHERE campaign_id = $1 AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`,
      [campaign.id],
    );
    const run = runResult.rows[0] || (await startCampaignRun(pool, campaign.id, agentUsername));
    const claimKey = crypto.randomUUID();
    const assignedAt = new Date();
    const autoDialAt = campaign.mode === "progressive"
      ? new Date(assignedAt.getTime() + PROGRESSIVE_COUNTDOWN_SECONDS * 1000).toISOString()
      : null;
    const { rows } = await pool.query(
      `WITH candidate AS (
        SELECT r.id
        FROM outbound_contact_records r
        WHERE r.contact_list_id = $1
          AND r.validation_status = 'valid'
          AND NOT EXISTS (
            SELECT 1 FROM outbound_attempt_ledger l
            WHERE l.campaign_id = $2
              AND l.contact_record_id = r.id
              AND l.status IN ('claimed', 'dialing', 'answered', 'completed')
              AND COALESCE(l.lease_expires_at, NOW() + INTERVAL '1 second') > NOW() - INTERVAL '5 seconds'
          )
        ORDER BY COALESCE(r.last_attempt_at, 'epoch'::timestamptz) ASC, r.created_at ASC, r.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      INSERT INTO outbound_attempt_ledger (
        campaign_id, run_id, contact_record_id, status, channel, handler_type, handler_ref,
        claim_key, lease_expires_at, attempt_reason, metadata
      )
      SELECT
        $2, $3, candidate.id, 'claimed', COALESCE($4, 'voice'), $11, $12,
        $6, NOW() + ($7::text || ' seconds')::interval, 'agent_campaign_claim',
        jsonb_build_object(
          'assigned_agent', $5::text,
          'assigned_at', $8::text,
          'assignment_mode', $9::text,
          'auto_dial_at', $10::text,
          'campaign_priority', $13::int
        )
      FROM candidate
      RETURNING id`,
      [
        campaign.contact_list_id,
        campaign.id,
        run?.id || null,
        campaign.channel || "voice",
        agentUsername,
        claimKey,
        CLAIM_LEASE_SECONDS,
        assignedAt.toISOString(),
        campaign.mode,
        autoDialAt,
        campaign.handler_type || null,
        campaign.handler_ref || null,
        normalizeCampaignPriority(campaign),
      ],
    );
    const ledgerId = rows[0]?.id || null;
    if (!ledgerId) continue;
    await pool.query(`UPDATE outbound_contact_records SET last_attempt_at = NOW(), updated_at = NOW() WHERE id = (SELECT contact_record_id FROM outbound_attempt_ledger WHERE id = $1)`, [ledgerId]);
    await pool.query(
      `UPDATE outbound_campaign_agent_assignments
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'served_count', COALESCE((metadata->>'served_count')::int, 0) + 1,
         'last_served_at', NOW()::text
       ), updated_at = NOW()
       WHERE campaign_id = $1 AND agent_username = $2`,
      [campaign.id, agentUsername],
    );
    await setAgentOnCampaignCall(pool, agentUsername, ledgerId);
    return loadClaimPayload(pool, ledgerId);
  }

  return null;
}

export async function broadcastCampaignActivationChanged(pool, campaign, reason = "campaign_status_changed") {
  if (!campaign?.id) return;
  try {
    const { broadcastToAllAgents, broadcastToKey } = await import("@/lib/sse");
    const payload = {
      type: reason,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        mode: campaign.mode,
        status: campaign.status,
        statusBadgeClass: agentCampaignStatusBadgeClass(campaign.status),
        priority: normalizeCampaignPriority(campaign),
      },
      campaignIds: Array.isArray(campaign.campaignIds) ? campaign.campaignIds : undefined,
      userId: campaign.userId || undefined,
      timestamp: new Date().toISOString(),
    };

    await broadcastToAllAgents(payload, "campaign_changed");

    if (pool) {
      const supervisors = await pool.query(
        `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`,
      );
      for (const supervisor of supervisors.rows || []) {
        await broadcastToKey(`monitor:${supervisor.id}`, payload, "campaign_changed");
      }
    }
  } catch (error) {
    console.error("[Agent Campaigns] Failed to broadcast campaign activation change:", error);
  }
}

export async function loadAgentCampaignAttempt(pool, agentUsername, attemptId) {
  const { rows } = await pool.query(
    `SELECT
       l.id AS ledger_id,
       l.campaign_id,
       l.run_id,
       l.contact_record_id,
       l.status AS ledger_status,
       l.metadata AS ledger_metadata,
       c.*
     FROM outbound_attempt_ledger l
     JOIN outbound_campaigns c ON c.id = l.campaign_id
     WHERE l.id = $1
       AND l.status = 'claimed'
       AND l.metadata->>'assigned_agent' = $2
       AND c.mode IN ('preview','progressive')
     LIMIT 1`,
    [attemptId, agentUsername],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    ledger: {
      id: row.ledger_id,
      campaign_id: row.campaign_id,
      run_id: row.run_id,
      contact_record_id: row.contact_record_id,
      status: row.ledger_status,
      metadata: row.ledger_metadata,
    },
    campaign: row,
  };
}

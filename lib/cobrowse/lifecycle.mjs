import { createHash, randomUUID } from "node:crypto";
import { appendEvent } from "../acd/events.mjs";
import { workItemInScope } from "../authz/scope.mjs";
import { isWidgetSessionOriginAllowed } from "../widgets/config.js";
import { getPublishedWidget } from "../widgets/store.js";
import { getWidgetSession } from "../widgets/sessions.js";
import { verifyWidgetBootstrapToken } from "../widgets/session-tokens.js";
import { matchStoredOrigin } from "./http.mjs";
import {
  equalHash, freshCredential, generatePairingCode, hashCredential,
  pairingCodeHmac, pairingResumeCredential,
} from "./credentials.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE = "state NOT IN ('ended','failed')";
const PAIRING_CHANNELS = new Set(["voice", "sms", "whatsapp"]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = (id) => { if (!UUID.test(String(id || ""))) throw fail("Invalid identifier"); return id; };
const actor = (id) => `agent:${id}`;

async function transaction(pool, run) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}

async function activeOwner(db, workItemId, agentId, scope) {
  validId(workItemId);
  const work = (await db.query(`SELECT id,channel,queue_id,terminal_at,state FROM acd_work_items WHERE id=$1 FOR UPDATE`, [workItemId])).rows[0];
  if (!work || work.terminal_at || work.state !== "active") throw fail("Interaction is not active", 409);
  const segment = (await db.query(`SELECT agent_id FROM acd_segments
    WHERE work_item_id=$1 AND kind='agent' AND ended_at IS NULL
    ORDER BY seq DESC LIMIT 1`, [workItemId])).rows[0];
  if (!segment || segment.agent_id !== String(agentId)) throw fail("Interaction is not assigned to you", 403);
  if (!(await workItemInScope(db, scope, workItemId, { queueId: work.queue_id, agentId, channel: work.channel }))) throw fail("Forbidden", 403);
  return work;
}

async function currentWidget(db, widgetId, origin, entryPoint) {
  const { rows } = await db.query("SELECT public_id FROM cc_widgets WHERE id=$1", [widgetId]);
  const widget = rows[0] && await getPublishedWidget(db, rows[0].public_id);
  if (!widget?.config.cobrowse?.enabled || !isWidgetSessionOriginAllowed(origin, widget.config.allowedOrigins)) throw fail("Co-browsing is unavailable", 403);
  if (entryPoint && !widget.config.cobrowse.entryPoints[entryPoint]) throw fail("Co-browsing entry point is unavailable", 403);
  return widget;
}

async function linkedWidgetSession(db, workItemId) {
  return (await db.query(`SELECT s.id,s.widget_id,s.revision_id,s.origin,s.expires_at>now() AS active FROM cc_widget_sessions s
    JOIN acd_work_items w ON w.conversation_id=s.conversation_id
    WHERE w.id=$1 ORDER BY s.created_at DESC LIMIT 1`, [workItemId])).rows[0] || null;
}

async function agentEntryPoint(db, work) {
  const linked = await linkedWidgetSession(db, work.id);
  if (linked) {
    if (!linked.active)
      return { kind: "unavailable", reason: "The linked widget session has expired. Ask the visitor to reopen the widget." };
    try {
      const widget = await currentWidget(db, linked.widget_id, linked.origin, "inSession");
      if (widget.revision_id !== linked.revision_id)
        return { kind: "unavailable", reason: "The widget was republished. Ask the visitor to reopen it." };
      return { kind: "inSession" };
    } catch (error) {
      if (error.status === 403) return { kind: "unavailable", reason: "Co-browsing is not enabled for this widget session." };
      throw error;
    }
  }
  return PAIRING_CHANNELS.has(work.channel)
    ? { kind: "pairingCode" }
    : { kind: "unavailable", reason: "This interaction has no supported co-browsing entry point." };
}

async function requirePairingInteraction(db, work) {
  if (!PAIRING_CHANNELS.has(work.channel)) throw fail("Pairing codes are available for voice, SMS and WhatsApp interactions only", 409);
  if (await linkedWidgetSession(db, work.id)) throw fail("This interaction is linked to a widget session; send an in-session request", 409);
}

function summary(row, widget) {
  if (!row) return null;
  return {
    id: row.id, workItemId: row.work_item_id, state: row.state,
    controlLevel: row.control_level || "observe", controlRequestedAt: row.control_requested_at || null,
    controlAvailable: widget?.config.cobrowse?.control?.maxLevel === "assist",
    agentId: row.agent_id,
    agentName: row.agent_name || null,
    consentGrantedAt: row.consent_granted_at, startedAt: row.started_at,
    endedAt: row.ended_at, endReason: row.end_reason,
    consent: widget ? widget.config.cobrowse.consent : undefined,
  };
}

async function withAgentName(db, row) {
  if (!row) return row;
  const user = (await db.query("SELECT first_name,last_name FROM users WHERE id=$1", [row.agent_id])).rows[0];
  return { ...row, agent_name: [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Support agent" };
}

async function endRow(db, row, reason, by) {
  if (!row || ["ended", "failed"].includes(row.state)) return row;
  const ended = (await db.query(`UPDATE acd_cobrowse_sessions
    SET state='ended',ended_at=now(),end_reason=$2,auth_generation=auth_generation+1,
        control_level='observe',control_requested_at=NULL,control_granted_at=NULL,
        previous_browser_secret_hash=NULL,previous_secret_expires_at=NULL,updated_at=now()
    WHERE id=$1 RETURNING *`, [row.id, reason])).rows[0];
  await appendEvent(db, { workItemId: row.work_item_id, agentId: row.agent_id,
    type: "cobrowse_ended", actor: by, payload: { session_id: row.id, reason } });
  return ended;
}

async function reconcileRow(db, row) {
  if (!row || ["ended", "failed"].includes(row.state)) return row;
  if (Date.now() - new Date(row.created_at).getTime() > 30 * 60_000)
    return endRow(db, row, "maximum_duration", "system:cobrowse");
  if (row.state === "pending_consent" && Date.now() - new Date(row.created_at).getTime() > 5 * 60_000)
    return endRow(db, row, "consent_timeout", "system:cobrowse");
  if (row.state === "connecting" && row.consent_granted_at &&
    Date.now() - new Date(row.consent_granted_at).getTime() > 2 * 60_000)
    return endRow(db, row, "publisher_connect_timeout", "system:cobrowse");
  if (row.state === "reconnecting" && row.reconnect_deadline_at &&
    new Date(row.reconnect_deadline_at).getTime() <= Date.now())
    return endRow(db, row, "publisher_disconnected", "system:cobrowse");
  const work = (await db.query("SELECT state,terminal_at FROM acd_work_items WHERE id=$1", [row.work_item_id])).rows[0];
  const owner = (await db.query(`SELECT agent_id FROM acd_segments WHERE work_item_id=$1
    AND kind='agent' AND ended_at IS NULL ORDER BY seq DESC LIMIT 1`, [row.work_item_id])).rows[0];
  if (!work || work.terminal_at || work.state !== "active") return endRow(db, row, "interaction_ended", "system:cobrowse");
  if (!owner || owner.agent_id !== row.agent_id) return endRow(db, row, "agent_changed", "system:cobrowse");
  try {
    const widget = await currentWidget(db, row.widget_id, row.origin);
    if (widget.revision_id !== row.widget_revision_id)
      return endRow(db, row, "widget_policy_changed", "system:cobrowse");
  }
  catch (error) {
    if (error.status === 403) return endRow(db, row, "widget_policy_changed", "system:cobrowse");
    throw error;
  }
  if (row.control_requested_at && row.control_level !== "assist" &&
    Date.now() - new Date(row.control_requested_at).getTime() > 2 * 60_000) {
    return (await db.query(`UPDATE acd_cobrowse_sessions SET control_requested_at=NULL,updated_at=now()
      WHERE id=$1 RETURNING *`, [row.id])).rows[0];
  }
  return row;
}

export async function readAgentCobrowse(pool, { workItemId, agentId, scope }) {
  return transaction(pool, async (db) => {
    const work = await activeOwner(db, workItemId, agentId, scope);
    let row = (await db.query(`SELECT * FROM acd_cobrowse_sessions WHERE work_item_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [workItemId])).rows[0];
    row = await reconcileRow(db, row);
    const widget = row && row.state !== "ended" ? await currentWidget(db, row.widget_id, row.origin) : null;
    return { session: summary(row, widget), entryPoint: await agentEntryPoint(db, work) };
  });
}

export async function requestAgentControl(pool, { workItemId, agentId, scope }) {
  return transaction(pool, async (db) => {
    await activeOwner(db, workItemId, agentId, scope);
    let row = (await db.query(`SELECT * FROM acd_cobrowse_sessions WHERE work_item_id=$1 AND ${LIVE} FOR UPDATE`, [workItemId])).rows[0];
    row = await reconcileRow(db, row);
    if (!row || row.state !== "active") throw fail("Page sharing must be active before requesting control", 409);
    const widget = await currentWidget(db, row.widget_id, row.origin);
    if (widget.config.cobrowse.control.maxLevel !== "assist") throw fail("Assisted control is disabled for this widget", 403);
    if (row.control_level === "assist" || row.control_requested_at) return summary(row, widget);
    const updated = (await db.query(`UPDATE acd_cobrowse_sessions SET control_requested_at=now(),updated_at=now()
      WHERE id=$1 RETURNING *`, [row.id])).rows[0];
    await appendEvent(db, { workItemId, agentId, type: "cobrowse_control_requested", actor: actor(agentId), payload: { session_id: row.id } });
    return summary(updated, widget);
  });
}

async function decideControl(db, row, decision, by) {
  const current = await reconcileRow(db, row);
  if (!current || current.state !== "active") throw fail("Page sharing is not active", 409);
  const widget = await currentWidget(db, current.widget_id, current.origin);
  if (decision === "accept") {
    if (widget.config.cobrowse.control.maxLevel !== "assist" || !current.control_requested_at)
      throw fail("Control request is unavailable", 409);
  } else if (!["decline", "revoke"].includes(decision)) throw fail("Invalid control decision");
  const granted = decision === "accept";
  const updated = (await db.query(`UPDATE acd_cobrowse_sessions
    SET control_level=$2,control_requested_at=NULL,control_granted_at=CASE WHEN $3 THEN now() ELSE NULL END,updated_at=now()
    WHERE id=$1 RETURNING *`, [current.id, granted ? "assist" : "observe", granted])).rows[0];
  await appendEvent(db, { workItemId: current.work_item_id, agentId: current.agent_id,
    type: granted ? "cobrowse_control_granted" : decision === "revoke" ? "cobrowse_control_revoked" : "cobrowse_control_declined",
    actor: by, payload: { session_id: current.id } });
  return summary(updated, widget);
}

export async function decideBrowserControl(pool, { sessionId, credential, origin, decision }) {
  return transaction(pool, async (db) => {
    const row = await browserRow(db, sessionId, credential, origin, { lock: true });
    return decideControl(db, row, decision, `browser:${row.id}`);
  });
}

export async function requestCobrowse(pool, { workItemId, agentId, scope }) {
  return transaction(pool, async (db) => {
    await activeOwner(db, workItemId, agentId, scope);
    const existing = (await db.query(`SELECT * FROM acd_cobrowse_sessions WHERE work_item_id=$1 AND ${LIVE} FOR UPDATE`, [workItemId])).rows[0];
    if (existing) {
      const current = await reconcileRow(db, existing);
      if (current.state !== "ended") return summary(current);
    }
    const widgetSession = await linkedWidgetSession(db, workItemId);
    if (!widgetSession) throw fail("This interaction has no widget session; use a pairing code", 409);
    if (!widgetSession.active) throw fail("The linked widget session has expired; reopen the widget", 409);
    const widget = await currentWidget(db, widgetSession.widget_id, widgetSession.origin, "inSession");
    if (widget.revision_id !== widgetSession.revision_id) throw fail("Widget publication changed; reopen the widget", 409);
    const id = randomUUID();
    const row = (await db.query(`INSERT INTO acd_cobrowse_sessions
      (id,work_item_id,widget_id,widget_revision_id,widget_session_id,origin,browser_secret_hash,agent_id,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending_consent') RETURNING *`,
    [id, workItemId, widgetSession.widget_id, widgetSession.revision_id, widgetSession.id,
      widgetSession.origin, hashCredential(freshCredential()), String(agentId)])).rows[0];
    await appendEvent(db, { workItemId, agentId, type: "cobrowse_requested", actor: actor(agentId), payload: { session_id: id, level: "observe" } });
    return summary(await withAgentName(db, row), widget);
  });
}

export async function issuePairing(pool, { publicId, bootstrapToken, origin, admissionKey }) {
  let claims;
  try { claims = verifyWidgetBootstrapToken(bootstrapToken, { publicId }); }
  catch { throw fail("Bootstrap expired", 401); }
  if (claims.org !== origin) throw fail("Origin mismatch", 403);
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,617322))", [`pair:${publicId}:${admissionKey}`]);
    const widget = await getPublishedWidget(db, publicId);
    if (!widget || widget.revision_id !== claims.rid || !widget.config.cobrowse.enabled ||
      !widget.config.cobrowse.entryPoints.pairingCode ||
      !isWidgetSessionOriginAllowed(origin, widget.config.allowedOrigins)) throw fail("Co-browsing is unavailable", 403);
    const count = (await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE admission_key=$2)::int AS client FROM acd_cobrowse_pairings
      WHERE widget_id=$1 AND created_at>now()-interval '1 minute'`, [widget.id, admissionKey])).rows[0];
    if (count.client >= 5 || count.total >= 300) throw fail("Too many pairing requests", 429);
    await db.query(`UPDATE acd_cobrowse_pairings SET state='expired' WHERE widget_id=$1 AND state='open' AND expires_at<=now()`, [widget.id]);
    const id = randomUUID(), credential = freshCredential();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generatePairingCode(), hmac = pairingCodeHmac(code);
      const inserted = await db.query(`INSERT INTO acd_cobrowse_pairings
        (id,widget_id,widget_revision_id,origin,code_hmac,browser_secret_hash,admission_key,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::text||' seconds')::interval)
        ON CONFLICT DO NOTHING RETURNING expires_at`,
      [id, widget.id, widget.revision_id, origin, hmac, hashCredential(credential), admissionKey, widget.config.cobrowse.pairing.seconds]);
      if (inserted.rowCount) return { pairingId: id, code, browserCredential: credential, expiresAt: inserted.rows[0].expires_at };
    }
    throw fail("Pairing code unavailable", 503);
  });
}

export async function claimPairing(pool, { workItemId, agentId, scope, code }) {
  const hmac = pairingCodeHmac(code);
  if (!hmac) throw fail("Invalid pairing code");
  const replay = await transaction(pool, async (db) => {
    const work = await activeOwner(db, workItemId, agentId, scope);
    await requirePairingInteraction(db, work);
    const existing = (await db.query(`SELECT s.*,p.code_hmac FROM acd_cobrowse_sessions s
      LEFT JOIN acd_cobrowse_pairings p ON p.id=s.pairing_id
      WHERE s.work_item_id=$1 AND s.state NOT IN ('ended','failed') FOR UPDATE OF s`, [workItemId])).rows[0];
    if (!existing) return null;
    const current = await reconcileRow(db, existing);
    if (current.state === "ended") return null;
    if (existing.code_hmac === hmac) return summary(current);
    throw fail("Co-browsing is already requested", 409);
  });
  if (replay) return replay;
  // This transaction commits before a bad code can abort the claim below.
  // Otherwise every failed guess would roll back its own rate-limit evidence.
  const attempts = await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,617323))", [`claim:${agentId}`]);
    await db.query("INSERT INTO acd_cobrowse_claim_attempts(agent_id) VALUES($1)", [String(agentId)]);
    return (await db.query(`SELECT count(*)::int AS n FROM acd_cobrowse_claim_attempts
      WHERE agent_id=$1 AND attempted_at>now()-interval '1 minute'`, [String(agentId)])).rows[0].n;
  });
  if (attempts > 5) throw fail("Too many pairing attempts", 429);
  return transaction(pool, async (db) => {
    const work = await activeOwner(db, workItemId, agentId, scope);
    await requirePairingInteraction(db, work);
    const existing = (await db.query(`SELECT s.*,p.code_hmac FROM acd_cobrowse_sessions s
      LEFT JOIN acd_cobrowse_pairings p ON p.id=s.pairing_id
      WHERE s.work_item_id=$1 AND s.state NOT IN ('ended','failed') FOR UPDATE OF s`, [workItemId])).rows[0];
    if (existing) {
      const current = await reconcileRow(db, existing);
      if (current.state !== "ended") {
        if (existing.code_hmac === hmac) return summary(current);
        throw fail("Co-browsing is already requested", 409);
      }
    }
    const pairing = (await db.query(`SELECT * FROM acd_cobrowse_pairings
      WHERE code_hmac=$1 AND state='open' AND expires_at>now() FOR UPDATE`, [hmac])).rows[0];
    if (!pairing || pairing.attempts >= 5) throw fail("Pairing code unavailable", 404);
    const widget = await currentWidget(db, pairing.widget_id, pairing.origin, "pairingCode");
    if (widget.revision_id !== pairing.widget_revision_id) throw fail("Pairing code expired after publication change", 409);
    const id = randomUUID();
    const credential = pairingResumeCredential(pairing.id, pairing.browser_secret_hash, id);
    const row = (await db.query(`INSERT INTO acd_cobrowse_sessions
      (id,work_item_id,pairing_id,widget_id,widget_revision_id,origin,browser_secret_hash,agent_id,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending_consent') RETURNING *`,
    [id, workItemId, pairing.id, pairing.widget_id, pairing.widget_revision_id, pairing.origin,
      hashCredential(credential), String(agentId)])).rows[0];
    await db.query(`UPDATE acd_cobrowse_pairings SET state='claimed',attempts=attempts+1,
      claimed_work_item_id=$2,claimed_by=$3,claimed_at=now() WHERE id=$1`, [pairing.id, workItemId, String(agentId)]);
    await appendEvent(db, { workItemId, agentId, type: "cobrowse_requested", actor: actor(agentId), payload: { session_id: id, level: "observe", path: "pairing" } });
    return summary(row);
  });
}

export async function readPairing(pool, { pairingId, credential, origin }) {
  validId(pairingId);
  const row = (await pool.query("SELECT * FROM acd_cobrowse_pairings WHERE id=$1", [pairingId])).rows[0];
  if (!row || !equalHash(credential, row.browser_secret_hash) || row.origin !== origin) throw fail("Pairing unavailable", 401);
  if (row.state === "open" && new Date(row.expires_at).getTime() <= Date.now()) return { state: "expired" };
  if (row.state !== "claimed") return { state: row.state, expiresAt: row.expires_at };
  const session = (await pool.query("SELECT id,agent_id FROM acd_cobrowse_sessions WHERE pairing_id=$1", [pairingId])).rows[0];
  if (!session) throw fail("Pairing unavailable", 404);
  const named = await withAgentName(pool, session);
  return { state: "claimed", sessionId: session.id, agentName: named.agent_name,
    browserCredential: pairingResumeCredential(row.id, row.browser_secret_hash, session.id) };
}

export async function cancelPairing(pool, { pairingId, credential, origin }) {
  validId(pairingId);
  return transaction(pool, async (db) => {
    const row = (await db.query("SELECT * FROM acd_cobrowse_pairings WHERE id=$1 FOR UPDATE", [pairingId])).rows[0];
    if (!row || !equalHash(credential, row.browser_secret_hash) || row.origin !== origin)
      throw fail("Pairing unavailable", 401);
    if (row.state === "open") {
      await db.query("UPDATE acd_cobrowse_pairings SET state='cancelled' WHERE id=$1", [pairingId]);
      return { state: "cancelled" };
    }
    if (row.state === "claimed") {
      const session = (await db.query("SELECT * FROM acd_cobrowse_sessions WHERE pairing_id=$1 FOR UPDATE", [pairingId])).rows[0];
      if (session?.state === "pending_consent") {
        await endRow(db, session, "visitor_cancelled", `browser:${session.id}`);
        await db.query("UPDATE acd_cobrowse_pairings SET state='cancelled' WHERE id=$1", [pairingId]);
        return { state: "cancelled" };
      }
    }
    return { state: row.state };
  });
}

async function browserRow(db, sessionId, credential, origin, { lock = false } = {}) {
  validId(sessionId);
  const row = (await db.query(`SELECT * FROM acd_cobrowse_sessions WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [sessionId])).rows[0];
  if (!row || row.origin !== origin ||
    !(equalHash(credential, row.browser_secret_hash) ||
      (row.previous_secret_expires_at && new Date(row.previous_secret_expires_at).getTime() > Date.now() && equalHash(credential, row.previous_browser_secret_hash))))
    throw fail("Session unavailable", 401);
  await currentWidget(db, row.widget_id, origin);
  return row;
}

export async function readBrowserCobrowse(pool, { sessionId, credential, origin }) {
  return transaction(pool, async (db) => {
    let row = await browserRow(db, sessionId, credential, origin, { lock: true });
    row = await reconcileRow(db, row);
    const widget = await currentWidget(db, row.widget_id, origin);
    return summary(await withAgentName(db, row), widget);
  });
}

export async function readWidgetCobrowse(pool, { token, clientKey }) {
  const session = await getWidgetSession(pool, token);
  if (!clientKey || session.client_key !== clientKey) throw fail("Browser tab mismatch", 403);
  return transaction(pool, async (db) => {
    let row = (await db.query(`SELECT * FROM acd_cobrowse_sessions WHERE widget_session_id=$1 AND ${LIVE}
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [session.id])).rows[0];
    if (!row) return null;
    row = await reconcileRow(db, row);
    const widget = await currentWidget(db, row.widget_id, row.origin);
    return summary(await withAgentName(db, row), widget);
  });
}

export async function consentWidgetCobrowse(pool, { token, clientKey, accepted }) {
  const widgetSession = await getWidgetSession(pool, token);
  if (!clientKey || widgetSession.client_key !== clientKey) throw fail("Browser tab mismatch", 403);
  return transaction(pool, async (db) => {
    const row = (await db.query(`SELECT * FROM acd_cobrowse_sessions WHERE widget_session_id=$1
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [widgetSession.id])).rows[0];
    if (!row) throw fail("Request unavailable", 404);
    return decideConsent(db, row, accepted, `widget:${widgetSession.id}`);
  });
}

async function decideConsent(db, row, accepted, by) {
  const current = await reconcileRow(db, row);
  if (current.state !== "pending_consent") {
    if (!accepted && current.state === "ended" && current.end_reason === "consent_declined")
      return { session: summary(current) };
    if (accepted && current.consent_granted_at && ["connecting", "active", "reconnecting"].includes(current.state)) {
      const credential = freshCredential();
      const updated = (await db.query(`UPDATE acd_cobrowse_sessions
        SET previous_browser_secret_hash=browser_secret_hash,
          previous_secret_expires_at=now()+interval '60 seconds',browser_secret_hash=$2,updated_at=now()
        WHERE id=$1 RETURNING *`, [row.id, hashCredential(credential)])).rows[0];
      return { session: summary(updated), browserCredential: credential };
    }
    throw fail("Consent is no longer pending", 409);
  }
  if (!accepted) {
    const ended = await endRow(db, current, "consent_declined", by);
    await appendEvent(db, { workItemId: row.work_item_id, agentId: row.agent_id, type: "cobrowse_consent_declined", actor: by, payload: { session_id: row.id } });
    return { session: summary(ended) };
  }
  const widget = await currentWidget(db, row.widget_id, row.origin);
  const policy = widget.config.cobrowse.consent;
  const policyHash = createHash("sha256").update(policy.text).digest("hex");
  const credential = freshCredential();
  const updated = (await db.query(`UPDATE acd_cobrowse_sessions
    SET state='connecting',consent_granted_at=now(),consent_policy_version=$2,
      consent_text_hash=$3,previous_browser_secret_hash=browser_secret_hash,
      previous_secret_expires_at=now()+interval '60 seconds',browser_secret_hash=$4,auth_generation=auth_generation+1,
      updated_at=now() WHERE id=$1 RETURNING *`,
  [row.id, policy.policyVersion, policyHash, hashCredential(credential)])).rows[0];
  await appendEvent(db, { workItemId: row.work_item_id, agentId: row.agent_id,
    type: "cobrowse_consent_granted", actor: by,
    payload: { session_id: row.id, level: "observe", policy_version: policy.policyVersion, policy_hash: policyHash } });
  return { session: summary(updated, widget), browserCredential: credential };
}

export async function consentBrowserCobrowse(pool, { sessionId, credential, origin, accepted }) {
  return transaction(pool, async (db) => {
    const row = await browserRow(db, sessionId, credential, origin, { lock: true });
    return decideConsent(db, row, accepted, `browser:${row.id}`);
  });
}

export async function stopBrowserCobrowse(pool, { sessionId, credential, origin }) {
  return transaction(pool, async (db) => {
    const row = await browserRow(db, sessionId, credential, origin, { lock: true });
    return summary(await endRow(db, row, "visitor_stopped", `browser:${row.id}`));
  });
}

export async function endAgentCobrowse(pool, { workItemId, agentId, scope }) {
  return transaction(pool, async (db) => {
    await activeOwner(db, workItemId, agentId, scope);
    const row = (await db.query(`SELECT * FROM acd_cobrowse_sessions WHERE work_item_id=$1 AND ${LIVE} FOR UPDATE`, [workItemId])).rows[0];
    return summary(await endRow(db, row, "agent_stopped", actor(agentId)));
  });
}

export async function issueViewerTicket(pool, { sessionId, agentId, scope }) {
  return transaction(pool, async (db) => {
    validId(sessionId);
    const target = (await db.query("SELECT work_item_id FROM acd_cobrowse_sessions WHERE id=$1", [sessionId])).rows[0];
    if (!target) throw fail("Session unavailable", 404);
    await activeOwner(db, target.work_item_id, agentId, scope);
    let row = (await db.query("SELECT * FROM acd_cobrowse_sessions WHERE id=$1 FOR UPDATE", [sessionId])).rows[0];
    row = await reconcileRow(db, row);
    if (!["connecting", "active", "reconnecting"].includes(row.state) || !row.consent_granted_at) throw fail("Visitor consent is required", 409);
    const ticket = freshCredential("cbt");
    await db.query(`INSERT INTO acd_cobrowse_tickets
      (token_hash,session_id,role,actor_id,origin,auth_generation,expires_at)
      VALUES($1,$2,'viewer',$3,$4,$5,now()+interval '60 seconds')`,
    [hashCredential(ticket), row.id, String(agentId), row.origin, row.auth_generation]);
    return { ticket, session: summary(row), expiresInSeconds: 60 };
  });
}

export async function issuePublisherTicket(pool, { sessionId, credential, origin }) {
  return transaction(pool, async (db) => {
    let row = await browserRow(db, sessionId, credential, origin, { lock: true });
    row = await reconcileRow(db, row);
    if (!["connecting", "active", "reconnecting"].includes(row.state) || !row.consent_granted_at) throw fail("Visitor consent is required", 409);
    const ticket = freshCredential("cbt"), nextCredential = freshCredential();
    await db.query(`UPDATE acd_cobrowse_sessions SET previous_browser_secret_hash=browser_secret_hash,
      previous_secret_expires_at=now()+interval '60 seconds',browser_secret_hash=$2,updated_at=now()
      WHERE id=$1`, [row.id, hashCredential(nextCredential)]);
    await db.query(`INSERT INTO acd_cobrowse_tickets
      (token_hash,session_id,role,origin,auth_generation,expires_at)
      VALUES($1,$2,'publisher',$3,$4,now()+interval '60 seconds')`,
    [hashCredential(ticket), row.id, row.origin, row.auth_generation]);
    return { ticket, browserCredential: nextCredential, expiresInSeconds: 60 };
  });
}

export async function consumeCobrowseTicket(pool, { ticket, origin }) {
  if (typeof ticket !== "string" || !/^cbt_[A-Za-z0-9_-]{43}$/.test(ticket)) throw fail("Invalid ticket", 401);
  return transaction(pool, async (db) => {
    const claimed = (await db.query(`UPDATE acd_cobrowse_tickets SET consumed_at=now()
      WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING *`, [hashCredential(ticket)])).rows[0];
    if (!claimed) throw fail("Ticket expired", 401);
    const row = (await db.query("SELECT * FROM acd_cobrowse_sessions WHERE id=$1 FOR UPDATE", [claimed.session_id])).rows[0];
    const live = await reconcileRow(db, row);
    if (live.state === "ended" || live.auth_generation !== claimed.auth_generation ||
      !["connecting", "active", "reconnecting"].includes(live.state)) throw fail("Session unavailable", 403);
    // A signed widget test grant stores cc-test:<browser origin> for audit and
    // allowlist isolation. The WebSocket Origin header still contains the real
    // browser origin, so compare using the same strict mapping as the HTTP API.
    if (claimed.role === "publisher" && !matchStoredOrigin(claimed.origin, origin)) throw fail("Origin mismatch", 403);
    if (claimed.role === "viewer" && claimed.actor_id !== live.agent_id) throw fail("Agent changed", 403);
    await currentWidget(db, live.widget_id, live.origin);
    return { sessionId: live.id, role: claimed.role, workItemId: live.work_item_id,
      authGeneration: Number(live.auth_generation), agentId: live.agent_id, origin: live.origin };
  });
}

export async function cobrowseRelayState(pool, sessionId) {
  validId(sessionId);
  return transaction(pool, async (db) => {
    const row = (await db.query("SELECT * FROM acd_cobrowse_sessions WHERE id=$1 FOR UPDATE", [sessionId])).rows[0];
    const live = await reconcileRow(db, row);
    return live && { state: live.state, authGeneration: Number(live.auth_generation),
      consentGranted: !!live.consent_granted_at, controlLevel: live.control_level };
  });
}

export async function setCobrowseTransportState(pool, { sessionId, state }) {
  if (!["active", "reconnecting"].includes(state)) throw fail("Invalid transport state");
  return transaction(pool, async (db) => {
    validId(sessionId);
    const row = (await db.query("SELECT * FROM acd_cobrowse_sessions WHERE id=$1 FOR UPDATE", [sessionId])).rows[0];
    const live = await reconcileRow(db, row);
    if (!live || !live.consent_granted_at || ["ended", "failed"].includes(live.state)) return false;
    if (live.state === state) return true;
    const updated = await db.query(`UPDATE acd_cobrowse_sessions SET state=$2,
      started_at=CASE WHEN $2='active' THEN COALESCE(started_at,now()) ELSE started_at END,
      reconnect_deadline_at=CASE WHEN $2='reconnecting' THEN now()+interval '60 seconds' ELSE NULL END,
      control_level=CASE WHEN $2='reconnecting' THEN 'observe' ELSE control_level END,
      control_requested_at=CASE WHEN $2='reconnecting' THEN NULL ELSE control_requested_at END,
      control_granted_at=CASE WHEN $2='reconnecting' THEN NULL ELSE control_granted_at END,
      updated_at=now() WHERE id=$1`, [sessionId, state]);
    if (updated.rowCount) await appendEvent(db, { workItemId: live.work_item_id, agentId: live.agent_id,
      type: state === "active" ? (live.started_at ? "cobrowse_resumed" : "cobrowse_started") : "cobrowse_reconnecting",
      actor: "system:cobrowse", payload: { session_id: sessionId } });
    return Boolean(updated.rowCount);
  });
}

export async function endCobrowseAfterReconnectTimeout(pool, sessionId) {
  return transaction(pool, async (db) => {
    validId(sessionId);
    const row = (await db.query("SELECT * FROM acd_cobrowse_sessions WHERE id=$1 FOR UPDATE", [sessionId])).rows[0];
    if (row?.state === "reconnecting") await endRow(db, row, "publisher_disconnected", "system:cobrowse");
  });
}

export async function sweepCobrowseSessions(pool, limit = 100) {
  return transaction(pool, async (db) => {
    await db.query("UPDATE acd_cobrowse_pairings SET state='expired' WHERE state='open' AND expires_at<=now()");
    await db.query("DELETE FROM acd_cobrowse_pairings WHERE state IN ('expired','cancelled') AND created_at<now()-interval '1 day'");
    await db.query("DELETE FROM acd_cobrowse_claim_attempts WHERE attempted_at<now()-interval '1 hour'");
    await db.query("DELETE FROM acd_cobrowse_tickets WHERE expires_at<now()-interval '1 hour'");
    const rows = (await db.query(`SELECT * FROM acd_cobrowse_sessions
      WHERE ${LIVE} ORDER BY updated_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    for (const row of rows) {
      const current = await reconcileRow(db, row);
      if (current && !["ended", "failed"].includes(current.state))
        await db.query("UPDATE acd_cobrowse_sessions SET updated_at=now() WHERE id=$1", [row.id]);
    }
    return rows.length;
  });
}

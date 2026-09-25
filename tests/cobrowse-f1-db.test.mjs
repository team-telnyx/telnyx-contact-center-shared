import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, test } from "node:test";
import { prepareAcdTestPool, seedAgent, seedQueue } from "./helpers/acd-test-db.mjs";
import { createDefaultWidgetConfig } from "../lib/widgets/config.js";
import { ensureCobrowseSchema } from "../lib/cobrowse/schema.mjs";
import { createWidgetBootstrapToken, hashSessionToken, widgetSessionToken } from "../lib/widgets/session-tokens.js";
import {
  cancelPairing, claimPairing, cobrowseRelayState, consentBrowserCobrowse, consentWidgetCobrowse,
  consumeCobrowseTicket, issuePairing, issuePublisherTicket, issueViewerTicket,
  decideBrowserControl, readAgentCobrowse, readPairing, readWidgetCobrowse, requestAgentControl, requestCobrowse, setCobrowseTransportState,
  stopBrowserCobrowse,
} from "../lib/cobrowse/lifecycle.mjs";

process.env.WIDGET_SESSION_SIGNING_SECRET = "cobrowse-f1-database-test-secret-at-least-32-characters";
process.env.COBROWSE_SIGNING_SECRET = "cobrowse-f1-pairing-test-secret-at-least-32-characters";
const pool = await prepareAcdTestPool("acd_cobrowse_f1_20260921");
after(async () => pool.end());

const origin = "https://customer.example";
const agent = randomUUID(), other = randomUUID(), queue = randomUUID();
await seedAgent(pool, agent);
await seedAgent(pool, other);
await seedQueue(pool, queue, [agent, other]);
const widgetId = randomUUID(), revisionId = randomUUID(), publicId = `cb-${randomUUID()}`;
const config = createDefaultWidgetConfig("en-US");
config.allowedOrigins = [origin];
config.cobrowse.enabled = true;
config.cobrowse.control.maxLevel = "assist";
await pool.query(`INSERT INTO cc_widgets(id,public_id,name,normalized_name,published_revision_id,created_by,updated_by)
  VALUES($1,$2,'Co-browse test',$3,$4,$5,$5)`, [widgetId, publicId, publicId, revisionId, agent]);
await pool.query(`INSERT INTO cc_widget_revisions(id,widget_id,version,state,config,created_by,published_at)
  VALUES($1,$2,1,'published',$3::jsonb,$4,now())`, [revisionId, widgetId, JSON.stringify(config), agent]);

async function work(channel = "chat", withWidgetSession = false, owner = agent, sessionOrigin = origin) {
  const id = randomUUID(), conversationId = randomUUID();
  await pool.query("INSERT INTO acd_conversations(id,channel,customer_name) VALUES($1,$2,'Visitor')", [conversationId, channel]);
  await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,queue_id,conversation_id)
    VALUES($1,$2,'inbound','active',$3,$4)`, [id, channel, queue, conversationId]);
  await pool.query(`INSERT INTO acd_segments(id,work_item_id,seq,kind,queue_id,agent_id,started_at)
    VALUES($1,$2,1,'agent',$3,$4,now())`, [randomUUID(), id, queue, owner]);
  let token = null, clientKey = null;
  if (withWidgetSession) {
    const widgetSessionId = randomUUID();
    token = widgetSessionToken(widgetSessionId);
    clientKey = randomUUID();
    await pool.query(`INSERT INTO cc_widget_sessions(id,token_hash,widget_id,revision_id,conversation_id,origin,client_key,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,
    [widgetSessionId, hashSessionToken(token), widgetId, revisionId, conversationId, sessionOrigin, clientKey]);
  }
  return { id, token, clientKey };
}

test("Path A requires the exact active assignee, fresh consent and one-use role tickets", async () => {
  const target = await work("chat", true);
  await assert.rejects(() => requestCobrowse(pool, { workItemId: target.id, agentId: other, scope: null }), { status: 403 });
  const pending = await requestCobrowse(pool, { workItemId: target.id, agentId: agent, scope: null });
  assert.equal(pending.state, "pending_consent");
  await assert.rejects(() => readWidgetCobrowse(pool, { token: target.token, clientKey: randomUUID() }), { status: 403 });
  assert.equal((await readWidgetCobrowse(pool, { token: target.token, clientKey: target.clientKey })).id, pending.id);
  await assert.rejects(() => issueViewerTicket(pool, { sessionId: pending.id, agentId: agent, scope: null }), { status: 409 });
  const accepted = await consentWidgetCobrowse(pool, { token: target.token, clientKey: target.clientKey, accepted: true });
  assert.equal(accepted.session.state, "connecting");
  assert.match(accepted.browserCredential, /^cbr_/);
  const retried = await consentWidgetCobrowse(pool, { token: target.token, clientKey: target.clientKey, accepted: true });
  assert.equal(retried.session.id, pending.id);
  assert.match(retried.browserCredential, /^cbr_/);
  const row = (await pool.query("SELECT consent_policy_version,consent_text_hash FROM acd_cobrowse_sessions WHERE id=$1", [pending.id])).rows[0];
  assert.equal(row.consent_policy_version, config.cobrowse.consent.policyVersion);
  assert.equal(row.consent_text_hash, createHash("sha256").update(config.cobrowse.consent.text).digest("hex"));
  await assert.rejects(() => issueViewerTicket(pool, { sessionId: pending.id, agentId: other, scope: null }), { status: 403 });
  const publisher = await issuePublisherTicket(pool, { sessionId: pending.id, credential: retried.browserCredential, origin });
  assert.equal((await consumeCobrowseTicket(pool, { ticket: publisher.ticket, origin })).role, "publisher");
  await assert.rejects(() => consumeCobrowseTicket(pool, { ticket: publisher.ticket, origin }), { status: 401 });
  const viewer = await issueViewerTicket(pool, { sessionId: pending.id, agentId: agent, scope: null });
  assert.equal((await consumeCobrowseTicket(pool, { ticket: viewer.ticket, origin: "https://cc.example" })).role, "viewer");
  const ended = await stopBrowserCobrowse(pool, { sessionId: pending.id, credential: publisher.browserCredential, origin });
  assert.equal(ended.state, "ended");
  await assert.rejects(() => issuePublisherTicket(pool, { sessionId: pending.id, credential: publisher.browserCredential, origin }), { status: 409 });
});

test("control requires a second visitor decision and is revoked on reconnect", async () => {
  const target = await work("chat", true);
  const pending = await requestCobrowse(pool, { workItemId: target.id, agentId: agent, scope: null });
  const args = { workItemId: target.id, agentId: agent, scope: null };
  await assert.rejects(() => requestAgentControl(pool, args), { status: 409 });
  const accepted = await consentWidgetCobrowse(pool, { token: target.token, clientKey: target.clientKey, accepted: true });
  await setCobrowseTransportState(pool, { sessionId: pending.id, state: "active" });
  await assert.rejects(() => requestAgentControl(pool, { ...args, agentId: other }), { status: 403 });
  const requested = await requestAgentControl(pool, args);
  assert.ok(requested.controlRequestedAt);
  assert.equal(requested.controlLevel, "observe");
  assert.equal((await cobrowseRelayState(pool, pending.id)).controlLevel, "observe");
  await assert.rejects(() => decideBrowserControl(pool, { sessionId: pending.id, credential: "wrong", origin, decision: "accept" }), { status: 401 });
  const granted = await decideBrowserControl(pool, { sessionId: pending.id, credential: accepted.browserCredential, origin, decision: "accept" });
  assert.equal(granted.controlLevel, "assist");
  assert.equal((await cobrowseRelayState(pool, pending.id)).controlLevel, "assist");
  const revoked = await decideBrowserControl(pool, { sessionId: pending.id, credential: accepted.browserCredential, origin, decision: "revoke" });
  assert.equal(revoked.controlLevel, "observe");
  await requestAgentControl(pool, args);
  await decideBrowserControl(pool, { sessionId: pending.id, credential: accepted.browserCredential, origin, decision: "accept" });
  await setCobrowseTransportState(pool, { sessionId: pending.id, state: "reconnecting" });
  assert.equal((await cobrowseRelayState(pool, pending.id)).controlLevel, "observe");
});

test("signed widget test origin accepts the real browser WebSocket origin only", async () => {
  const target = await work("chat", true, agent, `cc-test:${origin}`);
  const pending = await requestCobrowse(pool, { workItemId: target.id, agentId: agent, scope: null });
  const accepted = await consentWidgetCobrowse(pool, { token: target.token, clientKey: target.clientKey, accepted: true });
  const publisher = await issuePublisherTicket(pool, {
    sessionId: pending.id, credential: accepted.browserCredential, origin: `cc-test:${origin}`,
  });
  await assert.rejects(() => consumeCobrowseTicket(pool, { ticket: publisher.ticket, origin: "https://customer.example.attacker.test" }), { status: 403 });
  assert.equal((await consumeCobrowseTicket(pool, { ticket: publisher.ticket, origin })).role, "publisher");
  await assert.rejects(() => consumeCobrowseTicket(pool, { ticket: publisher.ticket, origin }), { status: 401 });
});

test("Path B pairs without a second channel session and transfer revokes consent", async () => {
  const target = await work("voice");
  const bootstrapToken = createWidgetBootstrapToken({ publicId, revisionId, origin });
  const issued = await issuePairing(pool, { publicId, bootstrapToken, origin, admissionKey: "test-admission" });
  assert.match(issued.code, /^\d{6}$/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_widget_sessions WHERE conversation_id=(SELECT conversation_id FROM acd_work_items WHERE id=$1)", [target.id])).rows[0].n, 0);
  assert.equal((await readPairing(pool, { pairingId: issued.pairingId, credential: issued.browserCredential, origin })).state, "open");
  const pending = await claimPairing(pool, { workItemId: target.id, agentId: agent, scope: null, code: issued.code });
  assert.equal(pending.state, "pending_consent");
  assert.equal((await claimPairing(pool, { workItemId: target.id, agentId: agent, scope: null, code: issued.code })).id, pending.id);
  const claimed = await readPairing(pool, { pairingId: issued.pairingId, credential: issued.browserCredential, origin });
  assert.equal(claimed.sessionId, pending.id);
  const accepted = await consentBrowserCobrowse(pool, { sessionId: pending.id, credential: claimed.browserCredential, origin, accepted: true });
  assert.equal(accepted.session.state, "connecting");
  await pool.query("UPDATE acd_segments SET ended_at=now(),outcome='transferred' WHERE work_item_id=$1 AND agent_id=$2", [target.id, agent]);
  await pool.query(`INSERT INTO acd_segments(id,work_item_id,seq,kind,queue_id,agent_id,started_at)
    VALUES($1,$2,2,'agent',$3,$4,now())`, [randomUUID(), target.id, queue, other]);
  assert.equal((await cobrowseRelayState(pool, pending.id)).state, "ended");
  assert.equal((await pool.query("SELECT end_reason FROM acd_cobrowse_sessions WHERE id=$1", [pending.id])).rows[0].end_reason, "agent_changed");
});

test("agent entry points distinguish linked widget sessions from PSTN, SMS and WhatsApp", async () => {
  const chat = await work("chat", true);
  const video = await work("video", true);
  const linkedVoice = await work("voice", true);
  const voice = await work("voice");
  const sms = await work("sms");
  const whatsapp = await work("whatsapp");
  const email = await work("email");
  const args = (target) => ({ workItemId: target.id, agentId: agent, scope: null });
  for (const target of [chat, video, linkedVoice]) {
    assert.equal((await readAgentCobrowse(pool, args(target))).entryPoint.kind, "inSession");
  }
  for (const target of [voice, sms, whatsapp]) {
    assert.equal((await readAgentCobrowse(pool, args(target))).entryPoint.kind, "pairingCode");
  }
  assert.equal((await readAgentCobrowse(pool, args(email))).entryPoint.kind, "unavailable");
  await assert.rejects(() => requestCobrowse(pool, args(voice)), { status: 409 });

  const bootstrapToken = createWidgetBootstrapToken({ publicId, revisionId, origin });
  const forChat = await issuePairing(pool, { publicId, bootstrapToken, origin, admissionKey: "chat-code-test" });
  await assert.rejects(() => claimPairing(pool, { ...args(chat), code: forChat.code }), { status: 409 });
  await assert.rejects(() => claimPairing(pool, { ...args(linkedVoice), code: forChat.code }), { status: 409 });
  await assert.rejects(() => claimPairing(pool, { ...args(email), code: forChat.code }), { status: 409 });
  const claimedSms = await claimPairing(pool, { ...args(sms), code: forChat.code });
  assert.equal(claimedSms.state, "pending_consent");
  const forWhatsapp = await issuePairing(pool, { publicId, bootstrapToken, origin, admissionKey: "whatsapp-code-test" });
  const claimedWhatsapp = await claimPairing(pool, { ...args(whatsapp), code: forWhatsapp.code });
  assert.equal(claimedWhatsapp.state, "pending_consent");
});

test("a new assignee can request after transfer without waiting for the relay sweep", async () => {
  const target = await work("chat", true);
  const original = await requestCobrowse(pool, { workItemId: target.id, agentId: agent, scope: null });
  await pool.query("UPDATE acd_segments SET ended_at=now(),outcome='transferred' WHERE work_item_id=$1 AND agent_id=$2", [target.id, agent]);
  await pool.query(`INSERT INTO acd_segments(id,work_item_id,seq,kind,queue_id,agent_id,started_at)
    VALUES($1,$2,2,'agent',$3,$4,now())`, [randomUUID(), target.id, queue, other]);
  const replacement = await requestCobrowse(pool, { workItemId: target.id, agentId: other, scope: null });
  assert.notEqual(replacement.id, original.id);
  assert.equal(replacement.state, "pending_consent");
  assert.equal((await pool.query("SELECT end_reason FROM acd_cobrowse_sessions WHERE id=$1", [original.id])).rows[0].end_reason, "agent_changed");
});

test("pending, connecting and reconnecting sessions expire without a live relay process", async () => {
  const pendingWork = await work("chat", true);
  const pending = await requestCobrowse(pool, { workItemId: pendingWork.id, agentId: agent, scope: null });
  await pool.query("UPDATE acd_cobrowse_sessions SET created_at=now()-interval '6 minutes' WHERE id=$1", [pending.id]);
  assert.equal((await cobrowseRelayState(pool, pending.id)).state, "ended");

  const connectingWork = await work("chat", true);
  const connecting = await requestCobrowse(pool, { workItemId: connectingWork.id, agentId: agent, scope: null });
  await consentWidgetCobrowse(pool, { token: connectingWork.token, clientKey: connectingWork.clientKey, accepted: true });
  await pool.query("UPDATE acd_cobrowse_sessions SET consent_granted_at=now()-interval '3 minutes' WHERE id=$1", [connecting.id]);
  assert.equal((await cobrowseRelayState(pool, connecting.id)).state, "ended");

  const reconnectWork = await work("chat", true);
  const reconnect = await requestCobrowse(pool, { workItemId: reconnectWork.id, agentId: agent, scope: null });
  await consentWidgetCobrowse(pool, { token: reconnectWork.token, clientKey: reconnectWork.clientKey, accepted: true });
  await setCobrowseTransportState(pool, { sessionId: reconnect.id, state: "reconnecting" });
  await pool.query("UPDATE acd_cobrowse_sessions SET reconnect_deadline_at=now()-interval '1 second' WHERE id=$1", [reconnect.id]);
  assert.equal((await cobrowseRelayState(pool, reconnect.id)).state, "ended");
});

test("visitor cancellation invalidates both unclaimed and claimed codes", async () => {
  const bootstrapToken = createWidgetBootstrapToken({ publicId, revisionId, origin });
  const open = await issuePairing(pool, { publicId, bootstrapToken, origin, admissionKey: "cancel-open" });
  assert.equal((await cancelPairing(pool, { pairingId: open.pairingId, credential: open.browserCredential, origin })).state, "cancelled");
  assert.equal((await readPairing(pool, { pairingId: open.pairingId, credential: open.browserCredential, origin })).state, "cancelled");

  const target = await work("voice");
  const claimed = await issuePairing(pool, { publicId, bootstrapToken, origin, admissionKey: "cancel-claimed" });
  const session = await claimPairing(pool, { workItemId: target.id, agentId: agent, scope: null, code: claimed.code });
  assert.equal((await cancelPairing(pool, { pairingId: claimed.pairingId, credential: claimed.browserCredential, origin })).state, "cancelled");
  assert.equal((await cobrowseRelayState(pool, session.id)).state, "ended");
  assert.equal((await pool.query("SELECT end_reason FROM acd_cobrowse_sessions WHERE id=$1", [session.id])).rows[0].end_reason, "visitor_cancelled");
});

test("invalid claim attempts survive failed transactions and lock out the caller", async () => {
  const attemptAgent = randomUUID();
  await seedAgent(pool, attemptAgent);
  const target = await work("voice", false, attemptAgent);
  for (let index = 0; index < 5; index += 1)
    await assert.rejects(() => claimPairing(pool, { workItemId: target.id, agentId: attemptAgent, scope: null, code: "000000" }), { status: 404 });
  await assert.rejects(() => claimPairing(pool, { workItemId: target.id, agentId: attemptAgent, scope: null, code: "000000" }), { status: 429 });
  const count = (await pool.query("SELECT count(*)::int AS n FROM acd_cobrowse_claim_attempts WHERE agent_id=$1", [attemptAgent])).rows[0].n;
  assert.equal(count, 6);
});

test("existing observe-only tables migrate to the assisted-control constraint", async () => {
  await pool.query("ALTER TABLE acd_cobrowse_sessions DROP CONSTRAINT acd_cobrowse_control_level_policy");
  await pool.query("ALTER TABLE acd_cobrowse_sessions ADD CONSTRAINT acd_cobrowse_sessions_control_level_check CHECK (control_level = 'observe')");
  await ensureCobrowseSchema(pool);
  const target = await work("chat", true);
  const session = await requestCobrowse(pool, { workItemId: target.id, agentId: agent, scope: null });
  await pool.query("UPDATE acd_cobrowse_sessions SET control_level='assist' WHERE id=$1", [session.id]);
  assert.equal((await pool.query("SELECT control_level FROM acd_cobrowse_sessions WHERE id=$1", [session.id])).rows[0].control_level, "assist");
});

import { campaignAgentAssistConfig } from "../../outbound-dialer/agent-assist.js";
import { randomUUID } from 'node:crypto';
import { defineSaga, startSaga } from '../saga-engine.mjs';
import { createWorkItem, applyTransition, openSegment, closeOpenSegment, isTerminalState } from '../lifecycle.mjs';
import { tryReserveCapacity } from '../capacity.mjs';
import { releaseReservation } from '../reservations.mjs';
import { reserveOutboundLine, releaseOutboundLine } from '../outbound-capacity.mjs';
import { appendEvent } from '../events.mjs';
import { startConnectSaga } from './connect.mjs';
import { outboundBlendingBudget } from '../outbound-blending.mjs';
import { unavailableOutboundResource } from '../outbound-configuration.mjs';
import { prepareOutboundVoiceAttempt, completeAttemptClaim, finalizeAgentlessAttemptByWebhook, normalizeAmdAnalysisMs } from '../../outbound-dialer/execution.js';
import { loadEffectiveAnsweredWithoutAgentPolicy } from '../../outbound-dialer/answered-without-agent-policy.mjs';
import { transitionDialState } from '../../outbound-dialer/dial-state.js';

export const VOICE_DIALER_MODES = Object.freeze(['preview', 'progressive', 'power', 'predictive', 'agentless_ai', 'agentless_flow']);
const HUMAN_RESULTS = new Set(['human', 'human_residence', 'human_business', 'not_sure']);
const endEvent = { 'leg.ended:customer': 'finish' };
const answeredEvents = { ...endEvent, 'leg.answered:customer': 'classify', 'outbound.amd:customer': 'classify', 'outbound.greeting:customer': 'classify' };
const readLeg = async (tx, id) => (await tx.query(`SELECT * FROM acd_legs WHERE work_item_id = $1 AND role = 'customer' ORDER BY created_at LIMIT 1`, [id])).rows[0];
const patchData = (tx, ctx, patch) => tx.query(`UPDATE acd_sagas SET data = data || $2::jsonb WHERE id = $1`, [ctx.saga.id, JSON.stringify(patch)]);
const setReason = (tx, ctx, reason) => patchData(tx, ctx, { finishReason: reason });
const markAttemptConnected = (tx, ctx) => tx.query(
  `UPDATE outbound_attempt_ledger
      SET dial_state = 'connected',
          metadata = metadata || jsonb_build_object(
            'connected_at', COALESCE(metadata->>'connected_at', now()::text)
          )
    WHERE id = $1`,
  [ctx.data.attemptId],
);
function voicemailSpeakRequest(ctx) {
  const amd = ctx.data.amd || {};
  const tts = amd.voicemail_tts && typeof amd.voicemail_tts === 'object' ? amd.voicemail_tts : {};
  const request = {
    payload: String(amd.voicemailMessage || amd.voicemail_message || amd.message).slice(0, 5000),
    voice: tts.voice || amd.voicemailVoice || 'Telnyx.KokoroTTS.af_heart',
  };
  const language = tts.language || amd.voicemailLanguage;
  if (language) request.language = language;
  if (tts.voice_api_key_ref) {
    request.voice_settings = { type: 'elevenlabs', api_key_ref: tts.voice_api_key_ref };
  }
  return request;
}
async function transition(tx, ctx, to) {
  return applyTransition(tx, { workItemId: ctx.workItem.id, to, actor: 'saga:outbound_connect', eventType: `outbound_${to}`,
    patch: isTerminalState(to) ? {terminalReason:ctx.data.finishReason || `outbound_${to}`} : {} });
}
async function liveCampaign(tx, ctx) {
  return (await tx.query(`SELECT * FROM outbound_campaigns WHERE id = $1 FOR SHARE`, [ctx.data.campaignId])).rows[0];
}
async function agentReady(tx, ctx, { pendingManual = false } = {}) {
  if (!ctx.data.agentId) return true;
  const found = await tx.query(`SELECT 1 FROM acd_reservations r JOIN acd_agent_state a ON a.agent_id = r.agent_id
    WHERE r.id = $1 AND r.state <> 'released' AND a.presence = 'online' AND (a.manual_status = 'Available' OR $2)
      AND EXISTS (SELECT 1 FROM acd_agent_sessions s WHERE s.agent_id = a.agent_id AND s.state = 'online' AND s.expires_at > now() AND s.capabilities->>'voice' = 'true')`, [ctx.data.reservationId,pendingManual]);
  return found.rowCount > 0;
}
async function preDialAllowed(tx, ctx, campaign) {
  if (!campaign || !await agentReady(tx,ctx)) return false;
  if (ctx.data.mode.startsWith('agentless')) return true;
  const budget=await outboundBlendingBudget(tx,campaign,{agentId:ctx.data.agentId,reservationId:ctx.data.reservationId,
    protectAutonomousDemand:['preview','progressive'].includes(ctx.data.mode)});
  const allowed=budget.agentEligible && budget.free>0;
  if(!allowed)await patchData(tx,ctx,{blendingDeferred:true,blendingReason:budget.queued>0?'inbound_priority':budget.autonomousDebt>0?'outbound_customer_pending':'inbound_reserve'});
  return allowed;
}
// How long to wait for a detection result once the customer answered. Telnyx
// stops analysing after total_analysis_time_millis (3500 ms by default per the
// Call Request schema) and reports its own result then, so a flat 30 s only
// ever bought dead air on a live call.
//
// This deadline must never expire BEFORE the provider's own analysis window,
// or the saga would classify a call the provider is still measuring. It is
// therefore derived from the configured budget plus webhook margin, floored so
// a tiny configuration cannot make it racy, and bounded only by a sanity limit
// that can never cut into the configured budget itself.
const AMD_WEBHOOK_MARGIN_MS = 5000;
const AMD_MIN_WAIT_MS = 6000;
const AMD_SANITY_LIMIT_MS = 120000;

function amdWaitMs(ctx) {
  // Prefer the value actually sent to the provider: the dial payload is the
  // one place both sides agree on. A saga created before the budget was
  // materialised has no such field, and then the fallback must still respect
  // the detection mode — premium analyses for far longer than word detection,
  // so a flat standard default would make a resumed premium saga give up
  // while the provider is still measuring.
  const sent = ctx.data?.dialPayload?.answering_machine_detection_config || {};
  const config = ctx.data?.amd?.detectionConfig || ctx.data?.amd?.detection_config || {};
  const analysis = normalizeAmdAnalysisMs(
    sent.total_analysis_time_millis
      ?? config.total_analysis_time_millis
      ?? config.totalAnalysisTimeMillis,
    ctx.data?.amd?.mode,
  );
  return Math.min(AMD_SANITY_LIMIT_MS, Math.max(AMD_MIN_WAIT_MS, analysis + AMD_WEBHOOK_MARGIN_MS));
}

async function alarm(tx, ctx, reason) {
  if (ctx.data.alarmReason === reason) return;
  await appendEvent(tx, { workItemId: ctx.workItem.id, type: 'manual_intervention_required', actor: 'saga:outbound_connect', payload: { saga_id: ctx.saga.id, reason } });
  await patchData(tx, ctx, { alarmReason: reason });
}

export async function startOutboundConnect(tx, { campaign, ledger, agentId = null, agentUsername = null }) {
  if (campaign.channel !== 'voice' || !VOICE_DIALER_MODES.includes(campaign.mode)) throw new Error('Only voice outbound is enabled');
  await tx.query(`SELECT pg_advisory_xact_lock(741901,5)`);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`outbound:${ledger.id}`]);
  const previous = (await tx.query(`SELECT s.id AS saga_id, w.id AS work_item_id FROM acd_work_items w JOIN acd_sagas s ON s.work_item_id = w.id AND s.type = 'outbound_connect' WHERE w.outbound_attempt_id = $1`, [ledger.id])).rows[0];
  if (previous) return { sagaId: previous.saga_id, workItemId: previous.work_item_id };
  const workItem = await createWorkItem(tx, { channel: 'voice', direction: 'outbound', outboundAttemptId: ledger.id,
    queueId: campaign.handler_type === 'queue' ? campaign.handler_ref : null,
    priority: Number(campaign.metadata?.priority || 0), attributes: { outbound_campaign_id: campaign.id,
      outbound_attempt_id: ledger.id, outbound_mode: campaign.mode, agent_assist_config: campaign.attached_form_id || campaign.metadata?.attached_form_id || campaign.metadata?.form_id || campaign.attached_workflow_id || campaign.metadata?.attached_workflow_id || campaign.metadata?.workflow_id
        ? campaignAgentAssistConfig(campaign) : campaign.metadata?.agent_assist_config || campaignAgentAssistConfig(campaign) } });
  let reservationId = null;
  if (['preview', 'progressive'].includes(campaign.mode)) {
    if (!agentId) throw new Error('Agent campaign requires an assigned agent');
    const budget=await outboundBlendingBudget(tx,campaign,{agentId,protectAutonomousDemand:true});
    if(!budget.agentEligible || budget.free<1) throw Object.assign(new Error('Inbound traffic owns the available agent budget'),{code:'ACD_NO_CAPACITY',status:409});
    reservationId = await tryReserveCapacity(tx, { agentId, workItemId: workItem.id, attemptId: ledger.id, purpose: 'outbound', leaseMs: 600000 });
    if (!reservationId) throw Object.assign(new Error('No voice capacity for campaign assignment'), { code: 'ACD_NO_CAPACITY', status: 409 });
  }
  const started = await startSaga(tx, { type: 'outbound_connect', workItemId: workItem.id, conflictKey: 'origination', data: {
    attemptId: ledger.id, campaignId: campaign.id, mode: campaign.mode, agentId, agentUsername, reservationId,
    autoDialAt: campaign.mode === 'progressive' ? ledger.metadata?.auto_dial_at || new Date(Date.now() + 30000).toISOString() : null,
    previewExpiresAt: new Date(Date.now() + 600000).toISOString(),
    dialRequested: !['preview', 'progressive'].includes(campaign.mode),
  } });
  await tx.query(`UPDATE outbound_attempt_ledger SET lease_expires_at = NULL, metadata = metadata || $2::jsonb WHERE id = $1`, [ledger.id,
    JSON.stringify({ work_item_id: workItem.id, acd_saga_id: started.sagaId, assigned_agent: agentUsername, assignment_mode: campaign.mode,
      auto_dial_at: campaign.mode === 'progressive' ? ledger.metadata?.auto_dial_at || new Date(Date.now() + 30000).toISOString() : null })]);
  return { ...started, workItemId: workItem.id };
}

export const outboundConnectSaga = defineSaga('outbound_connect', {
  initialStep: 'await_dial',
  steps: {
    await_dial: { run: async (tx, ctx) => {
      const campaign = await liveCampaign(tx, ctx);
      const ledger = (await tx.query(`SELECT status FROM outbound_attempt_ledger WHERE id = $1`, [ctx.data.attemptId])).rows[0];
      if (campaign?.status !== 'running' || ledger?.status !== 'claimed' || ctx.data.cancelRequested || !await preDialAllowed(tx,ctx,campaign)) {
        await setReason(tx, ctx, 'cancelled_before_dial'); return 'cancel_before_dial';
      }
      if (Date.now() >= Date.parse(ctx.data.previewExpiresAt)) { await setReason(tx, ctx, 'preview_expired'); return 'cancel_before_dial'; }
      return ctx.data.dialRequested || (ctx.data.autoDialAt && Date.now() >= Date.parse(ctx.data.autoDialAt)) ? 'prepare' : null;
    }, deadlineMs: 1000 },
    prepare: { run: async (tx, ctx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(741901, 5)`);
      const campaign = await liveCampaign(tx, ctx);
      if (campaign?.status !== 'running' || ctx.data.cancelRequested || !await preDialAllowed(tx,ctx,campaign)) return 'cancel_before_dial';
      const ledger = (await tx.query(`SELECT * FROM outbound_attempt_ledger WHERE id = $1 FOR UPDATE`, [ctx.data.attemptId])).rows[0];
      if (!ledger || ledger.status !== 'claimed') return 'cancel_before_dial';
      const unavailable=await unavailableOutboundResource(tx,campaign);
      if(unavailable) {
        await completeAttemptClaim(tx,ledger.id,'skipped',{failure_reason:'campaign_resource_unavailable',resource:unavailable,next_retry_at:new Date(Date.now()+15*60000).toISOString()});
        await setReason(tx,ctx,'campaign_resource_unavailable');
        return 'cancel_before_dial';
      }
      if (!await reserveOutboundLine(tx, { attemptId: ledger.id, campaignId: campaign.id, workItemId: ctx.workItem.id, sagaId: ctx.saga.id, campaign })) return null;
      const prepared = await prepareOutboundVoiceAttempt(tx, campaign, ledger);
      if (!prepared.ok) { await setReason(tx, ctx, prepared.reason); return 'cancel_before_dial'; }
      const answeredWithoutAgentPolicy = await loadEffectiveAnsweredWithoutAgentPolicy(tx, campaign);
      const encodedState = Buffer.from(JSON.stringify({ outbound: true, campaignId: campaign.id, attemptId: ledger.id, acdWorkItemId: ctx.workItem.id, acdRole: 'customer' })).toString('base64');
      const dialPayload = { ...prepared.payload, client_state: encodedState,
        custom_headers: [{ name: 'X-CC-Work-Item-Id', value: ctx.workItem.id }, { name: 'X-CC-Outbound-Attempt-Id', value: ledger.id }] };
      delete dialPayload.command_id;
      await patchData(tx, ctx, { dialPayload, amd: campaign.amd_config || {}, handlerRef: campaign.handler_ref,
        answeredWithoutAgentPolicy,
        humanWaitMs: ['power','predictive'].includes(ctx.data.mode)
          ? Math.max(100, Number(answeredWithoutAgentPolicy.max_agent_connect_seconds) * 1000)
          : Math.max(1000, Number(campaign.pacing_config?.abandonTimeoutSecs || (ctx.data.agentId ? 30 : 10)) * 1000) });
      await tx.query(`UPDATE acd_work_items SET customer_address = $2, cc_address = $3 WHERE id = $1`, [ctx.workItem.id, prepared.to_number, prepared.from_number]);
      await tx.query(`UPDATE outbound_attempt_ledger SET metadata = metadata || $2::jsonb WHERE id = $1`, [ledger.id, JSON.stringify(prepared.metadata)]);
      return ctx.data.agentId ? 'start_agent' : 'dial_customer';
    }, deadlineMs: 1000 },
    start_agent: { run: async (tx, ctx) => {
      const campaign=await liveCampaign(tx,ctx);
      if(campaign?.status!=='running'||ctx.data.cancelRequested||!await preDialAllowed(tx,ctx,campaign)) return 'cancel_before_dial';
      await transition(tx,ctx,'queued');
      await transition(tx,ctx,'offered');
      const agent=(await tx.query('SELECT * FROM users WHERE id=$1',[ctx.data.agentId])).rows[0];
      const offerId=randomUUID();
      await tx.query("INSERT INTO acd_offers(id,work_item_id,agent_id,generation,state,deadline_at) VALUES($1,$2,$3,1,'created',now()+interval '40 seconds')",[offerId,ctx.workItem.id,ctx.data.agentId]);
      const child=await startConnectSaga(tx,{workItem:ctx.workItem,routeResult:{agentId:ctx.data.agentId,reservationId:ctx.data.reservationId,offerId,generation:1},
        agentFirst:true,outboundSagaId:ctx.saga.id,agentDialPayload:{connection_id:ctx.data.dialPayload.connection_id,webhook_url:ctx.data.dialPayload.webhook_url,webhook_url_method:ctx.data.dialPayload.webhook_url_method,from:ctx.data.dialPayload.from},
        agentUsername:agent.username,agentSipUri:`sip:${agent.telephony_user_name||agent.username.split('@')[0]}@sip.telnyx.com`,
        customerNumber:ctx.workItem.customer_address,interactionId:ctx.workItem.id});
      await patchData(tx,ctx,{agentFirst:true,connectSagaId:child.sagaId});
      return 'wait_agent';
    } },
    wait_agent: { run: async(tx,ctx)=>{
      const campaign=await liveCampaign(tx,ctx);
      if(campaign?.status!=='running'||ctx.data.cancelRequested||ctx.data.connectionFailed||!await preDialAllowed(tx,ctx,campaign)) return 'cancel_before_dial';
      const device=(await tx.query("SELECT 1 FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2 AND role='agent_device' AND answered_at IS NOT NULL AND ended_at IS NULL",[ctx.workItem.id,ctx.data.connectSagaId])).rowCount;
      return device ? 'dial_customer' : null;
    },deadlineMs:1000 },
    dial_customer: {
      guard: async (tx, ctx) => {
        const campaign=await liveCampaign(tx,ctx);
        if (campaign?.status!=='running' || ctx.data.cancelRequested || ctx.data.connectionFailed || !await preDialAllowed(tx,ctx,campaign) || (ctx.data.agentFirst && !(await tx.query("SELECT 1 FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2 AND role='agent_device' AND answered_at IS NOT NULL AND ended_at IS NULL",[ctx.workItem.id,ctx.data.connectSagaId])).rowCount)) {
          await setReason(tx,ctx,'cancelled_before_dial');
          return 'cancel_before_dial';
        }
        return null;
      },
      prepare: async (tx, ctx) => {
        await tx.query(`UPDATE outbound_attempt_ledger SET status = 'dialing', dial_state = 'dialing', metadata = metadata || jsonb_build_object('dial_started_at', now()::text) WHERE id = $1`, [ctx.data.attemptId]);
      },
      cmd: ctx => ({ operation: 'outbound_dial', endpoint: '/calls', request: ctx.data.dialPayload }),
      onAccepted: async (tx, { saga, response }) => {
        const call = response?.data || {};
        if (call.call_control_id) await bindOutboundCustomer(tx, saga, call);
      },
      on: { accepted: 'await_answer', 'leg.initiated:customer': 'await_answer', ...answeredEvents },
      deadlineMs: ctx => (Number(ctx.data.dialPayload?.timeout_secs) || 30) * 1000 + 5000,
      onDeadline: 'verify_end', onFailure: 'originate_rejected',
    },
    await_answer: { run: async(tx,ctx)=>ctx.data.agentFirst&&ctx.data.connectionFailed?'hangup':null, on: answeredEvents, deadlineMs: ctx => (Number(ctx.data.dialPayload?.timeout_secs) || 30) * 1000 + 5000, onDeadline: 'verify_end' },
    classify: { run: async (tx, ctx) => {
      const leg = await readLeg(tx, ctx.workItem.id);
      if (leg?.ended_at) return 'finish';
      const result = ctx.workItem.attributes?.outbound_amd_result;
      if (!leg?.answered_at && !result) return 'await_answer';
      if (ctx.data.amd?.enabled && !result) return 'await_amd';
      const human = !ctx.data.amd?.enabled || HUMAN_RESULTS.has(String(result).toLowerCase());
      await tx.query(`UPDATE outbound_attempt_ledger SET status = 'answered', dial_state = $2,
        metadata = metadata || jsonb_build_object('amd_result', $3::text, 'answered_at', COALESCE(metadata->>'answered_at', now()::text))
          || CASE WHEN $4::text IS NOT NULL THEN jsonb_build_object('amd_detected_at', $4::text) ELSE '{}'::jsonb END
        WHERE id = $1`, [ctx.data.attemptId, human ? 'human' : 'machine', result || 'disabled', ctx.workItem.attributes?.outbound_amd_detected_at || null]);
      if (human) { await tx.query(`UPDATE outbound_attempt_ledger SET metadata = metadata || jsonb_build_object('human_answered_at', now()::text) WHERE id = $1`, [ctx.data.attemptId]); return 'start_handler'; }
      await setReason(tx, ctx, 'answering_machine');
      const action = ctx.data.amd.voicemailAction || ctx.data.amd.machine_action;
      await transitionDialState(tx, ctx.data.attemptId, 'voicemail_action', {
        event: 'outbound.amd',
        reason: action || 'hangup',
      });
      return ['drop_message', 'leave_message'].includes(action) && (ctx.data.amd.voicemailMessage || ctx.data.amd.voicemail_message || ctx.data.amd.message) ? (ctx.workItem.attributes?.outbound_greeting_ended ? 'voicemail' : 'await_greeting') : 'hangup';
    } },
    await_amd: { run: async(tx,ctx)=>ctx.data.agentFirst&&ctx.data.connectionFailed?'hangup':null, on: { ...endEvent, 'outbound.amd:customer': 'classify', 'outbound.greeting:customer': 'classify' }, deadlineMs: amdWaitMs, onDeadline: 'amd_timeout' },
    // A person who already said hello must never be left in dead air waiting
    // for a detection result the provider may never deliver. Treat a missing
    // result exactly like 'not_sure', which this saga already routes down the
    // human path (and which ends in the unserved announcement when no agent
    // connects), and keep the timeout visible in the ledger and attributes.
    amd_timeout: { run: async (tx, ctx) => {
      await tx.query(`UPDATE acd_work_items SET attributes = attributes || jsonb_build_object(
        'outbound_amd_result', 'not_sure', 'outbound_amd_timed_out', true) WHERE id = $1`, [ctx.workItem.id]);
      await tx.query(`UPDATE outbound_attempt_ledger SET metadata = metadata ||
        jsonb_build_object('amd_timed_out', true) WHERE id = $1`, [ctx.data.attemptId]);
      await appendEvent(tx, { workItemId: ctx.workItem.id, type: 'outbound_amd_timeout', actor: 'saga:outbound_connect',
        payload: { saga_id: ctx.saga.id, attempt_id: ctx.data.attemptId, waited_ms: amdWaitMs(ctx) } });
      return 'classify';
    } },
    await_greeting: { on: { ...endEvent, 'outbound.greeting:customer': 'classify' }, deadlineMs: 35000, onDeadline: 'hangup' },
    voicemail: { cmd: ctx => ({ operation: 'outbound_voicemail', endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/speak`,
      request: voicemailSpeakRequest(ctx) }),
      on: { ...endEvent, 'outbound.speak_ended:customer': 'hangup' }, deadlineMs: 60000, onDeadline: 'hangup', onFailure: 'hangup' },
    start_handler: { run: async (tx, ctx) => {
      if(ctx.data.agentFirst) {
        if(ctx.data.connectionFailed||!await agentReady(tx,ctx,{pendingManual:true})) return 'hangup';
        await tx.query("UPDATE acd_sagas SET data=data || jsonb_build_object('customerProviderCallId',$2::text,'customerReady',true) WHERE id=$1",[ctx.data.connectSagaId,ctx.data.customerProviderCallId]);
        return 'wait_connection';
      }
      if (ctx.workItem.state !== 'open') return 'wait_connection';
      await transition(tx, ctx, 'queued');
      if (['power', 'predictive'].includes(ctx.data.mode)) {
        await openSegment(tx, { workItemId: ctx.workItem.id, kind: 'queue_wait', queueId: ctx.workItem.queue_id });
        const customerLeg = await readLeg(tx, ctx.workItem.id);
        await patchData(tx, ctx, { humanAnsweredAt: customerLeg?.answered_at || new Date().toISOString() });
        return 'wait_connection';
      }
      await transition(tx, ctx, 'offered');
      if (ctx.data.agentId) {
        if (!await agentReady(tx, ctx, { pendingManual:true })) return 'hangup';
        const agent = (await tx.query(`SELECT * FROM users WHERE id = $1`, [ctx.data.agentId])).rows[0];
        const offerId = randomUUID();
        await tx.query(`INSERT INTO acd_offers (id, work_item_id, agent_id, generation, state, deadline_at) VALUES ($1, $2, $3, 1, 'created', now() + interval '40 seconds')`, [offerId, ctx.workItem.id, ctx.data.agentId]);
        // Record the child and its owner so an abandonment here can cancel it:
        // without both, a late bridge on this path promotes work the
        // origination owner has already given up on.
        const child = await startConnectSaga(tx, { workItem: ctx.workItem, routeResult: { agentId: ctx.data.agentId, reservationId: ctx.data.reservationId, offerId, generation: 1 },
          agentUsername: agent.username, agentSipUri: `sip:${agent.telephony_user_name || agent.username.split('@')[0]}@sip.telnyx.com`,
          connectionId: agent.telephony_credentials_id, customerProviderCallId: ctx.data.customerProviderCallId,
          customerNumber: ctx.workItem.customer_address, interactionId: ctx.workItem.id,
          outboundSagaId: ctx.saga.id,
          clientState: ctx.data.dialPayload.client_state });
        await patchData(tx, ctx, { connectSagaId: child.sagaId });
        return 'wait_connection';
      }
      await transition(tx, ctx, 'active');
      await openSegment(tx, { workItemId: ctx.workItem.id, kind: ctx.data.mode === 'agentless_ai' ? 'ai_assistant' : 'flow', answeredAt: new Date().toISOString() });
      if (ctx.data.mode === 'agentless_flow') {
        await tx.query(`UPDATE acd_work_items SET attributes = attributes || jsonb_build_object('outbound_flow_start_event_id', attributes->>'outbound_last_event_id') WHERE id = $1`, [ctx.workItem.id]);
        return 'handling';
      }
      return 'start_ai';
    } },
    start_ai: { cmd: ctx => ({ operation: 'outbound_start_ai', endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/ai_assistant_start`, request: { assistant: { id: ctx.data.handlerRef } } }),
      on: { accepted: 'handling', ...endEvent }, deadlineMs: 10000, onDeadline: 'ai_unconfirmed', onFailure: 'hangup' },
    ai_unconfirmed: { run: async (tx, ctx) => { await alarm(tx, ctx, 'ai_start_unconfirmed'); return 'hangup'; } },
    wait_connection: { run: async (tx, ctx) => {
      if ((await readLeg(tx, ctx.workItem.id))?.ended_at) return 'finish';
      if(ctx.data.connectionFailed) return 'connection_timeout';
      if (ctx.workItem.state === 'active') {
        await markAttemptConnected(tx, ctx);
        return 'handling';
      }
      return null;
    }, on: endEvent, deadlineMs: ctx => ctx.data.humanWaitMs || 10000, onDeadline: 'connection_timeout' },
    connection_timeout: { run: async (tx, ctx) => {
      await tx.query(`SELECT id FROM acd_work_items WHERE id = $1 FOR UPDATE`, [ctx.workItem.id]);
      const wi = (await tx.query(`SELECT state FROM acd_work_items WHERE id = $1`, [ctx.workItem.id])).rows[0];
      if (wi.state === 'active') {
        await markAttemptConnected(tx, ctx);
        return 'handling';
      }
      // An accepted bridge command is not yet a bridged call. Abandoning here
      // would announce an unserved call into a conversation the provider is
      // still connecting, and would mark a connected attempt as abandoned.
      // Wait once, bounded, for the bridge evidence the child saga expects.
      if (!ctx.data.bridgeGraceExpired && ctx.data.connectSagaId) {
        const child = (await tx.query(
          `SELECT state, data FROM acd_sagas WHERE id = $1`, [ctx.data.connectSagaId],
        )).rows[0];
        if (child?.state === 'running' && child.data?.bridgeRequested) {
          return 'await_bridge_evidence';
        }
      }
      const reason = ctx.data.connectSagaId ? 'agent_connection_failed' : 'no_agent_available';
      if(ctx.data.connectSagaId){
        await tx.query("UPDATE acd_sagas SET data=data || '{\"cancelRequested\":true}'::jsonb WHERE id=$1",[ctx.data.connectSagaId]);
      }
      const policy = ctx.data.answeredWithoutAgentPolicy || {};
      const retryAt = new Date(Date.now() + Math.max(0, Number(policy.retry_suppression_hours || 0)) * 3600000).toISOString();
      await patchData(tx, ctx, { finishReason: reason, abandonRetryAt: retryAt });
      await tx.query(`UPDATE outbound_attempt_ledger SET dial_state = 'abandoned',
        metadata = metadata || jsonb_build_object(
          'abandoned_at', now()::text,
          'reason_code', $2::text,
          'retry_eligible', true,
          'next_retry_at', $3::text,
          'answered_without_agent_policy', $4::jsonb)
        WHERE id = $1`, [ctx.data.attemptId, reason, retryAt, JSON.stringify(policy)]);
      return policy.mode === 'immediate_hangup' ? 'hangup' : 'announce_unserved';
    } },
    // Bounded wait for the bridge the child saga already requested. The child
    // owns the promotion to `active`; this step only re-reads the outcome, so
    // an established call becomes `handling` and a failed one abandons once.
    await_bridge_evidence: {
      run: async (tx, ctx) => {
        if ((await readLeg(tx, ctx.workItem.id))?.ended_at) return 'finish';
        const wi = (await tx.query(`SELECT state FROM acd_work_items WHERE id = $1`, [ctx.workItem.id])).rows[0];
        if (wi?.state === 'active') {
          await markAttemptConnected(tx, ctx);
          return 'handling';
        }
        return null;
      },
      on: endEvent,
      deadlineMs: ctx => Number(ctx.data.bridgeGraceMs) || 5000,
      onDeadline: 'expire_bridge_grace',
    },
    expire_bridge_grace: {
      run: async (tx, ctx) => {
        await patchData(tx, ctx, { bridgeGraceExpired: true });
        return 'connection_timeout';
      },
    },
    announce_unserved: {
      prepare: async (tx, ctx) => {
        await tx.query(`UPDATE outbound_attempt_ledger SET metadata=metadata || jsonb_build_object(
          'announcement_requested_at',now()::text,
          'announcement_message',$2::text,
          'announcement_voice',$3::text,
          'announcement_language',$4::text)
          WHERE id=$1`, [ctx.data.attemptId, ctx.data.answeredWithoutAgentPolicy?.announcement_message,
          ctx.data.answeredWithoutAgentPolicy?.announcement_voice,
          ctx.data.answeredWithoutAgentPolicy?.announcement_language]);
      },
      cmd: ctx => ({ operation: 'outbound_abandon_announcement',
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/speak`,
        request: {
          payload: ctx.data.answeredWithoutAgentPolicy?.announcement_message,
          voice: ctx.data.answeredWithoutAgentPolicy?.announcement_voice,
          language: ctx.data.answeredWithoutAgentPolicy?.announcement_language,
          target_legs: 'self',
        } }),
      on: { accepted: 'await_abandon_announcement', ...endEvent,
        'outbound.speak_started:customer': 'abandon_announcement_playing',
        'outbound.speak_ended:customer': 'hangup' },
      onEvent: async (tx, { saga, name }) => {
        if (name === 'outbound.speak_started') await tx.query(`UPDATE outbound_attempt_ledger SET metadata=metadata || jsonb_build_object('announcement_started_at',now()::text) WHERE id=$1`,[saga.data.attemptId]);
        if (name === 'outbound.speak_ended') await tx.query(`UPDATE outbound_attempt_ledger SET metadata=metadata || jsonb_build_object('announcement_ended_at',now()::text) WHERE id=$1`,[saga.data.attemptId]);
      },
      deadlineMs: ctx => Number(ctx.data.answeredWithoutAgentPolicy?.announcement_start_deadline_ms || 500),
      onDeadline: 'hangup', onFailure: 'hangup',
    },
    await_abandon_announcement: {
      on: { ...endEvent, 'outbound.speak_started:customer': 'abandon_announcement_playing', 'outbound.speak_ended:customer': 'hangup' },
      onEvent: async (tx, { saga, name }) => {
        await tx.query(`UPDATE outbound_attempt_ledger SET metadata=metadata || jsonb_build_object($2::text,now()::text) WHERE id=$1`,
          [saga.data.attemptId, name === 'outbound.speak_ended' ? 'announcement_ended_at' : 'announcement_started_at']);
      },
      deadlineMs: ctx => Number(ctx.data.answeredWithoutAgentPolicy?.announcement_start_deadline_ms || 500),
      onDeadline: 'hangup',
    },
    abandon_announcement_playing: {
      on: { ...endEvent, 'outbound.speak_ended:customer': 'hangup' },
      onEvent: async (tx, { saga }) => {
        await tx.query(`UPDATE outbound_attempt_ledger SET metadata=metadata || jsonb_build_object('announcement_ended_at',now()::text) WHERE id=$1`,[saga.data.attemptId]);
      },
      deadlineMs: ctx => Math.max(1000, Number(ctx.data.answeredWithoutAgentPolicy?.max_announcement_seconds || 8) * 1000),
      onDeadline: 'hangup',
    },
    handling: { on: endEvent, deadlineMs: 3600000, onDeadline: 'verify_handling' },
    verify_handling: { run: async (tx, ctx) => {
      if ((await readLeg(tx, ctx.workItem.id))?.ended_at) return 'finish';
      await alarm(tx, ctx, 'long_call_requires_end_evidence'); return 'handling';
    } },
    verify_end: { run: async (tx, ctx) => {
      const leg = await readLeg(tx, ctx.workItem.id);
      if (leg?.ended_at) return 'finish';
      if (leg) return 'hangup';
      await alarm(tx, ctx, 'origination_outcome_unknown'); return 'await_evidence';
    } },
    await_evidence: { on: { ...answeredEvents, 'leg.initiated:customer': 'verify_end' }, deadlineMs: 60000, onDeadline: 'verify_end' },
    hangup: {
      prepare: async (tx, ctx) => {
        if (['no_agent_available','agent_connection_failed'].includes(ctx.data.finishReason)) {
          await tx.query(`UPDATE outbound_attempt_ledger SET metadata=metadata || jsonb_build_object('hangup_requested_at',now()::text) WHERE id=$1`,[ctx.data.attemptId]);
        }
      },
      cmd: ctx => ({ operation: 'outbound_hangup', endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/hangup`, request: {} }),
      on: { accepted: 'await_end', ...endEvent }, deadlineMs: 10000, onDeadline: 'await_end', onFailure: 'await_end' },
    await_end: { run: async (tx, ctx) => {
      if ((await readLeg(tx, ctx.workItem.id))?.ended_at) return 'finish';
      return null;
    }, on: endEvent, deadlineMs: 60000, onDeadline: 'end_unconfirmed' },
    end_unconfirmed: { run: async (tx, ctx) => { await alarm(tx, ctx, 'hangup_end_unconfirmed'); return 'await_end'; } },
    originate_rejected: { run: async (tx, ctx) => {
      if (await readLeg(tx, ctx.workItem.id)) return 'verify_end';
      const campaign=await liveCampaign(tx,ctx);
      const delayHours=Math.max(1/60,Number(campaign?.retry_policy?.minDelayHours) || 6);
      await completeAttemptClaim(tx,ctx.data.attemptId,'failed',{failure_reason:'provider_rejected',next_retry_at:new Date(Date.now()+delayHours*3600000).toISOString()});
      await setReason(tx, ctx, 'provider_rejected'); return 'cancel_before_dial';
    } },
    cancel_before_dial: { run: async (tx, ctx) => {
      const uncertain = await tx.query(`SELECT 1 FROM acd_commands WHERE saga_id = $1 AND operation = 'outbound_dial' AND status <> 'failed'`, [ctx.saga.id]);
      if (uncertain.rowCount) return 'verify_end';
      if(ctx.data.connectSagaId) await tx.query("UPDATE acd_sagas SET data=data || '{\"cancelRequested\":true}'::jsonb WHERE id=$1",[ctx.data.connectSagaId]);
      if (ctx.data.reservationId) await releaseReservation(tx, ctx.data.reservationId, 'outbound_not_started');
      await releaseOutboundLine(tx, ctx.data.attemptId, 'no_provider_command');
      await tx.query(`UPDATE outbound_attempt_ledger SET status = CASE WHEN status = 'claimed' OR status = 'dialing' THEN 'cancelled' ELSE status END,
        dial_state = CASE WHEN status IN ('claimed','dialing') THEN 'cancelled' WHEN status='failed' THEN 'failed' WHEN status IN ('skipped','suppressed') THEN status ELSE dial_state END,
        lease_expires_at = NULL, metadata = metadata || jsonb_build_object('cancel_reason', $2::text) WHERE id = $1`, [ctx.data.attemptId, ctx.data.finishReason || 'campaign_not_running']);
      if(ctx.data.blendingDeferred) {
        await tx.query(`UPDATE outbound_attempt_ledger SET metadata=metadata || jsonb_build_object('blending_deferred',true,'cancel_reason',$2::text,'reason_code',$2::text) WHERE id=$1`,[ctx.data.attemptId,ctx.data.blendingReason||'inbound_priority']);
        // A yield before Dial is not a contact attempt. Restore the record's
        // ordering timestamp from the latest real telephone attempt so a
        // deferred first record stays ahead of untouched later records.
        await tx.query(`UPDATE outbound_contact_records r SET last_attempt_at=(
          SELECT max(a.created_at) FROM outbound_attempt_ledger a
          WHERE a.campaign_id=$2 AND a.contact_record_id=r.id AND a.id<>$1
            AND COALESCE(a.metadata->>'blending_deferred','false')<>'true'
            AND (a.call_control_id IS NOT NULL OR a.metadata ? 'dial_started_at')
        ),updated_at=now()
        WHERE r.id=(SELECT contact_record_id FROM outbound_attempt_ledger WHERE id=$1)`,[ctx.data.attemptId,ctx.data.campaignId]);
        await appendEvent(tx,{workItemId:ctx.workItem.id,type:'outbound_deferred_for_inbound',actor:'saga:outbound_connect',payload:{attempt_id:ctx.data.attemptId,reason:ctx.data.blendingReason}});
      }
      await transition(tx, ctx, 'failed');
      return 'cancelled';
    } },
    await_assignment_cleanup: {
      run: async (tx, ctx) => {
        const assignment = await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id = $1
          AND type = 'connect' AND state IN ('running', 'compensating')`, [ctx.workItem.id]);
        return assignment.rowCount ? null : 'finish';
      },
      deadlineMs: 1000,
      onDeadline: 'finish',
    },
    finish: { run: async (tx, ctx) => {
      const leg = await readLeg(tx, ctx.workItem.id);
      if (!leg?.ended_at) return 'verify_end';
      // The assignment saga finalizes the agent segment independently. The
      // origination owner releases only its own pre-connect reservation.
      if (ctx.data.reservationId) {
        const owned = await tx.query(`SELECT 1 FROM acd_reservations WHERE id = $1 AND owner_saga_id = $2`, [ctx.data.reservationId, ctx.saga.id]);
        if (owned.rowCount) await releaseReservation(tx, ctx.data.reservationId, 'outbound_customer_ended');
      }
      await releaseOutboundLine(tx, ctx.data.attemptId, 'customer_leg_ended');
      await finalizeAgentlessAttemptByWebhook(tx, { callControlId: leg.provider_call_id, eventType: 'call.hangup', hangupCause: leg.ended_reason });
      if (['no_agent_available','agent_connection_failed'].includes(ctx.data.finishReason)) {
        await tx.query(`UPDATE outbound_attempt_ledger SET dial_state='abandoned',
          metadata=metadata || jsonb_build_object(
            'reason_code',$2::text,
            'retry_eligible',true,
            'next_retry_at',$3::text,
            'answered_without_agent_policy',$4::jsonb)
          WHERE id=$1`, [ctx.data.attemptId, ctx.data.finishReason, ctx.data.abandonRetryAt,
          JSON.stringify(ctx.data.answeredWithoutAgentPolicy || {})]);
      }
      if (!isTerminalState(ctx.workItem.state)) {
        // Once a bridge made the work active, the assignment saga owns the
        // agent leg, segment and wrap-up lifecycle. Before a bridge, however,
        // the customer hangup and assignment cancellation can be delivered in
        // either order. Keep this saga alive until the child has released its
        // offer so the otherwise orphaned offered work can become terminal.
        const assignment = await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id = $1 AND type = 'connect' AND state IN ('running', 'compensating')`, [ctx.workItem.id]);
        if (assignment.rowCount) {
          if (ctx.workItem.state !== 'active') return 'await_assignment_cleanup';
        } else {
          await closeOpenSegment(tx, ctx.workItem.id, { outcome: 'completed' });
          await transition(tx, ctx, ctx.workItem.state === 'active' ? 'completed' : 'abandoned');
        }
      }
      // Agentless handlers never enter a human agent's connected/wrap-up
      // chain. Once their answered segment has ended, finalize their dial
      // state directly; the generic hangup mapping cannot leave `human`.
      if (['agentless_ai', 'agentless_flow'].includes(ctx.data.mode)) {
        await tx.query(`UPDATE outbound_attempt_ledger AS attempt
          SET dial_state = 'disposed', updated_at = now(),
              metadata = metadata || jsonb_build_object('dial_state_history',
                COALESCE(metadata->'dial_state_history', '[]'::jsonb) ||
                jsonb_build_array(jsonb_build_object('to', 'disposed', 'at', now()::text,
                  'event', 'call.hangup', 'reason', 'agentless_handler_ended')))
          WHERE attempt.id = $1 AND attempt.status = 'completed'
            AND attempt.dial_state IN ('human', 'connecting', 'connected', 'wrapup')
            AND EXISTS (SELECT 1 FROM acd_segments segment
              WHERE segment.work_item_id = $2 AND segment.kind IN ('ai_assistant', 'flow')
                AND segment.answered_at IS NOT NULL AND segment.ended_at IS NOT NULL)`,
        [ctx.data.attemptId, ctx.workItem.id]);
      }
      return 'succeeded';
    } },
  },
});

export async function bindOutboundCustomer(tx, saga, payload) {
  await tx.query(`INSERT INTO acd_legs (id, work_item_id, role, provider_call_id, provider_session_id, owner_saga_id, state)
    VALUES ($1, $2, 'customer', $3, $4, $5, 'ringing') ON CONFLICT (provider_call_id) DO NOTHING`,
    [randomUUID(), saga.work_item_id, payload.call_control_id, payload.call_session_id || null, saga.id]);
  await tx.query(`UPDATE acd_sagas SET data = data || jsonb_build_object('customerProviderCallId', $2::text) WHERE id = $1`, [saga.id, payload.call_control_id]);
  await tx.query(`UPDATE acd_work_items SET provider_session_id = COALESCE(provider_session_id, $2),
    attributes = attributes || jsonb_build_object('customer_call_control_id', $3::text) WHERE id = $1`, [saga.work_item_id, payload.call_session_id || null, payload.call_control_id]);
  await tx.query(`UPDATE outbound_attempt_ledger SET call_control_id = $2, call_session_id = COALESCE(call_session_id, $3) WHERE id = $1`, [saga.data.attemptId, payload.call_control_id, payload.call_session_id || null]);
}

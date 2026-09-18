import { createHmac, timingSafeEqual } from 'node:crypto';

export const GENERATOR_INBOUND_HEADER = 'X-CC-Generator-Identity';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (body, key) => createHmac('sha256', key).update('cc-generator-inbound:' + body).digest();

// client_state belongs to the originating API leg. SIP creates another
// session at the receiving flow, so carry a signed identity in its INVITE.
export function generatorInboundHeaders(
  { runId, ledgerId, flowId, directAgentId = null },
  key = process.env.TELNYX_API_KEY,
) {
  if (!key) throw new Error('Generator signing key is unavailable');
  if (directAgentId != null && !uuid.test(String(directAgentId))) {
    throw new Error('Direct generator agent id must be a UUID');
  }
  const body = Buffer.from(JSON.stringify({
    v: 1,
    runId,
    ledgerId,
    flowId,
    ...(directAgentId ? { directAgentId: String(directAgentId) } : {}),
  })).toString('base64url');
  return [{ name: GENERATOR_INBOUND_HEADER, value: `${body}.${digest(body, key).toString('base64url')}` }];
}

export function parseGeneratorInboundIdentity(headers, key = process.env.TELNYX_API_KEY) {
  if (!key || !Array.isArray(headers)) return null;
  const matches = headers.filter(h => String(h?.name).toLowerCase() === GENERATOR_INBOUND_HEADER.toLowerCase());
  if (matches.length !== 1 || typeof matches[0].value !== 'string' || matches[0].value.length > 2048) return null;
  try {
    const [body, signature, extra] = matches[0].value.split('.');
    if (!body || !signature || extra !== undefined) return null;
    const actual = Buffer.from(signature, 'base64url'), expected = digest(body, key);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const identity = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      identity.v !== 1 ||
      ![identity.runId, identity.ledgerId, identity.flowId].every(id => uuid.test(id)) ||
      (identity.directAgentId != null && !uuid.test(String(identity.directAgentId)))
    ) return null;
    return identity;
  } catch { return null; }
}

// Only a verified webhook may call this. Validate the caller and destination
// against the persisted attempt, and bind once before the flow changes state.
export async function bindGeneratedInbound(db, payload, flowId, key = process.env.TELNYX_API_KEY) {
  const identity = parseGeneratorInboundIdentity(payload.custom_headers, key);
  if (!identity || identity.flowId !== flowId || payload.direction !== 'incoming' || !payload.call_control_id) return null;
  const bound = await db.query(`UPDATE cg_call_ledger SET result = COALESCE(result, '{}'::jsonb) ||
      jsonb_build_object('inbound_call_control_id', $5::text, 'inbound_call_session_id', $6::text)
    WHERE id=$1 AND run_id=$2 AND result->>'flow_id'=$3 AND from_number=$4
      AND COALESCE(result->>'direct_agent_id', '') = COALESCE($7::text, '')
      AND dial_requested_at IS NOT NULL
      AND (media_ended_at IS NULL OR result->>'inbound_call_control_id'=$5)
      AND (result->>'inbound_call_control_id' IS NULL OR result->>'inbound_call_control_id'=$5)
    RETURNING id`, [identity.ledgerId, identity.runId, flowId, payload.from, payload.call_control_id, payload.call_session_id || null, identity.directAgentId || null]);
  if (!bound.rowCount) return null;
  return Buffer.from(JSON.stringify({
    callGenerator: true,
    runId: identity.runId,
    ledgerId: identity.ledgerId,
    ...(identity.directAgentId ? { directAgentId: identity.directAgentId } : {}),
  })).toString('base64');
}

// Telnyx SIP transfer exposes separate transport and WebRTC device legs.
// The transport receives call.bridged; the device receives call.answered.
// Keep their raw webhook states intact and derive media connectivity only
// from the exact, generation-fenced intent linking those two provider legs.
export function agentBridgeEvidence(legs, intents, agentId, { live = false } = {}) {
  const available = leg => !live || !leg.ended_at;
  for (const device of legs) {
    if (device.agent_id !== agentId || !['agent_device', 'consult_target', 'transfer_target'].includes(device.role) || !available(device)) continue;
    if (device.bridged_at) return { source: 'device_bridge', deviceLegId: device.id, bridgeLegId: device.id };
    if (device.role !== 'agent_device' || !device.answered_at || !device.owner_saga_id || device.offer_generation == null) continue;
    const intent = intents.find(i => i.bound_leg_id === device.id && i.work_item_id === device.work_item_id
      && i.agent_id === agentId && String(i.offer_generation) === String(device.offer_generation));
    if (!intent?.transport_call_id) continue;
    const transport = legs.find(l => l.provider_call_id === intent.transport_call_id && l.role === 'agent_transport'
      && l.work_item_id === device.work_item_id && l.owner_saga_id === device.owner_saga_id
      && String(l.offer_generation) === String(device.offer_generation) && available(l));
    const customer = legs.find(l => l.role === 'customer' && l.work_item_id === device.work_item_id && l.bridged_at && available(l));
    if (transport?.bridged_at && customer && (!customer.bridged_peer_call_id || customer.bridged_peer_call_id === transport.provider_call_id)) return { source: 'answered_device_on_bridged_transport', deviceLegId: device.id,
      bridgeLegId: transport.id, customerLegId: customer.id, intentId: intent.id };
    // Either side's original bridge notification names the exact peer. The
    // customer's signed event can therefore prove the same pair even if the
    // transport's duplicate notification is lost. Never set transport state
    // or accept a bare answer/active flag as a substitute for that evidence.
    if (transport && customer?.bridged_event_id && customer.bridged_peer_call_id === transport.provider_call_id) {
      return { source: 'customer_bridge_peer', deviceLegId: device.id, bridgeLegId: transport.id,
        customerLegId: customer.id, intentId: intent.id, eventId: customer.bridged_event_id };
    }
  }
  return null;
}

export async function loadVoiceBridgeTopology(db, workItemId) {
  const [legs, intents] = await Promise.all([
    db.query('SELECT * FROM acd_legs WHERE work_item_id=$1 ORDER BY created_at', [workItemId]),
    db.query('SELECT * FROM acd_leg_intents WHERE work_item_id=$1', [workItemId]),
  ]);
  return { legs: legs.rows, intents: intents.rows };
}

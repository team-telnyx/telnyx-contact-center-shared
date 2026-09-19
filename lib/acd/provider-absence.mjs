// Read-only fallback for a cancelled transfer whose device never bound.
// Empty complete inventories are deliberately required; unrelated active calls
// delay this exceptional cleanup rather than weakening media-end evidence.
export async function verifyProviderAbsence(request, get) {
  const {customerCallId,sourceConnectionId,credentialId}=request;
  if(!customerCallId||!/^\d+$/.test(sourceConnectionId||'')||!credentialId)throw Error('Missing provider reconciliation identity');
  const customer=await get(`/calls/${encodeURIComponent(customerCallId)}`);
  if(customer.data?.is_alive!==false)return {ended:false};
  const credential=await get(`/telephony_credentials/${encodeURIComponent(credentialId)}`);
  const targetConnectionId=/^connection:(\d+)$/.exec(credential.data?.resource_id||'')?.[1];
  if(!targetConnectionId)throw Error('Credential connection is unknown');
  const connections=[];
  for(const id of [...new Set([sourceConnectionId,targetConnectionId])]){
    const result=await get(`/connections/${encodeURIComponent(id)}/active_calls`);
    if(!Array.isArray(result.data)||result.data.length||result.meta?.next||result.meta?.cursors?.after||result.meta?.total_items!==0)return {ended:false};
    connections.push({connectionId:id,activeCalls:0});
  }
  // Recheck the parent after both inventories. No mutating provider request is
  // made, and a partial/failed read can never produce an end confirmation.
  if((await get(`/calls/${encodeURIComponent(customerCallId)}`)).data?.is_alive!==false)return {ended:false};
  return {ended:true,customerCallId,sourceConnectionId,targetConnectionId,credentialId,connections,checkedAt:new Date().toISOString()};
}

// A direct call has no parent leg to inspect, so the only admissible proof is a
// complete and empty active-call inventory on the connection that backs the
// agent's own credential. Any pagination hint, non-array body or unrelated
// active call withholds the confirmation: absence must be proven, never
// assumed from a browser that stopped reporting.
export async function verifyAgentConnectionIdle(request, get) {
  const { credentialId } = request || {};
  if (!credentialId) throw Error('Missing agent credential identity');
  const credential = await get(`/telephony_credentials/${encodeURIComponent(credentialId)}`);
  const connectionId = /^connection:(\d+)$/.exec(credential.data?.resource_id || '')?.[1];
  if (!connectionId) throw Error('Credential connection is unknown');
  const result = await get(`/connections/${encodeURIComponent(connectionId)}/active_calls`);
  if (!Array.isArray(result.data) || result.data.length || result.meta?.next
    || result.meta?.cursors?.after || result.meta?.total_items !== 0) {
    return { ended: false };
  }
  return { ended: true, credentialId, connectionId, activeCalls: 0, checkedAt: new Date().toISOString() };
}

// A successful hangup command is only an acknowledgement that Telnyx accepted
// the request. When its terminal webhook is lost, reconcile the exact call
// rather than either trusting the command response or expiring capacity by
// age. Only an explicit boolean `is_alive: false` is end evidence; malformed
// and partial responses preserve the reservation.
export async function verifyProviderCallEnded(request, get) {
  const callControlId = typeof request?.callControlId === "string"
    ? request.callControlId.trim()
    : "";
  if (!callControlId) throw Error("Missing provider call identity");
  const response = await get(`/calls/${encodeURIComponent(callControlId)}`);
  const isAlive = response?.data?.is_alive;
  return {
    ended: isAlive === false,
    conclusive: typeof isAlive === "boolean",
    callControlId,
    isAlive: typeof isAlive === "boolean" ? isAlive : null,
    checkedAt: new Date().toISOString(),
  };
}

// A successful Bridge command is still asynchronous. When its call.bridged
// webhook is missing, inspect the three exact calls involved before choosing
// between completing the transfer and restoring the source conversation.
// This is deliberately narrower than an active-call inventory: the accepted
// command plus two surviving parties and an ended source-agent leg is the
// provider-side signature of a completed consult handoff.
export async function verifyConsultCompletion(request, get) {
  const callIds = {
    customer: request?.customerCallId,
    target: request?.targetCallId,
    agent: request?.agentCallId,
  };
  if (Object.values(callIds).some((value) => !value)) {
    throw Error("Missing consult completion identity");
  }

  const entries = await Promise.all(
    Object.entries(callIds).map(async ([role, callControlId]) => {
      const response = await get(`/calls/${encodeURIComponent(callControlId)}`);
      const isAlive = response?.data?.is_alive;
      return [role, {
        callControlId,
        isAlive: typeof isAlive === "boolean" ? isAlive : null,
      }];
    }),
  );
  const calls = Object.fromEntries(entries);
  const conclusive = Object.values(calls).every(
    ({ isAlive }) => typeof isAlive === "boolean",
  );
  const transferred = conclusive &&
    calls.customer.isAlive === true &&
    calls.target.isAlive === true &&
    calls.agent.isAlive === false;
  const allEnded = conclusive &&
    Object.values(calls).every(({ isAlive }) => isAlive === false);

  return {
    conclusive,
    transferred,
    allEnded,
    calls,
    checkedAt: new Date().toISOString(),
  };
}

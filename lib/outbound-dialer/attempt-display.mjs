const words = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());

const MESSAGE_LABELS = { pending: 'Claimed — preparing message', rendered: 'Rendered', queued: 'Queued for sending', sending: 'Sending to Telnyx', accepted: 'Accepted by Telnyx', sent: 'Handed to carrier',
  delivered: 'Delivered', read: 'Read', replied: 'Customer replied', throttled: 'Throttled — retry scheduled', failed_transient: 'Failed — retry scheduled', failed_permanent: 'Failed', undeliverable: 'Undeliverable',
  suppressed: 'Suppressed', skipped: 'Skipped', unconfirmed: 'Unconfirmed delivery', cancelled: 'Cancelled' };

function messageAttemptDisplay(attempt = {}) {
  return {
    label: MESSAGE_LABELS[attempt.message_state] || words(attempt.message_state) || 'Pending',
    to: attempt.to_address || attempt.to_number || 'Not available',
    toIsCandidate: false,
    from: attempt.sender_address || attempt.from_number || 'Selected when sending starts',
    reason: words(attempt.suppression_reason || attempt.failure_reason || attempt.skip_reason || attempt.reason_code) || 'No issue reported',
    text: attempt.rendered_text || null,
  };
}

export function attemptDisplay(attempt = {}) {
  if (attempt.message_state) return messageAttemptDisplay(attempt);
  const state = attempt.dial_state || attempt.status;
  const terminal = ['completed', 'failed', 'cancelled', 'suppressed', 'skipped'].includes(attempt.status);
  let label = words(terminal ? attempt.status : state);
  if (attempt.status === 'cancelled' && ['inbound_priority','inbound_reserve'].includes(attempt.reason_code)) label = 'Deferred — inbound protection';
  else if (state === 'disposed' && attempt.status === 'completed') label = 'Completed — disposition saved';
  else if (state === 'wrapup' && attempt.status === 'completed') label = 'Call ended — awaiting disposition';
  else if (!terminal && attempt.status === 'claimed') label = attempt.auto_dial_at
    ? 'Assigned — automatic dialing pending' : 'Assigned — waiting for agent';
  else if (!terminal) label = ({ connected: 'Connected to agent', answered: 'Customer answered', dialing: 'Dialing customer', ringing: 'Customer ringing', wrapup: 'After-call work', amd_pending: 'Detecting human or machine' })[state] || label;
  const methods = attempt.contact_methods || {};
  const row = attempt.contact_row_data || {};
  const candidate = [...Object.values(methods.number || {}), ...Object.values(methods.voice || {}), row.phone_number, row.phone, row.mobile, row.msisdn, row.tel]
    .find(v => typeof v === 'string' && v.trim());
  return {
    label: label || 'Pending',
    to: attempt.to_number || candidate || 'Not available',
    toIsCandidate: !attempt.to_number && Boolean(candidate),
    from: attempt.from_number || 'Selected when dialing starts',
    reason: words(attempt.suppression_reason || attempt.failure_reason || attempt.skip_reason || attempt.reason_code) || 'No issue reported',
  };
}

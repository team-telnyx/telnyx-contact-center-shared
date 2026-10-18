import { sourceText } from "../i18n/source-text.mjs";
import { operationalStatusLabel } from "../i18n/interaction-labels.mjs";
const words = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());

const MESSAGE_LABELS = { pending: 'Claimed — preparing message', rendered: 'Rendered', queued: 'Queued for sending', sending: 'Sending to Telnyx', accepted: 'Accepted by Telnyx', sent: 'Handed to carrier',
  delivered: 'Delivered', read: 'Read', replied: 'Customer replied', throttled: 'Throttled — retry scheduled', failed_transient: 'Failed — retry scheduled', failed_permanent: 'Failed', undeliverable: 'Undeliverable',
  suppressed: 'Suppressed', skipped: 'Skipped', unconfirmed: 'Unconfirmed delivery', cancelled: 'Cancelled' };

function messageAttemptDisplay(attempt = {}, tUi = sourceText) {
  return {
    label: (MESSAGE_LABELS[attempt.message_state] ? tUi(MESSAGE_LABELS[attempt.message_state]) : words(attempt.message_state)) || tUi("Pending"),
    to: attempt.to_address || attempt.to_number || tUi("Not available"),
    toIsCandidate: false,
    from: attempt.sender_address || attempt.from_number || tUi("Selected when sending starts"),
    reason: words(attempt.suppression_reason || attempt.failure_reason || attempt.skip_reason || attempt.reason_code) || tUi("No issue reported"),
    text: attempt.rendered_text || null,
  };
}

export function attemptDisplay(attempt = {}, tUi = sourceText) {
  if (attempt.message_state) return messageAttemptDisplay(attempt, tUi);
  const state = attempt.dial_state || attempt.status;
  const terminal = ['completed', 'failed', 'cancelled', 'suppressed', 'skipped'].includes(attempt.status);
  const status = terminal ? attempt.status : state;
  let label = operationalStatusLabel(tUi, status) || words(status);
  if (attempt.status === 'cancelled' && ['inbound_priority','inbound_reserve'].includes(attempt.reason_code)) label = tUi("Deferred — inbound protection");
  else if (state === 'disposed' && attempt.status === 'completed') label = tUi("Completed — disposition saved");
  else if (state === 'wrapup' && attempt.status === 'completed') label = tUi("Call ended — awaiting disposition");
  else if (!terminal && attempt.status === 'claimed') label = attempt.auto_dial_at
    ? tUi("Assigned — automatic dialing pending") : tUi("Assigned — waiting for agent");
  else if (!terminal) label = ({ connected: tUi("Connected to agent"), answered: tUi("Customer answered"), dialing: tUi("Dialing customer"), ringing: tUi("Customer ringing"), wrapup: tUi("After-call work"), amd_pending: tUi("Detecting human or machine") })[state] || label;
  const methods = attempt.contact_methods || {};
  const row = attempt.contact_row_data || {};
  const candidate = [...Object.values(methods.number || {}), ...Object.values(methods.voice || {}), row.phone_number, row.phone, row.mobile, row.msisdn, row.tel]
    .find(v => typeof v === 'string' && v.trim());
  return {
    label: label || tUi("Pending"),
    to: attempt.to_number || candidate || tUi("Not available"),
    toIsCandidate: !attempt.to_number && Boolean(candidate),
    from: attempt.from_number || tUi("Selected when dialing starts"),
    reason: words(attempt.suppression_reason || attempt.failure_reason || attempt.skip_reason || attempt.reason_code) || tUi("No issue reported"),
  };
}

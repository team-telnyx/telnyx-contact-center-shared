const failures = new Set(['failed', 'bounced', 'expired', 'gw_reject', 'injection_timeout']);
const definitions = {
  received: ['Received', 'neutral'], draft: ['Draft', 'warning'],
  queued: ['Queued', 'info'], scheduled: ['Scheduled', 'info'], sending: ['Sending', 'info'],
  accepted: ['Sent', 'success'], sent: ['Sent', 'success'], delivered: ['Delivered', 'success'],
  failed: ['Failed', 'danger'], bounced: ['Bounced', 'danger'], expired: ['Expired', 'danger'],
  gw_reject: ['Rejected', 'danger'], injection_timeout: ['Failed', 'danger'],
  partial_failure: ['Partially failed', 'warning'], deferred: ['Deferred', 'warning'],
  ambiguous: ['Unconfirmed', 'warning'], suppressed: ['Suppressed', 'warning'],
  cancelled: ['Cancelled', 'neutral'], sandbox: ['Sandbox', 'neutral'],
};

export function emailMessageStatus(message) {
  let status = message.status || (message.sender_role === 'customer' ? 'received' : 'queued');
  const deliveries = message.deliveries || [];
  if (['accepted', 'sent', 'delivered'].includes(status) && deliveries.length) {
    const allKnown = message.recipient_count > 0 && deliveries.length >= message.recipient_count;
    const failed = deliveries.filter(d => failures.has(d.status)).length;
    if (failed) status = allKnown && failed === deliveries.length ? 'failed' : 'partial_failure';
    else if (allKnown && deliveries.every(d => d.status === 'delivered')) status = 'delivered';
    else if (deliveries.some(d => d.status === 'deferred')) status = 'deferred';
    else if (allKnown && deliveries.every(d => d.status === 'suppressed')) status = 'suppressed';
    else if (allKnown && deliveries.every(d => d.status === 'sandbox')) status = 'sandbox';
  }
  const [label, tone] = definitions[status] || [status.replaceAll('_', ' '), 'neutral'];
  const title = status === 'accepted' ? 'Accepted by Telnyx. Recipient delivery is shown separately.'
    : status === 'draft' ? 'Unsent reply, updated as the agent saves changes.' : label;
  return { status, label, tone, title };
}

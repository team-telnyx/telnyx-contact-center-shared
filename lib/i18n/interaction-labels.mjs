// Canonical API states stay unchanged; only registered application labels translate.
export const INTERACTION_STATE_LABELS = Object.freeze({
  open: 'Open', initiated: 'Initiated', in_flow: 'In flow', queued: 'Queued',
  offered: 'Offered', ringing: 'Ringing', dialing: 'Dialing', active: 'Active',
  connected: 'Connected', answered: 'Answered', bridged: 'Bridged',
  held: 'On Hold', parked: 'Parked', wrapup: 'Wrap-up', transferred: 'Transferred',
  completed: 'Completed', abandoned: 'Abandoned', failed: 'Failed', unknown: 'Unknown',
  waiting: 'Waiting', closed: 'Closed', cancelled: 'Cancelled', rejected: 'Rejected',
});
export function interactionStateLabel(t, value) {
  return Object.hasOwn(INTERACTION_STATE_LABELS, value) ? t(INTERACTION_STATE_LABELS[value]) : value;
}
export const OPERATIONAL_STATUS_LABELS = Object.freeze({
  ...INTERACTION_STATE_LABELS,
  draft: 'Draft', published: 'Published', archived: 'Archived', inactive: 'Inactive',
  pending: 'Pending', pending_agent: 'Waiting for agent', pending_queue: 'Waiting for queue',
  processing: 'Processing', processed: 'Processed', sent: 'Sent', sending: 'Sending',
  delivered: 'Delivered', received: 'Received', read: 'Read', unread: 'Unread',
  scheduled: 'Scheduled', running: 'Running', paused: 'Paused', stopped: 'Stopped',
  stopping: 'Stopping', starting: 'Starting', finished: 'Finished', success: 'Success',
  succeeded: 'Succeeded', error: 'Error', timeout: 'Timeout', expired: 'Expired',
  skipped: 'Skipped', ready: 'Ready', disabled: 'Disabled', enabled: 'Enabled',
  inbound: 'Inbound', outbound: 'Outbound', internal: 'Internal',
  preview: 'Preview', progressive: 'Progressive', power: 'Power', predictive: 'Predictive',
  broadcast: 'Broadcast', design: 'Design', pausing: 'Pausing',
  all: 'All', none: 'None', continuous: 'Continuous', random: 'Random',
  round_robin: 'Round robin', fifo: 'FIFO', skill_based: 'Skill-based', priority_based: 'Priority-based',
  not_attempted: 'Not attempted', unattempted: 'Not attempted', retry: 'Retry',
  waiting_retry: 'Waiting for retry', waiting_agent: 'Waiting for agent',
  suppressed: 'Suppressed', eligible: 'Eligible', ineligible: 'Ineligible', exhausted: 'Exhausted',
  approved: 'Approved', rejected: 'Rejected', verified: 'Verified', unverified: 'Unverified',
  submitted: 'Submitted', reviewing: 'Under review', failed_delivery: 'Delivery failed',
  read_only: 'Read only', marketing: 'Marketing', utility: 'Utility', authentication: 'Authentication',
  phone: 'Phone', phone_or_email: 'Phone or email',
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', campaign: 'Campaign', lifetime: 'Lifetime',
  work: 'Work', home: 'Home', mobile: 'Mobile', cell: 'Cell', landline: 'Landline', daytime: 'Daytime', evening: 'Evening',
  busy: 'Busy', no_answer: 'No answer', answering_machine: 'Answering machine', fax: 'Fax', system_error: 'System error',
  claimed: 'Claimed', recycled: 'Recycled', online: 'Online', offline: 'Offline', idle: 'Idle',
  enqueued: 'Queued', bridging: 'Connecting', hangup: 'Ended', positive: 'Positive', neutral: 'Neutral', negative: 'Negative',
  voice: 'Voice', chat: 'Chat', email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', video: 'Video',
  disconnected: 'Disconnected', live: 'Live', green: 'Green', yellow: 'Yellow', red: 'Red', text: 'Text', template: 'Template', image: 'Image', document: 'Document', audio: 'Audio', location: 'Location', contacts: 'Contacts', sticker: 'Sticker', interactive: 'Interactive',
  phone_call: 'Phone call', sms_chat: 'SMS', low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
  in_progress: 'In progress', on_hold: 'On Hold', resolved: 'Resolved', done: 'Done',
});
export function operationalStatusLabel(t, value) {
  const key = typeof value === 'string' ? value.toLowerCase() : value;
  return Object.hasOwn(OPERATIONAL_STATUS_LABELS, key) ? t(OPERATIONAL_STATUS_LABELS[key]) : value;
}

// Shipped template for the "Sales" queue seeded automatically on every fresh
// deployment (local docker AND cloud/AWS — see lib/seed-default-queue.mjs).
// Companion to lib/default-call-flow-template.mjs's Default Call Flow, whose
// `enqueue` node targets this queue by NAME (see that file's header comment
// for why the relationship is a plain string match, not a foreign key).
//
// Exported verbatim (minus id/timestamps) from a live, hand-edited instance
// so a fresh deployment gets the exact same queue configuration — including
// its queue-hold audio (queue_audio_media_name: "spring_field", one of the
// three media files seeded into the target Telnyx account by
// deploy/cli/lib/telnyx-media.mjs during Telnyx provisioning; see that
// module's header for the media_name <-> uploaded-file relationship).
export const SEEDED_DEFAULT_QUEUE_TEMPLATE = {
  name: 'Sales',
  displayName: 'Sales',
  description: 'Sales queue',
  routingStrategy: 'FIFO',
  maxWaitTimeSecs: 600,
  maxSize: 100,
  timeoutSecs: 300,
  overflowAction: 'transfer',
  priority: 3,
  enabled: true,
  active: true,
  skillRequirements: {},
  priorityRules: [],
  queueAudioMediaName: 'spring_field',
  queueAudioEnablePosition: true,
  queueAudioPositionIntervalSecs: 30,
  queueAudioTtsVoice: 'Telnyx.Ultra.d46abd1d-2d02-43e8-819f-51fb652c1c61',
  agentAnswerTimeoutSecs: 15,
  defaultCallPriority: 3,
  slaAnswerThresholdSeconds: 20,
  slaTargetPercentage: 80,
  avgHandleTimeSeconds: 180,
  // Every wrapup code this queue is linked to in cc_queue_wrapup_codes,
  // referenced by their STABLE ids (see lib/postgres-schema.mjs's
  // cc_wrapup_codes seed — these ids are plain slugs like "default",
  // "general-inquiry", never randomly generated, and are seeded on every
  // fresh deployment before this queue is, so the foreign key always
  // resolves). This IS a real foreign-key relationship (cc_queue_wrapup_codes
  // .wrapup_code_id REFERENCES cc_wrapup_codes(id)) — unlike the call flow's
  // queue_name string lookup, this one would break silently if seeded out of
  // order or against a target where the wrapup-code seed was skipped, which
  // is why seed-default-queue.mjs re-checks each id exists before inserting.
  wrapupCodeIds: [
    'default',
    'general-inquiry',
    'billing-problem',
    'technical-issue',
    'complaint',
    'order-completed',
    'service-request',
    'account-update',
    'general-feedback',
    'sale-lead',
    'no-answer',
    'voicemail',
    'wrong-number',
    'dnc-request',
    'not-interested',
    'callback-scheduled',
    'dropped-call',
  ],
};

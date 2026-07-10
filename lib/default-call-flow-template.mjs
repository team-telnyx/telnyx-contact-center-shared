// Shipped template for the "Default Call Flow" seeded automatically on every
// fresh deployment (local docker AND cloud/AWS — see lib/seed-default-call-flow.mjs).
//
// This file is the single source of truth for the flow's node graph. It used
// to live only under deploy/cli/assets/default-call-flow.json and be loaded
// exclusively by the deploy wizard (deploy/cli/lib/call-flow.mjs), which then
// connected directly to Postgres to insert it — a path that only worked for
// the Local target (AWS's RDS instance lives in a private subnet the wizard
// can't reach). Moving the seed into the app itself (this file + the app's
// own lib/postgres.mjs pool, run from ensurePostgresSchema() on every boot)
// means it runs wherever the app runs, local or cloud, with zero networking
// gymnastics — the app is always already sitting next to its own database.
//
// Kept as a plain .mjs literal (not a bundled .json import) so it works
// identically whether loaded by the Next.js app or a plain `node` script,
// with no JSON import-assertion syntax to keep in sync across Node versions.
//
// v2 (2026-07-08): flow extended past the original "answer -> speak -> hangup"
// shape to end in an `enqueue` node targeting the seeded "Sales" queue (see
// lib/seeded-default-queue-template.mjs / lib/seed-default-queue.mjs) instead
// of hanging up — exported verbatim from a live, hand-edited instance so the
// seeded flow demonstrates actual queue routing out of the box. The enqueue
// node's `queue_name` is a plain string lookup against `cc_queues.name` at
// call time (see app/api/voice/webhook's enqueue handler) — NOT a foreign key
// to a row id — so this template has no id-relationship to keep in sync with
// the seeded queue beyond the two sharing the literal name "Sales".
export const DEFAULT_CALL_FLOW_TEMPLATE = {
  version: '1.0',
  type: 'telnyx-contact-center-call-flow',
  name: 'Default Call Flow',
  description: 'Default call flow seeded automatically on first deploy.',
  nodes: [
    {
      id: 'incoming_call_1768906367324',
      data: {
        label: 'Incoming Call',
        config: {
          webhook_url: null,
          payloadVariable: 'call_payload',
          voice_application_id: null,
        },
        nodeId: 'incoming_call_1768906367324',
        isActive: false,
        nodeType: 'incoming_call',
        nodeNumber: 1,
      },
      type: 'customNode',
      width: 280,
      height: 84,
      dragging: false,
      position: { x: -488.0313751807357, y: 605.3718998050136 },
      selected: false,
      positionAbsolute: { x: -488.0313751807357, y: 605.3718998050136 },
    },
    {
      id: 'answer_1768906377745',
      data: {
        label: 'Answer Call',
        config: {
          record: 'record-from-answer',
          record_trim: '',
          record_track: 'both',
          record_format: 'mp3',
          record_channels: 'dual',
          record_max_length: 0,
          record_timeout_secs: 0,
          send_silence_when_idle: true,
          record_custom_file_name: '',
        },
        nodeId: 'answer_1768906377745',
        isActive: false,
        nodeType: 'answer',
        nodeNumber: 2,
        dynamicOutputs: 2,
        dynamicOutputEvents: ['call.answered', 'call.recording.saved'],
        dynamicOutputLabels: ['Answered', 'Recording Saved'],
        dynamicOutputDescriptions: [
          'Triggered when call is answered (call.answered event)',
          'Triggered when recording is saved (call.recording.saved event)',
        ],
      },
      type: 'customNode',
      width: 280,
      height: 121,
      dragging: false,
      position: { x: -72.50385736813541, y: 608.3082781824477 },
      selected: false,
      positionAbsolute: { x: -72.50385736813541, y: 608.3082781824477 },
    },
    {
      id: 'speak_1768906437764',
      data: {
        label: 'Speak Text',
        config: {
          voice: 'Telnyx.Ultra.d46abd1d-2d02-43e8-819f-51fb652c1c61',
          payload: 'Congratulations! Your Telnyx Contact Center is up and running. Head to your dashboard to configure your team and start taking calls.',
          voice_api_key_ref: '',
        },
        nodeId: 'speak_1768906437764',
        isActive: false,
        nodeType: 'speak',
        nodeNumber: 3,
      },
      type: 'customNode',
      width: 280,
      height: 121,
      dragging: false,
      position: { x: 328.6229973615166, y: 612.869138916659 },
      selected: true,
      positionAbsolute: { x: 328.6229973615166, y: 612.869138916659 },
    },
    {
      id: 'enqueue_1783495822163',
      data: {
        label: 'Enqueue Call',
        config: {
          max_size: 100,
          // Plain-string lookup against cc_queues.name at call time — see
          // this file's header comment. Must match
          // SEEDED_DEFAULT_QUEUE_NAME in lib/seeded-default-queue-template.mjs.
          queue_name: 'Sales',
          client_state: 'eyJjYWxsX3ByaW9yaXR5IjozfQ==',
          keep_after_hangup: false,
          use_queue_options: false,
        },
        nodeId: 'enqueue_1783495822163',
        nodeType: 'enqueue',
        nodeNumber: 4,
      },
      type: 'customNode',
      width: 280,
      height: 84,
      dragging: false,
      position: { x: -296.65858078081567, y: 945.2671103686611 },
      selected: false,
      positionAbsolute: { x: -296.65858078081567, y: 945.2671103686611 },
    },
    {
      id: 'flow_end_1783496849696',
      data: {
        label: 'Flow End',
        config: {},
        nodeId: 'flow_end_1783496849696',
        nodeType: 'flow_end',
        nodeNumber: 5,
      },
      type: 'customNode',
      width: 280,
      height: 84,
      dragging: false,
      position: { x: 152.96087989833256, y: 946.2690922014528 },
      selected: true,
      positionAbsolute: { x: 152.96087989833256, y: 946.2690922014528 },
    },
  ],
  edges: [
    {
      id: 'reactflow__edge-answer_1768906377745output-0-speak_1768906437764input-execute',
      data: { isActive: false, variableMappings: [] },
      source: 'answer_1768906377745',
      target: 'speak_1768906437764',
      sourceHandle: 'output-0',
      targetHandle: 'input-execute',
    },
    {
      id: 'reactflow__edge-incoming_call_1768906367324output-0-answer_1768906377745input-execute',
      data: { isActive: false, variableMappings: [] },
      source: 'incoming_call_1768906367324',
      target: 'answer_1768906377745',
      sourceHandle: 'output-0',
      targetHandle: 'input-execute',
    },
    {
      id: 'reactflow__edge-speak_1768906437764output-1-enqueue_1783495822163input-execute',
      data: { variableMappings: [] },
      source: 'speak_1768906437764',
      target: 'enqueue_1783495822163',
      sourceHandle: 'output-1',
      targetHandle: 'input-execute',
    },
    {
      id: 'reactflow__edge-enqueue_1783495822163output-0-flow_end_1783496849696input-execute',
      data: { variableMappings: [] },
      source: 'enqueue_1783495822163',
      target: 'flow_end_1783496849696',
      sourceHandle: 'output-0',
      targetHandle: 'input-execute',
    },
  ],
  globalVariables: {},
  variables: {},
  metadata: {},
  exported_at: null,
};

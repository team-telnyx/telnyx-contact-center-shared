// Central list of available Assistant tool types for the UI
// This is intentionally simple; per-type field editors live in the UI.
export const ASSISTANT_TOOL_TYPES = [
  { type: "webhook", label: "Webhook", singleton: false },
  { type: "retrieval", label: "Retrieval", singleton: true },
  { type: "handoff", label: "Handoff", singleton: true },
  { type: "transfer", label: "Transfer", singleton: true },
  { type: "refer", label: "SIP Refer", singleton: true },
  { type: "send_dtmf", label: "Send DTMF", singleton: true },
  { type: "hangup", label: "Hangup", singleton: true },
  { type: "send_message", label: "Send Message (SMS)", singleton: true },
  { type: "invite", label: "Invite", singleton: true },
  { type: "skip_turn", label: "Skip Turn", singleton: true },
];

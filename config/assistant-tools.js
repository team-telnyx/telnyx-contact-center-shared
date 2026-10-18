// Central list of available Assistant tool types for the UI
// This is intentionally simple; per-type field editors live in the UI.
export const ASSISTANT_TOOL_TYPES = [
  { type: "vision", label: "Vision", singleton: true, description: "Analyze recent camera and screen-share frames during a live conversation" },
  { type: "function", label: "Function", singleton: false },
  { type: "pay", label: "Payment", singleton: true },
  { type: "update_dynamic_variables", label: "Update Dynamic Variables", singleton: true },
  { type: "webhook", label: "Webhook", singleton: false },
  { type: "retrieval", label: "Retrieval", singleton: true },
  { type: "handoff", label: "Handoff", singleton: true },
  { type: "transfer", label: "Transfer", singleton: true },
  { type: "refer", label: "SIP Refer", singleton: true },
  { type: "send_dtmf", label: "Send DTMF", singleton: true },
  { type: "hangup", label: "Hangup", singleton: true },
  { type: "send_message", label: "Send Message (SMS)", singleton: true },
  { type: "whatsapp_template", label: "WhatsApp Template", singleton: true },
  { type: "client_side_tool", label: "Client-Side Tool", singleton: false },
  { type: "invite", label: "Invite", singleton: true },
  { type: "skip_turn", label: "Skip Turn", singleton: true },
];

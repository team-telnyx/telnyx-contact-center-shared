// Browser-safe presentation model for a message's WhatsApp delivery state.
// Read receipts exist on WhatsApp: "Read" means the customer opened the chat.
const definitions = {
  received: ["Received", "neutral", "Received from the customer."],
  queued: ["Sending", "info", "Waiting for Telnyx to accept the message."],
  accepted: ["Sent", "info", "Accepted by Telnyx. WhatsApp delivery is reported separately."],
  sending: ["Sending", "info", "Telnyx is handing the message to WhatsApp."],
  sent: ["Sent", "success", "Handed to WhatsApp. Delivery to the phone has not been confirmed yet."],
  delivered: ["Delivered", "success", "WhatsApp confirmed delivery to the customer's phone."],
  read: ["Read", "read", "The customer opened the message."],
  delivery_unconfirmed: ["Unconfirmed", "warning", "WhatsApp did not confirm delivery. The message may still have arrived."],
  sending_failed: ["Failed", "danger", "Telnyx could not send the message."],
  delivery_failed: ["Not delivered", "danger", "WhatsApp rejected or could not deliver the message."],
  undeliverable: ["Not delivered", "danger", "WhatsApp could not deliver the message."],
  failed: ["Failed", "danger", "The send was rejected."],
  ambiguous: ["Unconfirmed", "warning", "The provider response was lost. Check before sending again."],
};
export const WHATSAPP_FINAL_PRESENTATION = Object.freeze(["read", "delivery_failed", "sending_failed", "failed", "undeliverable", "delivery_unconfirmed"]);
export function whatsappMessageStatus(message) {
  const delivery = message?.delivery || {};
  const status = delivery.status || (message?.sender_role === "customer" ? "received" : "queued");
  const [label, tone, title] = definitions[status] || [String(status).replaceAll("_", " "), "neutral", String(status)];
  const detail = [delivery.error_code, delivery.error_detail].filter(Boolean).join(" · ");
  return { status, label, tone, title: detail ? `${title} ${detail}` : title, final: WHATSAPP_FINAL_PRESENTATION.includes(status) };
}

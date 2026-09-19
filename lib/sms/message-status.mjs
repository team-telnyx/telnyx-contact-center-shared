// Browser-safe presentation model for a message's SMS delivery state.
const definitions = {
  received: ["Received", "neutral", "Received from the customer."],
  queued: ["Sending", "info", "Waiting for Telnyx to accept the message."],
  accepted: ["Sent", "info", "Accepted by Telnyx. Carrier delivery is reported separately."],
  sending: ["Sending", "info", "Telnyx is handing the message to the carrier."],
  sent: ["Sent", "success", "Handed to the carrier. A delivery receipt has not arrived yet."],
  delivered: ["Delivered", "success", "The carrier confirmed delivery to the handset."],
  delivery_unconfirmed: ["Unconfirmed", "warning", "The carrier did not confirm delivery. The message may still have arrived."],
  sending_failed: ["Failed", "danger", "Telnyx could not send the message."],
  delivery_failed: ["Not delivered", "danger", "The carrier rejected or could not deliver the message."],
  failed: ["Failed", "danger", "The send was rejected."],
  ambiguous: ["Unconfirmed", "warning", "The provider response was lost. Check before sending again."],
};
export function smsMessageStatus(message) {
  const delivery = message?.delivery || {};
  const status = delivery.status || (message?.sender_role === "customer" ? "received" : "queued");
  const [label, tone, title] = definitions[status] || [String(status).replaceAll("_", " "), "neutral", String(status)];
  const detail = [delivery.error_code, delivery.error_detail].filter(Boolean).join(" · ");
  return { status, label, tone, title: detail ? `${title} ${detail}` : title, final: ["delivered", "delivery_failed", "sending_failed", "failed", "delivery_unconfirmed"].includes(status) };
}

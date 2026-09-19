// Folds WhatsApp annotations (reactions, quoted replies) onto the messages
// they refer to. Telnyx reports the target of a reaction or a quote as its own
// message id in both directions (`provider_message_id` here), so no WhatsApp
// message ids are needed to match them.
export function foldWhatsAppAnnotations(messages) {
  const byProviderId = new Map();
  for (const message of messages) {
    const id = message.delivery?.provider === "whatsapp" ? message.delivery.provider_message_id : null;
    if (id) byProviderId.set(String(id), message);
  }
  const kept = [];
  for (const message of messages) {
    const delivery = message.delivery;
    if (delivery?.provider === "whatsapp" && delivery.kind === "reaction" && delivery.content?.reaction) {
      const target = byProviderId.get(String(delivery.content.reaction.message_id || ""));
      if (target) {
        // The latest reaction per sender wins; an empty emoji removes it.
        const others = (target.delivery.reactions || []).filter((entry) => !(entry.sender_role === message.sender_role && entry.sender_id === message.sender_id));
        const emoji = String(delivery.content.reaction.emoji || "");
        target.delivery.reactions = emoji ? [...others, { emoji, sender_role: message.sender_role, sender_id: message.sender_id, message_id: message.id, created_at: message.created_at, status: delivery.status,
          error_detail: delivery.error_detail || null }] : others;
        continue; // rendered on the target bubble, not as its own bubble
      }
      delivery.orphan_reaction = true; // target not in this conversation
    }
    const quotedId = delivery?.provider === "whatsapp" ? delivery.content?.context?.message_id : null;
    if (quotedId && byProviderId.has(String(quotedId))) {
      const quoted = byProviderId.get(String(quotedId));
      delivery.quoted = { message_id: quoted.id, sender_role: quoted.sender_role, body: String(quoted.body || "").slice(0, 200), kind: quoted.delivery?.kind || "text" };
    }
    kept.push(message);
  }
  return kept;
}

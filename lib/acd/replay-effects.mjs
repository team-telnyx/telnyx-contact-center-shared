// Capability is a server-local Symbol, never a header or request parameter.
// Only durable, signature-verified inbox rows may re-enter adapter side effects.
export const VERIFIED_INBOX_REPLAY = Symbol("verified ACD inbox replay");

export async function replayVoiceEffects(row, result) {
  if (result.skipAdapterEffects || !row.source_route) return; // historical/fixture rows have no adapter effects
  const request = new Request("http://internal.invalid/verified-inbox", {
    method: "POST", body: JSON.stringify({ data: {
      id: row.event_id, event_type: result.adapterEventType || row.event_type, occurred_at: row.occurred_at, payload: row.payload,
    } }),
  });
  const context = { [VERIFIED_INBOX_REPLAY]: result, params: Promise.resolve({ flowId: row.source_flow_id }) };
  const handler = row.source_route === "incoming"
    ? await import("../../app/api/voice/webhook/incoming/[flowId]/route.js")
    : row.source_route === "voice"
      ? await import("../../app/api/voice/webhook/route.js") : null;
  if (!handler) throw new Error("Unknown durable voice adapter");
  const response = await handler.POST(request, context);
  if (!response.ok) throw new Error(`Voice adapter replay returned HTTP ${response.status}`);
}

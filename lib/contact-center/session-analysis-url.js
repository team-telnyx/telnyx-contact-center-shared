export function sessionAnalysisCallSessionId(conversation = {}) {
  return (
    conversation?.call_session_id ||
    conversation?.metadata?.call_session_id ||
    conversation?.metadata?.telnyx_call_session_id ||
    ""
  );
}

export function sessionAnalysisEventId(conversation = {}) {
  return sessionAnalysisCallSessionId(conversation) || conversation?.id || "";
}

export function sessionAnalysisRecordType(conversation = {}) {
  return sessionAnalysisCallSessionId(conversation) ? "call-session" : "ai-voice-assistant";
}

export function buildSessionAnalysisRequestUrl({ conversation = {}, useDemoApiKey = false } = {}) {
  const eventId = sessionAnalysisEventId(conversation);
  if (!eventId) return "";

  const params = new URLSearchParams();
  params.set("record_type", sessionAnalysisRecordType(conversation));
  params.set("max_depth", "5");

  if (conversation?.created_at) {
    const dateStr = String(conversation.created_at).split("T")[0];
    if (dateStr) params.set("date_time", dateStr);
  }

  if (useDemoApiKey) params.set("useDemoApiKey", "true");

  return `/api/ai/conversations/${encodeURIComponent(eventId)}/session-analysis?${params.toString()}`;
}

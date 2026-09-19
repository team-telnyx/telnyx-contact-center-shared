function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value) || fallback; } catch { return fallback; }
}
export function campaignAgentAssistConfig(campaign = {}) {
  const metadata = parseJson(campaign.metadata, {});
  const workflowId = campaign.attached_workflow_id || metadata.attached_workflow_id || metadata.workflow_id || null;
  const formId = campaign.attached_form_id || metadata.attached_form_id || metadata.form_id || null;
  if (workflowId) {
    return {
      enabled: true,
      assist_type: "workflows",
      workflow_id: workflowId,
      auto_start: true,
      source: "outbound_campaign",
    };
  }
  if (formId) {
    return {
      enabled: true,
      assist_type: "forms",
      form_ids: [formId],
      auto_open_forms: true,
      source: "outbound_campaign",
    };
  }
  return {
    enabled: true,
    assist_type: "kb_articles",
    kb_auto_suggest: true,
    kb_max_suggestions: 3,
    source: "outbound_campaign",
  };
}

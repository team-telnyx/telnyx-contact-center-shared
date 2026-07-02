const CLASSIFICATIONS = new Set(["none", "right_party_contact", "number_uncallable", "contact_uncallable", "retry"]);
const BUSINESS_CATEGORIES = new Set(["success", "neutral", "failure", "none"]);
const STATUSES = new Set(["active", "draft", "paused", "archived"]);

function cleanString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function cleanNullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

export function normalizeCampaignDispositionMapping(input = {}) {
  const classification = CLASSIFICATIONS.has(input.classification) ? input.classification : "none";
  const businessCategory = BUSINESS_CATEGORIES.has(input.business_category) ? input.business_category : "none";
  return {
    wrapup_code_id: cleanString(input.wrapup_code_id || input.wrapupCodeId, "default"),
    campaign_id: cleanNullableString(input.campaign_id || input.campaignId),
    classification,
    business_category: classification === "right_party_contact" ? businessCategory : "none",
    retry_eligible: classification === "retry" ? input.retry_eligible !== false : false,
    requires_callback: classification === "retry" ? input.requires_callback === true : false,
    status: STATUSES.has(input.status) ? input.status : "active",
    metadata: safeMetadata(input.metadata),
  };
}

export function mapCampaignDispositionMapping(row = {}) {
  if (!row) return null;
  return normalizeCampaignDispositionMapping({
    ...row,
    metadata: row.metadata || {},
  });
}

export function applyCampaignDispositionToLedger(attempt = {}, mapping = {}, submission = {}) {
  const normalized = normalizeCampaignDispositionMapping(mapping);
  const submittedAt = submission.submitted_at || submission.submittedAt || new Date().toISOString();
  const callbackAt = cleanNullableString(submission.callback_at || submission.callbackAt);
  const notes = cleanNullableString(submission.notes);
  const metadata = {
    ...(attempt.metadata || {}),
    disposition_code_id: normalized.wrapup_code_id,
    disposition_classification: normalized.classification,
    business_category: normalized.business_category,
    disposition_submitted_at: submittedAt,
    retry_eligible: normalized.retry_eligible,
    requires_callback: normalized.requires_callback,
  };
  if (notes) metadata.disposition_notes = notes;
  if (callbackAt) metadata.callback_at = callbackAt;

  let status = "completed";
  let nextRetryAt = null;
  let contactValidationStatus = null;

  if (normalized.classification === "retry") {
    status = "failed";
    metadata.reason_code = normalized.requires_callback ? "callback_scheduled" : "retry_requested";
    nextRetryAt = callbackAt;
  } else if (normalized.classification === "contact_uncallable") {
    status = "suppressed";
    metadata.reason_code = "contact_uncallable";
    metadata.contact_uncallable = true;
    contactValidationStatus = "suppressed";
  } else if (normalized.classification === "number_uncallable") {
    status = "suppressed";
    metadata.reason_code = "number_uncallable";
    metadata.number_uncallable = true;
  } else if (normalized.classification === "right_party_contact") {
    status = "completed";
    metadata.reason_code = "right_party_contact";
    metadata.right_party_contact = true;
  } else {
    status = "completed";
    metadata.reason_code = "completed";
  }

  return {
    status,
    metadata,
    next_retry_at: nextRetryAt,
    contact_validation_status: contactValidationStatus,
  };
}

function normalizePositiveInt(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.floor(numeric));
}

function hasValue(value) {
  return String(value || "").trim().length > 0;
}

const MAX_ROTATING_FROM_NUMBERS = 5;

export function campaignRequiredFromSlotCount(campaign = {}, options = {}) {
  const metadata = campaign?.metadata || {};
  const maxAttempts = normalizePositiveInt(options.maxAttempts ?? campaign?.retry_policy?.maxAttempts, 1);
  return metadata.rotate_numbers === true ? Math.min(maxAttempts, MAX_ROTATING_FROM_NUMBERS) : 1;
}

export function campaignSaveRequirements(campaign = {}, options = {}) {
  const metadata = campaign?.metadata || {};
  const missing = [];

  if (!hasValue(campaign.name)) missing.push("name");
  if (!hasValue(campaign.contact_list_id)) missing.push("contact_list");
  if (!Array.isArray(metadata.contact_list_numbers) || metadata.contact_list_numbers.filter(hasValue).length === 0) {
    missing.push("contact_list_numbers");
  }

  const fromNumbers = Array.isArray(metadata.from_numbers) ? metadata.from_numbers : [];
  const requiredSlots = campaignRequiredFromSlotCount(campaign, options);
  for (let index = 0; index < requiredSlots; index += 1) {
    if (hasValue(fromNumbers[index])) continue;
    missing.push(index === 0 ? "from_default" : `from_retry_${index}`);
  }

  return {
    canSave: missing.length === 0,
    missing,
    requiredFromSlots: requiredSlots,
  };
}

export function campaignSaveRequirementsMessage(requirements = {}) {
  const missing = Array.isArray(requirements.missing) ? requirements.missing : [];
  if (!missing.length) return "";
  const labels = missing.map((key) => {
    if (key === "name") return "Campaign Name";
    if (key === "contact_list") return "Contact List";
    if (key === "contact_list_numbers") return "Contact List Numbers";
    if (key === "from_default") return "FROM Default";
    const retry = String(key).match(/^from_retry_(\d+)$/);
    if (retry) return `FROM Retry ${retry[1]}`;
    return key;
  });
  return `Required before saving: ${labels.join(", ")}.`;
}

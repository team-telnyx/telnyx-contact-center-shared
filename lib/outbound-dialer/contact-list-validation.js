const VALIDATED_STATUS = "validated";
const DEFAULT_STATUS = "draft";
const VALIDATION_MAPPING_PREFIXES = ["number:", "email:", "whatsapp:"];

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function hasRecordCount(contactList = {}) {
  return Number(contactList.record_count || contactList.recordCount || 0) > 0;
}

export function hasNumberOrEmailMapping(contactList = {}) {
  const metadata = parseJson(contactList.metadata, {});
  const importSettings = metadata.csv_import_settings || metadata.csvImportSettings || {};
  const columnMappings = importSettings.column_mappings || importSettings.columnMappings || {};
  return Object.values(columnMappings || {}).some((values) => (Array.isArray(values) ? values : []).some((value) => VALIDATION_MAPPING_PREFIXES.some((prefix) => String(value || "").startsWith(prefix))));
}

export function canValidateContactList(contactList = {}) {
  return hasRecordCount(contactList) && hasNumberOrEmailMapping(contactList);
}

export function normalizeContactListStatus(contactList = {}) {
  return String(contactList.status || DEFAULT_STATUS) === VALIDATED_STATUS && canValidateContactList(contactList) ? VALIDATED_STATUS : DEFAULT_STATUS;
}

export function campaignContactListTargets(contactLists = []) {
  return (Array.isArray(contactLists) ? contactLists : []).filter((list) => list?.status === VALIDATED_STATUS);
}

export function contactListValidationMessage(contactList = {}) {
  if (!hasRecordCount(contactList)) return "Import at least one record before marking this contact list as validated.";
  if (!hasNumberOrEmailMapping(contactList)) return "Map at least one column to Number, Email, or WhatsApp before marking this contact list as validated.";
  return "This contact list can be marked as validated.";
}

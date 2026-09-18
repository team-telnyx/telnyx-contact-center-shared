// Browser-safe constants and normalizers for WhatsApp administration.
export const WHATSAPP_WABA_WEBHOOK_EVENTS = Object.freeze([
  { value: "messages", label: "Messages" },
  { value: "message_status_updates", label: "Message status updates" },
  { value: "message_template_status_updates", label: "Message template status updates" },
  { value: "phone_number_name_updates", label: "Phone number name updates" },
  { value: "phone_number_quality_updates", label: "Phone number quality updates" },
  { value: "account_updates", label: "Account updates" },
  { value: "account_review_updates", label: "Account review updates" },
  { value: "business_capability_updates", label: "Business capability updates" },
  { value: "security_events", label: "Security events" },
].map(Object.freeze));
export const WHATSAPP_PROFILE_CATEGORIES = Object.freeze(["AUTOMOTIVE", "BEAUTY_SPA_AND_SALON", "CLOTHING_AND_APPAREL", "EDUCATION", "ENTERTAINMENT", "EVENT_PLANNING_AND_SERVICE",
  "FINANCE_AND_BANKING", "FOOD_AND_GROCERY", "HOTEL_AND_LODGING", "MEDICAL_AND_HEALTH", "NON_PROFIT", "PROFESSIONAL_SERVICES", "PUBLIC_SERVICE", "RESTAURANT", "SHOPPING_AND_RETAIL",
  "TRAVEL_AND_TRANSPORTATION", "OTHER"]);
export const WHATSAPP_TIMEZONES = Object.freeze(["UTC", "Europe/Warsaw", "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Madrid", "Europe/Dublin", "America/New_York", "America/Chicago",
  "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"]);
export const WHATSAPP_VERIFICATION_LANGUAGES = Object.freeze(["en_US", "en_GB", "pl_PL", "de_DE", "es_ES", "fr_FR", "it_IT", "pt_BR"]);

export const isWhatsAppE164 = (value) => /^\+[1-9]\d{7,14}$/.test(String(value || "").trim());
export const normalizeWhatsAppPhone = (value) => { const digits = String(value || "").replace(/[^\d]/g, ""); return digits ? `+${digits}` : ""; };

export function normalizeWhatsAppAccount(account = {}) {
  return { id: account.id || "", wabaId: account.waba_id || "", name: account.name || "", status: account.status || "UNKNOWN",
    phoneNumbersCount: Number(account.phone_numbers_count || 0), businessVerificationStatus: account.business_verification_status || "unknown",
    accountReviewStatus: account.account_review_status || "UNKNOWN", country: account.country || "", createdAt: account.created_at || null };
}
export function normalizeWhatsAppPhoneNumber(number = {}) {
  return { phoneNumber: number.phone_number || "", phoneNumberId: number.phone_number_id || "", wabaId: number.waba_id || "",
    displayName: number.display_name || number.phone_number || "", qualityRating: number.quality_rating || "UNKNOWN", status: number.status || "UNKNOWN",
    enabled: number.enabled === true, callingEnabled: number.calling_enabled === true, createdAt: number.created_at || null };
}
export function normalizeWhatsAppSettings(settings = {}) {
  return { id: settings.id || "", name: settings.name || "", timezone: settings.timezone || "UTC", webhookUrl: settings.webhook_url || "",
    webhookFailoverUrl: settings.webhook_failover_url || "", webhookEnabled: settings.webhook_enabled === true,
    webhookEvents: Array.isArray(settings.webhook_events) ? settings.webhook_events : [], updatedAt: settings.updated_at || null };
}
export function statusTone(value) {
  const status = String(value || "").toUpperCase();
  if (["ACTIVE", "APPROVED", "CONNECTED", "GREEN", "VERIFIED", "ENABLED"].includes(status)) return "success";
  if (["REJECTED", "FAILED", "DISCONNECTED", "DISABLED", "RED", "SUSPENDED", "BANNED"].includes(status)) return "danger";
  if (status.includes("PENDING") || status.includes("INACTIVE") || status.includes("NOT_VERIFIED") || status === "YELLOW" || status === "PAUSED") return "warning";
  return "neutral";
}
export function whatsappReadinessItems(account, settings, phoneNumbers = []) {
  return [
    { label: "Account review", ready: String(account?.accountReviewStatus).toUpperCase() === "APPROVED", value: account?.accountReviewStatus || "Unknown" },
    { label: "Business verification", ready: ["VERIFIED", "APPROVED"].includes(String(account?.businessVerificationStatus).toUpperCase()), value: account?.businessVerificationStatus || "Unknown" },
    { label: "Connected phone number", ready: phoneNumbers.some((number) => number.enabled && String(number.status).toUpperCase() === "CONNECTED"), value: `${phoneNumbers.filter((number) => number.enabled).length} enabled` },
    { label: "WABA event webhooks", ready: settings?.webhookEnabled === true, value: settings?.webhookEnabled ? "Enabled" : "Disabled" },
  ];
}

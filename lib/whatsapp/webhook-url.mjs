import { resolveWebhookBaseUrl } from "../webhook-base-url.mjs";
import { telnyxWebhookPublicKeys } from "../telnyx-webhooks.js";
import { whatsappError } from "./policy.mjs";

export const WHATSAPP_WEBHOOK_PATH = "/api/webhooks/telnyx/whatsapp";

// Keys accepted on the WhatsApp webhook: the primary account key plus the
// backup account key when WhatsApp runs on TELNYX_API_KEY_WHATSAPP.
export const whatsappWebhookPublicKeys = () => telnyxWebhookPublicKeys({ extraPublicKeys: [process.env.TELNYX_WEBHOOK_PUBLIC_KEY_WHATSAPP || ""] });

export function whatsappWebhookUrl() {
  if (!whatsappWebhookPublicKeys().length) throw whatsappError("Configure the Telnyx webhook public key (TELNYX_WEBHOOK_PUBLIC_KEY) on the server first", 503);
  const url = new URL(`${resolveWebhookBaseUrl()}${WHATSAPP_WEBHOOK_PATH}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw whatsappError("Configure a public HTTPS application base URL (TELNYX_WEBHOOK_BASE_URL or APP_BASE_URL) before connecting WhatsApp", 503);
  return url.href;
}
// Outbound messages carry the webhook explicitly so delivery evidence reaches
// Contact Center even when the messaging profile points elsewhere.
export function whatsappWebhookUrlOrNull() {
  try { return whatsappWebhookUrl(); } catch { return null; }
}

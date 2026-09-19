// Server-side guards shared by the campaign routes: messaging campaigns are
// broadcast-only and must be complete before they leave draft or start.
import { campaignSaveRequirements, campaignSaveRequirementsMessage } from "../campaign-validation.js";
import { isOutboundMessagingChannel } from "../schema.js";
import { messagingCampaignConfig, normalizeMessagingCampaignConfig } from "./campaign-config.mjs";
import { messagingSettingsFrom } from "./settings.mjs";
import { loadMessagingTemplate, MEDIA_HEADER_FORMATS, messagingTemplateVariableKeys, usesUnsupportedLiquid } from "./templates.mjs";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Normalize `metadata.messaging` on every save so the runner never sees a
// hand-written shape.
export function normalizeMessagingMetadata(metadata = {}, channel = "voice") {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!isOutboundMessagingChannel(channel) && !metadata.messaging) return metadata;
  return { ...metadata, messaging: normalizeMessagingCampaignConfig(metadata.messaging || {}) };
}

export async function assertMessagingCampaignSavable(pool, campaign, globalSettings = {}) {
  if (!isOutboundMessagingChannel(campaign?.channel)) return null;
  if (campaign.status === "draft") return null;
  const channel = campaign.channel;
  const config = messagingCampaignConfig(campaign);
  const template = await loadMessagingTemplate(pool, channel, config.template[channel]?.template_id);
  if (config.template[channel]?.template_id && !template) throw fail("The selected template no longer exists");
  if (template?.status === "archived") throw fail("The selected template is archived. Choose an active template.");
  assertMessagingTemplateUsable(template, config, messagingSettingsFrom(globalSettings));
  const requirements = campaignSaveRequirements(campaign, { settings: globalSettings, templateVariables: template ? messagingTemplateVariableKeys(template, config) : null });
  if (!requirements.canSave) throw fail(campaignSaveRequirementsMessage(requirements));
  return requirements;
}

/**
 * Template requirements the renderer would otherwise discover per message, once
 * the campaign is already running and every message is being rejected: a media
 * header without its medium, a marketing template without a consent field, and
 * Liquid this installation renders locally and therefore cannot evaluate.
 */
export function assertMessagingTemplateUsable(template, config, settings) {
  if (!template) return;
  if (template.channel === "whatsapp") {
    if (MEDIA_HEADER_FORMATS.includes(String(template.header_format || "").toUpperCase()) && !String(config?.template?.whatsapp?.header_media?.url || "").trim()) {
      throw fail(`This template has a ${String(template.header_format).toLowerCase()} header. Add the media URL before saving.`);
    }
    if (settings?.whatsapp?.require_consent_for_marketing !== false && template.category === "MARKETING" && !String(config?.consent?.field || "").trim()) {
      throw fail("Marketing templates need a consent field. Choose one under Audience, or turn off the consent requirement in Dialer settings.");
    }
  }
  if (template.channel === "email") {
    if (template.uses_liquid_logic) throw fail("This template uses Liquid that campaigns render locally and cannot evaluate. Choose a template with plain {{variable}} placeholders.");
    if (usesUnsupportedLiquid(config?.template?.email?.subject_override)) throw fail("The subject override may only use plain {{variable}} placeholders.");
  }
}

export async function assertMessagingCampaignStartable(pool, campaign, globalSettings = {}) {
  const settings = messagingSettingsFrom(globalSettings);
  if (!settings.enabled_channels[campaign.channel]) throw fail(`${campaign.channel.toUpperCase()} campaigns are disabled in Dialer settings. Enable the channel under Settings → Messaging campaigns first.`, 409);
  if (campaign.mode !== "broadcast") throw fail("Messaging campaigns run in Broadcast mode only");
  return assertMessagingCampaignSavable(pool, { ...campaign, status: "ready" }, globalSettings);
}

// Why a campaign cannot be tested or validated as a messaging campaign, in
// terms of the control the operator would use to fix it.
export function messagingChannelRequired(campaign) {
  return `This is a ${String(campaign?.channel || "voice").toLowerCase()} campaign. Choose SMS, WhatsApp or email as the campaign channel first.`;
}

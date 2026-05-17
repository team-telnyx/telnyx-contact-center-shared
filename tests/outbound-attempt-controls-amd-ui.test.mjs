import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePromise = readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start > -1, `${name} should exist`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start) : source.length;
  assert.ok(end > start, `${name} should end before ${nextName}`);
  return source.slice(start, end);
}

test("recall controls render outcome as a full-width row with labeled numeric fields", async () => {
  const source = await sourcePromise;
  const recallRows = functionSource(source, "RecallRows", "OutboundSettingsForm");

  assert.match(recallRows, /grid-cols-\[minmax\(0,1fr\)_36px\]/, "recall rule header should reserve a full row for outcome and remove button");
  assert.match(recallRows, /grid grid-cols-2 gap-2/, "attempts and minutes should be in a second two-column row");
  assert.match(recallRows, /ConfigSelect label="Outcome"/, "outcome should always have a visible label");
  assert.doesNotMatch(recallRows, /bare=\{compact\}/, "outcome dropdown should not be rendered as a cramped bare control");
  assert.doesNotMatch(recallRows, /label=\{compact \? "" : "Attempts"\}/, "attempt labels should not disappear in compact phone-type rows");
  assert.doesNotMatch(recallRows, /label=\{compact \? "" : "Minutes"\}/, "minutes labels should not disappear in compact phone-type rows");
});

test("campaign AMD settings are gated by mode and expose voicemail action/TTS controls", async () => {
  const source = await sourcePromise;
  const campaignForm = functionSource(source, "CampaignSettingsForm", "AttemptControlSettingsForm");

  assert.match(source, /const AMD_ELIGIBLE_CAMPAIGN_MODES = \[/, "AMD eligible campaign modes should be declared centrally");
  assert.match(campaignForm, /amdAvailable/, "campaign form should derive AMD availability from mode");
  assert.match(campaignForm, /AMD_ELIGIBLE_CAMPAIGN_MODES\.includes\(mode\)/, "AMD should only be available for allowed modes");
  assert.match(campaignForm, /amdAvailable \? <CampaignAmdSettings/, "AMD config panel should render only when the mode supports AMD");
  assert.match(campaignForm, /amd_config: \{ \.\.\.\(draft\.amd_config \|\| \{\}\), enabled: amdAvailable && draft\.amd_config\?\.enabled === true \}/, "saving should disable AMD for unsupported modes without dropping existing voicemail settings");

  const amdSettings = functionSource(source, "CampaignAmdSettings", "AttemptControlSettingsForm");
  assert.match(amdSettings, /Answering machine action/, "AMD panel should expose action selection");
  assert.match(amdSettings, /disconnect/, "AMD actions should include disconnect");
  assert.match(amdSettings, /leave_message/, "AMD actions should include leave message");
  assert.match(amdSettings, /Voicemail message/, "leave-message mode should expose message text");
  assert.match(amdSettings, /Provider/, "leave-message mode should expose TTS provider");
  assert.match(amdSettings, /Model/, "leave-message mode should expose TTS model");
  assert.match(amdSettings, /Language Filter/, "leave-message mode should expose language filter");
  assert.match(amdSettings, /CommandInput[\s\S]*placeholder=\"Search languages\.\.\.\"/, "AMD language filter should use the same searchable command popover as Speak Text");
  assert.match(amdSettings, /IconWorld[\s\S]*All languages/, "AMD language filter trigger should show the same All languages state as Speak Text");
  assert.match(amdSettings, /CommandItem[\s\S]*value=\"__any__\"[\s\S]*<span>Any<\/span>/, "AMD language filter should expose the same Any option as Speak Text");
  assert.match(amdSettings, /Filter voices by language \(\{languageOptions\.length\} language/, "AMD language filter should show the same availability helper text as Speak Text");
  assert.doesNotMatch(amdSettings, /ConfigSelect label=\"Language Filter\"/, "AMD language filter must not use the compact ConfigSelect dropdown");
  assert.match(amdSettings, /Voice/, "leave-message mode should expose voice picker");
  assert.match(amdSettings, /Test Voice/, "leave-message mode should expose a test voice button");
  assert.match(amdSettings, /\/api\/tts\/voices/, "AMD TTS config should load the same voice catalog as Speak Text");
  assert.match(amdSettings, /\/api\/tts\/speech/, "AMD TTS config should test audio through the same endpoint as Speak Text");
  assert.match(amdSettings, /label="Provider"[\s\S]*?setLanguageFilter\(""\)[\s\S]*?updateTts\(\{ provider: value, model: "", voice: "", language: "" \}\)/, "changing provider should reset the local language filter along with persisted TTS language");
  assert.match(amdSettings, /label="Model"[\s\S]*?setLanguageFilter\(""\)[\s\S]*?updateTts\(\{ model: value, voice: "", language: "" \}\)/, "changing model should reset the local language filter along with persisted TTS language");
});

test("voice webhook can start outbound AI assistant from ledger columns when event metadata is sparse", async () => {
  const source = await readFile(new URL("../app/api/voice/webhook/route.js", import.meta.url), "utf8");
  assert.match(source, /finalizedMetadata\?\.outbound_handler_type \|\| finalizedLedger\?\.handler_type \|\| payloadMetadata\?\.outbound_handler_type/, "handler type should fall back to ledger columns");
  assert.match(source, /finalizedMetadata\?\.outbound_handler_ref \|\| finalizedLedger\?\.handler_ref \|\| payloadMetadata\?\.outbound_handler_ref/, "handler ref should fall back to ledger columns");
});

test("campaign inventory keeps contact list names visible and removes readiness column", async () => {
  const source = await sourcePromise;
  const campaignsView = functionSource(source, "CampaignsView", "ContactListsView");

  assert.match(campaignsView, /columns=\{\["Name", "Status", "List", "Mode", "Actions"\]\}/, "campaign table should not render the Ready column");
  assert.doesNotMatch(campaignsView, /"Ready"/, "Ready column header should be removed from Campaigns inventory");
  assert.doesNotMatch(campaignsView, /readiness\(c\)/, "Ready percentage cell should be removed with the column");
  assert.match(campaignsView, /campaignListName\(c, contactLists\)/, "List cell should resolve names from attached contactLists when the campaign payload lacks contact_list_name");
});

test("campaign update API returns refreshed contact list name after save", async () => {
  const updateRoute = await readFile(new URL("../app/api/contact-center/outbound-dialer/campaigns/[campaignId]/route.js", import.meta.url), "utf8");
  const putRoute = updateRoute.slice(updateRoute.indexOf("export async function PUT"), updateRoute.indexOf("export async function DELETE"));

  assert.match(updateRoute, /SELECT c\.\*, l\.name AS contact_list_name/, "save campaign response should be able to reload the updated campaign with joined contact list name");
  assert.match(updateRoute, /LEFT JOIN outbound_contact_lists l ON l\.id = c\.contact_list_id/, "save campaign response should join the selected contact list");
  assert.match(putRoute, /loadCampaignWithLookups\(pool, campaign\.id\)/, "PUT should reload lookup names after UPDATE RETURNING");
  assert.doesNotMatch(putRoute, /campaign:\s*mapCampaign\(campaign\)/, "PUT response must not return raw UPDATE RETURNING row without lookup names");
});

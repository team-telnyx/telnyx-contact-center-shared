import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard exhausted campaign card does not render a duplicate exhausted badge in controls area", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const cardStart = source.indexOf("function DashboardCampaignCard");
  const cardEnd = source.indexOf("function CampaignsView", cardStart);
  assert.ok(cardStart > -1, "DashboardCampaignCard should exist");
  assert.ok(cardEnd > cardStart, "DashboardCampaignCard should end before CampaignsView");

  const cardSource = source.slice(cardStart, cardEnd);
  assert.match(cardSource, /<Badge variant="outline" className=\{statusClass\(state\)\}>\{title\(state\)\}<\/Badge>/, "header should keep the campaign state badge");
  assert.doesNotMatch(cardSource, /controls\.controlsDisabled[\s\S]*?<Badge variant="outline" className=\{statusClass\("exhausted"\)\}>Exhausted<\/Badge>/, "disabled controls area should not render a second Exhausted badge");
});

test("expanded dashboard campaign card renders contact statistics and calls processing card groups", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const cardStart = source.indexOf("function DashboardCampaignCard");
  const cardEnd = source.indexOf("function CampaignsView", cardStart);
  assert.ok(cardStart > -1, "DashboardCampaignCard should exist");
  assert.ok(cardEnd > cardStart, "DashboardCampaignCard should end before CampaignsView");

  const cardSource = source.slice(cardStart, cardEnd);
  assert.match(cardSource, /buildDashboardCampaignExpandedStats\(\{ progress, live, summary, maxLines, channel: campaign\.channel \}\)/, "card should use the expanded stats view model");
  assert.match(cardSource, /CONTACTS STATISTICS/, "expanded card should label contact statistics group");
  assert.match(cardSource, /CALLS PROCESSING/, "expanded card should label calls processing group");
  assert.match(cardSource, /contactStats\.map/, "contact statistics should render from contactStats");
  assert.match(cardSource, /callProcessingStats\.map/, "calls processing should render from callProcessingStats");
  assert.match(cardSource, /sm:grid-cols-5/g, "expanded KPI groups should have five cards each");
  assert.doesNotMatch(cardSource, /MiniStat label="Readiness"/, "expanded card should not render the old readiness stat");
  assert.doesNotMatch(cardSource, /<Badge variant="outline" className=\{liveBadgeClasses\./, "expanded card should not render call-processing badges");
});

test("live calls view does not render the redundant hero card", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const viewStart = source.indexOf("function LiveCallsView");
  const viewEnd = source.indexOf("function LiveCallCard", viewStart);
  assert.ok(viewStart > -1, "LiveCallsView should exist");
  assert.ok(viewEnd > viewStart, "LiveCallsView should end before LiveCallCard");

  const viewSource = source.slice(viewStart, viewEnd);
  assert.doesNotMatch(viewSource, /Live campaign calls/);
  assert.doesNotMatch(viewSource, /Realtime monitor across all outbound campaigns/);
  assert.doesNotMatch(viewSource, /Hangup calls stay visible for 60 seconds/);
});

test("live calls filters include a default-on disconnected calls toggle that filters terminal statuses from the list", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const pageStart = source.indexOf("export default function OutboundDialerPage");
  const pageEnd = source.indexOf("function LiveCallsView", pageStart);
  const viewStart = source.indexOf("function LiveCallsView");
  const viewEnd = source.indexOf("function LiveCallCard", viewStart);
  const settingsStart = source.indexOf("function LiveCallsSettings");
  const settingsEnd = source.indexOf("function DashboardView", settingsStart);
  assert.ok(pageStart > -1 && pageEnd > pageStart, "OutboundDialerPage should exist before LiveCallsView");
  assert.ok(viewStart > -1 && viewEnd > viewStart, "LiveCallsView should exist");
  assert.ok(settingsStart > -1 && settingsEnd > settingsStart, "LiveCallsSettings should exist");

  const pageSource = source.slice(pageStart, pageEnd);
  const viewSource = source.slice(viewStart, viewEnd);
  const settingsSource = source.slice(settingsStart, settingsEnd);

  assert.match(pageSource, /const \[showDisconnectedLiveCalls, setShowDisconnectedLiveCalls\] = useState\(true\)/, "Show disconnected calls should default on");
  assert.match(viewSource, /showDisconnectedCalls/, "LiveCallsView should accept the disconnected-call visibility flag");
  assert.match(viewSource, /shouldShowOutboundLiveCallInUi\(call, \{ now, showDisconnectedCalls \}\)/, "LiveCallsView should apply disconnected-call toggle and 60-second retention in the UI");
  assert.match(settingsSource, /Show disconnected calls/, "Live call filters should render the requested toggle label");
  assert.match(settingsSource, /setShowDisconnectedCalls/, "Live call filters should wire toggle changes back to page state");
});

test("outbound dialer restores and persists the supervisor's last selected section", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const pageStart = source.indexOf("export default function OutboundDialerPage");
  const pageEnd = source.indexOf("function LiveCallsView", pageStart);
  assert.ok(pageStart > -1 && pageEnd > pageStart, "OutboundDialerPage should exist before LiveCallsView");

  const pageSource = source.slice(pageStart, pageEnd);

  assert.match(source, /activeSection: "supervisor\.outbound-dialer\.activeSection"/, "Outbound dialer should use a scoped storage key for the selected section");
  assert.match(pageSource, /localStorage\.getItem\(OUTBOUND_UI_STATE_STORAGE_KEYS\.activeSection\)/, "Outbound dialer should restore the selected section from localStorage");
  assert.match(pageSource, /NAV_ITEMS\.some\(\(item\) => item\.id === savedActive\)/, "Restored outbound section should be validated against known nav items");
  assert.match(pageSource, /localStorage\.setItem\(OUTBOUND_UI_STATE_STORAGE_KEYS\.activeSection, active\)/, "Outbound dialer should save section changes to localStorage");
  assert.match(source, /id: "time-sets"/, "Time Sets should remain a valid persisted section");
});

test("campaign command center applies the same persisted status selection to cards and details", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const dashboardSource = source.slice(source.indexOf("function DashboardView"), source.indexOf("function DashboardCampaignCard"));

  assert.doesNotMatch(source, /showOnlyActiveDashboardCampaigns|Show only active campaign/);
  assert.match(source, /dashboardCampaignStatuses.includes\(executionStateWithRuntimeFor\(campaign, contactLists, executionDebugByCampaign\?\.\[campaign.id\]\)\)/, "filter must use the same runtime state as campaign badges");
  assert.match(source, /dashboardCampaignCards=\{selectableDashboardCampaigns\}/, "cards must use the same filtered list as the selected detail panel");
  assert.match(source, /selectableDashboardCampaigns.find/, "detail selection must stay within the filtered list");
  assert.match(source, /localStorage.setItem\(OUTBOUND_UI_STATE_STORAGE_KEYS.dashboardCampaignStatuses, JSON.stringify\(dashboardCampaignStatuses\)\)/);
  assert.match(dashboardSource, /<ToggleGroup type="multiple" value=\{campaignStatuses\} onValueChange=\{setCampaignStatuses\}/);
  assert.match(dashboardSource, /Select at least one campaign status/, "an empty selection should explain how to show cards again");
});

test("time sets editor defaults to calendar view and persists the selected tab in localStorage", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const pageStart = source.indexOf("export default function OutboundDialerPage");
  const pageEnd = source.indexOf("function LiveCallsView", pageStart);
  const formStart = source.indexOf("function TimeSetSettingsForm");
  const formEnd = source.indexOf("function TimeSetCalendar", formStart);
  assert.ok(pageStart > -1 && pageEnd > pageStart, "OutboundDialerPage should exist before LiveCallsView");
  assert.ok(formStart > -1 && formEnd > formStart, "TimeSetSettingsForm should exist before TimeSetCalendar");

  const pageSource = source.slice(pageStart, pageEnd);
  const formSource = source.slice(formStart, formEnd);

  assert.match(source, /timeSetEditorView: "supervisor\.outbound-dialer\.timeSetEditorView"/, "Time Sets view should use a scoped storage key");
  assert.match(source, /const TIME_SET_EDITOR_VIEWS = \["calendar", "detail"\]/, "Time Sets persisted tab should be validated against known views");
  assert.match(pageSource, /const \[timeSetEditorView, setTimeSetEditorView\] = useState\("calendar"\)/, "Time Sets editor should default to Calendar View");
  assert.match(pageSource, /localStorage\.getItem\(OUTBOUND_UI_STATE_STORAGE_KEYS\.timeSetEditorView\)/, "Time Sets editor should restore selected tab from localStorage");
  assert.match(pageSource, /TIME_SET_EDITOR_VIEWS\.includes\(savedTimeSetEditorView\)/, "Restored Time Sets tab should be validated");
  assert.match(pageSource, /localStorage\.setItem\(OUTBOUND_UI_STATE_STORAGE_KEYS\.timeSetEditorView, timeSetEditorView\)/, "Time Sets editor should save tab changes to localStorage");
  assert.match(pageSource, /<SettingsPanel[\s\S]*timeSetEditorView=\{timeSetEditorView\}[\s\S]*setTimeSetEditorView=\{setTimeSetEditorView\}/, "SettingsPanel should receive the persisted Time Sets tab state");
  assert.match(source, /<TimeSetSettingsForm[\s\S]*view=\{timeSetEditorView\}[\s\S]*setView=\{setTimeSetEditorView\}/, "TimeSetSettingsForm should be controlled by the page-level store state");
  assert.match(formSource, /function TimeSetSettingsForm\(\{[\s\S]*view[\s\S]*setView[\s\S]*\}\)/, "TimeSetSettingsForm should accept controlled tab props");
  assert.match(formSource, /variant=\{view === "calendar" \? "default" : "ghost"\}/, "Calendar tab should still reflect selected view");
  assert.match(formSource, /onClick=\{\(\) => setView\("calendar"\)\}/, "Calendar tab should update the persisted tab state");
  assert.match(formSource, /onClick=\{\(\) => setView\("detail"\)\}/, "Detail tab should update the persisted tab state");
  assert.doesNotMatch(formSource, /setView\(timeSet\?\.metadata\?\.view/, "Saved time set metadata should not override the user's persisted editor tab");
});

test("expanded history call attempt rows render one right-aligned status reason badge before info", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const accordionStart = source.indexOf("function ContactRecordAttemptAccordion");
  const accordionEnd = source.indexOf("function BarList", accordionStart);
  assert.ok(accordionStart > -1, "ContactRecordAttemptAccordion should exist");
  assert.ok(accordionEnd > accordionStart, "ContactRecordAttemptAccordion should end before BarList");

  const accordionSource = source.slice(accordionStart, accordionEnd);
  assert.match(accordionSource, /attemptStatusReasonLabel\(attempt\)/, "attempt rows should use the combined status/reason label");
  assert.match(accordionSource, /className="ml-auto flex shrink-0 items-center gap-2"/, "attempt status badge should sit in a right-aligned actions cluster");
  assert.match(accordionSource, /<Badge variant="outline" className=\{attemptStatusClass\(attempt\.status\)\}>\{statusReasonLabel\}<\/Badge>[\s\S]*<Button size="icon"/, "single status/reason badge should render immediately before the info button and use status styling");
  assert.doesNotMatch(accordionSource, /<Badge variant="outline" className=\{attemptStatusClass\(attempt\.status\)\}>\{title\(attempt\.status\)\}<\/Badge>/, "attempt row should not render a separate status badge on the left");
});

test("settings allowed numbers card uses requested title and CLI subtitle", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const settingsSummaryStart = source.indexOf("function SettingsSummaryView");
  const settingsSummaryEnd = source.indexOf("function CrudTable", settingsSummaryStart);
  const outboundFormStart = source.indexOf("function OutboundSettingsForm");
  const outboundFormEnd = source.indexOf("function ContactListSettingsForm", outboundFormStart);
  assert.ok(settingsSummaryStart > -1 && settingsSummaryEnd > settingsSummaryStart, "SettingsSummaryView should exist");
  assert.ok(outboundFormStart > -1 && outboundFormEnd > outboundFormStart, "OutboundSettingsForm should exist");

  const summarySource = source.slice(settingsSummaryStart, settingsSummaryEnd);
  const formSource = source.slice(outboundFormStart, outboundFormEnd);
  assert.match(summarySource, /title="Allowed Numbers" subtitle="Numbers enabled for campaigns to be used as CLI"/);
  assert.match(formSource, /title="Allowed Numbers" subtitle="Numbers enabled for campaigns to be used as CLI"/);
  assert.doesNotMatch(source, /Selected allowed numbers/);
  assert.doesNotMatch(source, /Numbers currently enabled for campaign FROM selection/);
});

test("campaign inventory uses runtime display state instead of raw campaign status", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const viewStart = source.indexOf("function CampaignsView");
  const viewEnd = source.indexOf("function ContactListsView", viewStart);
  assert.ok(viewStart > -1 && viewEnd > viewStart, "CampaignsView should exist");

  const viewSource = source.slice(viewStart, viewEnd);
  assert.match(source, /campaignInventoryDisplayState/, "page should import the inventory display view model");
  assert.match(viewSource, /campaignInventoryDisplayState\(c, contactLists, executionDebugByCampaign\?\.\[c\.id\]\)/, "Campaign Inventory should derive display status from runtime progress/debug");
  assert.match(viewSource, /statusClass\(displayState\)/, "Campaign Inventory status badge should use the derived display state");
  assert.doesNotMatch(viewSource, /statusClass\(c\.status\)/, "Campaign Inventory should not show raw running status for exhausted runtime campaigns");
});

test("campaign save action is disabled until audience, Target, and FROM slots are complete", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const formStart = source.indexOf("function CampaignSettingsForm");
  const formEnd = source.indexOf("function parseTtsVoiceString", formStart);
  assert.ok(formStart > -1 && formEnd > formStart, "CampaignSettingsForm should exist");

  const formSource = source.slice(formStart, formEnd);
  assert.match(source, /campaignSaveRequirements/, "page should import campaign save requirement validation");
  assert.match(formSource, /campaignReferenceKindForMode\(mode\)/, "Campaign form should derive Target kind directly from selected Mode");
  assert.match(formSource, /campaignSaveRequirements\(normalizedDraft, \{ maxAttempts: campaignMaxAttempts, settings: outboundSettings, templateVariables: messagingTemplateVariables \}\)/, "form should evaluate campaign save requirements with effective max attempts");
  assert.match(formSource, /disabled: saving \|\| !saveRequirements\.canSave/, "Save campaign header action should be disabled until requirements pass");
  assert.doesNotMatch(formSource, /label="Handler"/, "Dialing Strategy should not render a Handler dropdown");
  assert.doesNotMatch(formSource, /label="Reference"/, "Campaign configuration should rename Reference to Target");
  assert.match(formSource, /<CampaignReferenceSelect[\s\S]*label="Target"[\s\S]*required[\s\S]*kind=\{referenceKind\}/, "Dialing Strategy should render one required Target selector based on Mode");
  assert.match(source, /function CampaignReferenceSelect/, "Campaign Target selector should support richer queue labels");
  assert.match(source, /routingTypeBadgeClass/, "Queue targets should render routing type badges");
});

test("campaign required fields are marked with red asterisks instead of a missing-fields description", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const formStart = source.indexOf("function CampaignSettingsForm");
  const formEnd = source.indexOf("function parseTtsVoiceString", formStart);
  assert.ok(formStart > -1 && formEnd > formStart, "CampaignSettingsForm should exist");

  const formSource = source.slice(formStart, formEnd);
  assert.match(source, /function RequiredFieldLabel/, "page should render required field labels with a reusable helper");
  assert.match(source, /text-red-500/, "required asterisk should be styled red");
  assert.match(formSource, /<InputBlock label="Campaign Name"[^>]*required/, "Campaign Name should be marked required");
  assert.match(formSource, /<ConfigSelect label="Contact List"[^>]*required/, "Contact List should be marked required");
  assert.match(formSource, /<MultiSelect label="Contact List Numbers"[^>]*required/, "Contact List Numbers should be marked required");
  assert.match(formSource, /<ConfigSelect key=\{`from-slot-\$\{idx\}`\}[^>]*required=\{idx < saveRequirements\.requiredFromSlots\}/, "FROM number slots should only mark enforced slots required");
  assert.doesNotMatch(formSource, /saveRequirementsMessage/, "Campaign form should not render missing-fields descriptions");
  assert.doesNotMatch(formSource, /Required before saving/, "Campaign form should not render Required before saving copy");
});

test("call session details sheet is portaled to body so outbound history cannot embed it inside the center card", async () => {
  const source = await readFile(new URL("../components/contact-center/InteractionDetailsSheet.jsx", import.meta.url), "utf8");

  assert.match(source, /import \{ createPortal \} from "react-dom"/);
  assert.match(source, /createPortal\(/);
  assert.match(source, /document\.body/);
});

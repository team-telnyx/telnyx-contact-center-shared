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
  assert.match(cardSource, /buildDashboardCampaignExpandedStats\(\{ progress, live, summary, maxLines \}\)/, "card should use the expanded stats view model");
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

test("expanded history call attempt rows render one right-aligned status reason badge before info", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const accordionStart = source.indexOf("function ContactRecordAttemptAccordion");
  const accordionEnd = source.indexOf("function BarList", accordionStart);
  assert.ok(accordionStart > -1, "ContactRecordAttemptAccordion should exist");
  assert.ok(accordionEnd > accordionStart, "ContactRecordAttemptAccordion should end before BarList");

  const accordionSource = source.slice(accordionStart, accordionEnd);
  assert.match(accordionSource, /attemptStatusReasonLabel\(attempt\)/, "attempt rows should use the combined status/reason label");
  assert.match(accordionSource, /className="ml-auto flex shrink-0 items-center gap-2"/, "attempt status badge should sit in a right-aligned actions cluster");
  assert.match(accordionSource, /<Badge variant="outline" className=\{reasonCodeClass\(reason\)\}>\{statusReasonLabel\}<\/Badge>[\s\S]*<Button size="icon"/, "single status/reason badge should render immediately before the info button");
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

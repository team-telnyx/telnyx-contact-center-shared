import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "@babel/parser";
import { compile } from "@mdx-js/mdx";
import { VOICE_FLOW_NODES } from "../config/voice-flow-nodes.js";
import { ASSISTANT_TOOL_TYPES } from "../config/assistant-tools.js";
import { AI_OPERATIONS } from "../lib/ai-operations/catalog.mjs";
import { CHANNEL_REGISTRY } from "../lib/acd/channel-registry.mjs";
import { BINDING_TRIGGERS } from "../lib/agent-assist/slot-mcp-runner.mjs";
import { HELP_TOPICS, SCREEN_HELP, DEFAULT_HELP_ID, resolveScreenHelpId, getHelpTopic } from "../lib/help/help-registry.js";
import { documentationErrors, filesBelow, helpInventory, literalRows, read, tableRows } from "./helpers/help-coverage.mjs";

const inventory = await helpInventory();
const assertLinks = (links) => assert.deepEqual(documentationErrors(inventory, links), []);

// Discover screens and catalog features from application sources, not fixed
// counts. For behavior without a catalog entry, add an actionable section to
// the cross-screen workflow check and a focused UI/browser regression below.
// Structural coverage cannot establish that prose accurately describes runtime
// behavior; feature changes still require a documentation review.

function assertDescribedRow(rows, label, context) {
  const row = rows.find(row => row[0] === label);
  assert.ok(row, `${context}: missing description for ${label}`);
  assert.ok(row.slice(1).join(" ").length >= 40, `${context}: ${label} needs an explanation, not just a label`);
}

test("every portal page has an explicit F1 mapping to a real article", async () => {
  const pages = (await filesBelow("app/(portal)")).filter(file => /\/page\.(jsx?|tsx?)$/.test(file));
  const routes = pages.map(file => file.replace(/^app\/\(portal\)/, "").replace(/\/page\.(jsx?|tsx?)$/, "") || "/");
  const declared = SCREEN_HELP.map(entry => entry.pathname);
  assert.equal(new Set(declared).size, declared.length, "duplicate F1 routes");
  assert.deepEqual([...declared].sort(), routes.sort(), "A new/removed screen needs an explicit Help mapping; parent fallback does not count");
  for (const route of routes) {
    const expected = SCREEN_HELP.find(entry => entry.pathname === route);
    const actual = resolveScreenHelpId(route.replace(/\[[^\]]+\]/g, "example-id"));
    assert.notEqual(actual, DEFAULT_HELP_ID, route);
    assert.equal(actual, expected.helpId, `wrong F1 destination for ${route}`);
    assertLinks([getHelpTopic(actual).articleHref]);
  }
});

test("all contextual topics and internal links resolve to existing articles and sections", () => {
  assertLinks(Object.values(HELP_TOPICS).map(topic => topic.articleHref));
  for (const [url, article] of inventory) {
    const links = [
      ...article.source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
      ...article.source.matchAll(/href="([^"\s]+)"/g),
    ].map(match => match[1]);
    const internal = links.filter(href => !/^[a-z]+:/i.test(href) && !href.startsWith("//")).map(href => {
      const resolved = new URL(href, `https://help.invalid${url}`);
      return resolved.pathname + resolved.hash;
    }).filter(href => href.startsWith("/help"));
    assert.deepEqual(documentationErrors(inventory, internal), [], article.file);
  }
});

test("all Help pages are reachable through sidebar metadata, with no missing or duplicate entries", async () => {
  const reachable = new Set();
  async function visit(directory) {
    const meta = JSON.parse(await read(`${directory}/meta.json`));
    assert.equal(new Set(meta.pages).size, meta.pages.length, `${directory}: duplicate entry`);
    for (const slug of meta.pages) {
      const prefix = directory.replace(/^content\/help/, "/help");
      const url = slug === "index" ? prefix : `${prefix}/${slug}`;
      const article = inventory.get(url);
      assert.ok(article, `${directory}: missing ${slug}`);
      if (slug !== "index" && article.file.endsWith("/index.mdx")) await visit(`${directory}/${slug}`);
      else {
        assert.ok(!reachable.has(url), `duplicate navigation to ${url}`);
        reachable.add(url);
      }
    }
  }
  await visit("content/help");
  assert.deepEqual([...reachable].sort(), [...inventory.keys()].sort(), "An article exists but is absent from navigation");
});

test("every actual Call Flow node has a navigable reference article", async () => {
  const meta = JSON.parse(await read("content/help/administration/call-flows/nodes/meta.json"));
  const expected = Object.keys(VOICE_FLOW_NODES).map(id => id.replaceAll("_", "-")).sort();
  assert.deepEqual(meta.pages.filter(slug => slug !== "index").sort(), expected, "Update Help when adding/removing a node; no fixed node-count assertion");
  assertLinks(expected.map(slug => `/help/administration/call-flows/nodes/${slug}`));
});

test("Admin overview puts every rail item in its own correct group", async () => {
  const rows = tableRows(inventory.get("/help/administration").source);
  for (const [label, file, variable] of [
    ["AI Assistants", "components/assistants/AiAssistantsSectionNav.jsx", "AI_SECTION_ITEMS"],
    ["Configuration", "components/admin/ConfigurationSectionNav.jsx", "CONFIGURATION_ITEMS"],
    ["System", "components/admin/SystemSectionNav.jsx", "SYSTEM_ITEMS"],
    ["Automations", "components/admin/AutomationsSectionNav.jsx", "AUTOMATION_ITEMS"],
  ]) {
    const actual = await literalRows(file, variable);
    const documented = rows.find(row => row[0] === label)?.[1].split(", ");
    assert.deepEqual(documented, actual.map(row => row.label), `${label}: an item is missing, misordered or in the wrong group`);
  }
});

test("assistant sections, tool types and AI operations all have functional descriptions", async () => {
  const sections = await literalRows("components/assistants/AssistantEditor.jsx", "RAIL_ITEMS");
  const assistant = tableRows(inventory.get("/help/administration/ai-assistants").source);
  for (const item of sections) assertDescribedRow(assistant, item.label, "Assistant editor");
  const tools = tableRows(inventory.get("/help/administration/tools-library").source);
  for (const item of ASSISTANT_TOOL_TYPES) assertDescribedRow(tools, item.label, "Tools Library");
  const operations = tableRows(inventory.get("/help/administration/system/ai-copilot").source);
  for (const item of AI_OPERATIONS) assertDescribedRow(operations, item.title, "AI Copilot");
});

test("every released channel has an agent procedure and configuration guide", () => {
  const guides = {
    voice: ["/help/agent/handling-calls", "/help/administration/call-flows"],
    chat: ["/help/agent/desktop#native-chat", "/help/administration/chat-widgets"],
    email: ["/help/agent/desktop#email", "/help/administration/email"],
    sms: ["/help/agent/desktop#sms", "/help/administration/sms"],
    whatsapp: ["/help/agent/desktop#whatsapp-locations-contact-cards-and-reactions", "/help/administration/whatsapp"],
    video: ["/help/agent/video-calls", "/help/administration/chat-widgets#video-calls-with-ai-and-vision"],
  };
  assert.deepEqual(Object.keys(guides).sort(), Object.values(CHANNEL_REGISTRY).filter(channel => channel.released).map(channel => channel.id).sort());
  assertLinks(Object.values(guides).flat());
});

test("every workflow MCP trigger has a functional description", async () => {
  const controls = await literalRows("components/admin/SlotMcpBindingEditor.jsx", "TRIGGERS");
  assert.deepEqual(controls.map(item => item.value).sort(), Object.values(BINDING_TRIGGERS).sort());
  const rows = tableRows(inventory.get("/help/administration/workflows/mcp-bindings").source);
  for (const trigger of Object.values(BINDING_TRIGGERS)) assertDescribedRow(rows, `\`${trigger}\``, "MCP binding triggers");
});

test("critical cross-screen workflows retain actionable sections and limitations", () => {
  assertLinks([
    "/help/administration/system/schedules#exception-calendars",
    "/help/administration/system/schedules#import-holidays-or-your-own-dates",
    "/help/administration/call-flows/nodes/schedules#inspect-and-test",
    "/help/administration/call-flows/validation-testing#conversation-websocket-conflicts",
    "/help/administration/ai-assistants#known-limitations",
    "/help/administration/ai-assistants#save-versions-and-testing",
    "/help/administration/system/ai-copilot#model-inheritance",
    "/help/administration/workflows/testing#voice-tests",
    "/help/administration/workflows/mcp-bindings#corrections-retries-and-submissions",
    "/help/administration/workflows/mcp-bindings#template-helpers",
    "/help/profile#language-and-personal-details",
    "/help/profile#notification-sounds",
    "/help/mobile#forget-a-retired-device",
    "/help/webrtc-phone/devices#move-an-active-call",
    "/help/agent/cobrowsing#request-control-separately",
    "/help/agent/video-calls#vision-consent-and-source-selection",
    "/help/agent/agent-assist#three-speaker-transcription",
    "/help/agent/agent-assist#confirm-a-transport-submission",
    "/help/supervisor/monitoring#video-supervision",
    "/help/supervisor/analytics#channel-scope-and-service-levels",
    "/help/supervisor/call-history#recordings-and-transcription",
    "/help/administration/queues#channels-and-utilization",
    "/help/webrtc-phone/troubleshooting#connection-quality",
  ]);
});

test("every literal UI help identifier resolves; key feature controls retain their context", async () => {
  const found = new Map();
  for (const file of [...await filesBelow("components"), ...await filesBelow("app/(portal)")].filter(file => /\.(jsx?|tsx?)$/.test(file))) {
    const source = await read(file);
    for (const [, id] of source.matchAll(/data-help-id="([^"]+)"/g)) {
      assert.ok(getHelpTopic(id), `${file}: unknown help ID ${id}`);
      found.set(file, [...(found.get(file) || []), id]);
    }
  }
  for (const [file, id] of [
    ["components/voice-flow/ScheduleNodeEditor.jsx", "admin.call-flows.schedules"],
    ["components/admin/SlotMcpBindingEditor.jsx", "admin.workflows.mcp"],
    ["components/voice-flow/AssistantInviteSettings.jsx", "admin.call-flows.assistant-invite"],
    ["components/contact-center/VoiceAssistantInvite.jsx", "agent.assistant-invite"],
    ["components/contact-center/VideoInteractionDetail.jsx", "agent.video"],
    ["components/contact-center/CobrowseAgentViewer.jsx", "agent.cobrowse"],
    ["components/contact-center/VoiceEndpointSelector.jsx", "phone.devices"],
    ["components/contact-center/handoff/DeviceHandoffDialog.jsx", "phone.devices"],
    ["app/(portal)/profile/page.jsx", "profile.devices"],
  ]) assert.ok(found.get(file)?.includes(id), `${file}: lost feature-level F1 context`);
});

test("coverage validation rejects a removed article, removed section and placeholder", () => {
  const href = "/help/administration/system/schedules#exception-calendars";
  const missingPage = new Map(inventory);
  missingPage.delete(href.split("#")[0]);
  assert.match(documentationErrors(missingPage, [href])[0], /Missing article/);
  const placeholderPage = new Map(inventory);
  placeholderPage.set(href.split("#")[0], { source: "TODO", sections: new Map() });
  assert.match(documentationErrors(placeholderPage, [href])[0], /placeholder article/);
  for (const content of [undefined, "TODO"]) {
    const broken = new Map(inventory);
    const original = inventory.get(href.split("#")[0]);
    const sections = new Map(original.sections);
    if (content === undefined) sections.delete("exception-calendars");
    else sections.set("exception-calendars", content);
    broken.set(href.split("#")[0], { ...original, sections });
    assert.equal(documentationErrors(broken, [href]).length, 1);
  }
});

test("every Help article compiles as MDX and all touched UI context files parse", async () => {
  for (const article of inventory.values()) {
    await compile({ value: article.source.replace(/^---\n[\s\S]*?\n---\n/, ""), path: article.file });
  }
  for (const file of ["components/voice-flow/ScheduleNodeEditor.jsx", "components/voice-flow/AssistantInviteSettings.jsx", "components/contact-center/CobrowseAgentViewer.jsx", "components/contact-center/CobrowseAgentModal.jsx", "components/contact-center/VideoInteractionDetail.jsx", "components/contact-center/VoiceAssistantInvite.jsx", "components/contact-center/VoiceEndpointSelector.jsx", "components/contact-center/handoff/DeviceHandoffDialog.jsx", "components/profile/VoiceDevicesCard.jsx", "components/profile/MobileAppSetupCard.jsx", "app/(portal)/profile/page.jsx"])
    parse(await read(file), { sourceType: "module", plugins: ["jsx"] });
});

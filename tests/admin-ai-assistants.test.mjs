import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeAssistantPayload } from "../lib/ai/assistant-payload.mjs";
import { telnyxErrorDetail } from "../lib/telnyx-error.mjs";
import { stripTtsExpressionTags } from "../lib/ai/tts-expression-text.mjs";

const root = new URL("../", import.meta.url);

test("Admin navigation exposes AI Assistants to admin and owner roles", async () => {
  const source = await readFile(new URL("config/menu.jsx", root), "utf8");
  assert.match(source, /title:\s*"AI Assistants"/);
  assert.match(source, /url:\s*"\/admin\/ai-assistants"/);
  assert.match(source, /role_access:\s*\["admin",\s*"owner"\]/);
});

test("AI Assistant editor represents every demo portal tab in the section rail", async () => {
  const source = await readFile(new URL("components/assistants/AssistantEditor.jsx", root), "utf8");
  for (const section of [
    "dashboard",
    "agent",
    "voice",
    "workflow",
    "integrations",
    "insights",
    "calling",
    "messaging",
    "widget",
    "privacy",
    "conversations",
  ]) {
    assert.match(source, new RegExp(`id:\\s*"${section}"`), `missing ${section} rail item`);
  }
  assert.match(source, /<SectionRail[\s\S]*items=\{RAIL_ITEMS\}/);
  assert.doesNotMatch(source, /<JsonField/);
});

test("AI Assistant Call opens the dedicated AI phone widget and unsaved exit uses a custom dialog", async () => {
  const editor = await readFile(new URL("components/assistants/AssistantEditor.jsx", root), "utf8");
  const phone = await readFile(new URL("components/assistants/AssistantPhoneWidget.jsx", root), "utf8");
  assert.match(editor, /import AssistantPhoneWidget/);
  assert.match(editor, /setShowPhone\(true\)/);
  assert.match(editor, /<AssistantPhoneWidget/);
  assert.doesNotMatch(editor, /softphone:open/);
  assert.doesNotMatch(editor, /window\.confirm/);
  assert.match(editor, /<AlertDialog open=\{leaveOpen\}/);
  assert.match(editor, /Leave without saving/);
  assert.match(editor, /document\.addEventListener\("click", interceptInternalNavigation, true\)/);
  assert.match(editor, /closest\("a\[href\]"\)/);
  assert.match(editor, /setLeaveTarget\(target\)/);
  assert.match(editor, /skipLeaveGuardRef\.current = true/);
  assert.match(editor, /window\.location\.assign\(target\)/);
  assert.match(phone, /TelnyxAIAgentProvider/);
  assert.match(phone, /client\.startConversation/);
  assert.match(phone, /client\.sendConversationMessage/);
  assert.match(phone, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(phone, /track\.enabled = !nextMuted/);
  assert.match(phone, /PANEL_WIDTH = 320/);
  assert.match(phone, /PANEL_HEIGHT = 690/);
  assert.match(phone, /data-drag-handle/);
  assert.match(phone, /<AudioVisualizer/);
  assert.match(phone, /min-h-0 flex-1 border-t/);
  assert.match(phone, /Audio visualizer will appear during calls/);
  assert.match(phone, /Real-time transcription will appear here during calls/);
  assert.match(phone, /stripTtsExpressionTags\(message\.content\)/);
});

test("assistant webhook presets only expose Contact Center data sources", async () => {
  const integrations = await readFile(new URL("components/assistants/IntegrationsTab.jsx", root), "utf8");
  const sources = await import("../config/contact-center-data-sources.js");
  assert.deepEqual(
    sources.CONTACT_CENTER_DATA_SOURCES.map(({ id, label }) => ({ id, label })),
    [
      { id: "contacts", label: "Contacts" },
      { id: "kb_articles", label: "KB Articles" },
      { id: "tasks", label: "Tasks" },
    ]
  );
  assert.equal(
    sources.getContactCenterDataSourceActions("contacts").find(({ id }) => id === "search")?.urlPattern,
    "{basePath}"
  );
  assert.equal(
    sources.getContactCenterDataSourceActions("kb_articles").find(({ id }) => id === "update")?.method,
    "PUT"
  );
  assert.deepEqual(sources.getContactCenterDataSourceActions("appointments"), []);
  assert.match(integrations, /CONTACT_CENTER_DATA_SOURCES\.map/);
  assert.doesNotMatch(integrations, /DEMO_ENTITIES\.map/);
});

test("AI phone transcript hides TTS emotion expression tags from assistant bubbles", () => {
  assert.equal(stripTtsExpressionTags('<emotion value="happy" />Thank you!'), "Thank you!");
  assert.equal(stripTtsExpressionTags('<emotion value="enthusiastic">Great!</emotion>'), "Great!");
  assert.equal(stripTtsExpressionTags('<EMOTION value="calm"/> Hello <emotion value="happy" />there'), "Hello there");
  assert.equal(stripTtsExpressionTags('<emotion value="happy" />'), "");
  assert.equal(stripTtsExpressionTags("Plain response"), "Plain response");
});

test("assistant payload normalization converts UI-only voice, voicemail, webhook, and workflow fields", () => {
  const payload = normalizeAssistantPayload({
    voice_settings: { elevenlabs_settings: { similarity_boost: 0.8, speed: 1.2 } },
    telephony_settings: { voicemail_detection: { on_voicemail_detected: "leave_message", voicemail_message: "Please call back" } },
    tools: [{ type: "webhook", async: true, webhook: { timeout_secs: 12 } }],
    conversation_flow: { nodes: [{ id: "n1", tools_override: true, tools_mode: "replace" }] },
  });
  assert.equal(payload.voice_settings.similarity_boost, 0.8);
  assert.equal(payload.voice_settings.voice_speed, 1.2);
  assert.equal(payload.telephony_settings.voicemail_detection.on_voicemail_detected.action, "leave_message_and_stop_assistant");
  assert.equal(payload.tools[0].webhook.timeout_ms, 12000);
  assert.equal(payload.tools[0].webhook.async, true);
  assert.equal("tools_override" in payload.conversation_flow.nodes[0], false);
});

test("assistant payload preserves MiniMax automatic language detection", () => {
  const payload = normalizeAssistantPayload({ voice_settings: { language_boost: "Auto" } });
  assert.equal(payload.voice_settings.language_boost, "auto");
});

test("Telnyx errors shown by the assistant editor use the API detail", () => {
  const raw = JSON.stringify({ errors: [{ title: "Bad Request", detail: "language_boost is invalid" }] });
  assert.equal(telnyxErrorDetail(raw), "language_boost is invalid");
});

test("assistant voice picker keeps dotted model ids selected", async () => {
  const source = await readFile(new URL("components/assistants/VoicePicker.jsx", root), "utf8");
  assert.match(source, /parseVoiceString\(voice, providers\)/);
  assert.match(source, /parts\.slice\(1, -1\)\.join\("\."\)/);
  assert.match(source, /value: language/);
  assert.match(source, /language === "auto"/);
  assert.doesNotMatch(source, /__auto__/, "Auto must be sent to Telnyx as the literal `auto`");
  assert.doesNotMatch(source, /None \(default\)/);
  assert.match(source, /parts\.length === 2 && defaultModel/);
  assert.match(source, /XAI_LANGUAGE_OPTIONS/);
  assert.match(source, /\["vi", "Vietnamese"\]/);

  const start = source.indexOf("function parseVoiceString");
  const end = source.indexOf("function buildVoiceString", start);
  const parseVoiceString = vm.runInNewContext(
    `${source.slice(start, end)}; parseVoiceString;`
  );
  const providers = [{
    id: "XAI",
    models: [{ id: "default", name: "Default", voices: [{ id: "XAI.eve" }] }],
  }];
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseVoiceString("xAI.eve", providers))),
    { provider: "XAI", model: "default", voiceName: "XAI.eve" }
  );
});

test("AI Assistant routes provide list, create, and edit views", async () => {
  const files = [
    "app/(portal)/admin/ai-assistants/page.jsx",
    "app/(portal)/admin/ai-assistants/new/page.jsx",
    "app/(portal)/admin/ai-assistants/[id]/page.jsx",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /Assistant(List|Editor)/, `${file} does not render an assistant view`);
  }
});

test("AI Assistants rail exposes pronunciation dictionary management", async () => {
  const rail = await readFile(new URL("components/assistants/AiAssistantsSectionNav.jsx", root), "utf8");
  const page = await readFile(new URL("app/(portal)/admin/ai-assistants/pronunciation-dictionaries/page.jsx", root), "utf8");
  const voicePicker = await readFile(new URL("components/assistants/VoicePicker.jsx", root), "utf8");
  const listRoute = await readFile(new URL("app/api/ai/pronunciation-dictionaries/route.js", root), "utf8");
  const itemRoute = await readFile(new URL("app/api/ai/pronunciation-dictionaries/[id]/route.js", root), "utf8");

  assert.match(rail, /id: "pronunciation-dictionaries"/);
  assert.match(rail, /href: "\/admin\/ai-assistants\/pronunciation-dictionaries"/);
  assert.match(page, /<AiAssistantsSectionPage activeId="pronunciation-dictionaries">/);
  assert.match(page, /New Pronunciation Dictionary/);
  assert.match(page, /\/api\/tts\/speech/);
  assert.match(page, /Upload file/);
  assert.match(voicePicker, /href="\/admin\/ai-assistants\/pronunciation-dictionaries"/);
  assert.match(listRoute, /export async function GET/);
  assert.match(listRoute, /export async function POST/);
  assert.match(itemRoute, /export async function GET/);
  assert.match(itemRoute, /export async function PATCH/);
  assert.match(itemRoute, /export async function DELETE/);
});

test("AI Assistants rail tables use the Tools Library icon action pattern", async () => {
  const files = [
    "components/assistants/AssistantList.jsx",
    "app/(portal)/admin/ai-assistants/pronunciation-dictionaries/page.jsx",
    "app/(portal)/admin/insights/page.jsx",
    "app/(portal)/supervisor/scheduled-events/page.jsx",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /inline-flex items-center/);
    assert.match(source, /text-red-500 hover:text-red-700/);
    assert.match(source, /<IconTrash className="size-4"/);
  }

  const dictionaries = await readFile(
    new URL("app/(portal)/admin/ai-assistants/pronunciation-dictionaries/page.jsx", root),
    "utf8"
  );
  assert.match(dictionaries, /title="Edit dictionary"[\s\S]*<IconPencil className="size-4"/);
  assert.match(dictionaries, /title="Delete dictionary"[\s\S]*<IconTrash className="size-4"/);
  assert.doesNotMatch(dictionaries, /<IconPencil className="size-4 mr-1"[\s\S]*Edit/);
  assert.doesNotMatch(dictionaries, /<IconTrash className="size-4 mr-1"[\s\S]*Delete/);
});

test("MCP Servers are owned only by the AI Assistants navigation", async () => {
  const configurationRail = await readFile(
    new URL("components/admin/ConfigurationSectionNav.jsx", root),
    "utf8"
  );
  const assistantsRail = await readFile(
    new URL("components/assistants/AiAssistantsSectionNav.jsx", root),
    "utf8"
  );
  const mcpPage = await readFile(
    new URL("app/(portal)/admin/mcp-servers/page.jsx", root),
    "utf8"
  );
  const menu = await readFile(new URL("config/menu.jsx", root), "utf8");

  assert.doesNotMatch(configurationRail, /id: "mcp-servers"/);
  assert.match(assistantsRail, /id: "mcp-servers"[\s\S]*href: "\/admin\/mcp-servers"/);
  assert.doesNotMatch(assistantsRail, /\/admin\/mcp-servers\?rail=ai/);
  assert.match(mcpPage, /<AiAssistantsSectionPage activeId="mcp-servers">/);
  assert.doesNotMatch(mcpPage, /ConfigurationSectionPage|useSearchParams|rail=ai/);
  assert.match(menu, /title: "AI Assistants"[\s\S]*activeUrls: \[[^\]]*"\/admin\/mcp-servers"/);
  assert.doesNotMatch(menu, /inactiveUrlQueries:[^\n]*mcp-servers/);
});

test("Pronunciation Dictionaries follows Scheduled Events in the AI Assistants rail", async () => {
  const rail = await readFile(
    new URL("components/assistants/AiAssistantsSectionNav.jsx", root),
    "utf8"
  );
  assert.ok(
    rail.indexOf('id: "scheduled-events"') < rail.indexOf('id: "pronunciation-dictionaries"'),
    "Pronunciation Dictionaries should appear below Scheduled Events"
  );
});

test("AI Assistant dashboard matches the demo portal executive review layout", async () => {
  const source = await readFile(new URL("components/assistants/AssistantDashboardTab.jsx", root), "utf8");
  for (const label of [
    "Use case summary",
    "LLM model",
    "STT provider/model",
    "TTS voice",
    "Total interactions",
    "Voice calls",
    "SMS + Chat",
    "Average latency",
    "Interactions over time",
    "Latency distribution",
  ]) assert.match(source, new RegExp(label.replace(/[+]/g, "\\+")));
  assert.match(source, /dashboard-summary/);
  assert.match(source, /metadata->assistant_id/);
  assert.doesNotMatch(source, /Executive configuration overview generated/);
  assert.doesNotMatch(source, />Refresh data</);
  assert.match(source, /flex h-full min-h-0 flex-col/);
  assert.match(source, /min-h-\[20rem\] flex-1/);
});

test("Dashboard summary uses a Telnyx-hosted chat completion model without requiring an OpenAI key", async () => {
  const source = await readFile(new URL("app/api/ai/assistants/[id]/dashboard-summary/route.js", root), "utf8");
  assert.match(source, /\/ai\/chat\/completions/);
  assert.match(source, /meta-llama\/Llama-3\.3-70B-Instruct/);
  assert.doesNotMatch(source, /\|\| "openai\/gpt-4o-mini"/);
});

test("Agent model selectors match the demo portal and only show Telnyx-recommended assistant models", async () => {
  const agentSource = await readFile(new URL("components/assistants/AgentSettingsPanel.jsx", root), "utf8");
  const pickerSource = await readFile(new URL("components/assistants/AIModels.jsx", root), "utf8");
  const apiSource = await readFile(new URL("app/api/ai/models/route.js", root), "utf8");
  assert.match(agentSource, /filter\(\(model\) => model\.recommended_for_assistants\)/);
  assert.match(agentSource, /<AIModels[\s\S]*models=\{recommendedModels\}/);
  assert.match(agentSource, /Fallback Model[\s\S]*<AIModels/);
  assert.match(pickerSource, /Search models\.\.\./);
  assert.match(pickerSource, /<SelectGroup>/);
  assert.match(pickerSource, /<ModelDetails/);
  assert.match(apiSource, /recommended_for_assistants: model\?\.recommended_for_assistants === true/);
  assert.match(apiSource, /raw: model \|\| null/);
});

test("Assistant conversations expose the demo portal recording and session actions", async () => {
  const source = await readFile(new URL("components/assistants/AssistantConversationsPanel.jsx", root), "utf8");
  assert.match(source, /title="Play recording"/);
  assert.match(source, /title="View Voice API session details"/);
  assert.match(source, /title="View TeXML session details"/);
  assert.match(source, /title="Preview messages"/);
  assert.match(source, /<RecordingPlayer/);
  assert.match(source, /<AssistantCallSessionSheet/);
  assert.match(source, /<ConversationMessagesSheet conversation=\{conversation\}>/);
  const sheetSource = await readFile(new URL("components/assistants/ConversationMessagesSheet.jsx", root), "utf8");
  assert.match(sheetSource, /call_session_id/);
  assert.match(sheetSource, /<AiConversationMessagesTab/);
  assert.match(sheetSource, /onSeek=\{\(timeInSeconds\) =>/);
  assert.match(sheetSource, /wavesurferRef\.current\.seekTo/);
  assert.match(source, /fixed inset-x-0 bottom-0[\s\S]*w-screen/);
  const sessionSource = await readFile(new URL("components/assistants/AssistantCallSessionSheet.jsx", root), "utf8");
  for (const icon of ["IconPhoneIncoming", "IconPhoneOff", "IconLink", "IconPlayerPlay", "IconFileText", "IconRobot"]) assert.match(sessionSource, new RegExp(icon));
  assert.match(sessionSource, /<TabsTrigger value="costs">Costs<\/TabsTrigger>/);
  assert.match(sessionSource, /<AiConversationCostsTab/);
  const eventsRoute = await readFile(new URL("app/api/voice/call-history/events/route.js", root), "utf8");
  assert.match(eventsRoute, /data: data\.data \|\| \[\]/);
  assert.doesNotMatch(eventsRoute, /payload: event\.metadata \|\| event\.payload/);
});

test("Next dev origins are normalized to hostnames for stable proxied HMR", async () => {
  const source = await readFile(new URL("next.config.mjs", root), "utf8");
  assert.match(source, /function devOriginHostname/);
  assert.match(source, /new URL\(candidate\.includes\(":\/\/"\)/);
  assert.match(source, /allowedDevOrigins,/);
  assert.match(source, /allowedOrigins: allowedDevOrigins/);
});

test("Voice through Privacy use the demo portal tabs inside fixed rail-height cards", async () => {
  const editor = await readFile(new URL("components/assistants/AssistantEditor.jsx", root), "utf8");
  const tabs = ["VoiceTab", "AssistantWorkflowTab", "IntegrationsTab", "InsightsTab", "CallingTab", "MessagingTab", "WidgetTab", "PrivacyTab"];
  for (const tab of tabs) {
    assert.match(editor, new RegExp(`import ${tab}`));
    assert.match(editor, new RegExp(`<${tab}`));
  }
  assert.match(editor, /function FixedRailCard/);
  assert.match(editor, /flex h-full min-h-0 w-full flex-col overflow-hidden/);
  assert.match(editor, /activeSection === "workflow"[\s\S]*<FixedRailCard scroll=\{false\}>/);
  const workflow = await readFile(new URL("components/assistants/AssistantWorkflowTab.jsx", root), "utf8");
  assert.match(workflow, /flex h-full min-h-0 flex-col[\s\S]*overflow-hidden/);
  const calling = await readFile(new URL("components/assistants/CallingTab.jsx", root), "utf8");
  assert.match(calling, /h-full min-h-0 w-full overflow-y-auto/);
  assert.match(calling, /Voice Numbers[\s\S]*Call Settings Card[\s\S]*Call Settings/);
  assert.doesNotMatch(calling, /<Card className="h-full min-h-0 w-full overflow-hidden">/);
  const widgetRoute = await readFile(new URL("app/api/ai/assistants\/\[id\]\/route.js", root), "utf8");
  assert.match(widgetRoute, /export async function POST\(request, context\)/);
});

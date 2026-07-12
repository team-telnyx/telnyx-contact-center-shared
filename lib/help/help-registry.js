const QUEUES_ARTICLE = "/help/administration/queues";
const USERS_ARTICLE = "/help/administration/users";
const SKILLS_ARTICLE = "/help/administration/skills";

/**
 * Canonical contextual-help copy.
 *
 * Keep field and screen snippets here so the in-app sheet and full help
 * articles can render the same content by help ID.
 */
export const HELP_TOPICS = Object.freeze({
  "help.overview": {
    id: "help.overview",
    scope: "screen",
    title: "Contact Center Help",
    summary:
      "Browse setup guides, day-to-day workflows, and explanations of contact center features.",
    paragraphs: [
      "Open the full help center to browse all chapters or search for a topic. On supported screens, this panel shows help for the field you are currently using.",
    ],
    articleHref: "/help",
  },
  "agent.desktop.screen": {
    id: "agent.desktop.screen",
    scope: "screen",
    title: "Agent Workspace",
    summary: "Handle live interactions, Agent Assist, forms, data sources, outbound assignments, and after-call work.",
    paragraphs: [
      "Use the application header to select status and activate queues or campaigns, then use WebRTC Phone for all call controls.",
    ],
    tips: [
      "After an answered call ends, complete the Wrapup Codes sheet before accepting the next interaction.",
    ],
    articleHref: "/help/agent",
  },
  "supervisor.monitor.screen": {
    id: "supervisor.monitor.screen",
    scope: "screen",
    title: "Live Monitoring",
    summary: "Observe realtime contact-center, agent, queue, waiting-caller, and active-call conditions.",
    paragraphs: ["Filter the view to identify the cause of service pressure before changing status, routing, or skills."],
    articleHref: "/help/supervisor/monitoring",
  },
  "supervisor.analytics.screen": {
    id: "supervisor.analytics.screen",
    scope: "screen",
    title: "Analytics",
    summary: "Analyze queue, agent, abandonment, adherence, transfer, wrap-up, AI, outbound, skills, and call-history data.",
    paragraphs: ["Use the same date range and filters before comparing values across reports."],
    articleHref: "/help/supervisor/analytics",
  },
  "supervisor.quality.screen": {
    id: "supervisor.quality.screen",
    scope: "screen",
    title: "Quality",
    summary: "Review quality trends, evaluate recorded conversations, and manage weighted scorecards.",
    paragraphs: ["AI evaluation output remains a draft until the required human review is complete."],
    articleHref: "/help/supervisor/quality",
  },
  "supervisor.outbound-dialer.screen": {
    id: "supervisor.outbound-dialer.screen",
    scope: "screen",
    title: "Outbound Dialer",
    summary: "Configure campaigns, contact lists, eligibility, compliance, attempts, and live outbound operations.",
    paragraphs: ["Validate lists and test DNC, time, retry, disposition, and handler behavior before starting a campaign."],
    articleHref: "/help/supervisor/outbound-dialer",
  },
  "admin.users.screen": {
    id: "admin.users.screen",
    scope: "screen",
    title: "Users",
    summary:
      "Create and manage accounts, access roles, invitations, phone numbers, queue assignments, and agent proficiency.",
    paragraphs: [
      "Use this screen to control who can sign in and which contact-center work each user is eligible to receive.",
    ],
    tips: [
      "After creating a user, reopen the account to complete activation, queue, skill, and number settings.",
      "Owner accounts cannot be deleted; deactivate an account when access should be suspended without removing it.",
    ],
    articleHref: USERS_ARTICLE,
  },
  "admin.queues.screen": {
    id: "admin.queues.screen",
    scope: "screen",
    title: "Queues",
    summary:
      "Create and manage the queues that hold calls until an eligible agent can handle them.",
    paragraphs: [
      "Use this screen to control how calls wait, how agents are selected, and what happens when a queue reaches its limits.",
    ],
    tips: [
      "Choose New Queue to create a queue, or use the edit action on an existing row.",
      "While this help panel is open, focus a supported field to see its explanation.",
    ],
    articleHref: QUEUES_ARTICLE,
  },
  "admin.queues.form.name": {
    id: "admin.queues.form.name",
    scope: "field",
    title: "Queue name",
    summary: "The stable internal identifier used to reference this queue.",
    paragraphs: [
      "Choose a short, recognizable name. Treat it as a technical identifier; use Display Name when agents need a more readable label.",
    ],
    tips: ["Use a consistent naming pattern such as support-billing or sales-emea."],
    articleHref: `${QUEUES_ARTICLE}#queue-name`,
  },
  "admin.queues.form.routing-strategy": {
    id: "admin.queues.form.routing-strategy",
    scope: "field",
    title: "Routing strategy",
    summary: "Controls how the queue chooses the next call and eligible agent.",
    paragraphs: [
      "FIFO handles calls in arrival order. Skill-based routing considers the skills required by a call. Priority-based routing considers call priority when deciding which waiting call should be handled first.",
    ],
    tips: [
      "Use skill-based routing only after agent skills and call skill requirements are configured.",
    ],
    articleHref: `${QUEUES_ARTICLE}#routing-strategy`,
  },
  "admin.queues.form.max-wait-time": {
    id: "admin.queues.form.max-wait-time",
    scope: "field",
    title: "Maximum wait time",
    summary:
      "The configured maximum waiting duration, in seconds, stored for this queue.",
    paragraphs: [
      "The local routing path does not currently apply overflow automatically when this duration elapses. Configure any required timeout, transfer, voicemail, or disconnect behavior explicitly in the call flow.",
    ],
    tips: [
      "Test the complete waiting and timeout path before relying on this value in production.",
    ],
    articleHref: `${QUEUES_ARTICLE}#maximum-wait-time`,
  },
  "admin.queues.form.max-size": {
    id: "admin.queues.form.max-size",
    scope: "field",
    title: "Maximum queue size",
    summary: "The maximum number of calls that may wait in the queue at once.",
    paragraphs: [
      "When the queue is full, local routing sends the call to an overflow queue when one is configured, or returns a hangup action when Hangup is selected. Test any other overflow choice in its call flow.",
    ],
    tips: [
      "Size the queue for expected peaks and confirm the overflow destination can handle excess traffic.",
    ],
    articleHref: `${QUEUES_ARTICLE}#maximum-queue-size`,
  },
  "admin.queues.form.agent-answer-timeout": {
    id: "admin.queues.form.agent-answer-timeout",
    scope: "field",
    title: "Agent answer timeout",
    summary:
      "How many seconds an offered agent has to answer a call from this queue.",
    paragraphs: [
      "If the agent does not answer before the limit, the call returns to the queue and the agent is placed in Agent Not Answering status.",
    ],
    tips: [
      "Allow enough time for the agent to recognize the offer without making the caller wait unnecessarily.",
    ],
    articleHref: `${QUEUES_ARTICLE}#agent-answer-timeout`,
  },
  "admin.queues.form.queue-priority": {
    id: "admin.queues.form.queue-priority",
    scope: "field",
    title: "Queue priority",
    summary:
      "Ranks this queue against other queues when routing work to available agents.",
    paragraphs: [
      "Higher-priority queues are considered before lower-priority queues. This setting ranks queues; Default Call Priority ranks individual calls within the routing flow.",
    ],
    tips: [
      "Reserve the highest levels for traffic with a genuine business or service-level requirement.",
    ],
    articleHref: `${QUEUES_ARTICLE}#queue-priority`,
  },
  "admin.skills.screen": {
    id: "admin.skills.screen",
    scope: "screen",
    title: "Skills",
    summary:
      "Manage the reusable capability catalog used by agent proficiency and skills-based routing.",
    paragraphs: [
      "Create skills here, assign their proficiency levels to users, and use them in Skill-based queues.",
    ],
    tips: [
      "Use a consistent one-to-five proficiency rubric across the organization.",
      "A skill cannot be deleted while it is assigned to a user; deactivate it when it should be retired but retained.",
    ],
    articleHref: SKILLS_ARTICLE,
  },
  "admin.statuses.screen": {
    id: "admin.statuses.screen",
    scope: "screen",
    title: "Statuses",
    summary: "Configure agent availability and break statuses.",
    paragraphs: ["Control which statuses are active, user-selectable, and available to routing and operational views."],
    tips: ["A status cannot be deleted while it is currently used by an agent."],
    articleHref: "/help/administration/statuses",
  },
  "admin.wrapup-codes.screen": {
    id: "admin.wrapup-codes.screen",
    scope: "screen",
    title: "Wrapup Codes",
    summary: "Manage the outcome codes agents select after interactions.",
    paragraphs: ["Create a consistent disposition catalog and assign the permitted codes to queues."],
    tips: ["The default code and codes used by queues or interactions cannot be deleted."],
    articleHref: "/help/administration/wrapup-codes",
  },
  "admin.scheduled-events.screen": {
    id: "admin.scheduled-events.screen",
    scope: "screen",
    title: "Scheduled Events",
    summary: "Schedule AI assistant calls and SMS messages and review their execution.",
    paragraphs: ["Create events individually or import them from CSV, then inspect status, duration, errors, and linked conversations."],
    tips: ["Select an assistant before loading its scheduled events."],
    articleHref: "/help/administration/scheduled-events",
  },
  "admin.numbers.screen": {
    id: "admin.numbers.screen",
    scope: "screen",
    title: "Numbers",
    summary: "Manage owned Telnyx numbers and search for new numbers to order.",
    paragraphs: ["Configure voice and messaging assignments, recording, tags, and deletion protection from the inventory tab."],
    tips: ["Number ordering is an external billable action; review pricing before confirmation."],
    articleHref: "/help/administration/numbers",
  },
  "admin.data-sources.screen": {
    id: "admin.data-sources.screen",
    scope: "screen",
    title: "Data Sources",
    summary: "Manage contacts, knowledge-base articles, and operational tasks.",
    paragraphs: ["Choose a data-source tile, then use its list, filters, editor, import, and API schema tools."],
    articleHref: "/help/administration/data-sources",
  },
  "admin.web-pages.screen": {
    id: "admin.web-pages.screen",
    scope: "screen",
    title: "Web Pages",
    summary: "Configure external pages and URLs with server-resolved secret references.",
    paragraphs: ["Preview URLs before activation and account for the target site's iframe and security policies."],
    articleHref: "/help/administration/web-pages",
  },
  "admin.media-library.screen": {
    id: "admin.media-library.screen",
    scope: "screen",
    title: "Media Library",
    summary: "Upload and manage reusable MP3 and WAV audio assets.",
    paragraphs: ["Preview assets here and select them later in queues or other voice configurations."],
    tips: ["Media names must be unique and files are limited to 20 MB."],
    articleHref: "/help/administration/media-library",
  },
  "admin.domains.screen": {
    id: "admin.domains.screen",
    scope: "screen",
    title: "Domains",
    summary: "Manage the email domains allowed for new user accounts.",
    paragraphs: ["When active domains exist, new users must have an email address in that allowlist."],
    articleHref: "/help/administration/domains",
  },
  "admin.mcp-servers.screen": {
    id: "admin.mcp-servers.screen",
    scope: "screen",
    title: "MCP Servers",
    summary: "Connect MCP servers, authenticate, discover tools, and define tool allowlists.",
    paragraphs: ["Use local Secrets for credentials and allow only the tools required by your assistants and workflows."],
    articleHref: "/help/administration/mcp-servers",
  },
  "admin.secrets.screen": {
    id: "admin.secrets.screen",
    scope: "screen",
    title: "Secrets",
    summary: "Store and rotate encrypted credentials used by integrations.",
    paragraphs: ["Secret values are never shown again after storage; edit with an empty value to retain the current encrypted value."],
    articleHref: "/help/administration/secrets",
  },
  "admin.theme-settings.screen": {
    id: "admin.theme-settings.screen",
    scope: "screen",
    title: "Theme Settings",
    summary: "Customize shared branding, images, and light and dark application colors.",
    paragraphs: ["Preview changes in both themes and save only after checking readability across major workspaces."],
    tips: ["Reset to Defaults persists default colors and removes custom images, but preserves the saved company name."],
    articleHref: "/help/administration/theme-settings",
  },
  "admin.ai-assistants.screen": {
    id: "admin.ai-assistants.screen",
    scope: "screen",
    title: "AI Assistants",
    summary: "Create, configure, version, test, and monitor AI assistants.",
    paragraphs: ["Use the outer AI rail for shared resources and the editor rail for model, voice, workflow, integration, channel, widget, privacy, and conversation settings."],
    articleHref: "/help/administration/ai-assistants",
  },
  "admin.tools-library.screen": {
    id: "admin.tools-library.screen",
    scope: "screen",
    title: "Tools Library",
    summary: "Manage reusable assistant tools and assign them to assistants.",
    paragraphs: ["Test webhook tools with safe sample data before assigning them to production assistants."],
    articleHref: "/help/administration/tools-library",
  },
  "admin.insights.screen": {
    id: "admin.insights.screen",
    scope: "screen",
    title: "Insights",
    summary: "Define post-conversation extraction instructions, schemas, groups, and webhooks.",
    paragraphs: ["Treat field-name and type changes as integration changes for downstream webhook consumers."],
    articleHref: "/help/administration/insights",
  },
  "admin.system.screen": {
    id: "admin.system.screen",
    scope: "screen",
    title: "System",
    summary: "Open operational testing, logging, hardphone, and theme modules from tiles or the rail.",
    paragraphs: ["Nested modules include an Exit rail item that returns to this System overview."],
    articleHref: "/help/administration/system",
  },
  "admin.call-generator.screen": {
    id: "admin.call-generator.screen",
    scope: "screen",
    title: "Call Generator",
    summary: "Create controlled call scenarios and inspect live or completed test runs.",
    paragraphs: ["Use strict concurrency, CPS, duration, source-number, and PSTN whitelist safety controls."],
    articleHref: "/help/administration/call-generator",
  },
  "admin.logging.screen": {
    id: "admin.logging.screen",
    scope: "screen",
    title: "Logging",
    summary: "Inspect live events and JSONL files and configure runtime logging policies.",
    paragraphs: ["Enable verbose logging only for a bounded investigation and handle log content as sensitive data."],
    articleHref: "/help/administration/logging",
  },
  "admin.phones-provisioning.screen": {
    id: "admin.phones-provisioning.screen",
    scope: "screen",
    title: "Phones Provisioning",
    summary: "Manage hardphones, SIP registration, LAN bridges, provisioning logs, and vendor setup.",
    paragraphs: ["Use the nested rail and right Context Settings panel to select and edit the current resource."],
    articleHref: "/help/administration/phones-provisioning",
  },
  "admin.call-flows.screen": {
    id: "admin.call-flows.screen",
    scope: "screen",
    title: "Call & App Flows",
    summary: "Build visual event, telephony, routing, and integration flows with typed nodes, expressions, and runtime variables.",
    paragraphs: ["Use the detailed node reference and test success, timeout, failure, and hangup paths before assigning production numbers."],
    articleHref: "/help/administration/call-flows",
  },
  "admin.workflows.screen": {
    id: "admin.workflows.screen",
    scope: "screen",
    title: "Workflows",
    summary: "Create staged Agent Assist workflows with precise item detection, slot extraction, prefill data, and testing.",
    paragraphs: ["Use distinct slot names, labels, hints, and validation rules; imports and duplicates remain inactive until reviewed."],
    articleHref: "/help/administration/workflows",
  },
  "admin.forms.screen": {
    id: "admin.forms.screen",
    scope: "screen",
    title: "Forms",
    summary: "Build, validate, publish, import, export, and archive agent-facing multi-page forms and their Data Actions.",
    paragraphs: ["Use the form editor rail for AI, Pages, Blocks, Data Actions, Media, and Templates, then test the complete submission payload."],
    articleHref: "/help/administration/forms",
  },
});

const SCREEN_HELP = Object.freeze([
  { pathname: "/agent/desktop", helpId: "agent.desktop.screen" },
  { pathname: "/supervisor/monitor", helpId: "supervisor.monitor.screen" },
  { pathname: "/supervisor/analytics", helpId: "supervisor.analytics.screen" },
  { pathname: "/supervisor/call-history", helpId: "supervisor.analytics.screen" },
  { pathname: "/supervisor/quality", helpId: "supervisor.quality.screen" },
  { pathname: "/supervisor/outbound-dialer", helpId: "supervisor.outbound-dialer.screen" },
  {
    pathname: "/admin/users",
    helpId: "admin.users.screen",
  },
  {
    pathname: "/admin/queues",
    helpId: "admin.queues.screen",
  },
  {
    pathname: "/admin/skills",
    helpId: "admin.skills.screen",
  },
  { pathname: "/admin/statuses", helpId: "admin.statuses.screen" },
  { pathname: "/admin/wrapup-codes", helpId: "admin.wrapup-codes.screen" },
  { pathname: "/supervisor/scheduled-events", helpId: "admin.scheduled-events.screen" },
  { pathname: "/admin/numbers", helpId: "admin.numbers.screen" },
  { pathname: "/admin/data-sources", helpId: "admin.data-sources.screen" },
  { pathname: "/admin/web-pages", helpId: "admin.web-pages.screen" },
  { pathname: "/admin/media-library", helpId: "admin.media-library.screen" },
  { pathname: "/admin/domains", helpId: "admin.domains.screen" },
  { pathname: "/admin/mcp-servers", helpId: "admin.mcp-servers.screen" },
  { pathname: "/admin/secrets", helpId: "admin.secrets.screen" },
  { pathname: "/settings", helpId: "admin.theme-settings.screen" },
  { pathname: "/admin/ai-assistants", helpId: "admin.ai-assistants.screen" },
  { pathname: "/admin/tools-library", helpId: "admin.tools-library.screen" },
  { pathname: "/admin/insights", helpId: "admin.insights.screen" },
  { pathname: "/admin/system", helpId: "admin.system.screen" },
  { pathname: "/admin/call-generator", helpId: "admin.call-generator.screen" },
  { pathname: "/admin/logging", helpId: "admin.logging.screen" },
  { pathname: "/admin/phones-provisioning", helpId: "admin.phones-provisioning.screen" },
  { pathname: "/admin/call-flows", helpId: "admin.call-flows.screen" },
  { pathname: "/admin/workflows", helpId: "admin.workflows.screen" },
  { pathname: "/admin/forms", helpId: "admin.forms.screen" },
]);

export const DEFAULT_HELP_ID = "help.overview";

export function getHelpTopic(helpId) {
  return helpId ? HELP_TOPICS[helpId] || null : null;
}

export function resolveScreenHelpId(pathname) {
  const normalizedPathname = normalizePathname(pathname);
  const match = SCREEN_HELP.find(
    (entry) =>
      normalizedPathname === entry.pathname ||
      normalizedPathname.startsWith(`${entry.pathname}/`),
  );

  return match?.helpId || DEFAULT_HELP_ID;
}

export function resolveHelpTopic({ pathname, helpId } = {}) {
  return (
    getHelpTopic(helpId) ||
    getHelpTopic(resolveScreenHelpId(pathname)) ||
    HELP_TOPICS[DEFAULT_HELP_ID]
  );
}

function normalizePathname(pathname) {
  const value = String(pathname || "/").split(/[?#]/, 1)[0] || "/";
  if (value === "/") return value;
  return value.replace(/\/+$/, "");
}

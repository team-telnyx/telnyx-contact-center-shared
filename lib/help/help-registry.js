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
    articleHref: "/help/agent/desktop",
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
    paragraphs: ["Configure providers, model fallback, voice/STT, Avatar and integrations in the editor. Use Search settings and Review changes, then check independent save verification before testing the actual channel."],
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
    summary: "Open Dashboard, Settings, Schedules & calendars, AI Copilot and operational tools.",
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
  "admin.widgets.screen": {
    id: "admin.widgets.screen", scope: "screen", title: "Web Widgets",
    summary: "Configure and publish chat, images, voice, avatars, video, Vision and co-browsing.",
    paragraphs: ["Enable the relevant channels for queues and agents, publish the widget, and start a fresh test session. Video Vision, AI chat images and co-browsing have separate controls and consent requirements."],
    articleHref: "/help/administration/chat-widgets",
  },
  "admin.email.screen": {
    id: "admin.email.screen", scope: "screen", title: "Email",
    summary: "Manage mailboxes, domain health, delivery and email AI Copilot.",
    paragraphs: ["Map each Contact Center inbox to an enabled email queue. Routing and sending can be paused independently; synchronization retains incoming mail."],
    articleHref: "/help/administration/email",
  },
  "admin.sms.screen": {
    id: "admin.sms.screen", scope: "screen", title: "SMS",
    summary: "Connect a Telnyx messaging profile, map SMS numbers to queues and review delivery.",
    paragraphs: ["Connect the messaging profile whose webhook points at this application, then map each SMS-capable number to an SMS-enabled queue. Routing and agent replies can be paused per number; delivery evidence and opt-outs are visible under Delivery."],
    articleHref: "/help/administration/sms",
  },
  "admin.whatsapp.screen": {
    id: "admin.whatsapp.screen", scope: "screen", title: "WhatsApp",
    summary: "Connect the WhatsApp Business Account, map WhatsApp numbers to queues, manage templates and business profiles.",
    paragraphs: ["Contact Center resolves the Telnyx account that owns the WhatsApp Business Account (primary key first, backup key second), connects a Contact Center messaging profile whose webhook points at this application and maps the numbers you choose to WhatsApp-enabled queues. Other numbers keep their own messaging profile, for example one used by a demo portal."],
    articleHref: "/help/administration/whatsapp",
  },
  "admin.forms.screen": {
    id: "admin.forms.screen",
    scope: "screen",
    title: "Forms",
    summary: "Build, validate, publish, import, export, and archive agent-facing multi-page forms and their Data Actions.",
    paragraphs: ["Use the form editor rail for AI, Pages, Blocks, Data Actions, Media, and Templates, then test the complete submission payload."],
    articleHref: "/help/administration/forms",
  },
  "agent.dashboard.screen": {
    id: "agent.dashboard.screen",
    scope: "screen",
    title: "Agent Dashboard",
    summary: "Review your workload, handling time, queues and disposition metrics.",
    paragraphs: ["Match dates and filters before comparing metrics. The home destination depends on the screens granted to your account."],
    articleHref: "/help/agent/dashboard",
  },
  "profile.screen": {
    id: "profile.screen",
    scope: "screen",
    title: "Profile and preferences",
    summary: "Manage personal details, interface and speech language, notification sounds, security and devices.",
    paragraphs: ["Interface language and speech language are separate. Save notifications separately from profile details."],
    articleHref: "/help/profile",
  },
  "profile.devices": {
    id: "profile.devices",
    scope: "screen",
    title: "Call devices",
    summary: "Review call-device availability, connect a companion app or forget a retired phone.",
    paragraphs: ["Computer represents your browser connections and cannot be forgotten. Resolve active work before forgetting a handset; Forget signs it out and disables future calls and notifications."],
    articleHref: "/help/mobile",
  },
  "phone.devices": {
    id: "phone.devices",
    scope: "screen",
    title: "Devices and call handoff",
    summary: "Choose where future calls ring or move supported active work to another device.",
    paragraphs: ["Calls on selects the destination for future calls. Use the move dialog or Take over here for an active call, and wait for the confirmed outcome."],
    articleHref: "/help/webrtc-phone/devices",
  },
  "agent.video": {
    id: "agent.video",
    scope: "screen",
    title: "Video calls and Vision",
    summary: "Handle video, screen sharing, AI participants and separately authorized Vision sources.",
    paragraphs: ["Only the handling device controls media and wrap-up. Browser camera permission does not grant AI access; each participant controls consent for their own source."],
    articleHref: "/help/agent/video-calls",
  },
  "agent.cobrowse": {
    id: "agent.cobrowse",
    scope: "screen",
    title: "Co-browsing",
    summary: "Request page viewing and separately approved control of eligible page elements.",
    paragraphs: ["A pairing code does not grant consent. Control needs visitor approval and the control permission. Sensitive fields remain blocked; co-browsing is not recorded."],
    articleHref: "/help/agent/cobrowsing",
  },
  "agent.assistant-invite": {
    id: "agent.assistant-invite",
    scope: "screen",
    title: "Invite an AI assistant",
    summary: "Add an allowed AI participant to a live voice conversation and inspect its separate transcript.",
    paragraphs: ["The flow must allow invitations and the assistant must have Skip Turn. Removing AI leaves the customer\u2013agent conversation active."],
    articleHref: "/help/agent/agent-assist#invite-an-ai-assistant-to-a-voice-call",
  },
  "admin.teams.screen": {
    id: "admin.teams.screen",
    scope: "screen",
    title: "Teams",
    summary: "Manage team membership, leadership and team-scoped access.",
    paragraphs: ["Team membership and queue assignments serve different purposes. Review scope permissions before changing a team."],
    articleHref: "/help/administration/teams",
  },
  "admin.permissions.screen": {
    id: "admin.permissions.screen",
    scope: "screen",
    title: "Permissions",
    summary: "Create and assign roles from screen, operation and scope permissions.",
    paragraphs: ["Permissions add across roles. Review scope and the audit trail; a role name alone does not grant access."],
    articleHref: "/help/administration/permissions",
  },
  "supervisor.history.screen": {
    id: "supervisor.history.screen",
    scope: "screen",
    title: "Interaction history",
    summary: "Inspect voice, messaging and video timelines, recordings, transcripts and workflow evidence.",
    paragraphs: ["Filter by date, channel and queue. A missing recording may still be processing or may have been disabled; an accepted message is not proof of delivery."],
    articleHref: "/help/supervisor/call-history",
  },
  "admin.system.dashboard.screen": {
    id: "admin.system.dashboard.screen",
    scope: "screen",
    title: "System Dashboard",
    summary: "Review platform configuration inventory, integrations and activity.",
    paragraphs: ["Use a controlled channel test to verify actual service behavior; inventory and connectivity indicators do not establish end-to-end success."],
    articleHref: "/help/administration/system/dashboard",
  },
  "admin.system.settings.screen": {
    id: "admin.system.settings.screen",
    scope: "screen",
    title: "System Settings",
    summary: "Configure shared SLA targets, hold experiences, notification sounds and agent lifecycle.",
    paragraphs: ["Save SLA separately from other settings. Personal notification overrides remain in Profile."],
    articleHref: "/help/administration/system/settings",
  },
  "admin.system.schedules.screen": {
    id: "admin.system.schedules.screen",
    scope: "screen",
    title: "Schedules & calendars",
    summary: "Publish working hours and ordered exception calendars for Call Flow routing.",
    paragraphs: ["Save draft does not change live routing. Publish reviewed resources, check coverage and time zones, then test the Schedules node."],
    articleHref: "/help/administration/system/schedules",
  },
  "admin.system.ai-copilot.screen": {
    id: "admin.system.ai-copilot.screen",
    scope: "screen",
    title: "AI Copilot",
    summary: "Configure the platform default model, operation overrides, business guidance and draft tests.",
    paragraphs: ["An empty model inherits. Apply to all clears operation/channel model overrides but preserves explicit workflow and scorecard choices. Test drafts before saving."],
    articleHref: "/help/administration/system/ai-copilot",
  },
  "admin.workflows.test.screen": {
    id: "admin.workflows.test.screen",
    scope: "screen",
    title: "Workflow test module",
    summary: "Test analysis and simulated callers with separate model choices in chat or voice.",
    paragraphs: ["A model choice here applies to one run. Voice uses an authenticated session; check recognized speech, final slots and errors rather than treating a reply as acceptance."],
    articleHref: "/help/administration/workflows/testing",
  },
  "admin.workflows.mcp": {
    id: "admin.workflows.mcp",
    scope: "screen",
    title: "Workflow MCP bindings",
    summary: "Map lookup inputs, derived slots, alternatives and deliberate submission actions.",
    paragraphs: ["Use input-change behavior for lookups and manual confirmation for transport creation. An uncertain outcome after dispatch must be reconciled before resubmission; manual slot edits remain protected."],
    articleHref: "/help/administration/workflows/mcp-bindings",
  },
  "admin.pronunciation.screen": {
    id: "admin.pronunciation.screen",
    scope: "screen",
    title: "Pronunciation Dictionaries",
    summary: "Manage reusable pronunciation entries for compatible assistant voices.",
    paragraphs: ["Assign the dictionary to the intended voice configuration and test representative names and terms."],
    articleHref: "/help/administration/pronunciation-dictionaries",
  },
  "admin.call-flows.schedules": {
    id: "admin.call-flows.schedules",
    scope: "screen",
    title: "Schedules node",
    summary: "Branch on published opening hours and exception calendars.",
    paragraphs: ["Connect True and False. Missing coverage is an error; select its fallback branch and test boundaries before saving."],
    articleHref: "/help/administration/call-flows/nodes/schedules",
  },
  "admin.call-flows.assistant-invite": {
    id: "admin.call-flows.assistant-invite",
    scope: "screen",
    title: "Assistant invitations",
    summary: "Select allowed assistants and prepare live conversation events when saving the flow.",
    paragraphs: ["Verify Skip Turn. Replacing another Conversation WebSocket destination affects every flow using that assistant; use separate assistants for simultaneous environments."],
    articleHref: "/help/administration/call-flows/nodes/agent-assist#allow-assistant-invitations",
  },

});

// Explicit page inventory: additions under app/(portal) require an article and
// an entry here. Dynamic segments use the same [id] notation as Next.js routes.
export const SCREEN_HELP = Object.freeze([
  { pathname: "/admin/ai-assistants/[id]", helpId: "admin.ai-assistants.screen" },
  { pathname: "/admin/ai-assistants/new", helpId: "admin.ai-assistants.screen" },
  { pathname: "/admin/ai-assistants", helpId: "admin.ai-assistants.screen" },
  { pathname: "/admin/ai-assistants/pronunciation-dictionaries", helpId: "admin.pronunciation.screen" },
  { pathname: "/admin/call-flows/[id]", helpId: "admin.call-flows.screen" },
  { pathname: "/admin/call-flows", helpId: "admin.call-flows.screen" },
  { pathname: "/admin/call-generator", helpId: "admin.call-generator.screen" },
  { pathname: "/admin/contacts", helpId: "admin.data-sources.screen" },
  { pathname: "/admin/data-sources", helpId: "admin.data-sources.screen" },
  { pathname: "/admin/domains", helpId: "admin.domains.screen" },
  { pathname: "/admin/email", helpId: "admin.email.screen" },
  { pathname: "/admin/forms/[id]", helpId: "admin.forms.screen" },
  { pathname: "/admin/forms", helpId: "admin.forms.screen" },
  { pathname: "/admin/insights", helpId: "admin.insights.screen" },
  { pathname: "/admin/kb-articles", helpId: "admin.data-sources.screen" },
  { pathname: "/admin/logging", helpId: "admin.logging.screen" },
  { pathname: "/admin/mcp-servers", helpId: "admin.mcp-servers.screen" },
  { pathname: "/admin/media-library", helpId: "admin.media-library.screen" },
  { pathname: "/admin/numbers", helpId: "admin.numbers.screen" },
  { pathname: "/admin/permissions/[id]", helpId: "admin.permissions.screen" },
  { pathname: "/admin/permissions", helpId: "admin.permissions.screen" },
  { pathname: "/admin/phones-provisioning", helpId: "admin.phones-provisioning.screen" },
  { pathname: "/admin/queues", helpId: "admin.queues.screen" },
  { pathname: "/admin/secrets", helpId: "admin.secrets.screen" },
  { pathname: "/admin/skills", helpId: "admin.skills.screen" },
  { pathname: "/admin/sms", helpId: "admin.sms.screen" },
  { pathname: "/admin/sms/templates", helpId: "admin.sms.screen" },
  { pathname: "/admin/statuses", helpId: "admin.statuses.screen" },
  { pathname: "/admin/system/dashboard", helpId: "admin.system.dashboard.screen" },
  { pathname: "/admin/system", helpId: "admin.system.screen" },
  { pathname: "/admin/system/schedules", helpId: "admin.system.schedules.screen" },
  { pathname: "/admin/system/settings/ai-copilot", helpId: "admin.system.ai-copilot.screen" },
  { pathname: "/admin/system/settings", helpId: "admin.system.settings.screen" },
  { pathname: "/admin/teams", helpId: "admin.teams.screen" },
  { pathname: "/admin/tools-library", helpId: "admin.tools-library.screen" },
  { pathname: "/admin/users", helpId: "admin.users.screen" },
  { pathname: "/admin/web-pages", helpId: "admin.web-pages.screen" },
  { pathname: "/admin/whatsapp", helpId: "admin.whatsapp.screen" },
  { pathname: "/admin/widgets", helpId: "admin.widgets.screen" },
  { pathname: "/admin/workflows/[id]", helpId: "admin.workflows.screen" },
  { pathname: "/admin/workflows/[id]/test", helpId: "admin.workflows.test.screen" },
  { pathname: "/admin/workflows/new", helpId: "admin.workflows.screen" },
  { pathname: "/admin/workflows", helpId: "admin.workflows.screen" },
  { pathname: "/admin/wrapup-codes", helpId: "admin.wrapup-codes.screen" },
  { pathname: "/agent/configuration", helpId: "profile.screen" },
  { pathname: "/agent/desktop", helpId: "agent.desktop.screen" },
  { pathname: "/", helpId: "agent.dashboard.screen" },
  { pathname: "/profile", helpId: "profile.screen" },
  { pathname: "/settings", helpId: "admin.theme-settings.screen" },
  { pathname: "/supervisor/analytics", helpId: "supervisor.analytics.screen" },
  { pathname: "/supervisor/call-history/[id]", helpId: "supervisor.history.screen" },
  { pathname: "/supervisor/call-history", helpId: "supervisor.history.screen" },
  { pathname: "/supervisor/interactions-history/[id]", helpId: "supervisor.history.screen" },
  { pathname: "/supervisor/interactions-history", helpId: "supervisor.history.screen" },
  { pathname: "/supervisor/monitor", helpId: "supervisor.monitor.screen" },
  { pathname: "/supervisor/outbound-dialer", helpId: "supervisor.outbound-dialer.screen" },
  { pathname: "/supervisor/quality/evaluations/[id]", helpId: "supervisor.quality.screen" },
  { pathname: "/supervisor/quality", helpId: "supervisor.quality.screen" },
  { pathname: "/supervisor/scheduled-events", helpId: "admin.scheduled-events.screen" },
]);

// More specific routes win over parent guides, independent of declaration order.
const ROUTE_HELP = SCREEN_HELP.map(entry => {
  const segments = entry.pathname.split("/").filter(Boolean);
  return { ...entry, segments, specificity: segments.length * 100 + segments.filter(segment => !segment.startsWith("[")).length };
}).sort((a, b) => b.specificity - a.specificity);

export const DEFAULT_HELP_ID = "help.overview";

export function getHelpTopic(helpId) {
  return helpId ? HELP_TOPICS[helpId] || null : null;
}

export function resolveScreenHelpId(pathname) {
  const normalizedPathname = normalizePathname(pathname);
  const segments = normalizedPathname.split("/").filter(Boolean);
  const match = ROUTE_HELP.find(entry => {
    if (!entry.segments.length) return !segments.length;
    return segments.length >= entry.segments.length && entry.segments.every((segment, index) =>
      /^\[[^\]]+\]$/.test(segment) || segment === segments[index],
    );
  });

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

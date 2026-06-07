const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

export const LOGGING_TOPIC_GROUPS = Object.freeze([
  {
    id: "platform",
    label: "Platform & Runtime",
    description: "Application startup, API infrastructure, database, scheduler, and logging runtime.",
    defaultLevel: "info",
    topics: [
      { id: "platform.app", label: "Application", description: "Application startup and general runtime events.", defaultLevel: "info" },
      { id: "platform.api", label: "API", description: "Generic API infrastructure and request handling.", defaultLevel: "info" },
      { id: "platform.db", label: "Database", description: "Postgres connection, schema, and query diagnostics.", defaultLevel: "warn" },
      { id: "platform.scheduler", label: "Scheduler", description: "Background jobs and scheduled runtime work.", defaultLevel: "info" },
      { id: "platform.logging", label: "Logging", description: "Logger startup, config, transports, and file sink events.", defaultLevel: "info" },
    ],
  },
  {
    id: "security",
    label: "Security & Auth",
    description: "Authentication, sessions, users, credentials hygiene, and admin security actions.",
    defaultLevel: "info",
    topics: [
      { id: "security.auth", label: "Authentication", description: "Login, logout, auth checks, and auth failures.", defaultLevel: "info" },
      { id: "security.sessions", label: "Sessions", description: "Session creation, validation, refresh, and expiry.", defaultLevel: "info" },
      { id: "security.users", label: "Users", description: "User profile and account management events.", defaultLevel: "info" },
      { id: "security.credentials", label: "Credentials", description: "Secrets, tokens, API keys, and credential storage hygiene.", defaultLevel: "warn" },
      { id: "security.admin", label: "Admin security", description: "Admin-only security controls and privileged changes.", defaultLevel: "info" },
    ],
  },
  {
    id: "contact-center",
    label: "Contact Center",
    description: "Agent status, queues, routing, reservations, interactions, wrap-up, transfer, consult, and supervision.",
    defaultLevel: "info",
    topics: [
      { id: "contact-center.status", label: "Agent status", description: "Agent status changes and DB-authoritative availability.", defaultLevel: "info" },
      { id: "contact-center.queues", label: "Queues", description: "Queue membership, activation, and queued call operations.", defaultLevel: "info" },
      { id: "contact-center.routing", label: "Routing", description: "Routing decisions, skill matching, and assignment outcomes.", defaultLevel: "info" },
      { id: "contact-center.reservations", label: "Reservations", description: "Agent capacity reservations, promotion, lease, and release.", defaultLevel: "info" },
      { id: "contact-center.timeout", label: "No-answer timeouts", description: "Agent no-answer, requeue, and timeout handling.", defaultLevel: "info" },
      { id: "contact-center.interactions", label: "Interactions", description: "Live interaction lifecycle, answer, hangup, history, and transcription hooks.", defaultLevel: "info" },
      { id: "contact-center.wrapup", label: "Wrap-up", description: "Wrap-up state, disposition, and wrap-up codes.", defaultLevel: "info" },
      { id: "contact-center.transfer", label: "Transfer", description: "Transfer request, accept, reject, and completion flow.", defaultLevel: "info" },
      { id: "contact-center.consult", label: "Consult", description: "Consult call lifecycle and escalation behavior.", defaultLevel: "info" },
      { id: "contact-center.supervision", label: "Supervision", description: "Listen, whisper, barge, and supervision call control.", defaultLevel: "info" },
    ],
  },
  {
    id: "voice",
    label: "Voice & Call Flow",
    description: "Voice API webhooks, flow execution, Call Control actions, recordings, and Call Flow Monitor streams.",
    defaultLevel: "info",
    topics: [
      { id: "voice.webhooks", label: "Voice webhooks", description: "Voice API webhook intake and compact correlation events.", defaultLevel: "info" },
      { id: "voice.flow", label: "Flow engine", description: "Call Flow node execution, transitions, and runtime decisions.", defaultLevel: "info" },
      { id: "voice.call-control", label: "Call Control", description: "Dial, answer, bridge, hangup, gather, speak, and call state actions.", defaultLevel: "info" },
      { id: "voice.recordings", label: "Recordings", description: "Recording retrieval, transcription requests, and recording metadata.", defaultLevel: "info" },
      { id: "voice.monitor", label: "Call Flow Monitor", description: "Monitor stream events and runtime monitor persistence.", defaultLevel: "info" },
    ],
  },
  {
    id: "telnyx",
    label: "Telnyx Media & Providers",
    description: "Telnyx media streaming, standalone STT, provider integrations, and Telnyx API failures.",
    defaultLevel: "info",
    topics: [
      { id: "telnyx.webhooks", label: "Telnyx webhooks", description: "Telnyx provider webhook events outside Voice Flow runtime.", defaultLevel: "info" },
      { id: "telnyx.streaming", label: "Streaming", description: "Streaming WebSocket sessions and stream lifecycle.", defaultLevel: "info" },
      { id: "telnyx.stt", label: "STT", description: "Standalone STT provider sessions and transcript events.", defaultLevel: "info" },
      { id: "telnyx.media", label: "Media", description: "Raw/near-raw media frame diagnostics; intentionally noisy.", defaultLevel: "warn" },
      { id: "telnyx.provider-api", label: "Provider API", description: "Telnyx REST/SDK/provider calls and failures.", defaultLevel: "info" },
    ],
  },
  {
    id: "agent-assist",
    label: "Agent Assist & AI",
    description: "Workflow analysis, suggestions, translation, AI handoff, and LLM/provider interactions.",
    defaultLevel: "info",
    topics: [
      { id: "agent-assist.workflow", label: "Workflow", description: "Agent Assist workflow sessions, slot filling, and workflow analysis.", defaultLevel: "info" },
      { id: "agent-assist.suggestions", label: "Suggestions", description: "Suggested responses and next-best-action generation.", defaultLevel: "info" },
      { id: "agent-assist.translation", label: "Translation", description: "Online translation and language handling.", defaultLevel: "info" },
      { id: "agent-assist.handoff", label: "AI handoff", description: "AI handoff preparation, context, and summary events.", defaultLevel: "info" },
      { id: "agent-assist.llm", label: "LLM", description: "Direct model calls, provider payload summaries, and LLM errors.", defaultLevel: "warn" },
    ],
  },
  {
    id: "outbound",
    label: "Outbound Dialer",
    description: "Outbound runner, campaign execution, agent campaigns, imports, and live outbound calls.",
    defaultLevel: "info",
    topics: [
      { id: "outbound.runner", label: "Runner", description: "Outbound background runner and claim loop.", defaultLevel: "info" },
      { id: "outbound.campaigns", label: "Campaigns", description: "Campaign CRUD, settings, and campaign state.", defaultLevel: "info" },
      { id: "outbound.execution", label: "Execution", description: "Start, stop, pause, resume, retries, and dialing execution.", defaultLevel: "info" },
      { id: "outbound.imports", label: "Imports", description: "Contact list imports, DNC imports, and import validation.", defaultLevel: "info" },
      { id: "outbound.live-calls", label: "Live calls", description: "Outbound live calls monitor, REST, and SSE events.", defaultLevel: "info" },
    ],
  },
  {
    id: "supervisor",
    label: "Supervisor & Reporting",
    description: "Supervisor monitor, dashboards, metrics, reports, summaries, and insights.",
    defaultLevel: "info",
    topics: [
      { id: "supervisor.monitor", label: "Monitor", description: "Supervisor monitor views and live monitor APIs.", defaultLevel: "info" },
      { id: "supervisor.dashboard", label: "Dashboard", description: "Supervisor dashboard data and refresh behavior.", defaultLevel: "info" },
      { id: "supervisor.metrics", label: "Metrics", description: "Realtime metrics, stats aggregation, and KPI calculations.", defaultLevel: "info" },
      { id: "supervisor.reports", label: "Reports", description: "Reports, call summaries, and historical reporting.", defaultLevel: "info" },
      { id: "supervisor.insights", label: "Insights", description: "Telnyx insights helpers and analysis lookups.", defaultLevel: "info" },
    ],
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Email and push notification delivery.",
    defaultLevel: "info",
    topics: [
      { id: "notifications.email", label: "Email", description: "Email notification delivery and errors.", defaultLevel: "info" },
      { id: "notifications.push", label: "Push", description: "Push notification delivery and errors.", defaultLevel: "info" },
    ],
  },
]);

export const LEGACY_TOPIC_ALIASES = Object.freeze({
  app: "platform.app",
  api: "platform.api",
  db: "platform.db",
  auth: "security.auth",
  admin: "security.admin",
  logger: "platform.logging",
  scheduler: "platform.scheduler",
  routing: "contact-center.routing",
  "state-manager": "contact-center.status",
  contact_center: "contact-center.interactions",
  "voice-webhook": "voice.webhooks",
  "flow-engine": "voice.flow",
  "voice-flow": "voice.flow",
  monitor: "supervisor.monitor",
  "telnyx.webhook": "telnyx.webhooks",
  "telnyx.standalone_stt": "telnyx.stt",
  "telnyx.stt.media": "telnyx.media",
  "streaming-ws": "telnyx.streaming",
  "streaming.ws": "telnyx.streaming",
  webrtc: "voice.call-control",
  "outbound-dialer": "outbound.campaigns",
});

export function flattenLoggingTopics(groups = LOGGING_TOPIC_GROUPS) {
  return groups.flatMap((group) => group.topics.map((topic) => ({
    ...topic,
    groupId: group.id,
    groupLabel: group.label,
    groupDescription: group.description,
    defaultLevel: normalizeTopicLevel(topic.defaultLevel || group.defaultLevel),
  })));
}

function normalizeTopicLevel(level, fallback = "info") {
  const normalized = String(level || fallback).toLowerCase();
  return VALID_LEVELS.has(normalized) ? normalized : fallback;
}

export function defaultTopicLevelsFromCatalog(groups = LOGGING_TOPIC_GROUPS) {
  const entries = [];
  for (const group of groups) {
    entries.push([group.id, normalizeTopicLevel(group.defaultLevel)]);
    for (const topic of group.topics) {
      entries.push([topic.id, normalizeTopicLevel(topic.defaultLevel || group.defaultLevel)]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function defaultTopicEnabledFromCatalog(groups = LOGGING_TOPIC_GROUPS) {
  const entries = [];
  for (const group of groups) {
    entries.push([group.id, true]);
    for (const topic of group.topics) entries.push([topic.id, true]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function topicGroupForTopic(topic, groups = LOGGING_TOPIC_GROUPS) {
  const canonical = canonicalTopicFor(topic);
  return groups.find((group) => group.id === canonical || group.topics.some((item) => item.id === canonical)) || null;
}

export function canonicalTopicFor(topic) {
  const key = String(topic || "").trim();
  return LEGACY_TOPIC_ALIASES[key] || key;
}

export function canonicalizeTopicMap(value, { includeLegacyAliases = false } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [topic, setting] of Object.entries(source)) {
    const canonical = canonicalTopicFor(topic);
    result[canonical] = setting;
    if (includeLegacyAliases && canonical !== topic) result[topic] = setting;
  }
  return result;
}

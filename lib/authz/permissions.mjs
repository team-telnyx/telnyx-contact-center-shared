/**
 * Permission catalogue — the single source of truth for permission keys.
 *
 * Two key families:
 *   screen:<workspace>.<group>[.<section>[.<tile>]]   navigation and page access
 *   <resource>:<action>                                operations on managed objects
 *
 * Wildcards: "*" (owner only), "screen:admin.*", "users:*". A parent screen key
 * such as "screen:admin.email.*" covers every current and future leaf below it.
 *
 * The database stores only role -> permission keys; this module knows what the
 * keys mean. Design: the internal documentation
 */

export const WILDCARD = "*";
export const SCREEN_PREFIX = "screen:";
export const CHANNELS = ["voice", "chat", "email", "sms", "whatsapp"];
export const ROLE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const RESERVED_ROLE_KEYS = ["agent", "supervisor", "admin", "owner"];

function section(prefix, ids, labels = {}) {
  return ids.map((id) => ({
    id: `${prefix}.${id}`,
    label: labels[id] || titleCase(id),
    path: `?section=${id}`,
  }));
}

function titleCase(id) {
  return String(id)
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bKb\b/, "KB")
    .replace(/\bDnc\b/, "DNC")
    .replace(/\bAi\b/, "AI")
    .replace(/\bMcp\b/, "MCP")
    .replace(/\bSla\b/, "SLA")
    .replace(/\bSms\b/, "SMS");
}

/** Navigation tree. Leaves are the grantable screens. */
export const SCREEN_TREE = [
  {
    id: "agent",
    label: "Agent",
    kids: [
      {
        id: "agent.desktop",
        label: "Desktop",
        path: "/agent/desktop",
        kids: section("agent.desktop", ["desktop", "dashboard", "forms", "web-pages", "contacts", "tasks", "kb-articles"], { desktop: "Interactions" }),
      },
      { id: "agent.configuration", label: "Configuration", path: "/agent/configuration" },
    ],
  },
  {
    id: "supervisor",
    label: "Supervisor",
    kids: [
      { id: "supervisor.monitor", label: "Monitoring", path: "/supervisor/monitor", kids: section("supervisor.monitor", ["overview", "dashboard", "agents", "queues", "interactions", "operations"]) },
      {
        id: "supervisor.analytics",
        label: "Analytics",
        path: "/supervisor/analytics",
        kids: section("supervisor.analytics", ["queue-performance", "agent-performance", "abandonment", "agent-adherence", "transfers-holds", "wrapup-codes", "ai-handoffs", "outbound-campaigns", "skills-gap", "call-history"], { "call-history": "Interactions History" }),
      },
      { id: "supervisor.quality", label: "Quality", path: "/supervisor/quality", kids: section("supervisor.quality", ["dashboard", "evaluations", "forms"]) },
      {
        id: "supervisor.outbound-dialer",
        label: "Outbound Dialer",
        path: "/supervisor/outbound-dialer",
        kids: section("supervisor.outbound-dialer", ["dashboard", "live-calls", "campaigns", "contact-lists", "dnc", "filters", "time-sets", "disposition-codes", "attempt-controls", "reports", "event-viewer", "settings"], { reports: "History" }),
      },
      { id: "supervisor.scheduled-events", label: "Scheduled Events", path: "/supervisor/scheduled-events" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    kids: [
      {
        id: "admin.configuration",
        label: "Configuration",
        path: "/admin/users",
        kids: [
          { id: "admin.configuration.users", label: "Users", path: "/admin/users" },
          { id: "admin.configuration.teams", label: "Teams", path: "/admin/teams" },
          { id: "admin.configuration.queues", label: "Queues", path: "/admin/queues" },
          { id: "admin.configuration.skills", label: "Skills", path: "/admin/skills" },
          { id: "admin.configuration.statuses", label: "Statuses", path: "/admin/statuses" },
          { id: "admin.configuration.wrapup-codes", label: "Wrapup Codes", path: "/admin/wrapup-codes" },
          { id: "admin.configuration.numbers", label: "Numbers", path: "/admin/numbers" },
          {
            id: "admin.configuration.data-sources",
            label: "Data Sources",
            path: "/admin/data-sources",
            kids: [
              { id: "admin.configuration.data-sources.contacts", label: "Contacts", path: "/admin/data-sources?view=contacts" },
              { id: "admin.configuration.data-sources.kb-articles", label: "KB Articles", path: "/admin/data-sources?view=kb-articles" },
              { id: "admin.configuration.data-sources.tasks", label: "Tasks", path: "/admin/data-sources?view=tasks" },
            ],
          },
          { id: "admin.configuration.web-pages", label: "Web Pages", path: "/admin/web-pages" },
          { id: "admin.configuration.media-library", label: "Media Library", path: "/admin/media-library" },
          { id: "admin.configuration.domains", label: "Domains", path: "/admin/domains" },
          { id: "admin.configuration.secrets", label: "Secrets", path: "/admin/secrets" },
          { id: "admin.configuration.permissions", label: "Permissions", path: "/admin/permissions" },
        ],
      },
      { id: "admin.automations", label: "Automations", path: "/admin/call-flows", kids: [
        { id: "admin.automations.call-app-flows", label: "Call & App Flows", path: "/admin/call-flows" },
        { id: "admin.automations.workflows", label: "Workflows", path: "/admin/workflows" },
        { id: "admin.automations.forms", label: "Forms", path: "/admin/forms" },
      ] },
      { id: "admin.ai", label: "AI Assistants", path: "/admin/ai-assistants", kids: [
        { id: "admin.ai.assistants", label: "AI Assistants", path: "/admin/ai-assistants" },
        { id: "admin.ai.tools", label: "Tools Library", path: "/admin/tools-library" },
        { id: "admin.ai.insights", label: "Insights", path: "/admin/insights" },
        { id: "admin.ai.pronunciation-dictionaries", label: "Pronunciation Dictionaries", path: "/admin/ai-assistants/pronunciation-dictionaries" },
        { id: "admin.ai.mcp-servers", label: "MCP Servers", path: "/admin/mcp-servers" },
      ] },
      { id: "admin.email", label: "Email", path: "/admin/email", kids: section("admin.email", ["mailboxes", "domain", "templates", "preview", "filters", "delivery", "copilot"]) },
      { id: "admin.sms", label: "SMS", path: "/admin/sms", kids: section("admin.sms", ["numbers", "profile", "templates", "delivery", "copilot"]) },
      { id: "admin.whatsapp", label: "WhatsApp", path: "/admin/whatsapp", kids: section("admin.whatsapp", ["numbers", "details", "templates", "phone-numbers", "delivery", "copilot"]) },
      { id: "admin.widgets", label: "Web Widgets", path: "/admin/widgets" },
      { id: "admin.system", label: "System", path: "/admin/system/dashboard", kids: [
        { id: "admin.system.dashboard", label: "Dashboard", path: "/admin/system/dashboard" },
        { id: "admin.system.settings", label: "Settings", path: "/admin/system/settings" },
        { id: "admin.system.call-generator", label: "Call Generator", path: "/admin/call-generator" },
        { id: "admin.system.logging", label: "Logging", path: "/admin/logging" },
        { id: "admin.system.phones-provisioning", label: "Phones Provisioning", path: "/admin/phones-provisioning" },
        { id: "admin.system.theme-settings", label: "Theme Settings", path: "/settings" },
      ] },
    ],
  },
];

const CRUD = ["read", "create", "update", "delete"];

/**
 * Managed objects grouped by area. `anchor` names the scope dimension that
 * limits a grant: queues | teams | campaigns | channels | objects | null.
 */
export const RESOURCE_AREAS = [
  { area: "Configuration", items: [
    { key: "users", label: "Users", crud: CRUD, named: ["invite", "roles.assign"], anchor: "teams" },
    { key: "roles", label: "Roles and permissions", crud: ["read"], named: ["manage"], anchor: null },
    { key: "teams", label: "Teams", crud: CRUD, named: ["members.assign"], anchor: "teams" },
    { key: "queues", label: "Queues", crud: CRUD, named: ["agents.assign"], anchor: "queues" },
    { key: "skills", label: "Skills", crud: CRUD, named: [], anchor: null },
    { key: "statuses", label: "Statuses", crud: CRUD, named: [], anchor: null },
    { key: "wrapup_codes", label: "Wrap-up codes", crud: CRUD, named: [], anchor: null },
    { key: "numbers", label: "Numbers", crud: CRUD, named: ["assign"], anchor: "objects" },
    { key: "domains", label: "Domains", crud: CRUD, named: [], anchor: null },
    { key: "secrets", label: "Secrets", crud: CRUD, named: [], anchor: null },
    { key: "data_sources", label: "Data sources", crud: ["read"], named: [], anchor: null },
    { key: "contacts", label: "Contacts", crud: CRUD, named: ["import"], anchor: null },
    { key: "kb_articles", label: "KB articles", crud: CRUD, named: [], anchor: "objects" },
    { key: "tasks", label: "Tasks", crud: CRUD, named: [], anchor: null },
    { key: "web_pages", label: "Web pages", crud: CRUD, named: [], anchor: "objects" },
    { key: "media", label: "Media", crud: ["read", "create", "delete"], named: [], anchor: null },
  ] },
  { area: "Automations", items: [
    { key: "call_flows", label: "Call & app flows", crud: CRUD, named: ["import", "export", "test", "monitor"], anchor: "objects" },
    { key: "workflows", label: "Workflows", crud: CRUD, named: ["import", "export", "ai"], anchor: "objects" },
    { key: "forms", label: "Forms", crud: CRUD, named: ["publish", "ai", "import", "export"], anchor: "objects" },
  ] },
  { area: "AI", items: [
    { key: "ai_assistants", label: "AI assistants", crud: CRUD, named: ["clone", "promote", "chat", "test"], anchor: "objects" },
    { key: "ai_tools", label: "AI tools", crud: CRUD, named: ["test", "assign"], anchor: "objects" },
    { key: "ai_insights", label: "Insights", crud: CRUD, named: [], anchor: null },
    { key: "ai_integrations", label: "AI integrations", crud: ["read", "create", "delete"], named: ["connect"], anchor: null },
    { key: "ai_models", label: "AI models", crud: ["read"], named: [], anchor: null },
    { key: "mcp_servers", label: "MCP servers", crud: CRUD, named: [], anchor: "objects" },
    { key: "pronunciation_dicts", label: "Pronunciation dictionaries", crud: CRUD, named: [], anchor: null },
    { key: "scheduled_events", label: "Scheduled events", crud: CRUD, named: ["import"], anchor: "objects" },
  ] },
  { area: "Channels", items: [
    { key: "email_admin", label: "Email administration", crud: ["read", "update"], named: ["mailboxes.manage", "domain.manage", "templates.manage", "filters.manage", "delivery.read", "copilot.use"], anchor: "objects" },
    { key: "sms_admin", label: "SMS administration", crud: ["read", "update"], named: ["numbers.manage", "profile.manage", "templates.manage", "delivery.read", "copilot.use"], anchor: "objects" },
    { key: "whatsapp_admin", label: "WhatsApp administration", crud: ["read", "update"], named: ["numbers.manage", "details.manage", "templates.manage", "delivery.read", "copilot.use"], anchor: "objects" },
    { key: "messaging_admin", label: "Messaging profiles", crud: ["read", "update"], named: [], anchor: null },
    { key: "widgets", label: "Web widgets", crud: CRUD, named: ["publish"], anchor: "objects" },
    { key: "messaging", label: "Messaging", crud: [], named: ["send"], anchor: "channels" },
    { key: "cobrowse", label: "Co-browsing", crud: [], named: ["request", "view", "control", "history.read", "supervise"], anchor: "queues" },
  ] },
  { area: "System", items: [
    { key: "system_dashboard", label: "System dashboard", crud: ["read"], named: [], anchor: null },
    { key: "system_settings", label: "System settings", crud: ["read", "update"], named: [], anchor: null },
    { key: "logging", label: "Logging", crud: CRUD, named: [], anchor: null },
    { key: "call_generator", label: "Call generator", crud: CRUD, named: ["execute"], anchor: null },
    { key: "phones", label: "Phones", crud: CRUD, named: ["provision"], anchor: null },
    { key: "telephony_connections", label: "Telephony connections", crud: ["read", "update"], named: [], anchor: null },
    { key: "utilization", label: "Utilization", crud: ["read", "update"], named: [], anchor: "queues" },
    { key: "sla", label: "SLA", crud: ["read", "update"], named: [], anchor: "queues" },
    { key: "telephony_tools", label: "TTS, translation, TeXML lookup", crud: [], named: ["use"], anchor: null },
  ] },
  { area: "Supervision", items: [
    { key: "monitor", label: "Live monitor", crud: ["read"], named: [], anchor: "queues" },
    { key: "reports", label: "Reports", crud: ["read"], named: ["export"], anchor: "queues" },
    { key: "interactions_history", label: "Interaction history", crud: ["read"], named: [], anchor: "queues" },
    { key: "interactions", label: "Interactions", crud: ["read"], named: ["transcribe", "annotate"], anchor: "queues" },
    { key: "recordings", label: "Recordings", crud: ["read"], named: ["transcribe", "download"], anchor: "queues" },
    { key: "calls", label: "Calls", crud: [], named: ["supervise.listen", "supervise.whisper", "supervise.barge", "supervise.takeover"], anchor: "queues" },
    { key: "agents", label: "Agents", crud: ["read"], named: ["status.set", "queues.set", "campaigns.assign", "logout"], anchor: "teams" },
    { key: "acd_operations", label: "ACD operations", crud: ["read"], named: ["manage"], anchor: null },
  ] },
  { area: "Quality", items: [
    { key: "quality", label: "Quality dashboard", crud: ["read"], named: [], anchor: "queues" },
    { key: "quality_forms", label: "Quality forms", crud: CRUD, named: [], anchor: "objects" },
    { key: "quality_evaluations", label: "Evaluations", crud: CRUD, named: ["ai", "calibrate"], anchor: "queues" },
  ] },
  { area: "Outbound", items: [
    { key: "campaigns", label: "Campaigns", crud: CRUD, named: ["execute", "pause"], anchor: "campaigns" },
    { key: "contact_lists", label: "Contact lists", crud: CRUD, named: ["import", "preview"], anchor: "campaigns" },
    { key: "dnc_lists", label: "DNC lists", crud: CRUD, named: ["import", "preview"], anchor: "campaigns" },
    { key: "dialer_filters", label: "Dialer filters", crud: CRUD, named: ["test"], anchor: "campaigns" },
    { key: "dialer_time_sets", label: "Time sets", crud: CRUD, named: [], anchor: "campaigns" },
    { key: "disposition_codes", label: "Disposition codes", crud: CRUD, named: [], anchor: "campaigns" },
    { key: "dialer_attempt_controls", label: "Attempt controls", crud: CRUD, named: [], anchor: "campaigns" },
    { key: "dialer_settings", label: "Dialer settings", crud: ["read", "update"], named: [], anchor: null },
  ] },
  { area: "Agent work", items: [
    { key: "agent", label: "Own interactions and desktop", crud: [], named: ["self"], anchor: null },
  ] },
];

/** Scope anchors. `own` resolves at request time from the assignee's memberships. */
export const SCOPE_ANCHORS = [
  { id: "queues", label: "Queues", source: "cc_queues", own: true },
  { id: "teams", label: "Teams", source: "agent_groups", own: true },
  { id: "campaigns", label: "Campaigns", source: "outbound_campaigns", own: true },
  { id: "channels", label: "Channels", source: "channel", own: false, options: CHANNELS },
];

export const SCOPE_MODES = ["all", "list", "own"];

// ---------------------------------------------------------------- derived lists

const SCREEN_INDEX = new Map(); // id -> node with parent chain
const SCREEN_LEAVES = [];
(function index(nodes, parents) {
  for (const node of nodes) {
    const entry = { ...node, parents };
    SCREEN_INDEX.set(node.id, entry);
    if (node.kids?.length) index(node.kids, [...parents, node.id]);
    else SCREEN_LEAVES.push(entry);
  }
})(SCREEN_TREE, []);

const RESOURCE_INDEX = new Map();
const OPERATION_KEYS = [];
for (const area of RESOURCE_AREAS) {
  for (const item of area.items) {
    RESOURCE_INDEX.set(item.key, { ...item, area: area.area });
    for (const action of [...item.crud, ...item.named]) OPERATION_KEYS.push(`${item.key}:${action}`);
  }
}

export function listScreenLeaves() {
  return SCREEN_LEAVES.map((leaf) => ({ id: leaf.id, key: SCREEN_PREFIX + leaf.id, label: leaf.label, path: leaf.path, parents: leaf.parents }));
}

export function listOperationKeys() {
  return OPERATION_KEYS.slice();
}

export function getResource(key) {
  return RESOURCE_INDEX.get(key) || null;
}

export function getScreenNode(id) {
  return SCREEN_INDEX.get(id) || null;
}

/** Human-readable breadcrumb for a screen id: "Supervisor › Monitor › Agents". */
export function screenLabel(id) {
  const node = SCREEN_INDEX.get(String(id || ""));
  if (!node) return String(id || "");
  const parts = [...node.parents.map((parentId) => SCREEN_INDEX.get(parentId)?.label || parentId), node.label];
  return parts.join(" › ");
}

/**
 * Does a set of screen grants admit a screen? `grants` are leaf ids, group
 * wildcards ("admin.*") or "*" (owner); a group screen is admitted by any
 * grant at or below it.
 */
export function screensPermit(grants, screen, { group = false } = {}) {
  const list = Array.isArray(grants) ? grants.map(String) : [];
  if (!screen) return false;
  if (list.includes(WILDCARD)) return true;
  const target = String(screen).replace(SCREEN_PREFIX, "");
  for (const raw of list) {
    const grant = raw.replace(SCREEN_PREFIX, "");
    if (grant.endsWith(".*")) {
      const prefix = grant.slice(0, -2);
      if (target === prefix || target.startsWith(`${prefix}.`) || (group && prefix.startsWith(`${target}.`))) return true;
      continue;
    }
    if (grant === target) return true;
    if (group && grant.startsWith(`${target}.`)) return true;
  }
  return false;
}

/** Leaf screen ids under a node id (the node itself when it is a leaf). */
export function screenLeavesUnder(nodeId) {
  const node = SCREEN_INDEX.get(nodeId);
  if (!node) return [];
  if (!node.kids?.length) return [node.id];
  return SCREEN_LEAVES.filter((leaf) => leaf.parents.includes(nodeId)).map((leaf) => leaf.id);
}

// ---------------------------------------------------------------- key grammar

const KEY_PATTERN = /^[a-z][a-z0-9_]*:(\*|[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*(\.\*)?)$/;

export function normalizeKey(key) {
  return String(key || "").trim().toLowerCase();
}

/** Grammar check only; use isKnownPermission for catalogue membership. */
export function isWellFormedKey(key) {
  const k = normalizeKey(key);
  return k === WILDCARD || KEY_PATTERN.test(k);
}

/** True when the key names something the catalogue knows (exact or a valid wildcard over it). */
export function isKnownPermission(key) {
  const k = normalizeKey(key);
  if (k === WILDCARD) return true;
  if (!isWellFormedKey(k)) return false;
  if (k.startsWith(SCREEN_PREFIX)) {
    const target = k.slice(SCREEN_PREFIX.length);
    if (target === WILDCARD) return true;
    if (target.endsWith(".*")) return SCREEN_INDEX.has(target.slice(0, -2));
    return SCREEN_INDEX.has(target);
  }
  const [resource, action] = k.split(":");
  const item = RESOURCE_INDEX.get(resource);
  if (!item) return false;
  if (action === WILDCARD) return true;
  return item.crud.includes(action) || item.named.includes(action);
}

/** Does a granted key satisfy a required key? Wildcards live on the granted side. */
export function matches(granted, required) {
  const g = normalizeKey(granted);
  const r = normalizeKey(required);
  if (!g || !r) return false;
  if (g === WILDCARD) return true;
  if (g === r) return true;
  if (g.startsWith(SCREEN_PREFIX) && r.startsWith(SCREEN_PREFIX)) {
    const gt = g.slice(SCREEN_PREFIX.length);
    const rt = r.slice(SCREEN_PREFIX.length);
    if (gt === WILDCARD) return true;
    if (gt.endsWith(".*")) return rt === gt.slice(0, -2) || rt.startsWith(gt.slice(0, -1));
    return false;
  }
  const [gr, ga] = g.split(":");
  const [rr] = r.split(":");
  return gr === rr && ga === WILDCARD;
}

/** Expand a set of granted keys into the concrete leaf keys they cover. */
export function expandGrants(keys) {
  const screens = new Set();
  const operations = new Set();
  let wildcard = false;
  for (const raw of keys || []) {
    const k = normalizeKey(raw);
    if (k === WILDCARD) { wildcard = true; continue; }
    if (k.startsWith(SCREEN_PREFIX)) {
      const target = k.slice(SCREEN_PREFIX.length);
      if (target === WILDCARD) SCREEN_LEAVES.forEach((leaf) => screens.add(leaf.id));
      else if (target.endsWith(".*")) screenLeavesUnder(target.slice(0, -2)).forEach((id) => screens.add(id));
      else if (SCREEN_INDEX.has(target)) screenLeavesUnder(target).forEach((id) => screens.add(id));
      continue;
    }
    const [resource, action] = k.split(":");
    const item = RESOURCE_INDEX.get(resource);
    if (!item) continue;
    if (action === WILDCARD) [...item.crud, ...item.named].forEach((a) => operations.add(`${resource}:${a}`));
    else if (item.crud.includes(action) || item.named.includes(action)) operations.add(k);
  }
  if (wildcard) {
    SCREEN_LEAVES.forEach((leaf) => screens.add(leaf.id));
    OPERATION_KEYS.forEach((op) => operations.add(op));
  }
  return { screens, operations, wildcard };
}

/**
 * Compact a set of leaf screen ids into stored keys: a fully covered group is
 * stored as "screen:<group>.*" so screens added in later releases are covered
 * too; partial groups are stored leaf by leaf.
 */
export function compactScreenGrants(leafIds) {
  const selected = new Set(leafIds);
  const out = [];
  const visit = (node) => {
    const leaves = screenLeavesUnder(node.id);
    if (!node.kids?.length) { if (selected.has(node.id)) out.push(SCREEN_PREFIX + node.id); return; }
    if (leaves.length && leaves.every((id) => selected.has(id))) { out.push(`${SCREEN_PREFIX}${node.id}.*`); return; }
    node.kids.forEach(visit);
  };
  SCREEN_TREE.forEach(visit);
  return out;
}

// ---------------------------------------------------------------- path resolution

const SECTION_DEFAULTS = {
  "agent.desktop": "desktop",
  "supervisor.monitor": "overview",
  "supervisor.analytics": "queue-performance",
  "supervisor.quality": "dashboard",
  "supervisor.outbound-dialer": "dashboard",
  "admin.email": "mailboxes",
  "admin.sms": "numbers",
  "admin.whatsapp": "numbers",
  "admin.configuration.data-sources": "contacts",
};

const PATH_RULES = [
  [/^\/agent\/desktop(\/|$)/, "agent.desktop", "section"],
  [/^\/agent\/configuration(\/|$)/, "agent.configuration"],
  [/^\/supervisor\/monitor(\/|$)/, "supervisor.monitor", "section"],
  [/^\/supervisor\/analytics(\/|$)/, "supervisor.analytics", "section"],
  [/^\/supervisor\/(call-history|interactions-history)(\/|$)/, "supervisor.analytics.call-history"],
  [/^\/supervisor\/quality\/evaluations(\/|$)/, "supervisor.quality.evaluations"],
  [/^\/supervisor\/quality(\/|$)/, "supervisor.quality", "section"],
  [/^\/supervisor\/outbound-dialer(\/|$)/, "supervisor.outbound-dialer", "section"],
  [/^\/supervisor\/scheduled-events(\/|$)/, "supervisor.scheduled-events"],
  [/^\/admin\/users(\/|$)/, "admin.configuration.users"],
  [/^\/admin\/permissions(\/|$)/, "admin.configuration.permissions"],
  [/^\/admin\/teams(\/|$)/, "admin.configuration.teams"],
  [/^\/admin\/queues(\/|$)/, "admin.configuration.queues"],
  [/^\/admin\/skills(\/|$)/, "admin.configuration.skills"],
  [/^\/admin\/statuses(\/|$)/, "admin.configuration.statuses"],
  [/^\/admin\/wrapup-codes(\/|$)/, "admin.configuration.wrapup-codes"],
  [/^\/admin\/numbers(\/|$)/, "admin.configuration.numbers"],
  [/^\/admin\/contacts(\/|$)/, "admin.configuration.data-sources.contacts"],
  [/^\/admin\/kb-articles(\/|$)/, "admin.configuration.data-sources.kb-articles"],
  [/^\/admin\/data-sources(\/|$)/, "admin.configuration.data-sources", "view"],
  [/^\/admin\/web-pages(\/|$)/, "admin.configuration.web-pages"],
  [/^\/admin\/media-library(\/|$)/, "admin.configuration.media-library"],
  [/^\/admin\/domains(\/|$)/, "admin.configuration.domains"],
  [/^\/admin\/secrets(\/|$)/, "admin.configuration.secrets"],
  [/^\/admin\/call-flows(\/|$)/, "admin.automations.call-app-flows"],
  [/^\/admin\/workflows(\/|$)/, "admin.automations.workflows"],
  [/^\/admin\/forms(\/|$)/, "admin.automations.forms"],
  [/^\/admin\/ai-assistants\/pronunciation-dictionaries(\/|$)/, "admin.ai.pronunciation-dictionaries"],
  [/^\/admin\/ai-assistants(\/|$)/, "admin.ai.assistants"],
  [/^\/admin\/tools-library(\/|$)/, "admin.ai.tools"],
  [/^\/admin\/insights(\/|$)/, "admin.ai.insights"],
  [/^\/admin\/mcp-servers(\/|$)/, "admin.ai.mcp-servers"],
  [/^\/admin\/email(\/|$)/, "admin.email", "section"],
  [/^\/admin\/sms\/templates(\/|$)/, "admin.sms.templates"],
  [/^\/admin\/sms(\/|$)/, "admin.sms", "section"],
  [/^\/admin\/whatsapp(\/|$)/, "admin.whatsapp", "section"],
  [/^\/admin\/widgets(\/|$)/, "admin.widgets"],
  [/^\/admin\/system\/settings(\/|$)/, "admin.system.settings"],
  [/^\/admin\/system(\/|$)/, "admin.system.dashboard"],
  [/^\/admin\/call-generator(\/|$)/, "admin.system.call-generator"],
  [/^\/admin\/logging(\/|$)/, "admin.system.logging"],
  [/^\/admin\/phones-provisioning(\/|$)/, "admin.system.phones-provisioning"],
  [/^\/settings(\/|$)/, "admin.system.theme-settings"],
];

/**
 * Map a portal path to the screen it belongs to. Returns
 *   { screen: "<id>", group: true|false }  or  null when the path is not gated.
 * A group result (e.g. /admin/data-sources without a tile, or /supervisor/monitor
 * without a section) is allowed when the user holds any leaf below it; the
 * section rail then opens the first permitted section. `defaultScreen` names
 * the leaf the page would open by default.
 */
export function resolveScreenForPath(pathname, search = "") {
  const path = String(pathname || "");
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  for (const [pattern, base, sectionParam] of PATH_RULES) {
    if (!pattern.test(path)) continue;
    if (sectionParam) {
      const requested = params.get(sectionParam);
      if (!requested) return { screen: base, group: true, defaultScreen: `${base}.${SECTION_DEFAULTS[base]}` };
      const id = `${base}.${requested}`;
      if (SCREEN_INDEX.has(id)) return { screen: id, group: false };
      return { screen: base, group: true };
    }
    const node = SCREEN_INDEX.get(base);
    return { screen: base, group: Boolean(node?.kids?.length) };
  }
  if (/^\/(admin|supervisor|agent)(\/|$)/.test(path)) return { screen: null, group: false, unknown: true };
  return null;
}

// ---------------------------------------------------------------- validation helpers

export function emptyScopes() {
  const scopes = {};
  for (const anchor of SCOPE_ANCHORS) scopes[anchor.id] = { mode: "all" };
  return scopes;
}

/**
 * Validate and normalise a scopes object. Unknown anchors are dropped.
 * `strict` (default, editor input) refuses an empty selection; stored scopes
 * are read with `strict: false` so a list emptied by a cascade delete keeps
 * meaning "nothing" instead of widening to "all" (permission tree rule 6).
 */
export function normalizeScopes(input, { strict = true } = {}) {
  const errors = [];
  const scopes = emptyScopes();
  const source = input && typeof input === "object" ? input : {};
  for (const anchor of SCOPE_ANCHORS) {
    const raw = source[anchor.id];
    if (raw == null) continue;
    const mode = String(raw.mode || "all").toLowerCase();
    if (!SCOPE_MODES.includes(mode)) { errors.push(`${anchor.label}: unknown scope mode "${raw.mode}"`); continue; }
    if (mode === "own" && !anchor.own) { errors.push(`${anchor.label}: "own" is not available for this anchor`); continue; }
    if (mode === "list") {
      const ids = Array.isArray(raw.ids) ? raw.ids.map((v) => String(v).trim()).filter(Boolean) : [];
      if (!ids.length && strict) { errors.push(`${anchor.label}: the selection is empty`); continue; }
      if (anchor.options && ids.some((id) => !anchor.options.includes(id))) { errors.push(`${anchor.label}: unknown value in selection`); continue; }
      scopes[anchor.id] = raw.own && anchor.own ? { mode, ids: [...new Set(ids)], own: true } : { mode, ids: [...new Set(ids)] };
    } else {
      scopes[anchor.id] = { mode };
    }
  }
  const objects = source.objects && typeof source.objects === "object" ? source.objects : null;
  if (objects) {
    scopes.objects = {};
    for (const [resource, raw] of Object.entries(objects)) {
      const item = RESOURCE_INDEX.get(resource);
      if (!item || item.anchor !== "objects") { errors.push(`Objects: ${resource} does not take an object list`); continue; }
      const mode = String(raw?.mode || "all").toLowerCase();
      if (mode === "all") { scopes.objects[resource] = { mode: "all" }; continue; }
      const ids = Array.isArray(raw?.ids) ? raw.ids.map((v) => String(v).trim()).filter(Boolean) : [];
      if (mode !== "list" || !ids.length) { errors.push(`Objects: ${item.label} selection is empty`); continue; }
      scopes.objects[resource] = { mode: "list", ids: [...new Set(ids)] };
    }
  }
  return { scopes, errors };
}

/** Validate permission keys; returns { keys, unknown }. */
export function normalizePermissionKeys(input) {
  const keys = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of Array.isArray(input) ? input : []) {
    const k = normalizeKey(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (isKnownPermission(k)) keys.push(k);
    else unknown.push(k);
  }
  return { keys, unknown };
}

export function summarizeGrants(keys) {
  const { screens, operations, wildcard } = expandGrants(keys);
  return { screens: screens.size, operations: operations.size, wildcard };
}

// Cover the candidate with whole grant rectangles, preserving correlations.
// Filter the remaining grants at each axis instead of flattening their ids.
function coveredByGrants(candidate, grants, axisIndex = 0) {
  if (!grants.length) return false;
  if (axisIndex === SCOPE_ANCHORS.length) return true;
  const axis = SCOPE_ANCHORS[axisIndex].id;
  const wanted = candidate?.[axis] || { mode: "all" };
  if (wanted.mode === "own") return coveredByGrants(candidate, grants, axisIndex + 1);
  if (wanted.mode === "all") return coveredByGrants(candidate, grants.filter((grant) => !grant[axis] || grant[axis].mode === "all"), axisIndex + 1);
  const choices = wanted.ids || [];
  return choices.every((id) => coveredByGrants(candidate, grants.filter((grant) => {
    const held = grant[axis] || { mode: "all" };
    return held.mode === "all" || (held.mode === "list" && (held.ids || []).includes(id));
  }), axisIndex + 1));
}

/** Is every permission and scope of `candidate` held by `holder`? (delegation rule) */
export function isSubsetOf(candidateKeys, candidateScopes, holderExpanded, holderScopes) {
  const missing = [];
  if (!holderExpanded.wildcard) {
    const c = expandGrants(candidateKeys);
    for (const s of c.screens) if (!holderExpanded.screens.has(s)) missing.push(SCREEN_PREFIX + s);
    for (const o of c.operations) if (!holderExpanded.operations.has(o)) missing.push(o);
    if (c.wildcard) missing.push(WILDCARD);
  }
  const scopeIssues = [];
  if (!holderExpanded.wildcard && holderScopes) {
    // `holderScopes` is either the holder's user-wide scopes or a function that
    // returns the holder's scope for one operation — the scope of the roles that
    // grant it (decision D-22) — so a broad but unrelated role cannot lend its
    // scope to a permission the holder only has narrowly.
    const perOperation = typeof holderScopes === "function";
    const targets = perOperation ? [...expandGrants(candidateKeys).operations] : [null];
    const seen = new Set();
    for (const operation of targets) {
      const holder = perOperation ? holderScopes(operation) : holderScopes;
      if (!holder) continue; // not held at all: already reported in `missing`
      if (holder.grants?.length > 1) {
        const covered = coveredByGrants(candidateScopes, holder.grants);
        if (!covered) scopeIssues.push(`Scope includes combinations outside your held grants (${operation})`);
        continue;
      }
      for (const anchor of SCOPE_ANCHORS) {
        const held = holder[anchor.id] || { mode: "all" };
        const cand = candidateScopes?.[anchor.id] || { mode: "all" };
        if (held.mode === "all") continue;
        let issue = null;
        if (cand.mode === "all") issue = `${anchor.label}: you cannot grant "all" because your own scope is limited`;
        else if (cand.mode === "own") continue;
        else if (held.mode === "own") issue = `${anchor.label}: you cannot grant a fixed selection because your own scope is dynamic`;
        else {
          const heldIds = new Set(held.ids || []);
          const outside = (cand.ids || []).filter((id) => !heldIds.has(id));
          if (outside.length) issue = `${anchor.label}: ${outside.join(", ")} outside your own scope`;
        }
        if (!issue) continue;
        const text = perOperation ? `${issue} (${operation})` : issue;
        if (!seen.has(text)) { seen.add(text); scopeIssues.push(text); }
      }
    }
  }
  return { ok: missing.length === 0 && scopeIssues.length === 0, missing, scopeIssues };
}

// ---------------------------------------------------------------- built-in roles

const AGENT_KEYS = ["screen:agent.*", "agent:self", "interactions:read", "cobrowse:request", "cobrowse:view", "kb_articles:read", "forms:read", "contacts:read", "tasks:read", "web_pages:read"];
const SUPERVISOR_KEYS = [
  ...AGENT_KEYS,
  "screen:supervisor.monitor.*", "screen:supervisor.analytics.*", "screen:supervisor.quality.*", "screen:supervisor.scheduled-events",
  "monitor:read", "reports:*", "interactions_history:read", "interactions:*", "recordings:*", "cobrowse:history.read", "calls:*", "agents:*",
  "quality:*", "quality_forms:*", "quality_evaluations:*", "scheduled_events:*", "messaging:send",
  // Kept from the pre-RBAC supervisor: the assistant list and TTS used by scheduled events and the dialer, and the call-flow monitor streams.
  "ai_assistants:read", "telephony_tools:use", "call_flows:monitor",
];
const ADMIN_KEYS = [
  ...SUPERVISOR_KEYS,
  "screen:supervisor.outbound-dialer.*", "screen:admin.*",
  ...RESOURCE_AREAS.flatMap((area) => area.items.map((item) => `${item.key}:*`)),
];

export const SYSTEM_ROLES = [
  { key: "agent", name: "Agent", description: "Handles interactions on the agent desktop.", permissions: AGENT_KEYS, scopes: emptyScopes() },
  { key: "supervisor", name: "Supervisor", description: "Monitors queues and agents, coaches live, runs quality and reporting.", permissions: SUPERVISOR_KEYS, scopes: emptyScopes() },
  { key: "admin", name: "Admin", description: "Configures the contact centre, including the outbound dialer.", permissions: [...new Set(ADMIN_KEYS)], scopes: emptyScopes() },
  { key: "owner", name: "Owner", description: "Unrestricted access. Cannot be edited; only an owner can grant it.", permissions: [WILDCARD], scopes: emptyScopes() },
];

const own = (...anchors) => { const s = emptyScopes(); for (const a of anchors) s[a] = { mode: "own" }; return s; };

/** Ten shipped position roles (the internal documentation). Seeded once, editable, never overwritten. */
export const PRESET_ROLES = [
  { key: "team-leader", name: "Team Leader", description: "Day-to-day supervision and live coaching of one's own team.",
    permissions: ["screen:supervisor.monitor.overview", "screen:supervisor.monitor.agents", "screen:supervisor.monitor.queues", "screen:supervisor.monitor.interactions", "screen:supervisor.analytics.agent-performance", "screen:supervisor.analytics.agent-adherence", "screen:supervisor.analytics.transfers-holds", "screen:supervisor.analytics.call-history", "screen:supervisor.quality.dashboard", "screen:supervisor.quality.evaluations",
      "monitor:read", "reports:read", "interactions_history:read", "interactions:read", "recordings:read", "calls:supervise.listen", "calls:supervise.whisper", "calls:supervise.barge", "agents:read", "agents:status.set", "agents:queues.set", "quality:read", "quality_evaluations:read", "quality_evaluations:create", "quality_evaluations:update"],
    scopes: own("queues", "teams") },
  { key: "quality-manager", name: "Quality Manager", description: "Owns the evaluation programme: scorecards, evaluations, calibration, recordings and transcripts.",
    permissions: ["screen:supervisor.quality.*", "screen:supervisor.analytics.call-history", "screen:supervisor.analytics.agent-performance", "screen:supervisor.analytics.wrapup-codes", "screen:supervisor.analytics.ai-handoffs", "screen:supervisor.monitor.overview",
      "quality:read", "quality_forms:*", "quality_evaluations:*", "interactions_history:read", "interactions:read", "interactions:transcribe", "recordings:*", "reports:read", "reports:export", "monitor:read"],
    scopes: emptyScopes() },
  { key: "workforce-analyst", name: "Workforce Analyst", description: "Watches the floor in real time and owns capacity settings.",
    permissions: ["screen:supervisor.monitor.overview", "screen:supervisor.monitor.dashboard", "screen:supervisor.monitor.agents", "screen:supervisor.monitor.queues", "screen:supervisor.monitor.interactions", "screen:supervisor.analytics.queue-performance", "screen:supervisor.analytics.agent-performance", "screen:supervisor.analytics.agent-adherence", "screen:supervisor.analytics.abandonment", "screen:supervisor.analytics.transfers-holds", "screen:supervisor.analytics.skills-gap",
      "monitor:read", "reports:read", "reports:export", "agents:read", "agents:status.set", "utilization:*", "sla:*", "queues:read", "skills:read"],
    scopes: emptyScopes() },
  { key: "reporting-analyst", name: "Reporting Analyst", description: "Aggregate reports only; no access to conversation content.",
    permissions: ["screen:supervisor.analytics.queue-performance", "screen:supervisor.analytics.agent-performance", "screen:supervisor.analytics.abandonment", "screen:supervisor.analytics.agent-adherence", "screen:supervisor.analytics.transfers-holds", "screen:supervisor.analytics.wrapup-codes", "screen:supervisor.analytics.ai-handoffs", "screen:supervisor.analytics.outbound-campaigns", "screen:supervisor.analytics.skills-gap", "screen:supervisor.monitor.dashboard",
      "reports:read", "reports:export", "monitor:read"],
    scopes: emptyScopes() },
  { key: "compliance-auditor", name: "Compliance Auditor", description: "Reads everything relevant to an audit and changes nothing.",
    permissions: ["screen:supervisor.analytics.*", "screen:supervisor.quality.dashboard", "screen:supervisor.quality.evaluations", "screen:supervisor.monitor.overview", "screen:admin.configuration.users", "screen:admin.configuration.permissions",
      "reports:read", "reports:export", "interactions_history:read", "interactions:read", "recordings:read", "recordings:download", "quality:read", "quality_evaluations:read", "users:read", "roles:read", "monitor:read"],
    scopes: emptyScopes() },
  { key: "campaign-manager", name: "Campaign Manager", description: "Runs outbound: campaigns, lists, suppression, pacing and campaign reporting.",
    permissions: ["screen:supervisor.outbound-dialer.*", "screen:supervisor.analytics.outbound-campaigns", "screen:supervisor.monitor.overview", "screen:supervisor.monitor.interactions",
      "campaigns:*", "contact_lists:*", "dnc_lists:*", "dialer_filters:*", "dialer_time_sets:*", "disposition_codes:*", "dialer_attempt_controls:*", "dialer_settings:*", "agents:read", "agents:campaigns.assign", "contacts:read", "reports:read", "reports:export", "monitor:read"],
    scopes: emptyScopes() },
  { key: "user-administrator", name: "User Administrator", description: "Staffing and access management without telephony configuration.",
    permissions: ["screen:admin.configuration.users", "screen:admin.configuration.permissions", "screen:admin.configuration.skills",
      "users:*", "roles:*", "skills:*", "teams:*", "queues:read", "queues:agents.assign"],
    scopes: emptyScopes() },
  { key: "routing-administrator", name: "Routing Administrator", description: "Owns how interactions reach people: queues, skills, flows, numbers and dispositions.",
    permissions: ["screen:admin.configuration.queues", "screen:admin.configuration.skills", "screen:admin.configuration.statuses", "screen:admin.configuration.wrapup-codes", "screen:admin.configuration.numbers", "screen:admin.automations.call-app-flows", "screen:admin.system.dashboard",
      "queues:*", "skills:*", "statuses:*", "wrapup_codes:*", "numbers:*", "call_flows:*", "telephony_connections:*", "sla:*", "monitor:read"],
    scopes: emptyScopes() },
  { key: "conversation-designer", name: "Conversation Designer", description: "Builds assistants, tools, agent-assist workflows, forms and knowledge.",
    permissions: ["screen:admin.ai.*", "screen:admin.automations.workflows", "screen:admin.automations.forms", "screen:admin.configuration.data-sources.*", "screen:supervisor.scheduled-events", "screen:supervisor.analytics.ai-handoffs",
      "ai_assistants:*", "ai_tools:*", "ai_insights:*", "ai_models:read", "ai_integrations:read", "ai_integrations:connect", "mcp_servers:*", "pronunciation_dicts:*", "scheduled_events:*", "workflows:*", "forms:*", "kb_articles:*", "contacts:read", "tasks:read", "telephony_tools:use", "reports:read"],
    scopes: emptyScopes() },
  { key: "channel-administrator", name: "Channel Administrator", description: "Owns e-mail, SMS, WhatsApp and web widgets end to end.",
    permissions: ["screen:admin.email.*", "screen:admin.sms.*", "screen:admin.whatsapp.*", "screen:admin.widgets", "screen:admin.configuration.media-library",
      "email_admin:*", "sms_admin:*", "whatsapp_admin:*", "messaging_admin:*", "widgets:*", "messaging:send", "media:*", "numbers:read", "domains:read"],
    scopes: emptyScopes() },
];

/** Catalogue payload for the role editor. */
export function describeCatalogue() {
  return {
    screens: SCREEN_TREE,
    areas: RESOURCE_AREAS,
    anchors: SCOPE_ANCHORS,
    channels: CHANNELS,
    modes: SCOPE_MODES,
    totals: { screens: SCREEN_LEAVES.length, operations: OPERATION_KEYS.length },
  };
}

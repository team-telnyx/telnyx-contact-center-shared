// RBAC Phase 3: menu, section rails and pages follow the screen catalogue.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getScreenNode, listScreenLeaves, resolveScreenForPath, screenLabel, screensPermit, SYSTEM_ROLES, PRESET_ROLES } from "../lib/authz/permissions.mjs";
import { effectiveAccess } from "../lib/authz/effective.mjs";
import { decidePageAccess, deniedRedirectPath } from "../lib/authz/page-access.mjs";
import { screenGrantsFor } from "../lib/authz/page-access-server.mjs";
import { resolveHomeDestination, ADMIN_HOME, SUPERVISOR_HOME, AGENT_HOME } from "../lib/home-destination.mjs";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const definitions = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map((r) => [r.key, r]));
const grantsOf = async (roles) => screenGrantsFor(await effectiveAccess({ id: "u", roles }, definitions));

test("every menu item names an existing screen or screen group and its url resolves to it", () => {
  const menu = source("config/menu.jsx");
  assert.doesNotMatch(menu, /role_access/);
  const items = [...menu.matchAll(/title:\s*"([^"]+)",[\s\S]*?url:\s*"([^"]+)",[\s\S]*?(?:screen:\s*"([^"]+)"|screens:\s*\[([^\]]+)\])/g)];
  assert.ok(items.length >= 13, `expected the menu items, found ${items.length}`);
  for (const [, title, url, screen, screens] of items) {
    const declared = screen ? [screen] : screens.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    for (const id of declared) assert.ok(getScreenNode(id), `${title}: screen ${id} is not in the catalogue`);
    const resolved = resolveScreenForPath(url.split("?")[0], url.includes("?") ? url.slice(url.indexOf("?")) : "");
    assert.ok(resolved?.screen, `${title}: ${url} resolves to no screen`);
    assert.ok(declared.some((id) => resolved.screen === id || resolved.screen.startsWith(`${id}.`)), `${title}: ${url} resolves to ${resolved.screen}, declared ${declared.join(", ")}`);
  }
});

test("section rails declare their catalogue group and every rail entry maps to a screen", () => {
  const rails = [
    ["components/admin/ConfigurationSectionNav.jsx", "admin.configuration"],
    ["components/admin/SystemSectionNav.jsx", "admin.system"],
    ["components/admin/AutomationsSectionNav.jsx", "admin.automations"],
    ["components/assistants/AiAssistantsSectionNav.jsx", "admin.ai"],
    ["components/contact-center/MonitorSectionNav.jsx", "supervisor.monitor"],
    ["components/contact-center/AnalyticsSectionNav.jsx", "supervisor.analytics"],
    ["components/contact-center/QualitySectionNav.jsx", "supervisor.quality"],
    ["components/email/EmailAdmin.jsx", "admin.email"],
    ["components/sms/SmsAdmin.jsx", "admin.sms"],
    ["components/whatsapp/WhatsAppAdmin.jsx", "admin.whatsapp"],
    ["components/contact-center/AgentDesktop.jsx", "agent.desktop"],
    ["app/(portal)/supervisor/outbound-dialer/page.jsx", "supervisor.outbound-dialer"],
  ];
  const ARRAYS = ["CONFIGURATION_ITEMS", "SYSTEM_ITEMS", "AUTOMATION_ITEMS", "AI_SECTION_ITEMS", "MONITOR_RAIL_ITEMS", "ANALYTICS_RAIL_ITEMS", "QUALITY_RAIL_ITEMS", "EMAIL_SECTIONS", "SMS_SECTIONS", "SECTIONS", "AGENT_RAIL_ITEMS", "NAV_ITEMS"];
  const railBlock = (text) => {
    for (const name of ARRAYS) {
      const start = text.search(new RegExp(`(?:export )?const ${name}\\s*=\\s*\\[`));
      if (start < 0) continue;
      const end = text.indexOf("];", start);
      return text.slice(start, end);
    }
    return text;
  };
  for (const [path, group] of rails) {
    const text = source(path);
    assert.ok(text.includes(`screenGroup="${group}"`), `${path} declares screenGroup ${group}`);
    const block = railBlock(text);
    const ids = [...block.matchAll(/\{\s*id:\s*["']([a-z-]+)["'],\s*label:/g)].map((m) => m[1]).filter((id) => id !== "exit");
    assert.ok(ids.length > 0, `${path} lists rail items`);
    const explicit = Object.fromEntries([...block.matchAll(/id:\s*"([a-z-]+)"[^\n]*screen:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    for (const id of ids) {
      const screen = explicit[id] || `${group}.${id}`;
      assert.ok(getScreenNode(screen), `${path}: rail item ${id} → ${screen} is not in the catalogue`);
    }
  }
  for (const page of ["app/(portal)/supervisor/monitor/page.jsx", "app/(portal)/supervisor/analytics/page.jsx", "app/(portal)/supervisor/quality/page.jsx"]) {
    assert.match(source(page), /screenGroup="supervisor\.(monitor|analytics|quality)"/, `${page} rail follows the screens`);
  }
});

test("system roles keep today's menus: agent sees Desktop only, supervisor adds the supervisor items, admin everything", async () => {
  const menuScreens = {
    Desktop: "agent.desktop", Monitoring: "supervisor.monitor", Analytics: "supervisor.analytics", Quality: "supervisor.quality", "Outbound Dialer": "supervisor.outbound-dialer",
    Configuration: "admin.configuration", Automations: "admin.automations", "AI Assistants": "admin.ai", Email: "admin.email", SMS: "admin.sms", WhatsApp: "admin.whatsapp", "Web Widgets": "admin.widgets", System: "admin.system",
  };
  const visible = async (roles) => Object.entries(menuScreens).filter(([, screen]) => screensPermit(screensGrants, screen, { group: true })).map(([title]) => title);
  let screensGrants = await grantsOf(["agent"]);
  assert.deepEqual(await visible(["agent"]), ["Desktop"]);
  screensGrants = await grantsOf(["supervisor"]);
  assert.deepEqual(await visible(["supervisor"]), ["Desktop", "Monitoring", "Analytics", "Quality"]);
  screensGrants = await grantsOf(["admin"]);
  assert.deepEqual(await visible(["admin"]), Object.keys(menuScreens));
  screensGrants = await grantsOf(["owner"]);
  assert.deepEqual(screensGrants, ["*"]);
  screensGrants = await grantsOf(["team-leader"]);
  assert.deepEqual(await visible(["team-leader"]), ["Monitoring", "Analytics", "Quality"]);
});

test("screensPermit understands leaves, group wildcards and the owner wildcard", () => {
  assert.equal(screensPermit(["admin.*"], "admin.configuration.users"), true);
  assert.equal(screensPermit(["admin.*"], "admin.configuration", { group: true }), true);
  assert.equal(screensPermit(["admin.configuration.users"], "admin.configuration", { group: true }), true);
  assert.equal(screensPermit(["admin.configuration.users"], "admin.configuration"), false, "a group screen needs the group flag");
  assert.equal(screensPermit(["admin.configuration.users"], "admin.configuration.queues"), false);
  assert.equal(screensPermit(["*"], "anything.at.all"), true);
  assert.equal(screensPermit(["screen:supervisor.monitor.*"], "supervisor.monitor.agents"), true, "the screen: prefix is tolerated");
  assert.equal(screensPermit([], "agent.desktop"), false);
});

test("page decisions: not gated, granted, refused, group without a section, unknown portal path", async () => {
  const agent = await grantsOf(["agent"]);
  const supervisor = await grantsOf(["supervisor"]);
  assert.equal(decidePageAccess({ pathname: "/profile", screens: agent }).allowed, true);
  assert.equal(decidePageAccess({ pathname: "/help/administration", screens: [] }).allowed, true);
  assert.equal(decidePageAccess({ pathname: "/agent/desktop", search: "?section=tasks", screens: agent }).allowed, true);
  const refused = decidePageAccess({ pathname: "/supervisor/monitor", search: "?section=agents", screens: agent });
  assert.equal(refused.allowed, false);
  assert.equal(refused.screen, "supervisor.monitor.agents");
  assert.equal(refused.label, "Supervisor › Monitoring › Agents");
  assert.equal(decidePageAccess({ pathname: "/supervisor/monitor", screens: supervisor }).allowed, true, "a section-less path needs any leaf of the group");
  assert.equal(decidePageAccess({ pathname: "/supervisor/outbound-dialer", screens: supervisor }).allowed, false, "supervisors do not hold the dialer (D-13)");
  assert.equal(decidePageAccess({ pathname: "/admin/users", screens: ["admin.configuration.users"] }).allowed, true);
  assert.equal(decidePageAccess({ pathname: "/admin/users", screens: null }).reason, "screens_unavailable");
  assert.equal(decidePageAccess({ pathname: "/admin/does-not-exist", screens: ["*"] }).allowed, false, "unknown portal paths fail closed");
  assert.equal(deniedRedirectPath("supervisor.monitor.agents"), "/?denied=supervisor.monitor.agents");
  assert.equal(screenLabel("admin.configuration.teams"), "Admin › Configuration › Teams");
});

test("the home destination follows the granted screens in the order agent → supervisor → admin", async () => {
  assert.equal(resolveHomeDestination(["agent"], await grantsOf(["agent"])), AGENT_HOME);
  assert.equal(resolveHomeDestination(["supervisor"], await grantsOf(["supervisor"])), AGENT_HOME, "supervisors keep the agent desktop as home (screen:agent.*)");
  assert.equal(resolveHomeDestination([], ["supervisor.analytics.*"]), "/supervisor/analytics");
  assert.equal(resolveHomeDestination([], ["supervisor.monitor.agents"]), SUPERVISOR_HOME);
  assert.equal(resolveHomeDestination([], ["admin.configuration.users"]), "/admin/users");
  assert.equal(resolveHomeDestination([], ["admin.*"]), ADMIN_HOME);
  assert.equal(resolveHomeDestination([], ["*"]), AGENT_HOME, "owners hold every screen; the agent desktop stays first");
  // legacy order without screens
  assert.equal(resolveHomeDestination(["supervisor"]), SUPERVISOR_HOME);
  assert.equal(resolveHomeDestination(["admin"]), ADMIN_HOME);
});

test("the proxy authorises pages, the jwt callback snapshots screens and the shells carry the guard", () => {
  const proxy = source("proxy.js");
  assert.match(proxy, /authorizePage\(\{ token, pathname, search: request\.nextUrl\.search \}\)/);
  assert.match(proxy, /deniedRedirectPath\(decision\.screen\)/);
  assert.match(proxy, /getToken\(\{ req: request/);
  const nextauth = source("app/api/auth/[...nextauth]/route.js");
  assert.match(nextauth, /token\.authz = await authzSnapshotFor\(dbUser\)/);
  const layout = source("app/(portal)/layout.jsx");
  assert.match(layout, /<ScreenGuard>\{children\}<\/ScreenGuard>/);
  assert.match(layout, /<AccessDeniedNotice \/>/);
  const provider = source("components/auth-provider.jsx");
  assert.match(provider, /export function ScreenGuard/);
  assert.match(provider, /updateSession\(\)/, "an authz_changed push refreshes the NextAuth screen snapshot");
  for (const page of ["app/(portal)/supervisor/outbound-dialer/page.jsx", "app/(portal)/admin/call-flows/page.jsx"]) {
    assert.doesNotMatch(source(page), /role === "admin" \|\| role === "owner"|userRoles\.includes\("owner"\)/, `${page} no longer checks role names`);
  }
  assert.match(source("components/contact-center/AgentInteractionsProvider.jsx"), /canScreen\("agent\.desktop"\)/);
  assert.match(source("components/data-sources/DataSourcesTiles.jsx"), /admin\.configuration\.data-sources\.\$\{tile\.id\}/);
});

test("in-page actions are wrapped in <Can> with the matching operation", () => {
  const expectations = [
    ["app/(portal)/admin/users/page.jsx", ["users:create", "users:delete"]],
    ["app/(portal)/admin/queues/page.jsx", ["queues:create", "queues:delete"]],
    ["app/(portal)/admin/skills/page.jsx", ["skills:create", "skills:delete"]],
    ["app/(portal)/admin/statuses/page.jsx", ["statuses:create", "statuses:delete"]],
    ["app/(portal)/admin/wrapup-codes/page.jsx", ["wrapup_codes:create", "wrapup_codes:delete"]],
    ["app/(portal)/admin/domains/page.jsx", ["domains:create", "domains:delete"]],
    ["app/(portal)/admin/secrets/page.jsx", ["secrets:create", "secrets:delete"]],
    ["app/(portal)/admin/web-pages/page.jsx", ["web_pages:create", "web_pages:delete"]],
    ["app/(portal)/admin/media-library/page.jsx", ["media:create", "media:delete"]],
    ["app/(portal)/admin/workflows/page.jsx", ["workflows:import", "workflows:create", "workflows:delete"]],
    ["app/(portal)/admin/call-flows/page.jsx", ["call_flows:import", "call_flows:create", "call_flows:delete"]],
    ["app/(portal)/admin/forms/page.jsx", ["forms:import", "forms:create", "forms:publish", "forms:delete"]],
    ["app/(portal)/admin/tools-library/page.jsx", ["ai_tools:create", "ai_tools:delete"]],
    ["app/(portal)/admin/insights/page.jsx", ["ai_insights:create", "ai_insights:delete"]],
    ["app/(portal)/admin/mcp-servers/page.jsx", ["mcp_servers:create", "mcp_servers:delete"]],
    ["app/(portal)/admin/ai-assistants/pronunciation-dictionaries/page.jsx", ["pronunciation_dicts:create", "pronunciation_dicts:delete"]],
    ["app/(portal)/admin/teams/page.jsx", ["teams:create"]],
    ["app/(portal)/supervisor/scheduled-events/page.jsx", ["scheduled_events:create", "scheduled_events:delete"]],
    ["app/(portal)/supervisor/monitor/page.jsx", ["agents:status.set"]],
    ["app/(portal)/supervisor/outbound-dialer/page.jsx", ["campaigns:execute", "campaigns:pause", "campaigns:delete", "contact_lists:delete", "dialer_filters:create"]],
    ["components/contact-center/QualityFormsView.jsx", ["quality_forms:create"]],
    ["components/contact-center/QualityEvaluationsView.jsx", ["quality_evaluations:create"]],
    ["components/contact-center/SupervisionModal.jsx", ["calls:supervise.listen", "calls:supervise.whisper", "calls:supervise.barge"]],
  ];
  const known = new Set(listScreenLeaves().map((l) => l.id));
  for (const [path, permissions] of expectations) {
    const text = source(path);
    for (const permission of permissions) assert.ok(text.includes(`"${permission}"`), `${path} gates ${permission}`);
  }
  assert.ok(known.size >= 88);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("supervisor page headers do not render decorative implementation badges", () => {
  const expectations = [
    ["app/(portal)/supervisor/outbound-dialer/page.jsx", /SupervisorPageHeader[\s\S]*?badges=\{[\s\S]*?(Phase 2 CRUD|Persisted)/],
    ["app/(portal)/supervisor/monitor/page.jsx", /Live monitor|Agents · Queues · Statistics/],
    ["app/(portal)/supervisor/call-history/page.jsx", /Interaction records|Recordings · Events/],
    ["app/(portal)/supervisor/scheduled-events/page.jsx", /Assistant automation|Retry-aware/],
  ];

  for (const [page, forbiddenPattern] of expectations) {
    const content = source(page);
    assert.doesNotMatch(content, forbiddenPattern, `${page} should not show decorative header badges`);
  }
});

// Decision D-13 (the internal documentation): the system
// admin role includes the Outbound Dialer; supervisors do not. Since RBAC
// Phase 3 the menu item names its screen and visibility follows the roles'
// screen grants (supervisor.outbound-dialer.* is granted to admin and owner).
test("Outbound Dialer menu item declares its screen instead of a role list", () => {
  const menu = source("config/menu.jsx");
  assert.match(
    menu,
    /title:\s*"Outbound Dialer",[\s\S]*?url:\s*"\/supervisor\/outbound-dialer",[\s\S]*?screen:\s*"supervisor\.outbound-dialer"/,
    "Outbound Dialer sidebar item should declare the supervisor.outbound-dialer screen",
  );
  assert.doesNotMatch(menu, /role_access/, "role lists are gone from the menu");
});

test("Outbound Dialer page and APIs are limited to administrators and owners", () => {
  const page = source("app/(portal)/supervisor/outbound-dialer/page.jsx");
  const api = source("lib/outbound-dialer/api.js");
  const campaigns = source("app/api/contact-center/outbound-dialer/campaigns/route.js");

  assert.doesNotMatch(page, /userRoles\.includes\("owner"\)/, "the page no longer checks role names; the proxy and ScreenGuard enforce the screen");
  assert.match(page, /screenGroup="supervisor\.outbound-dialer"/, "the dialer rail follows the screen grants");
  assert.doesNotMatch(api, /requireOutboundSupervisor|isOwner\(user\)|isSupervisorOrAdmin/, "the owner-only helper is gone; routes use withPermission");
  assert.match(campaigns, /withPermission\("campaigns:read", GET_handler, \{ route:/, "campaign routes use the campaigns permission family; the system admin holds it (D-13)");
  assert.doesNotMatch(campaigns, /isSupervisorOrAdmin|requireOutboundSupervisor/, "supervisors are not granted the dialer");
});

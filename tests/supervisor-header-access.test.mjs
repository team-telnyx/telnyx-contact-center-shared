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

test("Outbound Dialer menu item is owner-only", () => {
  const menu = source("config/menu.jsx");
  assert.match(
    menu,
    /title:\s*"Outbound Dialer",[\s\S]*?url:\s*"\/supervisor\/outbound-dialer",[\s\S]*?role_access:\s*\["owner"\]/,
    "Outbound Dialer sidebar item should be visible only to owners",
  );
});

test("Outbound Dialer page and APIs are owner-only", () => {
  const page = source("app/(portal)/supervisor/outbound-dialer/page.jsx");
  const api = source("lib/outbound-dialer/api.js");

  assert.match(page, /userRoles\.includes\("owner"\)/, "direct page access should require owner role");
  assert.doesNotMatch(api, /isSupervisorOrAdmin/, "outbound API guard should not allow supervisors/admins by default");
  assert.match(api, /isOwner\(user\)/, "outbound API guard should require owner role");
});

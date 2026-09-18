import { test } from "node:test";
import assert from "node:assert/strict";

import {
  workspaceLabelForPath,
  workspaceMenuTarget,
} from "../lib/workspace-navigation.js";

const groups = {
  agent: {
    label: "AGENT",
    items: [{ title: "Desktop", url: "/agent/desktop" }],
  },
  supervisor: {
    label: "SUPERVISOR",
    items: [
      { title: "Monitoring", url: "/supervisor/monitor" },
      { title: "Analytics", url: "/supervisor/analytics" },
    ],
  },
  admin: {
    label: "ADMIN",
    items: [
      { title: "Configuration", url: "/admin/users" },
      { title: "Automations", url: "/admin/call-flows" },
    ],
  },
};

test("workspace selection opens the first menu on first entry", () => {
  assert.equal(workspaceMenuTarget(groups.supervisor, {}), "/supervisor/monitor");
  assert.equal(workspaceMenuTarget(groups.admin, {}), "/admin/users");
});

test("workspace selection restores a remembered visible menu", () => {
  assert.equal(
    workspaceMenuTarget(groups.supervisor, {
      SUPERVISOR: "/supervisor/analytics",
    }),
    "/supervisor/analytics",
  );
  assert.equal(
    workspaceMenuTarget(groups.admin, { ADMIN: "/admin/call-flows" }),
    "/admin/call-flows",
  );
});

test("agent always opens Desktop and stale remembered menus fall back safely", () => {
  assert.equal(
    workspaceMenuTarget(groups.agent, { AGENT: "/agent/anything-else" }),
    "/agent/desktop",
  );
  assert.equal(
    workspaceMenuTarget(groups.supervisor, {
      SUPERVISOR: "/supervisor/no-longer-visible",
    }),
    "/supervisor/monitor",
  );
});

test("workspace is derived from direct and nested routes", () => {
  assert.equal(workspaceLabelForPath("/agent/desktop"), "AGENT");
  assert.equal(workspaceLabelForPath("/supervisor/call-history/123"), "SUPERVISOR");
  assert.equal(workspaceLabelForPath("/admin/queues"), "ADMIN");
  assert.equal(workspaceLabelForPath("/settings"), "ADMIN");
  assert.equal(workspaceLabelForPath("/"), null);
});

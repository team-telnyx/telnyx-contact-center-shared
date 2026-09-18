import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveScreenForPath } from "../lib/authz/permissions.mjs";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Permissions is the last item of the Admin → Configuration rail and links to /admin/permissions", () => {
  const nav = source("components/admin/ConfigurationSectionNav.jsx");
  const items = [...nav.matchAll(/\{\s*id:\s*"([a-z-]+)",\s*label:\s*"([^"]+)"[^}]*href:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], label: m[2], href: m[3] }));
  assert.ok(items.length >= 12, "rail items parsed");
  const last = items[items.length - 1];
  assert.deepEqual(last, { id: "permissions", label: "Permissions", href: "/admin/permissions" });
  assert.equal(items.filter((item) => item.id === "permissions").length, 1);
});

test("the Permissions pages exist and map to the catalogue screen", () => {
  assert.match(source("app/(portal)/admin/permissions/page.jsx"), /ConfigurationSectionPage activeId="permissions"/);
  assert.match(source("app/(portal)/admin/permissions/[id]/page.jsx"), /ConfigurationSectionPage activeId="permissions"/);
  assert.deepEqual(resolveScreenForPath("/admin/permissions"), { screen: "admin.configuration.permissions", group: false });
});

test("the shared status stream knows the authz_changed event", () => {
  assert.match(source("lib/status-stream-client.js"), /"authz_changed"/);
  assert.match(source("components/auth-provider.jsx"), /subscribeStatusStream\("authz_changed"/);
});

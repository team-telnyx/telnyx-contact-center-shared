import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ROUTE_EXEMPTIONS, GUARD_PATTERNS } from "../lib/authz/route-exemptions.mjs";
import { isKnownPermission } from "../lib/authz/permissions.mjs";

const root = new URL("../", import.meta.url).pathname;
const apiRoot = join(root, "app", "api");

async function routeFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await routeFiles(full, out);
    else if (/^route\.(js|mjs|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function routeKey(file) {
  return relative(apiRoot, file).replace(/\/route\.(js|mjs|ts)$/, "");
}

test("every API route is guarded or listed as an exemption with a reason", async () => {
  const files = await routeFiles(apiRoot);
  assert.ok(files.length > 300, `expected the route inventory, found ${files.length}`);
  const unguarded = [];
  for (const file of files) {
    const key = routeKey(file);
    const source = await readFile(file, "utf8");
    const guarded = GUARD_PATTERNS.some((pattern) => pattern.test(source));
    const exempt = Object.prototype.hasOwnProperty.call(ROUTE_EXEMPTIONS, key);
    if (!guarded && !exempt) unguarded.push(key);
  }
  assert.deepEqual(unguarded, [], `Unguarded routes (add a guard or an exemption with a reason): ${unguarded.join(", ")}`);
});

test("exemptions name existing routes and carry a reason", async () => {
  const files = new Set((await routeFiles(apiRoot)).map(routeKey));
  for (const [key, reason] of Object.entries(ROUTE_EXEMPTIONS)) {
    assert.ok(files.has(key), `exemption ${key} does not match a route file`);
    assert.ok(typeof reason === "string" && reason.length > 10, `exemption ${key} needs a reason`);
  }
});

test("after Phase 2 no route keeps a bare handler export or a local admin helper unless it is exempt", async () => {
  const files = await routeFiles(apiRoot);
  const bare = [];
  const local = [];
  for (const file of files) {
    const key = routeKey(file);
    const source = await readFile(file, "utf8");
    if (/^async function (requireAdmin|requireSupervisorOrAdmin)\(/m.test(source)) local.push(key);
    if (Object.prototype.hasOwnProperty.call(ROUTE_EXEMPTIONS, key)) continue;
    if (/^export (async )?function (GET|POST|PUT|PATCH|DELETE|HEAD)\(/m.test(source)) bare.push(key);
  }
  assert.deepEqual(local, [], `local admin helpers must not come back: ${local.join(", ")}`);
  assert.deepEqual(bare, [], `non-exempt routes must export through withPermission or a wrapper: ${bare.join(", ")}`);
});

test("routes hardened in Phase 0 export guarded handlers only", async () => {
  const hardened = [
    "ai/assistants", "ai/assistants/[id]", "ai/assistants/[id]/canary-deploys", "ai/tools", "ai/conversations", "ai/integrations", "ai/models",
    "assistants/webhook-configs", "tts/speech", "tts/voices", "translate", "texml-applications", "media/audio", "config/supervisor-number",
    "voice/flows/test-http-request", "voice/monitor/webhooks", "voice/streaming/capabilities", "voice/flows/import", "voice/flows/[id]/monitor/clear",
    "admin/workflows", "admin/workflows/[id]", "admin/workflows/import", "admin/web-pages", "admin/web-pages/[id]", "admin/forms/[id]/publish", "admin/forms/[id]/ai",
    "admin/numbers/features", "admin/numbers/inventory-coverage", "admin/numbers/lerg-typeahead", "admin/numbers/regulatory",
  ];
  for (const key of hardened) {
    const source = await readFile(join(apiRoot, key, "route.js"), "utf8");
    assert.doesNotMatch(source, /^export (async )?function (GET|POST|PUT|PATCH|DELETE)\(/m, `${key} still exports a bare handler`);
    const exported = [...source.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE) = withPermission\(/gm)].map((m) => m[1]);
    assert.ok(exported.length > 0, `${key} exports no guarded handler`);
  }
});

test("after Phase 5 no route or wrapper keeps a legacy role predicate and every permission key is in the catalogue", async () => {
  const files = [...await routeFiles(apiRoot), join(root, "lib", "email", "api.js"), join(root, "lib", "widgets", "admin-api.js")];
  const predicates = [];
  const roleImports = [];
  const unknown = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const key = file.startsWith(apiRoot) ? routeKey(file) : relative(root, file);
    if (/\blegacy(Elevated)?:/.test(source)) predicates.push(key);
    if (/from ["'](@\/lib\/role-utils|\.\.\/role-utils)["']/.test(source)) roleImports.push(key);
    for (const match of source.matchAll(/withPermission\(\s*(\[[^\]]*\]|"[^"]+")/g)) {
      const keys = match[1].startsWith("[") ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [match[1].replace(/"/g, "")];
      for (const permission of keys) if (permission !== "authenticated" && !isKnownPermission(permission)) unknown.push(`${key}: ${permission}`);
    }
  }
  assert.deepEqual(predicates, [], `legacy predicates must not come back: ${predicates.join(", ")}`);
  assert.deepEqual(roleImports, [], `routes decide by permission, never by role name: ${roleImports.join(", ")}`);
  assert.deepEqual(unknown, [], `unknown permission keys: ${unknown.join(", ")}`);
});

test("the HTTP test route refuses non-public targets before any request is made", async () => {
  const source = await readFile(join(apiRoot, "voice/flows/test-http-request/route.js"), "utf8");
  assert.match(source, /assertPublicHostname\(urlObject\.hostname\)/);
  assert.ok(source.indexOf("assertPublicHostname(urlObject.hostname)") < source.indexOf("await fetch(urlObject.toString()"), "policy check precedes the fetch");
});

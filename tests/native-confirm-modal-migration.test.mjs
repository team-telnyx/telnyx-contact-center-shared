// Guards the project convention that confirmation prompts use the custom
// AlertDialog modal, never native window.confirm / confirm(). Covers the pages
// converted away from native confirm: phones-provisioning (delete phone, delete
// bridge) and the agent tasks view (caller-not-registered).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function readCode(rel) {
  const src = readFileSync(join(repoRoot, rel), "utf8");
  // Strip comments so a "no native confirm" note isn't mistaken for a call.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return { src, code };
}

const FILES = [
  "app/(portal)/admin/phones-provisioning/page.jsx",
  "components/contact-center/AgentTasksView.jsx",
];

for (const rel of FILES) {
  test(`${rel} never calls native confirm/alert/prompt`, () => {
    const { code } = readCode(rel);
    assert.ok(!/window\.confirm\s*\(/.test(code), "no window.confirm");
    assert.ok(!/window\.alert\s*\(/.test(code), "no window.alert");
    assert.ok(!/window\.prompt\s*\(/.test(code), "no window.prompt");
    assert.ok(!/(^|[^.\w])confirm\s*\(/.test(code), "no bare confirm()");
    assert.ok(!/(^|[^.\w])prompt\s*\(/.test(code), "no bare prompt()");
  });

  test(`${rel} imports the custom AlertDialog`, () => {
    const { src } = readCode(rel);
    assert.ok(
      /from\s+["']@\/components\/ui\/alert-dialog["']/.test(src),
      "should import AlertDialog",
    );
    assert.ok(/<AlertDialog\b/.test(src), "should render an AlertDialog");
  });
}

test("phones-provisioning delete phone & bridge go through the confirm dialog", () => {
  const { src } = readCode("app/(portal)/admin/phones-provisioning/page.jsx");
  assert.ok(/setConfirmDeletePhone\(/.test(src), "delete phone opens dialog");
  assert.ok(/performDeletePhone\(/.test(src), "confirm runs real phone delete");
  assert.ok(/setConfirmDeleteBridge\(/.test(src), "delete bridge opens dialog");
  assert.ok(/performDeleteBridge\(/.test(src), "confirm runs real bridge delete");
  assert.ok(/Delete phone\?/.test(src), "phone dialog title");
  assert.ok(/Delete bridge\?/.test(src), "bridge dialog title");
});

test("agent tasks view caller-not-registered uses the confirm dialog", () => {
  const { src } = readCode("components/contact-center/AgentTasksView.jsx");
  assert.ok(/setConfirmCreateContact\(/.test(src), "opens dialog");
  assert.ok(/Caller is not registered/.test(src), "dialog title");
});

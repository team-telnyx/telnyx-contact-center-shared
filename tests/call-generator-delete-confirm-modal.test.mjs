// Guards the project convention that the Call Generator Scenarios/Actions
// delete flows use the custom AlertDialog confirm modal, never native
// window.confirm / window.alert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = join(
  __dirname,
  "..",
  "app/(portal)/admin/call-generator/page.jsx",
);
const src = readFileSync(pagePath, "utf8");

// Strip comments so a "no native confirm" comment can't be mistaken for a call.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("call-generator page never calls native window.confirm / window.alert", () => {
  assert.ok(!/window\.confirm\s*\(/.test(code), "must not use window.confirm");
  assert.ok(!/window\.alert\s*\(/.test(code), "must not use window.alert");
  // Also guard the bare global forms.
  assert.ok(!/(^|[^.\w])confirm\s*\(/.test(code), "must not use bare confirm()");
  assert.ok(!/(^|[^.\w])alert\s*\(/.test(code), "must not use bare alert()");
});

test("call-generator page imports and renders the custom AlertDialog confirm modal", () => {
  assert.ok(
    /from\s+["']@\/components\/ui\/alert-dialog["']/.test(src),
    "should import AlertDialog from the shared ui component",
  );
  assert.ok(/<AlertDialog\b/.test(src), "should render an AlertDialog");
});

test("delete scenario flow uses the custom confirm dialog (not an immediate delete)", () => {
  // The button handler opens the dialog via state, and the confirm action runs
  // the real delete.
  assert.ok(/setConfirmDeleteScenario\(/.test(src), "delete scenario opens the dialog");
  assert.ok(/performDeleteScenario\(/.test(src), "confirm runs the real scenario delete");
  assert.ok(/Delete scenario\?/.test(src), "dialog has a Delete scenario? title");
});

test("delete action flow uses the custom confirm dialog (not an immediate delete)", () => {
  assert.ok(/setConfirmDeleteAction\(/.test(src), "delete action opens the dialog");
  assert.ok(/performDeleteAction\(/.test(src), "confirm runs the real action delete");
  assert.ok(/Delete action\?/.test(src), "dialog has a Delete action? title");
});

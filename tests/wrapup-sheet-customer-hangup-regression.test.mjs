import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("GlobalWrapupSheet derives pending work only from the Core snapshot", async () => {
  const sheet = await source("components/contact-center/GlobalWrapupSheet.jsx");
  assert.match(sheet, /subscribeCoreSnapshot/);
  assert.match(sheet, /snapshot\?\.agent\?\.workflow_state\s*!==\s*["']wrapup["']/);
  assert.match(sheet, /snapshot\.agent\.workflow_work_item_id/);
  assert.match(sheet, /pending\.ended_at/);
  assert.match(sheet, /!pending\.wrapup_ended_at/);
  assert.doesNotMatch(sheet, /wrapup_required|status_changed|new EventSource|\/api\/user\/profile/);
});

test("a repeated snapshot cannot reopen the same wrap-up", async () => {
  const sheet = await source("components/contact-center/GlobalWrapupSheet.jsx");
  assert.match(
    sheet,
    /!sheet\.open\s*\|\|\s*String\(sheet\.interactionId\)\s*!==\s*String\(pendingInteractionId\)/,
  );
  assert.equal([...sheet.matchAll(/\.openWrapup\(/g)].length, 1);
});

test("a snapshot without pending wrap-up closes stale UI state", async () => {
  const sheet = await source("components/contact-center/GlobalWrapupSheet.jsx");
  assert.match(sheet, /if \(!pending\)[\s\S]*getState\(\)\.open[\s\S]*closeWrapup\(\)/);
});

test("wrap-up submission only completes server-authoritative Core work", async () => {
  const sheet = await source("components/contact-center/GlobalWrapupSheet.jsx");
  const codes = await source("components/contact-center/WrapupCodesSheet.jsx");
  assert.match(codes, /action:\s*["']end["']/);
  assert.match(sheet, /<WrapupCodesSheet[\s\S]*interactionId=\{interactionId\}/);
  assert.match(sheet, /pending-wrapup\?interactionId=/);
});

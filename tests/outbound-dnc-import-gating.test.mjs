import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a DNC list whose match strategy changed on screen cannot be imported until it is saved", async () => {
  // Codex review of #1482: with dnc_lists:update and dnc_lists:import together an
  // operator could change the strategy and upload at once; the import endpoint
  // applied the stored strategy while the preview followed the draft's.
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const formStart = source.indexOf("function DncSettingsForm");
  const formEnd = source.indexOf("function FilterSettingsForm", formStart);
  assert.ok(formStart > -1 && formEnd > formStart, "DncSettingsForm precedes FilterSettingsForm");
  const form = source.slice(formStart, formEnd);
  assert.match(form, /const storedStrategy = dncList\?\.id \? dncList\.match_strategy \|\| "phone" : null;/);
  assert.match(form, /const strategyUnsaved = Boolean\(storedStrategy\) && \(draft\.match_strategy \|\| "phone"\) !== storedStrategy;/);
  assert.match(form, /strategyUnsaved\s*\?\s*\{ ready: false, title: "Save the match strategy first"/, "the upload button is blocked with a save-first message");
  assert.match(form, /title: importReadiness\.title \|\| "Preview selection required"/, "a blocked import names the save-first reason");
  assert.match(form, /const savedDncList = draft\.id \? draft : await save\(\);/, "an existing list is still imported without an unrelated metadata save");
  assert.match(form, /readiness=\{importReadiness\}/, "the upload card disables its button from the same readiness");
});

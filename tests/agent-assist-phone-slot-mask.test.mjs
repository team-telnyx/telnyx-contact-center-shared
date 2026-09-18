import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatPhoneSlotDisplay, formatSlotDisplay } from "../lib/agent-assist/slot-display.mjs";

// an earlier fix: phone slots render 3-3-4 in the intake form. The mask is display
// only — the raw digits stay in state, the database, the dispatch system dispatch
// payload (an earlier fix) and pre-dispatch validation (an earlier fix).

test("a captured 10-digit number masks to 3-3-4", () => {
  assert.equal(formatPhoneSlotDisplay("5551234567"), "555-123-4567");
});

test("mask applies to partial input as digits stream in from the analyzer", () => {
  assert.equal(formatPhoneSlotDisplay("5"), "5");
  assert.equal(formatPhoneSlotDisplay("555"), "555");
  assert.equal(formatPhoneSlotDisplay("5551"), "555-1");
  assert.equal(formatPhoneSlotDisplay("555123"), "555-123");
  assert.equal(formatPhoneSlotDisplay("5551234"), "555-123-4");
  assert.equal(formatPhoneSlotDisplay("555123456"), "555-123-456");
});

test("an already-punctuated capture is re-masked to one consistent shape", () => {
  assert.equal(formatPhoneSlotDisplay("(555) 123-4567"), "555-123-4567");
  assert.equal(formatPhoneSlotDisplay("555.123.4567"), "555-123-4567");
  assert.equal(formatPhoneSlotDisplay("555 123 4567"), "555-123-4567");
  assert.equal(formatPhoneSlotDisplay("  5551234567  "), "555-123-4567");
});

test("NANP country code is kept in front of the masked national digits", () => {
  assert.equal(formatPhoneSlotDisplay("+15551234567"), "+1 555-123-4567");
  assert.equal(formatPhoneSlotDisplay("+1 (555) 123-4567"), "+1 555-123-4567");
  assert.equal(formatPhoneSlotDisplay("15551234567"), "1-555-123-4567");
});

test("values that can't be masked confidently are returned exactly as captured", () => {
  // Extensions — masking would strip or misplace the extension.
  assert.equal(formatPhoneSlotDisplay("555-123-4567 x22"), "555-123-4567 x22");
  assert.equal(formatPhoneSlotDisplay("5551234567 ext 400"), "5551234567 ext 400");
  // Non-NANP international.
  assert.equal(formatPhoneSlotDisplay("+442071234567"), "+442071234567");
  assert.equal(formatPhoneSlotDisplay("+33123456789"), "+33123456789");
  // More digits than the plan holds.
  assert.equal(formatPhoneSlotDisplay("5551234567890"), "5551234567890");
  // Free text the agent typed instead of a number.
  assert.equal(formatPhoneSlotDisplay("unknown"), "unknown");
  assert.equal(formatPhoneSlotDisplay("N/A"), "N/A");
});

test("empty and non-string values pass through untouched", () => {
  assert.equal(formatPhoneSlotDisplay(""), "");
  assert.equal(formatPhoneSlotDisplay("   "), "   ");
  assert.equal(formatPhoneSlotDisplay(null), null);
  assert.equal(formatPhoneSlotDisplay(undefined), undefined);
  assert.equal(formatPhoneSlotDisplay(false), false);
  assert.equal(formatPhoneSlotDisplay(5551234567), "555-123-4567");
});

test("formatSlotDisplay masks only slot_type 'phone'", () => {
  assert.equal(formatSlotDisplay("5551234567", "phone"), "555-123-4567");
  // A room/bed/account number that happens to be ten digits stays untouched.
  assert.equal(formatSlotDisplay("5551234567", "text"), "5551234567");
  assert.equal(formatSlotDisplay("5551234567", "number"), "5551234567");
  assert.equal(formatSlotDisplay("5551234567", undefined), "5551234567");
});

test("formatSlotDisplay keeps its Yes/No behaviour for boolean slots", () => {
  assert.equal(formatSlotDisplay(false, "phone"), "No");
  assert.equal(formatSlotDisplay(true, "boolean"), "Yes");
  assert.equal(formatSlotDisplay("Summit Hospital", "text"), "Summit Hospital");
});

test("the mask never reaches state: writes carry the raw value", async () => {
  const cmp = await readFile(new URL("../components/contact-center/AgentAssistWorkflow.jsx", import.meta.url), "utf8");

  // Confirming a suggestion / an alternative stores the unformatted value.
  assert.match(cmp, /handleConfirmSuggestedSlot\(item\.id, slotValue\)/);
  assert.match(cmp, /handleConfirmSuggestedSlot\(item\.id, alt\.value\)/);
  assert.doesNotMatch(cmp, /handleConfirmSuggestedSlot\(item\.id, formatSlotDisplay/);
  assert.doesNotMatch(cmp, /handleConfirmSuggestedSlot\(item\.id, formatPhoneSlotDisplay/);

  // The edit input is seeded from the raw value, not the mask.
  assert.match(cmp, /handleStartEdit\(item, slotValue\)/);
  assert.doesNotMatch(cmp, /handleStartEdit\(item, formatSlotDisplay/);
  assert.doesNotMatch(cmp, /handleStartEdit\(item, formatPhoneSlotDisplay/);

  // The component only ever formats inside a render, never before a write.
  assert.doesNotMatch(cmp, /onCompleteItem\([^)]*format(Slot|Phone)Display/);
});

test("the phone formatter is not reachable from dispatch/payload code", async () => {
  // Guards the an earlier fix constraint at the import level: if the formatter ever
  // shows up outside a display surface, an API payload can carry the mask.
  // readback.mjs is an allowed display surface: the read-back is a SPOKEN
  // script the agent reads aloud (the the reference workflow confirmation sentence speaks the
  // EMS contact in 3-3-4), never a payload — the raw digits stay untouched
  // in slots_filled. Anything else appearing here needs the same scrutiny.
  const { execFileSync } = await import("node:child_process");
  const repoRoot = new URL("../", import.meta.url).pathname;
  const hits = execFileSync(
    "grep",
    ["-rl", "--include=*.js", "--include=*.mjs", "--include=*.jsx", "formatPhoneSlotDisplay", "lib", "app", "components"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();

  assert.deepEqual(hits, [
    "lib/agent-assist/readback.mjs",
    "lib/agent-assist/slot-display.mjs",
  ]);
});

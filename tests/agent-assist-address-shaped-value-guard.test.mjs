import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Reported live: MCP auto-fill for pickup_address failed (an upstream
// dispatch system data gap - no facility record for the test phone number),
// forcing the caller to speak the address aloud. STT delivered it in
// fragments across separate analyze calls ("twenty five hundred" / "Soto
// Transport Parkway" / "Stamford, California"), and the model attributed
// "Soto Transport Parkway" to pickup_department (with "Total Transport
// Center" as a low-confidence alternative) and "2500" to pickup_room,
// instead of any of it landing on pickup_address, which stayed empty.

function guardSection(route) {
  const start = route.indexOf("Fifth guard:");
  const end = route.indexOf("Process completed items");
  return route.slice(start, end);
}

test("fifth guard exists and only inspects non-address slots with a street-suffix-shaped value", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /Fifth guard: address-shaped text landing on a non-address sibling slot/);
  const section = guardSection(route);

  assert.match(section, /if \(!item\?\.slot_name \|\| item\.slot_validation === "address"\) continue;/);
  assert.match(section, /if \(!STREET_SUFFIX_WORDS\.test\(valueText\)\) continue;/);
});

test("street-suffix regex matches full, unabbreviated street words and is case-insensitive", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = guardSection(route);
  const match = section.match(/const STREET_SUFFIX_WORDS =\s*\n\s*(\/.*\/i);/);
  assert.ok(match, "STREET_SUFFIX_WORDS regex must be defined in the guard");
  const re = new RegExp(match[1].slice(1, -2), "i");

  assert.ok(re.test("Soto Transport Parkway"));
  assert.ok(re.test("123 Main Street"));
  assert.ok(re.test("456 Oak Avenue"));
  assert.ok(re.test("789 Elm Boulevard"));
  // Bare numeric values (real room/bed numbers) must NOT match - this is
  // the deliberate false-positive guard the tests below also cover.
  assert.equal(re.test("2500"), false);
  assert.equal(re.test("412"), false);
});

// Codex review (PR #1382, round 2, P1): short abbreviated forms are
// dangerously ambiguous in this specific healthcare domain - "CT" is a
// real department name (CT scan/imaging), "St." routinely appears in
// hospital names ("St. Mary's ICU"), and "Dr." is extremely common in this
// workflow's physician fields. Matching abbreviations would misfire on
// entirely correct department/doctor values.
test("street-suffix regex does NOT match short abbreviations that collide with common healthcare terms (regression)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = guardSection(route);
  const match = section.match(/const STREET_SUFFIX_WORDS =\s*\n\s*(\/.*\/i);/);
  assert.ok(match, "STREET_SUFFIX_WORDS regex must be defined in the guard");
  const re = new RegExp(match[1].slice(1, -2), "i");

  assert.equal(re.test("CT"), false, "must not match CT (CT scan department)");
  assert.equal(re.test("CT Scan"), false);
  assert.equal(re.test("St. Mary's ICU"), false, "must not match St. as in Saint");
  assert.equal(re.test("Dr. Patel"), false, "must not match Dr. as in Doctor");
});

// Codex review (PR #1382, P2): "not validated as address" alone is too
// broad a source condition - it also matches the group's OWN *_facility
// slot. A facility name like "Oak Street Health" or "Parkway Medical
// Center" is a completely plausible real value that contains a
// street-suffix word by coincidence of naming, not because it's actually
// an address. Redirecting that would steal a correct facility name away
// into the address slot, corrupting both.
test("fifth guard only redirects department/room/bed - NOT facility or any other slot type (regression)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = guardSection(route);

  assert.match(
    section,
    /const ADDRESS_MISATTRIBUTION_SOURCE_SUFFIXES = \/_\(department\|room\|bed\)\$\/;/
  );
  assert.match(
    section,
    /if \(!ADDRESS_MISATTRIBUTION_SOURCE_SUFFIXES\.test\(item\.slot_name\)\) continue;/
  );
  // This check must run BEFORE the street-suffix value check, so a
  // facility-name value never even reaches the redirect logic regardless
  // of what words it happens to contain.
  const suffixCheckIdx = section.indexOf("ADDRESS_MISATTRIBUTION_SOURCE_SUFFIXES.test");
  const valueCheckIdx = section.indexOf("STREET_SUFFIX_WORDS.test(valueText)");
  assert.ok(suffixCheckIdx > -1 && valueCheckIdx > -1 && suffixCheckIdx < valueCheckIdx);
});

test("fifth guard redirects to the still-open address sibling in the same pickup/destination group", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = guardSection(route);

  assert.match(
    section,
    /const prefixMatch = item\.slot_name\.match\(\/\^\(pickup\|destination\|sending\|receiving\)_\/\);/
  );
  assert.match(
    section,
    /const addressSibling = pendingItems\.find\(\(sib\) =>\s*\n\s*sib\.slot_validation === "address" && sib\.slot_name\?\.startsWith\(`\$\{prefix\}_`\)\s*\n\s*\);/
  );
  assert.match(section, /completed\.item_id = addressSibling\.item_id;/);
  assert.match(section, /workflow_address_shaped_value_redirected/);
});

test("fifth guard defers to a direct address completion in the same response, same as guard 4's round-5 fix", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = guardSection(route);

  assert.match(
    section,
    /const addressAlreadyCompletedDirectly = \(analysisResult\.completed_items \|\| \[\]\)\.some\(\s*\n\s*\(c\) => c !== completed && c\.item_id === addressSibling\.item_id\s*\n\s*\);/
  );
  assert.match(section, /if \(addressAlreadyCompletedDirectly\) \{\s*\n\s*bleedRejectedItemIds\.add\(completed\.item_id\);/);
});

test("fifth guard respects earlier guards' rejections and is placed after the fourth guard", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const fourthIdx = route.indexOf("Fourth guard:");
  const fifthIdx = route.indexOf("Fifth guard:");
  assert.ok(fourthIdx > -1 && fifthIdx > fourthIdx, "fifth guard must be defined after the fourth guard");

  const section = guardSection(route);
  assert.match(section, /if \(bleedRejectedItemIds\.has\(completed\.item_id\)\) continue;/);
});

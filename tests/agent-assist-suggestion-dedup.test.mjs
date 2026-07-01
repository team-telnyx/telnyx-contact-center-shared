import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSuggestionText,
  isDuplicateSuggestion,
  appendUniqueSuggestion,
} from "../lib/agent-assist/suggestion-dedup.mjs";

test("normalizeSuggestionText collapses whitespace, trims, and lowercases", () => {
  assert.equal(normalizeSuggestionText("  Hello   World  "), "hello world");
  assert.equal(normalizeSuggestionText("\tFoo\nBar\t"), "foo bar");
  assert.equal(normalizeSuggestionText("MiXeD CaSe"), "mixed case");
  assert.equal(normalizeSuggestionText(""), "");
  assert.equal(normalizeSuggestionText(null), "");
  assert.equal(normalizeSuggestionText(undefined), "");
});

test("isDuplicateSuggestion: empty list or empty candidate is never a duplicate", () => {
  assert.equal(isDuplicateSuggestion([], { itemId: "a", text: "hi" }), false);
  assert.equal(isDuplicateSuggestion(null, { itemId: "a", text: "hi" }), false);
  assert.equal(isDuplicateSuggestion([{ itemId: "a", text: "hi" }], null), false);
  assert.equal(isDuplicateSuggestion([{ itemId: "a", text: "hi" }], { itemId: "a", text: "" }), false);
});

test("isDuplicateSuggestion: same itemId + same normalized text is a duplicate", () => {
  const list = [{ itemId: "name", text: "Could you tell me your name?" }];
  assert.equal(
    isDuplicateSuggestion(list, { itemId: "name", text: "could you   tell me your NAME? " }),
    true
  );
});

test("isDuplicateSuggestion: same text but different itemId is NOT a duplicate (both have ids)", () => {
  const list = [{ itemId: "name", text: "Please confirm." }];
  assert.equal(
    isDuplicateSuggestion(list, { itemId: "dob", text: "Please confirm." }),
    false
  );
});

test("isDuplicateSuggestion: identical text with missing itemId on either side is a duplicate", () => {
  assert.equal(
    isDuplicateSuggestion([{ text: "Thanks for holding." }], { text: "thanks for holding." }),
    true
  );
  assert.equal(
    isDuplicateSuggestion([{ itemId: "x", text: "Thanks for holding." }], { text: "thanks for holding." }),
    true
  );
});

test("appendUniqueSuggestion: appends a genuinely new suggestion (new array)", () => {
  const list = [{ id: "1", itemId: "name", text: "What is your name?" }];
  const next = { id: "2", itemId: "dob", text: "What is your date of birth?" };
  const result = appendUniqueSuggestion(list, next);
  assert.equal(result.length, 2);
  assert.notEqual(result, list);
  assert.deepEqual(result[1], next);
});

test("appendUniqueSuggestion: revisiting a prior target (A->B->A) does NOT duplicate", () => {
  // Simulates the oscillation bug: the same guide for item A is produced again
  // after B, with a fresh id (Date.now-based). It must not be appended twice.
  let list = [];
  const aSuggestion = () => ({ id: `name-${Math.round(Math.random() * 1e9)}`, itemId: "name", text: "Could you tell me your name?" });
  const b = { id: "dob-1", itemId: "dob", text: "And your date of birth?" };
  list = appendUniqueSuggestion(list, aSuggestion()); // A
  list = appendUniqueSuggestion(list, b);             // B
  const before = list;
  list = appendUniqueSuggestion(list, aSuggestion()); // A again (different id, same text+itemId)
  assert.equal(list.length, 2);
  assert.equal(list, before, "duplicate revisit returns the same list reference");
});

test("appendUniqueSuggestion: returns the same reference for empty/blank candidate", () => {
  const list = [{ id: "1", itemId: "name", text: "hi" }];
  assert.equal(appendUniqueSuggestion(list, null), list);
  assert.equal(appendUniqueSuggestion(list, undefined), list);
  assert.equal(appendUniqueSuggestion(list, { id: "2", itemId: "z", text: "   " }), list);
});

test("appendUniqueSuggestion: distinct target keys producing identical text render once", () => {
  const list = [{ id: "1", text: "Let me look into that for you." }];
  // No itemId on either side -> text-only equality -> duplicate suppressed.
  const result = appendUniqueSuggestion(list, { id: "2", text: "let me look into that for you." });
  assert.equal(result.length, 1);
  assert.equal(result, list);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeForMatch,
  findTranscriptIdForUtterance,
} from "../lib/agent-assist/slot-utterance-match.mjs";

test("normalizeForMatch collapses whitespace, trims, and lowercases", () => {
  assert.equal(normalizeForMatch("  Hello   World  "), "hello world");
  assert.equal(normalizeForMatch("\tFoo\nBar\t"), "foo bar");
  assert.equal(normalizeForMatch("MiXeD CaSe"), "mixed case");
  assert.equal(normalizeForMatch(""), "");
  assert.equal(normalizeForMatch(null), "");
  assert.equal(normalizeForMatch(undefined), "");
  assert.equal(normalizeForMatch(123), "123");
});

test("findTranscriptIdForUtterance returns null for empty/null utterance", () => {
  const transcriptions = [
    { id: "a", transcript: "hello world", isFinal: true },
  ];
  assert.equal(findTranscriptIdForUtterance(transcriptions, ""), null);
  assert.equal(findTranscriptIdForUtterance(transcriptions, null), null);
  assert.equal(findTranscriptIdForUtterance(transcriptions, undefined), null);
  assert.equal(findTranscriptIdForUtterance(transcriptions, "   "), null);
});

test("findTranscriptIdForUtterance returns null for empty/invalid transcriptions", () => {
  assert.equal(findTranscriptIdForUtterance([], "hello"), null);
  assert.equal(findTranscriptIdForUtterance(null, "hello"), null);
  assert.equal(findTranscriptIdForUtterance(undefined, "hello"), null);
  assert.equal(findTranscriptIdForUtterance({}, "hello"), null);
});

test("findTranscriptIdForUtterance returns null when no transcript contains the utterance", () => {
  const transcriptions = [
    { id: "a", transcript: "goodbye now", isFinal: true },
    { id: "b", transcript: "see you later", isFinal: true },
  ];
  assert.equal(findTranscriptIdForUtterance(transcriptions, "hello"), null);
});

test("findTranscriptIdForUtterance returns the matching id for a verbatim substring match", () => {
  const transcriptions = [
    { id: "a", transcript: "Hi, my name is John Smith", isFinal: true },
    { id: "b", transcript: "I live in Springfield", isFinal: true },
  ];
  assert.equal(
    findTranscriptIdForUtterance(transcriptions, "John Smith"),
    "a"
  );
});

test("findTranscriptIdForUtterance matches case-insensitively and ignores extra whitespace", () => {
  const transcriptions = [
    { id: "a", transcript: "My  EMAIL  is Foo@Bar.com", isFinal: true },
  ];
  assert.equal(
    findTranscriptIdForUtterance(transcriptions, "  foo@bar.com  "),
    "a"
  );
});

test("findTranscriptIdForUtterance prefers isFinal over interim among matches", () => {
  const transcriptions = [
    { id: "interim1", transcript: "account number 12345", isFinal: false },
    { id: "final1", transcript: "the account number 12345 is active", isFinal: true },
  ];
  // Both contain the utterance; final should win even though it appears later.
  assert.equal(
    findTranscriptIdForUtterance(transcriptions, "account number 12345"),
    "final1"
  );
});

test("findTranscriptIdForUtterance prefers final even when an interim match appears later", () => {
  const transcriptions = [
    { id: "final1", transcript: "my name is Jane Doe", isFinal: true },
    { id: "interim1", transcript: "name is Jane Doe", isFinal: false },
  ];
  assert.equal(
    findTranscriptIdForUtterance(transcriptions, "Jane Doe"),
    "final1"
  );
});

test("findTranscriptIdForUtterance prefers the most recent match when finality is equal", () => {
  const transcriptions = [
    { id: "old", transcript: "please confirm order 99", isFinal: true },
    { id: "new", transcript: "confirm order 99 again", isFinal: true },
  ];
  assert.equal(
    findTranscriptIdForUtterance(transcriptions, "order 99"),
    "new"
  );
});

test("findTranscriptIdForUtterance prefers the most recent among multiple interim matches", () => {
  const transcriptions = [
    { id: "i1", transcript: "calling about invoice 7", isFinal: false },
    { id: "i2", transcript: "invoice 7 again", isFinal: false },
  ];
  assert.equal(
    findTranscriptIdForUtterance(transcriptions, "invoice 7"),
    "i2"
  );
});

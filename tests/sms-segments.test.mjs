import { test } from "node:test";
import assert from "node:assert/strict";
import { smsSegments, isGsmText, describeSmsSegments, SMS_MAX_PARTS } from "../lib/sms/segments.mjs";

test("empty text is a zero-part GSM-7 draft with the whole first part remaining", () => {
  assert.deepEqual(smsSegments(""), { encoding: "GSM-7", chars: 0, units: 0, parts: 0, perPart: 160, remaining: 160, tooLong: false });
  assert.equal(smsSegments(null).parts, 0);
});

test("GSM-7 single part fills exactly 160 septets and 161 becomes two 153-septet parts", () => {
  const full = smsSegments("a".repeat(160));
  assert.deepEqual([full.encoding, full.parts, full.perPart, full.remaining], ["GSM-7", 1, 160, 0]);
  const over = smsSegments("a".repeat(161));
  assert.deepEqual([over.parts, over.perPart, over.remaining, over.units], [2, 153, 153 * 2 - 161, 161]);
});

test("GSM extension characters cost two septets", () => {
  assert.equal(isGsmText("€^{}[]~|\\"), true);
  assert.deepEqual([smsSegments("€".repeat(80)).parts, smsSegments("€".repeat(80)).remaining], [1, 0]);
  assert.equal(smsSegments("€".repeat(81)).parts, 2);
});

test("an extension escape never straddles two parts", () => {
  // 152 septets, then € (2) which cannot fit in the last septet of part 1.
  const stats = smsSegments(`${"a".repeat(152)}€${"a".repeat(152)}`);
  assert.equal(stats.units, 306);
  assert.equal(stats.parts, 3);
});

test("non-GSM characters switch to UCS-2 with 70/67 limits counted in UTF-16 units", () => {
  const polish = smsSegments("ą".repeat(70));
  assert.deepEqual([polish.encoding, polish.parts, polish.perPart, polish.remaining], ["UCS-2", 1, 70, 0]);
  const longer = smsSegments("ą".repeat(71));
  assert.deepEqual([longer.parts, longer.perPart, longer.remaining], [2, 67, 134 - 71]);
  const emoji = smsSegments("😀");
  assert.deepEqual([emoji.encoding, emoji.chars, emoji.units, emoji.remaining], ["UCS-2", 1, 2, 68]);
  assert.equal(isGsmText("Zażółć"), false);
});

test("messages beyond the part ceiling are flagged instead of silently accepted", () => {
  const stats = smsSegments("a".repeat(153 * SMS_MAX_PARTS + 1));
  assert.equal(stats.parts, SMS_MAX_PARTS + 1);
  assert.equal(stats.tooLong, true);
  assert.equal(smsSegments("a".repeat(153 * SMS_MAX_PARTS)).tooLong, false);
});

test("describeSmsSegments renders the counter summary", () => {
  assert.equal(describeSmsSegments(smsSegments("Hello")), "GSM-7 · 1 part · 155 remaining");
  assert.equal(describeSmsSegments(smsSegments("a".repeat(200))), "GSM-7 · 2 parts · 106 remaining");
});

import assert from "node:assert/strict";
import test from "node:test";
import { canValidateContactList, campaignContactListTargets, contactListValidationMessage, normalizeContactListStatus } from "../lib/outbound-dialer/contact-list-validation.js";

const list = (overrides = {}) => ({
  status: "draft",
  record_count: 0,
  custom_field_schema: [],
  metadata: {},
  ...overrides,
});

test("contact list can be validated only after import and number/email mapping", () => {
  assert.equal(canValidateContactList(list({ record_count: 1, metadata: { csv_import_settings: { column_mappings: { Phone: ["number:mobile"] } } } })), true);
  assert.equal(canValidateContactList(list({ record_count: 1, metadata: { csv_import_settings: { column_mappings: { Email: ["email:primary"] } } } })), true);
  assert.equal(canValidateContactList(list({ record_count: 0, metadata: { csv_import_settings: { column_mappings: { Phone: ["number:mobile"] } } } })), false);
  assert.equal(canValidateContactList(list({ record_count: 1, metadata: { csv_import_settings: { column_mappings: { Name: ["text:name"] } } } })), false);
});

test("normalizeContactListStatus prevents validated status when prerequisites are missing", () => {
  assert.equal(normalizeContactListStatus(list({ status: "validated", record_count: 0 })), "draft");
  assert.equal(normalizeContactListStatus(list({ status: "validated", record_count: 2, metadata: { csv_import_settings: { column_mappings: { Email: ["email:primary"] } } } })), "validated");
  assert.equal(normalizeContactListStatus(list({ status: "validating", record_count: 2 })), "draft");
});

test("campaignContactListTargets returns only validated lists", () => {
  const validated = list({ id: "validated", status: "validated" });
  const draft = list({ id: "draft", status: "draft" });
  const validating = list({ id: "validating", status: "validating" });
  assert.deepEqual(campaignContactListTargets([draft, validated, validating]).map((item) => item.id), ["validated"]);
});

test("contactListValidationMessage explains the missing prerequisite", () => {
  assert.match(contactListValidationMessage(list({ record_count: 0 })), /Import at least one record/);
  assert.match(contactListValidationMessage(list({ record_count: 1 })), /Map at least one column/);
});

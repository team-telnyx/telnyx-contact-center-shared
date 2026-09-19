import assert from "node:assert/strict";
import test from "node:test";
import { autoMapVariables, mergeVariableMapping, resolveVariableValues, systemVariableValues } from "../lib/outbound-dialer/messaging/variables.mjs";
import { resolveMessagingDestination, normalizeMessagingAddress } from "../lib/outbound-dialer/messaging/destination.mjs";

test("variable values come from columns, slots, static text and system values with fallbacks", () => {
  const mapping = [
    { key: "first_name", source: "contact_field", value: "Imię", fallback: "Kliencie" },
    { key: "phone", source: "contact_method", value: "number:mobile" },
    { key: "brand", source: "static", value: "Telnyx" },
    { key: "campaign", source: "system", value: "campaign_name" },
    { key: "order", source: "contact_field", value: "Order" },
  ];
  const resolved = resolveVariableValues(mapping, { rowData: { Imię: "Anna", Order: "" }, contactMethods: { number: { mobile: "+48600000001" } }, system: { campaign_name: "Autumn" } });
  assert.deepEqual(resolved.values, { first_name: "Anna", phone: "+48600000001", brand: "Telnyx", campaign: "Autumn", order: "" });
  assert.deepEqual(resolved.missing, ["order"]);
  const fallback = resolveVariableValues(mapping, { rowData: {}, contactMethods: {}, system: {} });
  assert.equal(fallback.values.first_name, "Kliencie");
  assert.deepEqual(fallback.missing, ["phone", "campaign", "order"]);
});

test("auto mapping matches normalized column names and aliases, keeping manual choices", () => {
  const mapped = autoMapVariables(["first_name", "Company", "order_id", "body:1"], ["First Name", "company name", "Order ID", "Phone"], [{ key: "order_id", source: "static", value: "fixed" }]);
  assert.deepEqual(mapped, [
    { key: "first_name", source: "contact_field", value: "First Name", fallback: "" },
    { key: "Company", source: "contact_field", value: "company name", fallback: "" },
    { key: "order_id", source: "static", value: "fixed", fallback: "" },
    { key: "body:1", source: "contact_field", value: "", fallback: "" },
  ]);
  assert.deepEqual(mergeVariableMapping([{ key: "gone", value: "x" }, { key: "keep", value: "y" }], ["keep", "new"]).map((row) => row.key), ["keep", "new"]);
});

test("system variables include the campaign name, sender and local date", () => {
  const values = systemVariableValues({ campaign: { name: "Promo" }, senderAddress: "+48500100200", optOutInstructions: "Reply STOP", timezone: "Europe/Warsaw", now: new Date("2026-09-15T22:30:00Z") });
  assert.equal(values.campaign_name, "Promo");
  assert.equal(values.sender_address, "+48500100200");
  assert.equal(values.today, "2026-09-16");
  assert.equal(values.opt_out_instructions, "Reply STOP");
});

test("destination resolution honours field order, slots and channel fallbacks", () => {
  const contact = { rowData: { Phone: "48 600-000-001", Email: "Anna@Example.com", Mobile: "" }, contactMethods: { number: { mobile: "", home: "+48123456789" }, email: { work: "anna@example.com" } } };
  assert.deepEqual(resolveMessagingDestination({ channel: "sms", destinationFields: ["number:mobile", "Phone"], ...contact }), { address: "+48600000001", field: "Phone" });
  assert.deepEqual(resolveMessagingDestination({ channel: "sms", destinationFields: [], ...contact }), { address: "+48123456789", field: "number:home" });
  assert.deepEqual(resolveMessagingDestination({ channel: "email", destinationFields: ["Email"], ...contact }), { address: "anna@example.com", field: "Email" });
  assert.deepEqual(resolveMessagingDestination({ channel: "sms", destinationFields: ["Mobile"], rowData: { Mobile: "12" }, contactMethods: {} }), { address: null, field: null });
  assert.equal(normalizeMessagingAddress("sms", "0048 600 000 001"), null);
  assert.equal(normalizeMessagingAddress("email", "not-an-email"), null);
});

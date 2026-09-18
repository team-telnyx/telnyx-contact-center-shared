import assert from "node:assert/strict";
import test from "node:test";

import {
  BINDING_TRIGGERS,
  bindingFingerprint,
  collapseSingleAlternative,
  collectSlotMcpBindings,
  getValueByPath,
  mapBindingOutputs,
  normalizeSlotMcpBinding,
  resolveBindingArguments,
  resolveTemplate,
  selectTriggeredBindings,
  unwrapMcpResultEnvelope,
} from "../lib/agent-assist/slot-mcp-runner.mjs";

// Real lookup_addresses response, the reference workflow UAT integration samples (step 3).
const LOOKUP_PICKUP_RESULT = [
  {
    facility_id: "2566",
    facility_name: "Sutter - PALO ALTO Medical Clinic",
    address: "Sutter - PALO ALTO Medical Clinic, 300 Homer Ave, Palo Alto, CA, 94301",
    city: "Palo Alto",
    state: "CA",
    zip: "94301",
    county: "Santa Clara",
    lat: null,
    lng: null,
    facility_type: "Hospital",
    location_type: "Physician's office",
    location_type_code: "P",
  },
];

// The pickup binding as an integrator would configure it against the reference workflow.
const PICKUP_BINDING = {
  server_id: "srv-intake",
  tool_name: "lookup_addresses",
  trigger: "on_fill",
  result_key: "pickup_lookup",
  arguments: {
    contractId: "{{mcp.phone_info.contract_id}}",
    facilityId: "{{mcp.phone_info.facility_id}}",
    userAddress: "{{slots.pickup_location}}",
    disableLandingZoneSearch: true,
  },
  outputs: {
    pickup_facility_id: "0.facility_id",
    pickup_address: "0.address",
    pickup_location_type: "0.location_type",
  },
  alternatives: {
    path: "$",
    label: "{{facility_name}} - {{city}}, {{state}}",
    value: "{{facility_id}}",
    target_slot: "pickup_facility_id",
  },
};

const PHONE_INFO = { contract_id: "10", facility_id: "1562", facility_name: "Sutter - Transfer Center" };

test("normalizeSlotMcpBinding requires a server and a tool", () => {
  assert.equal(normalizeSlotMcpBinding(null), null);
  assert.equal(normalizeSlotMcpBinding({ server_id: "srv" }), null);
  assert.equal(normalizeSlotMcpBinding({ tool_name: "lookup_addresses" }), null);

  const binding = normalizeSlotMcpBinding({ serverId: "srv", toolName: "lookup_addresses" });
  assert.equal(binding.server_id, "srv");
  assert.equal(binding.tool_name, "lookup_addresses");
  // Defaults: fires on fill, results keyed by tool name.
  assert.equal(binding.trigger, BINDING_TRIGGERS.ON_FILL);
  assert.equal(binding.result_key, "lookup_addresses");
});

test("normalizeSlotMcpBinding falls back to on_fill for an unknown trigger", () => {
  const binding = normalizeSlotMcpBinding({ server_id: "s", tool_name: "t", trigger: "whenever" });
  assert.equal(binding.trigger, BINDING_TRIGGERS.ON_FILL);
});

test("getValueByPath walks dots, numeric segments and bracket indices", () => {
  const scope = { mcp: { pickup: [{ facility_id: "2566" }] } };
  assert.equal(getValueByPath(scope, "mcp.pickup.0.facility_id"), "2566");
  assert.equal(getValueByPath(scope, "mcp.pickup[0].facility_id"), "2566");
  assert.equal(getValueByPath(scope, "$.mcp.pickup.0.facility_id"), "2566");
  assert.equal(getValueByPath(scope, "mcp.missing.0.facility_id"), undefined);
  assert.deepEqual(getValueByPath(scope, "$"), scope);
});

test("resolveTemplate keeps type for an exact match and interpolates otherwise", () => {
  const scope = { slots: { count: 3, flag: false }, mcp: { r: { id: "SUT" } } };
  // Exact single template preserves the underlying type.
  assert.equal(resolveTemplate("{{slots.count}}", scope), 3);
  assert.equal(resolveTemplate("{{slots.flag}}", scope), false);
  // Embedded templates stringify.
  assert.equal(resolveTemplate("contract {{mcp.r.id}}", scope), "contract SUT");
  // Non-strings pass through untouched.
  assert.equal(resolveTemplate(true, scope), true);
  // Missing paths resolve to empty rather than leaking the template.
  assert.equal(resolveTemplate("{{slots.nope}}", scope), "");
});

test("collectSlotMcpBindings keeps bound slots and skips unbound ones", () => {
  const items = [
    { id: "i1", slot_name: "pickup_location", mcp_binding: PICKUP_BINDING },
    { id: "i2", slot_name: "patient_name" },
    { id: "i3", slot_name: "broken", mcp_binding: { tool_name: "no_server" } },
  ];
  const bindings = collectSlotMcpBindings(items);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].slot_name, "pickup_location");
  assert.equal(bindings[0].binding.tool_name, "lookup_addresses");
});

test("on_fill binding waits for its slot, then resolves the reference workflow arguments", () => {
  const bindings = collectSlotMcpBindings([
    { id: "i1", slot_name: "pickup_location", mcp_binding: PICKUP_BINDING },
  ]);

  // Slot empty -> nothing fires.
  assert.equal(
    selectTriggeredBindings({ bindings, slotsFilled: {}, mcpResults: { phone_info: PHONE_INFO } }).length,
    0,
  );

  const [triggered] = selectTriggeredBindings({
    bindings,
    slotsFilled: { pickup_location: "Palo Alto Medical Clinic" },
    mcpResults: { phone_info: PHONE_INFO },
    defaultArguments: { systemId: "Telnyx" },
  });

  assert.deepEqual(triggered.arguments, {
    systemId: "Telnyx",
    contractId: "10",
    facilityId: "1562",
    userAddress: "Palo Alto Medical Clinic",
    disableLandingZoneSearch: true,
  });
});

test("defaultArguments supply systemId without every binding repeating it", () => {
  const bindings = collectSlotMcpBindings([
    { id: "i1", slot_name: "pickup_location", mcp_binding: PICKUP_BINDING },
  ]);
  const [triggered] = selectTriggeredBindings({
    bindings,
    slotsFilled: { pickup_location: "Palo Alto Medical Clinic" },
    mcpResults: { phone_info: PHONE_INFO },
    defaultArguments: { systemId: "Telnyx" },
  });
  assert.equal(triggered.arguments.systemId, "Telnyx");
});

test("a binding overrides a default argument", () => {
  const bindings = collectSlotMcpBindings([
    {
      id: "i1",
      slot_name: "pickup_location",
      mcp_binding: { ...PICKUP_BINDING, arguments: { ...PICKUP_BINDING.arguments, systemId: "Override" } },
    },
  ]);
  const [triggered] = selectTriggeredBindings({
    bindings,
    slotsFilled: { pickup_location: "Palo Alto Medical Clinic" },
    mcpResults: { phone_info: PHONE_INFO },
    defaultArguments: { systemId: "Telnyx" },
  });
  assert.equal(triggered.arguments.systemId, "Override");
});

test("a binding cannot drop systemId - the reference workflow requires it on every call", () => {
  const withOverride = (systemId) =>
    collectSlotMcpBindings([
      {
        id: "i1",
        slot_name: "caller_number",
        mcp_binding: {
          server_id: "srv-intake",
          tool_name: "get_phone_information",
          trigger: "on_fill",
          result_key: "phone_info",
          arguments: { ani: "{{slots.caller_number}}", systemId },
        },
      },
    ]);

  // null, undefined and empty string all fall back to the default rather than
  // producing a call without systemId.
  for (const attempt of [null, undefined, ""]) {
    const [triggered] = selectTriggeredBindings({
      bindings: withOverride(attempt),
      slotsFilled: { caller_number: "9255550101" },
      defaultArguments: { systemId: "Telnyx" },
    });
    assert.deepEqual(triggered.arguments, { ani: "9255550101", systemId: "Telnyx" });
  }
});

test("ANI passes through verbatim - the reference workflow accepts E.164, so never reformat it", () => {
  const bindings = collectSlotMcpBindings([
    {
      id: "i1",
      slot_name: "caller_number",
      mcp_binding: {
        server_id: "srv-intake",
        tool_name: "get_phone_information",
        trigger: "on_fill",
        result_key: "phone_info",
        arguments: { ani: "{{slots.caller_number}}" },
      },
    },
  ]);

  // Telnyx delivers the ANI in E.164 and the reference workflow accepts it as-is. Stripping the
  // "+1" here would be a silent regression, so pin the pass-through.
  for (const ani of ["+19255550101", "9255550101"]) {
    const [triggered] = selectTriggeredBindings({
      bindings,
      slotsFilled: { caller_number: ani },
      defaultArguments: { systemId: "Telnyx" },
    });
    assert.deepEqual(triggered.arguments, { ani, systemId: "Telnyx" });
  }
});

test("a binding defers while an upstream template is still unresolved", () => {
  const bindings = collectSlotMcpBindings([
    { id: "i1", slot_name: "pickup_location", mcp_binding: PICKUP_BINDING },
  ]);

  // Slot is filled but get_phone_information has not returned yet, so
  // contractId/facilityId would be blank. Calling now would hit the reference workflow with holes.
  const triggered = selectTriggeredBindings({
    bindings,
    slotsFilled: { pickup_location: "Palo Alto Medical Clinic" },
    mcpResults: {},
  });
  assert.equal(triggered.length, 0);
});

test("a binding does not re-run until its resolved arguments change", () => {
  const bindings = collectSlotMcpBindings([
    { id: "i1", slot_name: "pickup_location", mcp_binding: PICKUP_BINDING },
  ]);
  const state = { slotsFilled: { pickup_location: "Palo Alto Medical Clinic" }, mcpResults: { phone_info: PHONE_INFO } };

  const [first] = selectTriggeredBindings({ bindings, ...state });
  // Same inputs, same binding -> skipped.
  const runs = { [first.key]: first.fingerprint };
  assert.equal(selectTriggeredBindings({ bindings, ...state, completedRuns: runs }).length, 0);

  // Caller corrects the pickup location -> new fingerprint, runs again.
  const [second] = selectTriggeredBindings({
    bindings,
    ...state,
    slotsFilled: { pickup_location: "Fairmont Hospital" },
    completedRuns: runs,
  });
  assert.ok(second);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test("bindingFingerprint ignores argument key order", () => {
  const entry = { item_id: "i1", slot_name: "pickup_location", binding: normalizeSlotMcpBinding(PICKUP_BINDING) };
  assert.equal(
    bindingFingerprint(entry, { a: 1, b: 2 }),
    bindingFingerprint(entry, { b: 2, a: 1 }),
  );
});

test("bindingFingerprint separates two slots bound to the same tool", () => {
  // Pickup and dropoff can legitimately be the same facility; keying on
  // arguments alone would collide and skip the second lookup.
  const binding = normalizeSlotMcpBinding(PICKUP_BINDING);
  const args = { userAddress: "Hospital A" };
  assert.notEqual(
    bindingFingerprint({ item_id: "pickup", binding }, args),
    bindingFingerprint({ item_id: "dropoff", binding }, args),
  );
});

test("on_result chains validate_address off the lookup that produced the address", () => {
  const bindings = collectSlotMcpBindings([
    {
      id: "i9",
      slot_name: "pickup_coordinates",
      mcp_binding: {
        server_id: "srv-intake",
        tool_name: "validate_address",
        trigger: "on_result",
        depends_on: "pickup_lookup",
        result_key: "pickup_coords",
        arguments: { systemId: "Telnyx", userAddress: "{{mcp.pickup_lookup.0.address}}" },
        outputs: { pickup_lat: "lat", pickup_lng: "lng" },
      },
    },
  ]);

  // Dependency absent -> holds.
  assert.equal(selectTriggeredBindings({ bindings, mcpResults: {} }).length, 0);

  const [triggered] = selectTriggeredBindings({
    bindings,
    mcpResults: { pickup_lookup: LOOKUP_PICKUP_RESULT },
  });
  assert.equal(triggered.arguments.userAddress, LOOKUP_PICKUP_RESULT[0].address);
});

test("on_complete holds until every required slot is filled", () => {
  const bindings = collectSlotMcpBindings([
    {
      id: "i20",
      slot_name: "transport_created",
      mcp_binding: {
        server_id: "srv-intake",
        tool_name: "create_transport",
        trigger: "on_complete",
        arguments: { systemId: "Telnyx" },
      },
    },
  ]);

  assert.equal(selectTriggeredBindings({ bindings, allRequiredSlotsFilled: false }).length, 0);
  assert.equal(selectTriggeredBindings({ bindings, allRequiredSlotsFilled: true }).length, 1);
});

test("mapBindingOutputs lands the reference workflow facility fields in sibling slots", () => {
  const binding = normalizeSlotMcpBinding(PICKUP_BINDING);
  const { slotUpdates, alternatives } = mapBindingOutputs(binding, LOOKUP_PICKUP_RESULT);

  assert.deepEqual(slotUpdates, {
    pickup_facility_id: "2566",
    pickup_address: "Sutter - PALO ALTO Medical Clinic, 300 Homer Ave, Palo Alto, CA, 94301",
    pickup_location_type: "Physician's office",
  });

  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].label, "Sutter - PALO ALTO Medical Clinic - Palo Alto, CA");
  assert.equal(alternatives[0].value, "2566");
});

test("mapBindingOutputs skips null result fields rather than writing empty slots", () => {
  const binding = normalizeSlotMcpBinding({
    ...PICKUP_BINDING,
    outputs: { pickup_lat: "0.lat", pickup_facility_id: "0.facility_id" },
  });
  const { slotUpdates } = mapBindingOutputs(binding, LOOKUP_PICKUP_RESULT);
  // lat is null in the the reference workflow response - the slot must stay unfilled so the
  // validate_address step still runs.
  assert.deepEqual(slotUpdates, { pickup_facility_id: "2566" });
});

test("multiple candidates stay as alternatives for the agent to choose", () => {
  const binding = normalizeSlotMcpBinding(PICKUP_BINDING);
  const twoMatches = [LOOKUP_PICKUP_RESULT[0], { ...LOOKUP_PICKUP_RESULT[0], facility_id: "2999", city: "Menlo Park" }];
  const { alternatives } = mapBindingOutputs(binding, twoMatches);

  assert.equal(alternatives.length, 2);
  assert.deepEqual(collapseSingleAlternative(binding, alternatives), {});
});

test("a single candidate collapses into a direct slot fill", () => {
  const binding = normalizeSlotMcpBinding(PICKUP_BINDING);
  const { alternatives } = mapBindingOutputs(binding, LOOKUP_PICKUP_RESULT);
  assert.deepEqual(collapseSingleAlternative(binding, alternatives), { pickup_facility_id: "2566" });
});

test("unwrapMcpResultEnvelope extracts the result the reference workflow wraps every payload in", () => {
  const { payload, error } = unwrapMcpResultEnvelope({ result: LOOKUP_PICKUP_RESULT, error: null });
  assert.deepEqual(payload, LOOKUP_PICKUP_RESULT);
  assert.equal(error, null);

  // Output paths are relative to the unwrapped payload, so "0.facility_id"
  // must resolve once the envelope is off.
  const binding = normalizeSlotMcpBinding(PICKUP_BINDING);
  assert.equal(mapBindingOutputs(binding, payload).slotUpdates.pickup_facility_id, "2566");
});

test("unwrapMcpResultEnvelope reports an envelope error - a 200 can still be a failure", () => {
  const { payload, error } = unwrapMcpResultEnvelope({ result: null, error: "Contract not found" });
  assert.equal(payload, null);
  assert.equal(error, "Contract not found");
});

test("unwrapMcpResultEnvelope passes through a payload that is not enveloped", () => {
  assert.deepEqual(unwrapMcpResultEnvelope(LOOKUP_PICKUP_RESULT), { payload: LOOKUP_PICKUP_RESULT, error: null });
  assert.deepEqual(unwrapMcpResultEnvelope(null), { payload: null, error: null });
});

// Codex review (0557da1d54, P1): unwrapMcpResultEnvelope is also called from
// executeMcpToolNode (mcp-tool-runner.js), which runs for ANY configured MCP
// server, not only the reference workflow's. A `result`-only match (the original check) would
// silently collapse a legitimate non-the reference workflow response like
// `{result: value, cursor: token}` down to just `value`, dropping `cursor`
// and any other sibling field. the reference integration's own envelope always carries BOTH
// `result` and `error` (error: null on success, never omitted per its docs)
// - requiring both here is a no-op for a real the reference workflow response but stops a
// false-positive match on an unrelated server's response shape.
test("unwrapMcpResultEnvelope does NOT treat a result-only payload (no error key) as an envelope — false-positive guard for non-the reference workflow MCP servers", () => {
  const nonEnvelopePayload = { result: "some-value", cursor: "next-page-token" };
  assert.deepEqual(unwrapMcpResultEnvelope(nonEnvelopePayload), { payload: nonEnvelopePayload, error: null });
});

// Codex review (5d724831, P1): "has both result and error keys" alone is
// still too loose — a legitimate non-the reference workflow response can coincidentally reuse
// both field names alongside others, e.g. {result, error: null, cursor}.
// the reference integration's real envelope never carries anything beyond result/error, so
// requiring an EXACT 2-key shape closes this without needing to thread
// server-identity information through every call site.
test("unwrapMcpResultEnvelope does NOT treat a result+error payload with EXTRA sibling keys as an envelope (regression)", () => {
  const nonEnvelopePayload = { result: "some-value", error: null, cursor: "next-page-token" };
  assert.deepEqual(unwrapMcpResultEnvelope(nonEnvelopePayload), { payload: nonEnvelopePayload, error: null });
});

test("template helpers compute values no slot can supply", () => {
  const scope = { slots: { callback_number: "+19255550101" }, mcp: {} };

  // the reference workflow requires a near-now UTC pickup time; nothing in a transcript holds one.
  const time = resolveTemplate("{{@utc_now_plus_minutes:20}}", scope);
  assert.match(time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const delta = (new Date(time) - Date.now()) / 60000;
  assert.ok(delta > 18 && delta < 22, `expected ~20min ahead, got ${delta}`);

  // the reference workflow requires areaCode/number split; the workflow captures one E.164 slot.
  assert.equal(resolveTemplate("{{@us_area_code:slots.callback_number}}", scope), "925");
  assert.equal(resolveTemplate("{{@us_local_number:slots.callback_number}}", scope), "555-0101");
});

test("phone helpers accept common US formats and reject the rest", () => {
  const mk = (v) => ({ slots: { n: v }, mcp: {} });
  assert.equal(resolveTemplate("{{@us_area_code:slots.n}}", mk("(925) 555-0101")), "925");
  assert.equal(resolveTemplate("{{@us_area_code:slots.n}}", mk("19255550101")), "925");
  assert.equal(resolveTemplate("{{@us_area_code:slots.n}}", mk("9255550101")), "925");
  // Non-US numbers resolve to nothing rather than a mangled split - including
  // an international E.164 that happens to carry ten digits, whose country
  // code would otherwise be read as a US area code (+354... -> "354").
  assert.equal(getValueByPath(mk("+48600000001"), "@us_area_code:slots.n"), undefined);
  assert.equal(getValueByPath(mk("+3545551234"), "@us_area_code:slots.n"), undefined);
  assert.equal(getValueByPath(mk("+3545551234"), "@us_local_number:slots.n"), undefined);
  // The + prefix demands +1 specifically; bare 10-digit national still works.
  assert.equal(getValueByPath(mk("+9255550101"), "@us_area_code:slots.n"), undefined);
});

// Reported live: create_transport's arguments reference {{@number:slots.
// patient_weight}} and {{@us_date_mmddyyyy:slots.patient_dob}} - the reference workflow needs a
// numeric weight (with a separate weightUnit field) and a US-format date of
// birth, neither of which a plain workflow slot can supply directly (the
// slot holds "300 lbs" / an ISO "1975-01-01"). Both helper names were never
// added to TEMPLATE_HELPERS alongside us_area_code/us_local_number in
// #1377, so getValueByPath's "unknown helper resolves to undefined" rule
// (a deliberate typo-safety net) meant these arguments were ALWAYS
// unresolved - the manual-submit binding could never fire for ANY session,
// regardless of data quality, and the agent always saw "Transport is not
// ready to submit."
test("number and us_date_mmddyyyy helpers compute the reference integration's required weight/DOB formats", () => {
  const weightScope = { slots: { patient_weight: "300 lbs" }, mcp: {} };
  assert.equal(resolveTemplate("{{@number:slots.patient_weight}}", weightScope), 300);
  // No digits at all defers the binding rather than dispatching 0/NaN.
  assert.equal(
    getValueByPath({ slots: { patient_weight: "unknown" }, mcp: {} }, "@number:slots.patient_weight"),
    undefined
  );
  assert.equal(
    getValueByPath({ slots: {}, mcp: {} }, "@number:slots.patient_weight"),
    undefined
  );

  const dobScope = { slots: { patient_dob: "1975-01-01" }, mcp: {} };
  assert.equal(resolveTemplate("{{@us_date_mmddyyyy:slots.patient_dob}}", dobScope), "01/01/1975");
  // Already-US-formatted input is normalized (zero-padded) rather than
  // rejected, since a manual agent edit could plausibly enter it that way.
  assert.equal(
    resolveTemplate("{{@us_date_mmddyyyy:slots.patient_dob}}", { slots: { patient_dob: "1/1/1975" }, mcp: {} }),
    "01/01/1975"
  );
  // Unparseable input defers rather than sending a malformed DOB.
  assert.equal(
    getValueByPath({ slots: { patient_dob: "not a date" }, mcp: {} }, "@us_date_mmddyyyy:slots.patient_dob"),
    undefined
  );
});

// Codex review (PR #1394, P1): create_transport's arguments pair @number's
// output with a FIXED "lbs" weightUnit literal - there is no unit slot/
// helper the binding could use to templatize that field. But the workflow's
// own slot hint ("weight, weighs, pounds, kilograms, kg, lbs") explicitly
// accepts kg too. A bare magnitude extraction would silently mislabel a kg
// value as lbs - "72.5 kg" shipping as "72.5 lbs" understates a real
// air-transport weight-and-balance figure by more than half. @number must
// convert kg to lbs so the magnitude always matches the unit the reference workflow is told.
test("@number converts a kilogram value to pounds, matching the binding's fixed lbs weightUnit", () => {
  const mk = (v) => ({ slots: { patient_weight: v }, mcp: {} });
  assert.equal(resolveTemplate("{{@number:slots.patient_weight}}", mk("72.5 kg")), 159.8);
  assert.equal(resolveTemplate("{{@number:slots.patient_weight}}", mk("72.5 kilograms")), 159.8);
  assert.equal(resolveTemplate("{{@number:slots.patient_weight}}", mk("50kg")), 110.2);
  // Explicit lbs, and no unit at all (the common case), pass through as-is -
  // both already match the fixed "lbs" the payload declares.
  assert.equal(resolveTemplate("{{@number:slots.patient_weight}}", mk("300 lbs")), 300);
  assert.equal(resolveTemplate("{{@number:slots.patient_weight}}", mk("300")), 300);
});

// Codex review (PR #1394, P2): the ISO/US date regexes only validated
// SHAPE (4/2/2 digits), so a value like "1975-13-40" or "02/30/1975" -
// reachable through the checklist's unrestricted manual text editor, not
// just LLM extraction - would have been treated as resolved and sent to
// create_transport, where it would only fail once it reached the reference workflow. Must
// defer (return undefined) on any shape-valid but calendar-invalid date.
test("us_date_mmddyyyy rejects shape-valid but calendar-invalid dates", () => {
  const mk = (v) => ({ slots: { patient_dob: v }, mcp: {} });
  assert.equal(getValueByPath(mk("1975-13-40"), "@us_date_mmddyyyy:slots.patient_dob"), undefined);
  assert.equal(getValueByPath(mk("02/30/1975"), "@us_date_mmddyyyy:slots.patient_dob"), undefined);
  assert.equal(getValueByPath(mk("0000-00-00"), "@us_date_mmddyyyy:slots.patient_dob"), undefined);
  // Leap day is valid only in an actual leap year.
  assert.equal(resolveTemplate("{{@us_date_mmddyyyy:slots.patient_dob}}", mk("2024-02-29")), "02/29/2024");
  assert.equal(getValueByPath(mk("2023-02-29"), "@us_date_mmddyyyy:slots.patient_dob"), undefined);
});

test("a helper with a missing source defers the binding like any other template", () => {
  const bindings = collectSlotMcpBindings([
    {
      item_id: "i1",
      slot_name: "pickup_location",
      mcp_binding: {
        server_id: "s",
        tool_name: "create_transport",
        trigger: "on_fill",
        result_key: "t",
        arguments: { phone: "{{@us_area_code:slots.callback_number}}" },
        outputs: {},
      },
    },
  ]);
  // callback_number absent -> helper undefined -> defer. A typo'd helper name
  // behaves the same, so a bad config holds rather than sending garbage.
  const held = selectTriggeredBindings({
    bindings,
    slotsFilled: { pickup_location: "X" },
    defaultArguments: { systemId: "T" },
  });
  assert.equal(held.length, 0);

  const ready = selectTriggeredBindings({
    bindings,
    slotsFilled: { pickup_location: "X", callback_number: "+19255550101" },
    defaultArguments: { systemId: "T" },
  });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].arguments.phone, "925");
});

test("@uuid is stable within one invocation scope and fresh across scopes", () => {
  const scope = { slots: {}, mcp: {} };
  const resolved = resolveTemplate(
    { extSystemTripId: "{{@uuid:trip}}", leg: { extSystemTripLegId: "{{@uuid:trip}}" }, other: "{{@uuid:other}}" },
    scope,
  );
  // the reference workflow: extSystemTripLegId must equal extSystemTripId on single-leg trips...
  assert.equal(resolved.extSystemTripId, resolved.leg.extSystemTripLegId);
  assert.match(resolved.extSystemTripId, /^[0-9a-f-]{36}$/);
  // ...but distinct names stay distinct,
  assert.notEqual(resolved.other, resolved.extSystemTripId);
  // and a retry (fresh scope) must generate a fresh id - duplicates are rejected.
  const again = resolveTemplate("{{@uuid:trip}}", { slots: {}, mcp: {} });
  assert.notEqual(again, resolved.extSystemTripId);
});

test("volatile helper outputs do not register as argument changes", () => {
  // @uuid resolves fresh per scope, and the clock moves every second. If either
  // participated in the fingerprint, an on_argument_change binding would look
  // changed on every pass and re-invoke itself up to the invocation cap.
  const bindings = collectSlotMcpBindings([
    {
      item_id: "i1",
      slot_name: "pickup_location",
      mcp_binding: {
        server_id: "s",
        tool_name: "create_transport",
        trigger: "on_fill",
        result_key: "t",
        arguments: { tripId: "{{@uuid:trip}}", when: "{{@utc_now_plus_minutes:20}}", where: "{{slots.pickup_location}}" },
        outputs: {},
      },
    },
  ]);
  const state = { slotsFilled: { pickup_location: "Hospital A" }, defaultArguments: { systemId: "T" } };

  const [first] = selectTriggeredBindings({ bindings, ...state });
  assert.ok(first, "first pass selects");
  assert.match(first.arguments.tripId, /^[0-9a-f-]{36}$/, "dispatch args still carry a real uuid");

  // Same slots, new pass, new scope, new uuid/time - must be SKIPPED.
  const runs = { [first.key]: first.fingerprint };
  const second = selectTriggeredBindings({ bindings, ...state, completedRuns: runs });
  assert.equal(second.length, 0, "unchanged inputs must not re-select a volatile-arg binding");

  // A real input change still re-triggers.
  const [third] = selectTriggeredBindings({
    bindings,
    ...state,
    slotsFilled: { pickup_location: "Hospital B" },
    completedRuns: runs,
  });
  assert.ok(third, "a changed slot re-selects");
});

test("deterministic phone helpers still count as inputs for change detection", () => {
  const bindings = collectSlotMcpBindings([
    {
      item_id: "i1",
      slot_name: "pickup_location",
      mcp_binding: {
        server_id: "s",
        tool_name: "lookup_addresses",
        trigger: "on_fill",
        result_key: "t",
        arguments: { area: "{{@us_area_code:slots.callback_number}}" },
        outputs: {},
      },
    },
  ]);
  const base = { slotsFilled: { pickup_location: "X", callback_number: "+19255550101" }, defaultArguments: { systemId: "T" } };

  const [first] = selectTriggeredBindings({ bindings, ...base });
  const runs = { [first.key]: first.fingerprint };
  // Same callback -> same fingerprint -> skipped.
  assert.equal(selectTriggeredBindings({ bindings, ...base, completedRuns: runs }).length, 0);
  // Corrected callback -> the split changes -> re-triggers, as a lookup should.
  const [again] = selectTriggeredBindings({
    bindings,
    ...base,
    slotsFilled: { pickup_location: "X", callback_number: "+14155550100" },
    completedRuns: runs,
  });
  assert.ok(again);
  assert.equal(again.arguments.area, "415");
});

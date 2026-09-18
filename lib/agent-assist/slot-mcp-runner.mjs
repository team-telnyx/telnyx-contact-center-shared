/**
 * Per-slot MCP tool bindings for Agent Assist workflows.
 *
 * A workflow slot can carry an `mcp_binding` describing an MCP tool to invoke
 * once the slot is filled. This lets a workflow enrich itself mid-call: the
 * caller names a pickup facility, the binding calls `lookup_addresses`, and the
 * resolved facility id / address / coordinates land in sibling slots.
 *
 * Bindings chain. `on_result` bindings fire off an earlier binding's output, so
 * `validate_address` can run against the address `lookup_addresses` returned
 * without the caller ever stating it.
 *
 * Pure module (no imports) so it can be unit-tested directly with node --test.
 */

/** Trigger kinds a binding can declare. */
export const BINDING_TRIGGERS = Object.freeze({
  /** Fire when the owning slot receives a value. */
  ON_FILL: "on_fill",
  /** Fire when another binding's result key is present. */
  ON_RESULT: "on_result",
  /** Fire automatically when every required input slot is filled. */
  ON_COMPLETE: "on_complete",
  /** Fire only from an explicit, confirmed agent submit action. */
  MANUAL_SUBMIT: "manual_submit",
});

const VALID_TRIGGERS = new Set(Object.values(BINDING_TRIGGERS));

/**
 * How often a binding may run.
 *
 * Enrichment tools (lookup_addresses, validate_address) should re-run whenever
 * their inputs change - that is how a correction propagates. Submit tools must
 * not: once create_transport has succeeded, a later correction changing its
 * arguments would otherwise dispatch a second ambulance. Correcting a booked
 * transport is an update/cancel operation, not another create.
 */
export const EXECUTION_POLICIES = Object.freeze({
  ON_ARGUMENT_CHANGE: "on_argument_change",
  ONCE_PER_SESSION: "once_per_session",
});

const VALID_POLICIES = new Set(Object.values(EXECUTION_POLICIES));

/**
 * Unwrap a sample `{result, error}` envelope.
 *
 * the reference workflow returns every payload wrapped this way, and reports failures in the
 * envelope rather than as a transport error - so a 200 response can still be a
 * failed call. Payloads that are not enveloped pass straight through.
 *
 * Requires the payload's keys to be EXACTLY `result` and `error` - nothing
 * more, nothing less - not just "has both". This is also called from
 * executeMcpToolNode (mcp-tool-runner.js) and the flow-editor's saved-
 * response helpers, which run for ANY configured MCP server, not only the reference workflow's.
 * A "has both keys" check alone still misclassifies a legitimate non-the reference workflow
 * response like `{result: value, error: null, cursor: token}` - the
 * envelope match would collapse it to just `value`, silently dropping
 * `cursor` and any other sibling field. the reference integration's actual envelope never carries
 * anything beyond `result`/`error` (per its docs), so requiring an exact
 * 2-key shape changes nothing for a real the reference workflow response while excluding any
 * response that merely happens to reuse those two field names alongside
 * others.
 *
 * (This is still a shape-based heuristic, not a definitive "this server is
 * the reference workflow" signal - a truly bulletproof fix would gate on server identity
 * instead, which none of this function's call sites currently have cheap,
 * consistent access to. An exact key-set match closes the concrete
 * false-positive shape raised in review without that larger change.)
 *
 * @returns {{payload: unknown, error: string|null}}
 */
export function unwrapMcpResultEnvelope(payload) {
  const isEnvelope =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (() => {
      const keys = Object.keys(payload);
      return keys.length === 2 && keys.includes("result") && keys.includes("error");
    })();
  if (!isEnvelope) return { payload, error: null };
  if (payload.error) return { payload: null, error: String(payload.error) };
  return { payload: payload.result, error: null };
}

/** A value is "meaningful" if it is neither null/undefined nor an empty string. */
export function hasMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * Template helper functions, addressed as `{{@name:arg}}`.
 *
 * These exist for binding arguments that no slot can supply: the reference workflow's
 * create_transport requires a near-now UTC pickup timestamp, and requires the
 * caller's phone split into areaCode/number while the workflow captures one
 * E.164 string. A helper whose source path resolves to nothing returns
 * undefined, so the standard defer semantics still hold - the tool is not
 * called with a half-built argument.
 */
/**
 * Named UUIDs, memoized per argument-resolution scope: every `{{@uuid:trip}}`
 * inside ONE binding invocation yields the same value (the reference workflow requires
 * extSystemTripId === extSystemTripLegId on single-leg trips), while a retry -
 * which builds a fresh scope - gets a fresh id (the reference workflow rejects duplicates).
 */
const scopeUuids = new WeakMap();

/**
 * Helpers whose output changes on every evaluation (fresh UUIDs, the clock).
 * These must NOT participate in change detection: fingerprinting their
 * resolved value would make every pass look like an argument change, and an
 * on_argument_change binding would re-invoke itself up to the pass cap. Their
 * fingerprint contribution is the template text itself. Deterministic helpers
 * (the phone splits) fingerprint by resolved value, so a changed callback
 * number still re-triggers exactly as a changed slot does.
 */
const VOLATILE_HELPERS = new Set(["uuid", "utc_now_plus_minutes"]);

const TEMPLATE_HELPERS = Object.freeze({
  /** `{{@uuid:trip}}` -> one stable UUID per name per invocation scope. */
  uuid(arg, scope) {
    const name = String(arg || "default");
    if (!scope || typeof scope !== "object") return globalThis.crypto.randomUUID();
    let names = scopeUuids.get(scope);
    if (!names) { names = new Map(); scopeUuids.set(scope, names); }
    if (!names.has(name)) names.set(name, globalThis.crypto.randomUUID());
    return names.get(name);
  },
  /** `{{@utc_now_plus_minutes:20}}` -> ISO-8601 UTC, seconds precision. */
  utc_now_plus_minutes(arg) {
    const minutes = Number(arg);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) return undefined;
    return new Date(Date.now() + minutes * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  },
  /** `{{@us_area_code:slots.callback_number}}` -> "925" from any US format. */
  us_area_code(arg, scope) {
    const digits = usDigits(getValueByPath(scope, arg));
    return digits ? digits.slice(0, 3) : undefined;
  },
  /** `{{@us_local_number:slots.callback_number}}` -> "555-0101". */
  us_local_number(arg, scope) {
    const digits = usDigits(getValueByPath(scope, arg));
    return digits ? `${digits.slice(3, 6)}-${digits.slice(6, 10)}` : undefined;
  },
  /**
   * `{{@number:slots.patient_weight}}` -> 300 (a JS number) from a slot value
   * like "300 lbs" or "300". the reference integration's weight field is numeric with a separate,
   * fixed "lbs" weightUnit sibling in this binding's arguments (there is no
   * unit slot/helper to templatize it) - but the workflow's own slot hint
   * ("weight, weighs, pounds, kilograms, kg, lbs") explicitly accepts kg
   * too. Codex review (PR #1394, P1): a kg value must be CONVERTED to lbs
   * here, not passed through as a bare magnitude, or a caller-stated "72.5
   * kg" would silently ship as "72.5 lbs" - roughly a 2.2x understatement on
   * a medical air-transport weight-and-balance figure. Returns undefined
   * (defers the binding) rather than NaN/0 when no digits are present, so a
   * garbled or empty weight never dispatches as "0 lbs".
   */
  number(arg, scope) {
    const raw = getValueByPath(scope, arg);
    if (raw === null || raw === undefined) return undefined;
    const str = String(raw);
    const match = str.match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;
    const magnitude = Number(match[0]);
    if (!Number.isFinite(magnitude)) return undefined;
    if (/\d\s*kgs?\b|\bkilo(?:gram)?s?\b/i.test(str)) {
      return Math.round(magnitude * KG_TO_LBS * 10) / 10;
    }
    return magnitude;
  },
  /**
   * `{{@us_date_mmddyyyy:slots.patient_dob}}` -> "01/01/1975" from the slot's
   * ISO "YYYY-MM-DD" value (or an already-MM/DD/YYYY value, passed through
   * normalized). the reference workflow requires the US date format; the workflow captures DOB
   * as ISO. Returns undefined on anything unparseable, INCLUDING a
   * shape-valid but calendar-invalid date like "1975-13-40" or "02/30/1975"
   * (Codex review, PR #1394, P2 - reachable via the checklist's manual text
   * editor, not just LLM extraction), rather than sending a malformed date
   * of birth that would only fail once it reached the reference workflow.
   */
  us_date_mmddyyyy(arg, scope) {
    const raw = getValueByPath(scope, arg);
    if (raw === null || raw === undefined) return undefined;
    const str = String(raw).trim();
    const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const [, year, month, day] = iso.map(Number);
      return isValidCalendarDate(year, month, day) ? `${iso[2]}/${iso[3]}/${iso[1]}` : undefined;
    }
    const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) {
      const [, month, day, year] = us.map(Number);
      if (!isValidCalendarDate(year, month, day)) return undefined;
      return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
    }
    return undefined;
  },
});

const KG_TO_LBS = 2.2046226218;

/** True when year/month/day form a real calendar date (rejects 02/30, 13/40, etc). */
function isValidCalendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Ten national digits from a US number in E.164 or local format, else null. */
function usDigits(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    // An explicit international prefix must be +1. A length-only check would
    // read +3545551234 (Iceland, ten digits) as area code 354 + 555-1234 and
    // dispatch mangled contact data instead of deferring.
    if (digits.length !== 11 || !digits.startsWith("1")) return null;
    digits = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits.length === 10 ? digits : null;
}

/**
 * Read a dotted path out of a scope object. Supports numeric segments and
 * bracket indices, so `mcp.pickup.0.facility_id` and `mcp.pickup[0].facility_id`
 * are equivalent. Returns undefined when any segment is missing.
 */
export function getValueByPath(scope, path) {
  const trimmed = String(path ?? "").trim();
  if (!trimmed || trimmed === "$") return scope;

  // `@helper:arg` computes a value instead of reading one. Unknown helper
  // names resolve to undefined, which the defer check treats as unresolved -
  // a typo therefore holds the binding rather than sending garbage.
  if (trimmed.startsWith("@")) {
    const sep = trimmed.indexOf(":");
    const name = (sep < 0 ? trimmed.slice(1) : trimmed.slice(1, sep)).trim();
    const arg = sep < 0 ? "" : trimmed.slice(sep + 1).trim();
    const helper = TEMPLATE_HELPERS[name];
    return helper ? helper(arg, scope) : undefined;
  }
  const segments = trimmed
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment !== "");

  let cursor = scope;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Resolve `{{path}}` templates against a scope, recursing through arrays and
 * plain objects. A string that is exactly one template keeps the referenced
 * value's type (numbers stay numbers, objects stay objects); a template
 * embedded in surrounding text is stringified and interpolated.
 */
export function resolveTemplate(value, scope, options = {}) {
  if (Array.isArray(value)) return value.map((entry) => resolveTemplate(entry, scope, options));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveTemplate(entry, scope, options)]),
    );
  }
  if (typeof value !== "string") return value;

  const isVolatileRef = (path) => {
    const trimmed = String(path).trim();
    if (!trimmed.startsWith("@")) return false;
    const sep = trimmed.indexOf(":");
    return VOLATILE_HELPERS.has((sep < 0 ? trimmed.slice(1) : trimmed.slice(1, sep)).trim());
  };

  const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (exact) {
    // Fingerprint mode: a volatile helper's value is generated at dispatch,
    // not an input - represent it by its template text so it cannot register
    // as an argument change.
    if (options.volatileAsLiteral && isVolatileRef(exact[1])) return value;
    const resolved = getValueByPath(scope, exact[1]);
    return resolved === undefined ? "" : resolved;
  }

  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, path) => {
    if (options.volatileAsLiteral && isVolatileRef(path)) return match;
    const resolved = getValueByPath(scope, path);
    if (resolved === undefined || resolved === null) return "";
    return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
  });
}

/**
 * Coerce a stored binding into a predictable shape, or null when it is unusable.
 * A binding needs at minimum a server, a tool, and somewhere to put the result.
 */
export function normalizeSlotMcpBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const serverId = String(raw.server_id ?? raw.serverId ?? "").trim();
  const toolName = String(raw.tool_name ?? raw.toolName ?? "").trim();
  if (!serverId || !toolName) return null;

  const trigger = String(raw.trigger ?? BINDING_TRIGGERS.ON_FILL).trim();
  const configuredResultKey = String(raw.result_key ?? raw.resultKey ?? "").trim();
  const resultKey = configuredResultKey || toolName;

  const args = raw.arguments && typeof raw.arguments === "object" && !Array.isArray(raw.arguments)
    ? raw.arguments
    : {};

  const outputs = raw.outputs && typeof raw.outputs === "object" && !Array.isArray(raw.outputs)
    ? Object.fromEntries(
        Object.entries(raw.outputs)
          .map(([slotName, path]) => [String(slotName).trim(), String(path ?? "").trim()])
          .filter(([slotName]) => slotName),
      )
    : {};

  const rawAlternatives = raw.alternatives;
  const alternatives = rawAlternatives && typeof rawAlternatives === "object" && !Array.isArray(rawAlternatives)
    ? {
        path: String(rawAlternatives.path ?? "$").trim(),
        label: String(rawAlternatives.label ?? "").trim(),
        value: String(rawAlternatives.value ?? "").trim(),
        target_slot: String(rawAlternatives.target_slot ?? rawAlternatives.targetSlot ?? "").trim(),
      }
    : null;

  const resolvedTrigger = VALID_TRIGGERS.has(trigger) ? trigger : BINDING_TRIGGERS.ON_FILL;
  const rawPolicy = String(raw.execution_policy ?? raw.executionPolicy ?? "").trim();
  // Completion/submit actions default to once-per-session. A duplicate there is
  // a real-world side effect, not a wasted lookup.
  const defaultPolicy =
    resolvedTrigger === BINDING_TRIGGERS.ON_COMPLETE || resolvedTrigger === BINDING_TRIGGERS.MANUAL_SUBMIT
      ? EXECUTION_POLICIES.ONCE_PER_SESSION
      : EXECUTION_POLICIES.ON_ARGUMENT_CHANGE;

  return {
    server_id: serverId,
    tool_name: toolName,
    trigger: resolvedTrigger,
    execution_policy: VALID_POLICIES.has(rawPolicy) ? rawPolicy : defaultPolicy,
    result_key: resultKey,
    depends_on: String(raw.depends_on ?? raw.dependsOn ?? "").trim(),
    arguments: args,
    outputs,
    alternatives,
    /** When true a failed call is surfaced but does not block the workflow. */
    optional: raw.optional !== false,
  };
}

/**
 * Pull every usable binding out of a workflow's items, tagged with the slot that
 * owns it. Items without a binding are skipped.
 */
export function collectSlotMcpBindings(items) {
  const list = Array.isArray(items) ? items : [];
  const collected = [];
  for (const item of list) {
    const binding = normalizeSlotMcpBinding(item?.mcp_binding ?? item?.mcpBinding);
    if (!binding) continue;
    collected.push({
      item_id: item.item_id ?? item.id ?? null,
      slot_name: typeof item.slot_name === "string" ? item.slot_name.trim() : "",
      binding,
    });
  }
  return collected;
}

/** The scope templates resolve against: filled slots plus prior tool results. */
export function buildBindingScope({ slotsFilled = {}, mcpResults = {} } = {}) {
  return { slots: slotsFilled || {}, mcp: mcpResults || {} };
}

/**
 * Resolve a binding's argument template map against the current scope.
 *
 * `defaultArguments` are merged underneath the binding's own arguments, so a
 * value every tool needs (the reference integration's `systemId`) is declared once rather than
 * repeated on every binding.
 *
 * A binding may override a default with a real value, but it cannot drop one:
 * a null, undefined or empty override falls back to the default. the reference workflow requires
 * `systemId` on every call, so it must not be possible to configure a binding
 * that omits it.
 */
export function resolveBindingArguments(binding, scope, defaultArguments = {}, options = {}) {
  const defaults = defaultArguments || {};
  const resolved = resolveTemplate({ ...defaults, ...(binding?.arguments || {}) }, scope, options);

  for (const [key, fallback] of Object.entries(defaults)) {
    if (!hasMeaningfulValue(resolved[key])) resolved[key] = fallback;
  }
  return resolved;
}

/**
 * Stable identity for a binding, independent of its arguments.
 *
 * Keyed on the owning item so two slots bound to the same tool - pickup and
 * dropoff both using lookup_addresses - are tracked separately. Without the
 * item id, a transport whose pickup and dropoff are the same facility would
 * see the second lookup skipped as a duplicate.
 */
export function bindingKey(entry) {
  const itemId = entry?.item_id ?? entry?.slot_name ?? "";
  const binding = entry?.binding || {};
  return JSON.stringify([itemId, binding.server_id, binding.tool_name, binding.result_key]);
}

/**
 * Stable identity for "this binding, with these arguments".
 *
 * Recorded per binding as the *latest* successful invocation rather than
 * accumulated into a set of everything ever run. A pickup edited
 * A -> B -> A must re-run on the return to A: the derived facility data
 * currently on the session belongs to B, so treating A as already-done would
 * leave the session internally inconsistent.
 */
export function bindingFingerprint(entry, args) {
  const sortedKeys = Object.keys(args || {}).sort();
  const canonical = sortedKeys.map((key) => [key, args[key]]);
  return JSON.stringify([bindingKey(entry), canonical]);
}

/**
 * Slot names the caller is NOT expected to supply.
 *
 * Two distinct kinds, and conflating them causes opposite bugs:
 *
 * 1. Declared outputs (`outputs`, `alternatives.target_slot`) - written by a
 *    tool. Requiring them would deadlock, since nothing fills them until the
 *    tool runs.
 *
 * 2. Control slots - the owning slot of an `on_result`, `on_complete`, or
 *    `manual_submit` binding. These exist to hang machine work off the workflow,
 *    rather than to collect a caller value.
 *
 * An `on_fill` owner is deliberately NOT included: `pickup_location` triggers a
 * lookup and is still something the caller has to say.
 */
export function collectMcpProducedSlots(bindings = []) {
  const produced = new Set();
  for (const entry of bindings) {
    const binding = entry?.binding || {};
    for (const slotName of Object.keys(binding.outputs || {})) produced.add(slotName);
    const target = binding.alternatives?.target_slot;
    if (target) produced.add(target);

    const ownerIsControlSlot =
      binding.trigger === BINDING_TRIGGERS.ON_RESULT ||
      binding.trigger === BINDING_TRIGGERS.ON_COMPLETE ||
      binding.trigger === BINDING_TRIGGERS.MANUAL_SUBMIT;
    if (ownerIsControlSlot && entry?.slot_name) produced.add(entry.slot_name);
  }
  return produced;
}

/**
 * True when `template` references a `{{...}}` path that has no value yet.
 *
 * Each referenced path is checked against the scope rather than testing whether
 * the resolved output looks non-empty: `"facility-{{slots.facility_id}}"`
 * resolves to `"facility-"`, which is perfectly truthy and would send a partial
 * argument to the tool. Walks objects and arrays so a nested reference defers
 * the call just as a top-level one does.
 */
function templateWentMissing(template, scope) {
  if (typeof template === "string") {
    const references = template.match(/\{\{\s*([^}]+?)\s*\}\}/g);
    if (!references) return false;
    return references.some((reference) => {
      const path = reference.replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "");
      return !hasMeaningfulValue(getValueByPath(scope, path));
    });
  }
  if (Array.isArray(template)) {
    return template.some((entry) => templateWentMissing(entry, scope));
  }
  if (template && typeof template === "object") {
    return Object.values(template).some((entry) => templateWentMissing(entry, scope));
  }
  return false;
}

/**
 * Everything downstream of a binding: its own outputs and result key, plus
 * those of every binding chained off it, recursively.
 *
 * Used to invalidate a whole generation the moment its inputs change. Clearing
 * only the binding's own outputs leaves coordinates derived from the previous
 * facility sitting in the session, and an on_complete tool will happily submit
 * them.
 *
 * Run markers are different from derived data: a descendant configured as
 * once_per_session may have already performed an external side effect. Its
 * outputs/results still become stale when an ancestor changes, but its run
 * marker must survive so the correction cannot execute that side effect again.
 *
 * @returns {{slots: string[], resultKeys: string[], bindingKeys: string[]}}
 */
export function collectDerivedClosure(bindings, rootEntry) {
  const slots = new Set();
  const resultKeys = new Set();
  const bindingKeys = new Set();
  const visitedKeys = new Set();

  const visit = (entry) => {
    const binding = entry?.binding;
    if (!binding) return;
    const key = bindingKey(entry);
    if (visitedKeys.has(key)) return;
    visitedKeys.add(key);

    if (binding.execution_policy !== EXECUTION_POLICIES.ONCE_PER_SESSION) {
      bindingKeys.add(key);
    }

    // A chained/control item is itself machine-derived state. Reopen its owning
    // checklist slot together with its result/output closure; otherwise an
    // upstream correction can leave it completed after its result is retired.
    const ownerIsControlSlot =
      binding.trigger === BINDING_TRIGGERS.ON_RESULT ||
      binding.trigger === BINDING_TRIGGERS.ON_COMPLETE ||
      binding.trigger === BINDING_TRIGGERS.MANUAL_SUBMIT;
    if (ownerIsControlSlot && entry?.slot_name) slots.add(entry.slot_name);

    const producedSlots = new Set(Object.keys(binding.outputs || {}));
    const target = binding.alternatives?.target_slot;
    if (target) producedSlots.add(target);
    for (const slotName of producedSlots) slots.add(slotName);
    if (binding.result_key) resultKeys.add(binding.result_key);

    // A descendant can depend on either this binding's result key or a slot this
    // binding produced. The latter matters when a produced slot owns its own
    // on_fill binding: changing the ancestor must retire that binding's stale
    // result/output generation too, not just remove the intermediate slot.
    for (const candidate of bindings) {
      if (candidate === entry) continue;
      const candidateBinding = candidate?.binding;
      const waitsOnResult =
        candidateBinding?.depends_on && candidateBinding.depends_on === binding.result_key;
      const waitsOnProducedSlot =
        candidateBinding?.trigger === BINDING_TRIGGERS.ON_FILL &&
        candidate?.slot_name &&
        producedSlots.has(candidate.slot_name);
      if (waitsOnResult || waitsOnProducedSlot) visit(candidate);
    }
  };

  visit(rootEntry);

  // The root's own binding key is excluded: the caller is claiming it right
  // now, so its run record is being replaced rather than cleared.
  bindingKeys.delete(bindingKey(rootEntry));
  return {
    slots: [...slots],
    resultKeys: [...resultKeys],
    bindingKeys: [...bindingKeys],
  };
}

/**
 * Decide which bindings should run this pass.
 *
 * `on_fill`       - the owning slot holds a meaningful value.
 * `on_result`     - the binding named in `depends_on` has produced a result.
 * `on_complete`   - every required input slot is filled.
 * `manual_submit` - same readiness requirement, but ONLY when the caller names
 *                   the binding item explicitly (the normal analyzer never does).
 *
 * `completedRuns` maps binding key -> latest fingerprint. A binding is skipped
 * only when its own most recent run used identical arguments, so a value that
 * changes and changes back still re-runs.
 */
export function selectTriggeredBindings({
  bindings = [],
  slotsFilled = {},
  mcpResults = {},
  completedRuns = {},
  allRequiredSlotsFilled = false,
  defaultArguments = {},
  manualSubmitItemId = null,
} = {}) {
  const scope = buildBindingScope({ slotsFilled, mcpResults });
  const latestRuns = completedRuns || {};
  const selected = [];

  for (const entry of bindings) {
    const { binding, slot_name: slotName } = entry;
    if (!binding) continue;

    if (binding.trigger === BINDING_TRIGGERS.ON_FILL) {
      if (!slotName || !hasMeaningfulValue(slotsFilled[slotName])) continue;
    } else if (binding.trigger === BINDING_TRIGGERS.ON_RESULT) {
      const dependency = binding.depends_on;
      if (!dependency || !hasMeaningfulValue(mcpResults[dependency])) continue;
    } else if (binding.trigger === BINDING_TRIGGERS.ON_COMPLETE) {
      if (!allRequiredSlotsFilled) continue;
    } else if (binding.trigger === BINDING_TRIGGERS.MANUAL_SUBMIT) {
      if (!manualSubmitItemId || entry.item_id !== manualSubmitItemId || !allRequiredSlotsFilled) continue;
    }

    const args = resolveBindingArguments(binding, scope, defaultArguments);
    // Fingerprint on the stable form: volatile helper outputs (@uuid, the
    // clock) are generated at dispatch and must not read as input changes, or
    // an on_argument_change binding re-invokes itself every pass.
    const stableArgs = resolveBindingArguments(binding, scope, defaultArguments, { volatileAsLiteral: true });

    // An argument that still contains an unresolved template means an upstream
    // value has not landed yet. Wait rather than calling the tool with a hole
    // in it. Checked recursively: a template nested inside an object or array
    // resolves to "" just the same, and a top-level-only check would let
    // { request: { facilityId: "{{mcp.lookup.id}}" } } through.
    const hasUnresolved = Object.values(binding.arguments || {}).some((template) =>
      templateWentMissing(template, scope),
    );
    if (hasUnresolved) continue;

    const key = bindingKey(entry);
    const fingerprint = bindingFingerprint(entry, stableArgs);

    // once_per_session: any recorded run means this binding already succeeded
    // (or is in flight) - a failed call releases its record, so it stays
    // retryable. Argument changes must NOT make a submit tool eligible again.
    if (binding.execution_policy === EXECUTION_POLICIES.ONCE_PER_SESSION) {
      if (latestRuns[key] !== undefined) continue;
    } else if (latestRuns[key] === fingerprint) {
      // Otherwise skip only when this binding's latest run used identical args.
      continue;
    }

    selected.push({ ...entry, arguments: args, key, fingerprint });
  }

  return selected;
}

/**
 * Turn a tool result into slot updates and, when the binding asks for them,
 * agent-facing alternatives.
 *
 * `outputs` maps slot name -> path into the result. `alternatives` describes an
 * array in the result that the agent should choose from rather than the system
 * guessing - the right behaviour when `lookup_addresses` returns several
 * candidate facilities.
 */
export function mapBindingOutputs(binding, result) {
  const slotUpdates = {};
  const normalized = binding || {};

  for (const [slotName, path] of Object.entries(normalized.outputs || {})) {
    const value = getValueByPath(result, path);
    if (hasMeaningfulValue(value)) slotUpdates[slotName] = value;
  }

  let alternatives = [];
  const altConfig = normalized.alternatives;
  if (altConfig) {
    const candidates = getValueByPath(result, altConfig.path || "$");
    if (Array.isArray(candidates)) {
      alternatives = candidates.map((candidate, index) => ({
        label: altConfig.label
          ? String(resolveTemplate(altConfig.label, candidate))
          : `Option ${index + 1}`,
        value: altConfig.value ? resolveTemplate(altConfig.value, candidate) : candidate,
        raw: candidate,
      }));
    }
  }

  return { slotUpdates, alternatives };
}

/**
 * When exactly one candidate came back there is nothing to disambiguate. Only
 * an EXPLICIT target slot receives the alternative value; a blank target means
 * the owning slot is merely where choices are displayed. This prevents a lookup
 * candidate id from replacing caller/LLM input such as `pickup_location`.
 */
export function collapseSingleAlternative(binding, alternatives, _fallbackSlot = null) {
  const targetSlot = binding?.alternatives?.target_slot;
  if (!targetSlot || alternatives.length !== 1) return {};
  return { [targetSlot]: alternatives[0].value };
}

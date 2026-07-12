/**
 * Agent Assist — final read-back helpers.
 *
 * At the confirmation step a workflow usually has a non-slot item like
 * "Confirm all information is correct" / "Read back transport details". The
 * generic suggestion generator is capped at two sentences and explicitly told
 * not to produce a summary, so it can never read back the collected slots. These
 * helpers build a deterministic read-back of every captured slot value that
 * bypasses that truncation, so the agent can confirm the whole intake at once.
 */

// Strong, finalization-specific phrases. Kept tight on purpose so mid-flow
// "summarize the issue" / "summarize their needs" items do NOT trigger a
// premature read-back — a bare "summarize" is intentionally not enough.
const READBACK_PATTERNS = [
  /read[\s-]?back/,
  /confirm all/,
  /all (?:the )?(?:information|details|info) (?:is|are) correct/,
  /everything (?:is|looks) (?:correct|right)/,
  /verify (?:the )?(?:details|information)/,
  /go over (?:the )?(?:details|information)/,
  /recap (?:the )?(?:details|information)/,
];

/**
 * Is this the finalization "read back / confirm all the collected info" item?
 * Slot items never qualify.
 */
export function isReadBackItem({ itemType, itemLabel, itemPromptHint, itemHints } = {}) {
  if (itemType === "slot") return false;
  const text = [itemLabel, itemPromptHint, ...(Array.isArray(itemHints) ? itemHints : [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;
  return READBACK_PATTERNS.some((re) => re.test(text));
}

/**
 * Given workflow items ALREADY in workflow order (stage, then item), return the
 * id of the earliest read-back-matching item, or null if none match. Lets the
 * caller ensure only the first read-back item recites the full list, so an
 * adjacent "confirm all information" follow-up doesn't repeat every slot.
 */
export function earliestReadBackItemId(orderedItems) {
  const match = (Array.isArray(orderedItems) ? orderedItems : []).find((it) =>
    isReadBackItem({
      itemType: it?.type,
      itemLabel: it?.label,
      itemPromptHint: it?.prompt_hint,
      itemHints: it?.hints,
    })
  );
  return match?.id ?? null;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/**
 * Format a captured value for a spoken read-back. Boolean slots (#1118) come
 * through as true/false — read those as "Yes"/"No" instead of "true"/"false".
 */
export function formatSlotValue(value) {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return String(value).trim();
}

/** "patient_name" -> "Patient Name" */
export function humanizeSlotName(slotName) {
  return String(slotName || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Turn a { slot_name: value } map into an ordered [{ label, value }] list,
 * dropping empties. `labelBySlot` supplies human labels; missing ones fall back
 * to a humanized slot name. Preserves the map's own key order.
 */
export function orderedSlotsFromMap(prefilledSlots, labelBySlot = {}) {
  return Object.entries(prefilledSlots || {})
    .filter(([, value]) => hasValue(value))
    .map(([slotName, value]) => ({
      label: labelBySlot[slotName] || humanizeSlotName(slotName),
      value: formatSlotValue(value),
    }));
}

/**
 * Compose the spoken read-back line from an ordered [{ label, value }] list.
 * When rawSlots is provided and contains air-transport intake keys, uses a
 * compact one-liner format instead of the generic label: value list.
 * Returns null when there is nothing collected.
 */
export function buildReadBackSuggestion({ orderedSlots, rawSlots } = {}) {
  if (rawSlots && isTransportIntake(rawSlots)) {
    return buildTransportReadBack(rawSlots);
  }

  const entries = (Array.isArray(orderedSlots) ? orderedSlots : []).filter(
    (s) => s && hasValue(s.value) && String(s.label || "").trim() !== ""
  );
  if (entries.length === 0) return null;

  const list = entries.map(({ label, value }) => `${label}: ${value}`).join(". ");
  return `Let me read back what I have to make sure everything is correct. ${list}. Is that all correct, or is there anything you'd like to change?`;
}

function isTransportIntake(rawSlots) {
  return !!(rawSlots.patient_name || rawSlots.pickup_facility || rawSlots.destination_facility);
}

function v(rawSlots, key) {
  const val = rawSlots[key];
  if (val === null || val === undefined) return null;
  if (val === true || val === "true") return "Yes";
  if (val === false || val === "false") return "No";
  const str = String(val).trim();
  return str === "" ? null : str;
}

function formatWeight(raw) {
  if (!raw) return null;
  const lbsMatch = String(raw).match(/^(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)$/i);
  if (lbsMatch) {
    const lbs = Math.round(parseFloat(lbsMatch[1]));
    const kg = Math.round(lbs / 2.205);
    return `${lbs} lbs (${kg} kg)`;
  }
  return String(raw).trim();
}

function buildTransportReadBack(rawSlots) {
  const segments = [];

  // Patient: "We're transferring Marcus Webb, DOB Jun 15 1958, 198 lbs (90 kg)"
  const name = v(rawSlots, "patient_name");
  const dob  = v(rawSlots, "patient_dob");
  const wt   = formatWeight(rawSlots.patient_weight);
  let patient = name ? `We're transferring ${name}` : "We're arranging a transport";
  if (dob) patient += `, DOB ${dob}`;
  if (wt)  patient += `, ${wt}`;
  segments.push(patient);

  // Location: "from Maplewood Regional, ED to Riverside Medical, Cath Lab"
  const pickupFacility = v(rawSlots, "pickup_facility");
  const pickupDept     = v(rawSlots, "pickup_department");
  const pickupRoom     = v(rawSlots, "pickup_room");
  const pickupBed      = v(rawSlots, "pickup_bed");
  const destFacility   = v(rawSlots, "destination_facility");
  const destDept       = v(rawSlots, "destination_department");
  const destRoom       = v(rawSlots, "destination_room");
  const destBed        = v(rawSlots, "destination_bed");

  if (pickupFacility || destFacility) {
    let from = pickupFacility || "";
    if (pickupDept) from += `, ${pickupDept}`;
    if (pickupRoom) from += `, room ${pickupRoom}`;
    if (pickupBed)  from += `, bed ${pickupBed}`;
    let to = destFacility || "";
    if (destDept) to += `, ${destDept}`;
    if (destRoom) to += `, room ${destRoom}`;
    if (destBed)  to += `, bed ${destBed}`;
    const loc = [from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(" ");
    if (loc) segments.push(loc);
  }

  // Reason
  const reason = v(rawSlots, "transport_reason");
  if (reason) segments.push(`reason: ${reason}`);

  // Join patient + location + reason with " - "
  let result = segments.join(" - ");

  // Clinical details appended with ". "
  const clinical = [];
  const ivCount = v(rawSlots, "iv_count");
  if (ivCount) clinical.push(`${ivCount} IV drip(s)`);
  const equip = v(rawSlots, "special_equipment");
  if (equip) clinical.push(`equipment: ${equip}`);
  const accompanying = v(rawSlots, "accompanying");
  const accompanyingPerson = v(rawSlots, "accompanying_person");
  if (accompanying) {
    const companyStr = accompanyingPerson ? `company: Yes, ${accompanyingPerson}` : `company: ${accompanying}`;
    clinical.push(companyStr);
  }
  const notes = v(rawSlots, "trip_notes");
  if (notes) clinical.push(`Notes: ${notes}`);
  if (clinical.length) result += `. ${clinical.join(", ")}`;

  const contact = v(rawSlots, "callback_number");
  if (contact) result += `. EMS contact: ${contact}`;

  return result;
}

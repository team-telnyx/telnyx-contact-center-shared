/**
 * Helpers for applying call-flow-provided workflow_data to Agent Assist workflow slots.
 */

function isConfiguredValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function getWorkflowSlotItems(workflow = {}) {
  const flatItems = Array.isArray(workflow.items)
    ? workflow.items
    : Array.isArray(workflow.stages)
      ? workflow.stages.flatMap((stage) => stage.items || [])
      : [];

  return flatItems.filter((item) =>
    item &&
    item.type === "slot" &&
    typeof item.slot_name === "string" &&
    item.slot_name.trim(),
  );
}

export function buildWorkflowPrefillFromClientState(clientState = {}, workflow = {}) {
  const workflowData = clientState?.workflow_data;
  if (!workflowData || typeof workflowData !== "object" || Array.isArray(workflowData)) {
    return { slotsFilled: {}, itemCompletions: [] };
  }

  const slotItems = getWorkflowSlotItems(workflow);
  const slotsFilled = {};
  const itemCompletions = [];

  for (const item of slotItems) {
    const slotName = item.slot_name;
    const rawValue = workflowData[slotName];
    const value = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) && "value" in rawValue
      ? rawValue.value
      : rawValue;

    if (!isConfiguredValue(value)) continue;

    slotsFilled[slotName] = value;
    itemCompletions.push({
      itemId: item.id || item.item_id,
      slotName,
      value,
    });
  }

  return { slotsFilled, itemCompletions };
}

import { normalizeField, normalizeFormDefinition, validateFormDefinition } from "./form-schema";
function ensureArray(value) { return Array.isArray(value) ? value : []; }
function unique(values) { return Array.from(new Set(ensureArray(values).filter(Boolean))); }
export function applyFormOperation(form, operation = {}) {
  const next = normalizeFormDefinition(JSON.parse(JSON.stringify(form || {}))); const op = operation.type || operation.op;
  if (op === "addField") { const field = normalizeField(operation.field || operation); if (!next.schema.fields.some((f) => f.id === field.id)) next.schema.fields.push(field); next.layout.order = [...ensureArray(next.layout.order).filter((id) => id !== field.id), field.id]; }
  else if (op === "updateField") { const target = operation.fieldId || operation.id; next.schema.fields = next.schema.fields.map((f) => f.id === target ? normalizeField({ ...f, ...(operation.patch || operation.field || {}) }) : f); }
  else if (op === "removeField") { const id = operation.fieldId || operation.id; next.schema.fields = next.schema.fields.filter((f) => f.id !== id); next.layout.order = ensureArray(next.layout.order).filter((x) => x !== id); }
  else if (op === "moveField" || op === "addToLayout") { const id = operation.fieldId || operation.id; const order = ensureArray(next.layout.order).filter((x) => x !== id); const index = Math.max(0, Math.min(Number(operation.index ?? order.length), order.length)); order.splice(index, 0, id); next.layout.order = order; }
  else if (op === "setBinding") { next.bindings = { ...next.bindings, [operation.fieldId || operation.id]: operation.binding || operation.value || null }; }
  else if (op === "setQueueAssignment") { next.queue_ids = unique(operation.queue_ids || operation.queueIds || next.queue_ids); next.queue_names = unique(operation.queue_names || operation.queueNames || next.queue_names); if (operation.auto_open !== undefined) next.auto_open = Boolean(operation.auto_open); }
  else if (op === "setDataTargetProposal") { next.actions = ensureArray(next.actions); next.actions.push({ type: "data_target_proposal", target: "form_submissions.data", proposal: operation.proposal || operation.value || {} }); }
  else throw new Error(`Unsupported form operation: ${op || "unknown"}`);
  return next;
}
export function applyFormOperations(form, operations = []) { const result = ensureArray(operations).reduce((acc, op) => applyFormOperation(acc, op), form); const validation = validateFormDefinition(result); return { form: result, validation }; }
export function validateFormOperations(operations = []) { const allowed = new Set(["addField", "updateField", "removeField", "moveField", "addToLayout", "setBinding", "setQueueAssignment", "setDataTargetProposal"]); const errors = []; ensureArray(operations).forEach((op, index) => { const type = op.type || op.op; if (!allowed.has(type)) errors.push({ index, message: `Unsupported operation ${type}` }); }); return { ok: errors.length === 0, errors }; }

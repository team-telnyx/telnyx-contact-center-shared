import { flattenPageOrder, makePageId, normalizeField, normalizeFormDefinition, normalizePage, validateFormDefinition } from "./form-schema";
function ensureArray(value) { return Array.isArray(value) ? value : []; }
function unique(values) { return Array.from(new Set(ensureArray(values).filter(Boolean))); }
function rebuildOrder(form) { return { ...form, layout: { ...form.layout, order: flattenPageOrder(form.schema.pages || []) } }; }
function pageIndexForField(form, fieldId) { const index = ensureArray(form.schema.pages).findIndex((page) => ensureArray(page.fields).includes(fieldId)); return index >= 0 ? index : 0; }
function targetPageIndex(form, operation = {}) { const pageId = operation.pageId || operation.targetPageId || operation.page_id; const index = pageId ? ensureArray(form.schema.pages).findIndex((page) => page.id === pageId) : -1; return index >= 0 ? index : 0; }

export function applyFormOperation(form, operation = {}) {
  let next = normalizeFormDefinition(JSON.parse(JSON.stringify(form || {}))); const op = operation.type || operation.op;
  if (op === "addField") {
    const field = normalizeField(operation.field || operation);
    if (!next.schema.fields.some((f) => f.id === field.id)) next.schema.fields.push(field);
    const pageIndex = targetPageIndex(next, operation);
    next.schema.pages = next.schema.pages.map((page, index) => index === pageIndex ? { ...page, fields: [...ensureArray(page.fields).filter((id) => id !== field.id), field.id] } : { ...page, fields: ensureArray(page.fields).filter((id) => id !== field.id) });
    next = rebuildOrder(next);
  }
  else if (op === "updateField") { const target = operation.fieldId || operation.id; next.schema.fields = next.schema.fields.map((f) => f.id === target ? normalizeField({ ...f, ...(operation.patch || operation.field || {}) }) : f); }
  else if (op === "removeField") { const id = operation.fieldId || operation.id; next.schema.fields = next.schema.fields.filter((f) => f.id !== id); next.schema.pages = next.schema.pages.map((page) => ({ ...page, fields: ensureArray(page.fields).filter((x) => x !== id) })); next = rebuildOrder(next); }
  else if (op === "moveField" || op === "addToLayout") {
    const id = operation.fieldId || operation.id; const fromPageIndex = pageIndexForField(next, id); const toPageIndex = operation.pageId || operation.targetPageId || operation.page_id ? targetPageIndex(next, operation) : fromPageIndex;
    next.schema.pages = next.schema.pages.map((page) => ({ ...page, fields: ensureArray(page.fields).filter((x) => x !== id) }));
    const target = next.schema.pages[toPageIndex] || next.schema.pages[0]; const order = ensureArray(target.fields); const index = Math.max(0, Math.min(Number(operation.index ?? order.length), order.length)); order.splice(index, 0, id);
    next.schema.pages[toPageIndex] = { ...target, fields: order }; next = rebuildOrder(next);
  }
  else if (op === "addPage") {
    const title = operation.title || operation.name || `Page ${ensureArray(next.schema.pages).length + 1}`; const page = normalizePage({ id: operation.pageId || operation.id || makePageId(title), title, description: operation.description || "", fields: ensureArray(operation.fields) }, next.schema.pages.length);
    if (!next.schema.pages.some((item) => item.id === page.id)) next.schema.pages = [...next.schema.pages, page];
    next = rebuildOrder(next);
  }
  else if (op === "updatePage") {
    const id = operation.pageId || operation.id; const patch = operation.patch || operation.page || operation;
    next.schema.pages = next.schema.pages.map((page) => page.id === id ? { ...page, title: patch.title ?? patch.name ?? page.title, description: patch.description ?? page.description } : page);
  }
  else if (op === "removePage") {
    const id = operation.pageId || operation.id; if (next.schema.pages.length > 1) {
      const removed = next.schema.pages.find((page) => page.id === id); const remaining = next.schema.pages.filter((page) => page.id !== id);
      if (removed?.fields?.length) remaining[0] = { ...remaining[0], fields: [...ensureArray(remaining[0].fields), ...removed.fields] };
      next.schema.pages = remaining; next = rebuildOrder(next);
    }
  }
  else if (op === "movePage") {
    const id = operation.pageId || operation.id; const pages = [...next.schema.pages]; const from = pages.findIndex((page) => page.id === id); if (from >= 0) { const [page] = pages.splice(from, 1); const to = Math.max(0, Math.min(Number(operation.index ?? pages.length), pages.length)); pages.splice(to, 0, page); next.schema.pages = pages; next = rebuildOrder(next); }
  }
  else if (op === "setBinding") { next.bindings = { ...next.bindings, [operation.fieldId || operation.id]: operation.binding || operation.value || null }; }
  else if (op === "setQueueAssignment") { next.queue_ids = unique(operation.queue_ids || operation.queueIds || next.queue_ids); next.queue_names = unique(operation.queue_names || operation.queueNames || next.queue_names); if (operation.auto_open !== undefined) next.auto_open = Boolean(operation.auto_open); }
  else if (op === "setDataTargetProposal") { next.actions = ensureArray(next.actions); next.actions.push({ type: "data_target_proposal", target: "form_submissions.data", proposal: operation.proposal || operation.value || {} }); }
  else throw new Error(`Unsupported form operation: ${op || "unknown"}`);
  return normalizeFormDefinition(next);
}
export function applyFormOperations(form, operations = []) { const result = ensureArray(operations).reduce((acc, op) => applyFormOperation(acc, op), form); const validation = validateFormDefinition(result); return { form: result, validation }; }
export function validateFormOperations(operations = []) { const allowed = new Set(["addField", "updateField", "removeField", "moveField", "addToLayout", "addPage", "updatePage", "removePage", "movePage", "setBinding", "setQueueAssignment", "setDataTargetProposal"]); const errors = []; ensureArray(operations).forEach((op, index) => { const type = op.type || op.op; if (!allowed.has(type)) errors.push({ index, message: `Unsupported operation ${type}` }); }); return { ok: errors.length === 0, errors }; }

import { flattenPageOrder, getFieldChildIds, makePageId, normalizeField, normalizeFormDefinition, normalizePage, validateFormDefinition } from "./form-schema.js";
function ensureArray(value) { return Array.isArray(value) ? value : []; }
function unique(values) { return Array.from(new Set(ensureArray(values).filter(Boolean))); }
function rebuildOrder(form) { return { ...form, layout: { ...form.layout, order: flattenPageOrder(form.schema.pages || [], form.schema.fields || []) } }; }
function pageIndexForField(form, fieldId) { const index = ensureArray(form.schema.pages).findIndex((page) => ensureArray(page.fields).includes(fieldId)); return index >= 0 ? index : 0; }
function targetPageIndex(form, operation = {}) { const pageId = operation.pageId || operation.targetPageId || operation.page_id; const index = pageId ? ensureArray(form.schema.pages).findIndex((page) => page.id === pageId) : -1; return index >= 0 ? index : 0; }

function boundedInsertIndex(index, length) {
  if (index === undefined || index === null || index === "") return length;
  const number = Number(index);
  return Number.isFinite(number) ? Math.max(0, Math.min(number, length)) : length;
}

function normalizeOptionLayoutPatch(field = {}, patch = {}) {
  const nextPatch = { ...(patch || {}) };
  const props = nextPatch.props && typeof nextPatch.props === "object" ? { ...nextPatch.props } : {};
  const aliases = [props.direction, props.layout, props.orientation, props.optionLayout, nextPatch.direction, nextPatch.layout, nextPatch.orientation, nextPatch.optionLayout];
  const direction = aliases.map((value) => String(value || "").toLowerCase()).find((value) => value === "horizontal" || value === "vertical");
  if (direction && ["radio", "checkbox", "select"].includes(field.type)) {
    props.direction = direction;
    delete props.layout;
    delete props.orientation;
    delete props.optionLayout;
    nextPatch.props = props;
    delete nextPatch.direction;
    delete nextPatch.layout;
    delete nextPatch.orientation;
    delete nextPatch.optionLayout;
  }
  return nextPatch;
}

function mergeFieldPatch(field = {}, patch = {}) {
  const normalizedPatch = normalizeOptionLayoutPatch(field, patch);
  const merged = { ...field, ...normalizedPatch };
  if (normalizedPatch.props && typeof normalizedPatch.props === "object") merged.props = { ...(field.props || {}), ...normalizedPatch.props };
  return merged;
}

function removeFieldRefsFromProps(props = {}, id) {
  const next = { ...props };
  if (Array.isArray(next.children)) next.children = next.children.filter((x) => x !== id);
  if (Array.isArray(next.slots)) next.slots = next.slots.map((slot) => ensureArray(slot).filter((x) => x !== id));
  if (next.cells && typeof next.cells === "object") next.cells = Object.fromEntries(Object.entries(next.cells).map(([key, value]) => [key, ensureArray(value).filter((x) => x !== id)]));
  return next;
}
function descendantIds(form, id) {
  const byId = new Map(ensureArray(form.schema.fields).map((field) => [field.id, field]));
  const out = [];
  function walk(fieldId) {
    const field = byId.get(fieldId);
    if (!field) return;
    for (const child of getFieldChildIds(field)) { out.push(child); walk(child); }
  }
  walk(id);
  return out;
}

export function applyFormOperation(form, operation = {}) {
  let next = normalizeFormDefinition(JSON.parse(JSON.stringify(form || {}))); const op = operation.type || operation.op;
  if (op === "addField") {
    const field = normalizeField(operation.field || operation);
    if (!next.schema.fields.some((f) => f.id === field.id)) next.schema.fields.push(field);
    const pageIndex = targetPageIndex(next, operation);
    next.schema.pages = next.schema.pages.map((page) => ({ ...page, fields: ensureArray(page.fields).filter((id) => id !== field.id) }));
    const target = next.schema.pages[pageIndex] || next.schema.pages[0];
    const order = ensureArray(target.fields);
    order.splice(boundedInsertIndex(operation.index, order.length), 0, field.id);
    next.schema.pages[pageIndex] = { ...target, fields: order };
    next = rebuildOrder(next);
  }
  else if (op === "updateField") { const target = operation.fieldId || operation.id; next.schema.fields = next.schema.fields.map((f) => f.id === target ? normalizeField(mergeFieldPatch(f, operation.patch || operation.field || {})) : f); }
  else if (op === "removeField") { const id = operation.fieldId || operation.id; const removeIds = new Set([id, ...descendantIds(next, id)]); next.schema.fields = next.schema.fields.filter((f) => !removeIds.has(f.id)).map((f) => ({ ...f, props: Array.from(removeIds).reduce((props, removeId) => removeFieldRefsFromProps(props, removeId), f.props || {}) })); next.schema.pages = next.schema.pages.map((page) => ({ ...page, fields: ensureArray(page.fields).filter((x) => !removeIds.has(x)) })); next = rebuildOrder(next); }
  else if (op === "moveField" || op === "addToLayout") {
    const id = operation.fieldId || operation.id; const fromPageIndex = pageIndexForField(next, id); const toPageIndex = operation.pageId || operation.targetPageId || operation.page_id ? targetPageIndex(next, operation) : fromPageIndex;
    next.schema.pages = next.schema.pages.map((page) => ({ ...page, fields: ensureArray(page.fields).filter((x) => x !== id) }));
    const target = next.schema.pages[toPageIndex] || next.schema.pages[0]; const order = ensureArray(target.fields); const index = boundedInsertIndex(operation.index, order.length); order.splice(index, 0, id);
    next.schema.pages[toPageIndex] = { ...target, fields: order }; next = rebuildOrder(next);
  }
  else if (op === "addPage") {
    const title = operation.title || operation.name || `Page ${ensureArray(next.schema.pages).length + 1}`; const page = normalizePage({ id: operation.pageId || operation.id || makePageId(title), title, description: operation.description || "", icon: operation.icon || operation.page?.icon || "", fields: ensureArray(operation.fields) }, next.schema.pages.length);
    if (!next.schema.pages.some((item) => item.id === page.id)) next.schema.pages = [...next.schema.pages, page];
    next = rebuildOrder(next);
  }
  else if (op === "updatePage") {
    const id = operation.pageId || operation.id; const patch = operation.patch || operation.page || operation;
    next.schema.pages = next.schema.pages.map((page) => page.id === id ? { ...page, title: patch.title ?? patch.name ?? page.title, description: patch.description ?? page.description, icon: patch.icon ?? page.icon ?? "" } : page);
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
  else if (op === "setFormSchemaOptions") { next.schema = { ...next.schema }; if (operation.showNavigationButtons !== undefined) next.schema.showNavigationButtons = Boolean(operation.showNavigationButtons); }
  else throw new Error(`Unsupported form operation: ${op || "unknown"}`);
  return normalizeFormDefinition(next);
}
export function applyFormOperations(form, operations = []) { const result = ensureArray(operations).reduce((acc, op) => applyFormOperation(acc, op), form); const validation = validateFormDefinition(result); return { form: result, validation }; }
export function validateFormOperations(operations = []) { const allowed = new Set(["addField", "updateField", "removeField", "moveField", "addToLayout", "addPage", "updatePage", "removePage", "movePage", "setBinding", "setQueueAssignment", "setDataTargetProposal", "setFormSchemaOptions"]); const errors = []; ensureArray(operations).forEach((op, index) => { const type = op.type || op.op; if (!allowed.has(type)) errors.push({ index, message: `Unsupported operation ${type}` }); }); return { ok: errors.length === 0, errors }; }

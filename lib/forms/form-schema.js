export const FORM_COMPONENT_TYPES = ["section", "row", "columns", "grid", "flex", "spacer", "divider", "codeblock", "hero", "stats", "card", "richtext", "label", "text", "textarea", "select", "radio", "checkbox", "button", "image", "context_value", "hidden"];
export const FORM_CONTAINER_TYPES = ["section", "row", "columns", "grid", "flex", "card"];
export const FORM_COMPONENT_REGISTRY = {
  section: { label: "Section", data: false }, row: { label: "Row", data: false }, columns: { label: "Columns", data: false }, grid: { label: "Grid", data: false }, flex: { label: "Flex", data: false }, spacer: { label: "Spacer", data: false }, divider: { label: "Divider", data: false }, codeblock: { label: "Code block", data: false },
  hero: { label: "Hero", data: false }, stats: { label: "Stats", data: false }, card: { label: "Card", data: false }, richtext: { label: "Rich text", data: false },
  label: { label: "Label", data: false }, text: { label: "Text input", data: true }, textarea: { label: "Textarea", data: true },
  select: { label: "Select", data: true, options: true }, radio: { label: "Radio group", data: true, options: true }, checkbox: { label: "Checkbox", data: true },
  button: { label: "Button", data: false }, image: { label: "Image", data: false }, context_value: { label: "Context value", data: false }, hidden: { label: "Hidden", data: true },
};

export function slugifyFormName(name = "") { return String(name || "form").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "form"; }
export function makePageId(title = "Page") { return `page_${slugifyFormName(title).replace(/-/g, "_")}_${Math.random().toString(36).slice(2, 6)}`; }

export function createDefaultForm(overrides = {}) {
  const slug = slugifyFormName(overrides.name || "New agent form");
  const defaultFields = [{ id: "customer_name", type: "text", label: "Customer name", required: false, placeholder: "Name from the conversation" }, { id: "notes", type: "textarea", label: "Notes", required: false, placeholder: "Summarize the request" }];
  return { name: overrides.name || "New agent form", slug: overrides.slug || slug, description: overrides.description || "", category: overrides.category || "General", status: overrides.status || "draft", version: overrides.version || 1,
    schema: overrides.schema || { fields: defaultFields, pages: [{ id: "page_1", title: "Page 1", fields: defaultFields.map((field) => field.id) }] },
    layout: overrides.layout || { order: defaultFields.map((field) => field.id) }, theme: overrides.theme || { density: "comfortable" }, bindings: overrides.bindings || {}, actions: overrides.actions || [{ type: "submit", label: "Submit" }], queue_ids: overrides.queue_ids || [], queue_names: overrides.queue_names || [], auto_open: Boolean(overrides.auto_open) };
}

export function normalizeField(field = {}) {
  const id = String(field.id || field.name || "field").trim().replace(/[^A-Za-z0-9_:-]/g, "_"); const type = FORM_COMPONENT_TYPES.includes(field.type) ? field.type : "text";
  return { id, type, label: field.label || id.replace(/[_-]+/g, " "), required: Boolean(field.required), placeholder: field.placeholder || "", helpText: field.helpText || field.help_text || "", options: Array.isArray(field.options) ? field.options.map((o) => typeof o === "string" ? { label: o, value: o } : o) : [], defaultValue: field.defaultValue ?? field.default_value ?? "", contextPath: field.contextPath || field.context_path || "", hidden: Boolean(field.hidden), props: normalizeFieldProps(type, field.props && typeof field.props === "object" ? field.props : {}) };
}

function onlyIds(values) { return Array.isArray(values) ? values.filter((id) => typeof id === "string" && id.trim()) : []; }
function normalizeFieldProps(type, props = {}) {
  const next = { ...props };
  if (["section", "row", "flex", "card"].includes(type)) next.children = onlyIds(next.children);
  if (type === "columns") {
    const count = Math.max(1, Math.min(Number(next.columns || next.columnCount || 2), 6));
    const source = Array.isArray(next.slots) ? next.slots : Array.isArray(next.children) ? [next.children] : [];
    next.columns = count;
    next.slots = Array.from({ length: count }, (_, index) => onlyIds(source[index]));
  }
  if (type === "grid") {
    const columns = Math.max(1, Math.min(Number(next.columns || 2), 6));
    const rows = Math.max(1, Math.min(Number(next.rows || 2), 12));
    const source = next.cells && typeof next.cells === "object" ? next.cells : {};
    next.columns = columns;
    next.rows = rows;
    next.cells = Object.fromEntries(Array.from({ length: rows }).flatMap((_, row) => Array.from({ length: columns }).map((__, column) => {
      const key = `${row}:${column}`;
      return [key, onlyIds(source[key] || source[`${row}-${column}`])];
    })));
  }
  return next;
}

export function getFieldChildIds(field = {}) {
  const props = field.props || {};
  if (["section", "row", "flex", "card"].includes(field.type)) return onlyIds(props.children);
  if (field.type === "columns") return (Array.isArray(props.slots) ? props.slots : []).flatMap(onlyIds);
  if (field.type === "grid") return Object.values(props.cells || {}).flatMap(onlyIds);
  return [];
}

export function flattenFieldTree(rootIds = [], fields = []) {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const out = [];
  const seen = new Set();
  function visit(id) {
    if (!id || seen.has(id) || !byId.has(id)) return;
    seen.add(id); out.push(id);
    getFieldChildIds(byId.get(id)).forEach(visit);
  }
  rootIds.forEach(visit);
  return out;
}

export function normalizePage(page = {}, fallbackIndex = 0) {
  const rawTitle = page.title || page.name || `Page ${fallbackIndex + 1}`;
  const id = String(page.id || page.pageId || slugifyFormName(rawTitle).replace(/-/g, "_") || `page_${fallbackIndex + 1}`).trim().replace(/[^A-Za-z0-9_:-]/g, "_");
  return { id, title: rawTitle, description: page.description || "", icon: page.icon || "", fields: Array.isArray(page.fields) ? page.fields.filter(Boolean) : Array.isArray(page.order) ? page.order.filter(Boolean) : [] };
}

function normalizePages({ schema = {}, layout = {}, fields = [] }) {
  const knownIds = new Set(fields.map((f) => f.id));
  const nestedIds = new Set(fields.flatMap(getFieldChildIds));
  const pagesSource = Array.isArray(schema.pages) && schema.pages.length ? schema.pages : Array.isArray(layout.pages) && layout.pages.length ? layout.pages : [];
  let pages = pagesSource.map(normalizePage).map((page) => ({ ...page, fields: page.fields.filter((id) => knownIds.has(id) && !nestedIds.has(id)) }));
  const assigned = new Set(pages.flatMap((page) => page.fields));
  const legacyOrder = Array.isArray(layout.order) ? layout.order.filter((id) => knownIds.has(id) && !nestedIds.has(id)) : fields.map((f) => f.id).filter((id) => !nestedIds.has(id));
  const unassigned = [...legacyOrder.filter((id) => !assigned.has(id)), ...fields.map((f) => f.id).filter((id) => !assigned.has(id) && !legacyOrder.includes(id) && !nestedIds.has(id))];
  if (!pages.length) pages = [{ id: "page_1", title: "Page 1", description: "", icon: "", fields: legacyOrder.length ? legacyOrder : fields.map((f) => f.id) }];
  else if (unassigned.length) pages[0] = { ...pages[0], fields: [...pages[0].fields, ...unassigned] };
  const seenPageIds = new Set();
  pages = pages.map((page, index) => {
    let id = page.id || `page_${index + 1}`;
    if (seenPageIds.has(id)) id = `${id}_${index + 1}`;
    seenPageIds.add(id);
    return { ...page, id, title: page.title || `Page ${index + 1}`, fields: Array.from(new Set(page.fields.filter((fieldId) => knownIds.has(fieldId) && !nestedIds.has(fieldId)))) };
  });
  if (!pages.length) pages = [{ id: "page_1", title: "Page 1", description: "", icon: "", fields: [] }];
  return pages;
}

export function flattenPageOrder(pages = [], fields = []) { const roots = pages.flatMap((page) => Array.isArray(page.fields) ? page.fields : []); return fields.length ? flattenFieldTree(roots, fields) : roots; }
export function getFormPages(form = {}) { return normalizeFormDefinition(form).schema.pages; }
export function getActivePage(form = {}, pageId) { const pages = getFormPages(form); return pages.find((page) => page.id === pageId) || pages[0]; }
export function getPageFields(form = {}, pageId) { const normalized = normalizeFormDefinition(form); const page = getActivePage(normalized, pageId); const byId = new Map((normalized.schema?.fields || []).map((field) => [field.id, field])); return (page?.fields || []).map((id) => byId.get(id)).filter(Boolean); }

export function normalizeFormDefinition(form = {}) {
  const base = createDefaultForm(form);
  const fields = Array.isArray(base.schema?.fields) ? base.schema.fields.map(normalizeField) : [];
  const pages = normalizePages({ schema: base.schema, layout: base.layout, fields });
  const pageOrder = flattenPageOrder(pages, fields);
  const fieldIds = fields.map((field) => field.id);
  const order = [...pageOrder, ...fieldIds.filter((id) => !pageOrder.includes(id))];
  return { ...form, ...base, schema: { ...base.schema, fields, pages }, layout: { ...base.layout, order } };
}

export function validateFormDefinition(form = {}) {
  const errors = []; if (!String(form.name || "").trim()) errors.push({ path: "name", message: "Name is required" }); if (!String(form.slug || "").trim()) errors.push({ path: "slug", message: "Slug is required" }); const fields = form.schema?.fields; if (!Array.isArray(fields)) errors.push({ path: "schema.fields", message: "Fields must be an array" }); const seen = new Set(); for (const field of fields || []) { if (!field.id) errors.push({ path: "schema.fields", message: "Every field needs an id" }); if (seen.has(field.id)) errors.push({ path: `schema.fields.${field.id}`, message: "Duplicate field id" }); seen.add(field.id); if (!FORM_COMPONENT_TYPES.includes(field.type)) errors.push({ path: `schema.fields.${field.id}.type`, message: `Unsupported field type ${field.type}` }); }
  const pages = form.schema?.pages; if (pages !== undefined && !Array.isArray(pages)) errors.push({ path: "schema.pages", message: "Pages must be an array" }); const knownIds = new Set((fields || []).map((field) => field.id)); const pageIds = new Set(); for (const page of pages || []) { if (!page.id) errors.push({ path: "schema.pages", message: "Every page needs an id" }); if (pageIds.has(page.id)) errors.push({ path: `schema.pages.${page.id}`, message: "Duplicate page id" }); pageIds.add(page.id); for (const fieldId of page.fields || []) if (!knownIds.has(fieldId)) errors.push({ path: `schema.pages.${page.id}.fields`, message: `Unknown field id ${fieldId}` }); }
  return { ok: errors.length === 0, errors };
}

export function validateSubmissionData(form = {}, data = {}) {
  const normalized = normalizeFormDefinition(form); const errors = []; for (const field of normalized.schema?.fields || []) { const meta = FORM_COMPONENT_REGISTRY[field.type] || {}; if (!meta.data || field.type === "hidden") continue; const value = data[field.id]; if (field.required && (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0))) errors.push({ field: field.id, message: `${field.label || field.id} is required` }); } return { ok: errors.length === 0, errors };
}

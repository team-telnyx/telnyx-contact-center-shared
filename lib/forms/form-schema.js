export const FORM_COMPONENT_TYPES = ["label", "text", "textarea", "select", "radio", "checkbox", "button", "image", "context_value", "hidden"];
export const FORM_COMPONENT_REGISTRY = {
  label: { label: "Label", data: false }, text: { label: "Text input", data: true }, textarea: { label: "Textarea", data: true },
  select: { label: "Select", data: true, options: true }, radio: { label: "Radio group", data: true, options: true }, checkbox: { label: "Checkbox", data: true },
  button: { label: "Button", data: false }, image: { label: "Image", data: false }, context_value: { label: "Context value", data: false }, hidden: { label: "Hidden", data: true },
};
export function slugifyFormName(name = "") { return String(name || "form").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "form"; }
export function createDefaultForm(overrides = {}) {
  const slug = slugifyFormName(overrides.name || "New agent form");
  return { name: overrides.name || "New agent form", slug: overrides.slug || slug, description: overrides.description || "", category: overrides.category || "General", status: overrides.status || "draft", version: overrides.version || 1,
    schema: overrides.schema || { fields: [{ id: "customer_name", type: "text", label: "Customer name", required: false, placeholder: "Name from the conversation" }, { id: "notes", type: "textarea", label: "Notes", required: false, placeholder: "Summarize the request" }] },
    layout: overrides.layout || { order: ["customer_name", "notes"] }, theme: overrides.theme || { density: "comfortable" }, bindings: overrides.bindings || {}, actions: overrides.actions || [{ type: "submit", label: "Submit" }], queue_ids: overrides.queue_ids || [], queue_names: overrides.queue_names || [], auto_open: Boolean(overrides.auto_open) };
}
export function normalizeField(field = {}) {
  const id = String(field.id || field.name || "field").trim().replace(/[^A-Za-z0-9_:-]/g, "_"); const type = FORM_COMPONENT_TYPES.includes(field.type) ? field.type : "text";
  return { id, type, label: field.label || id.replace(/[_-]+/g, " "), required: Boolean(field.required), placeholder: field.placeholder || "", helpText: field.helpText || field.help_text || "", options: Array.isArray(field.options) ? field.options.map((o) => typeof o === "string" ? { label: o, value: o } : o) : [], defaultValue: field.defaultValue ?? field.default_value ?? "", contextPath: field.contextPath || field.context_path || "", hidden: Boolean(field.hidden), props: field.props && typeof field.props === "object" ? field.props : {} };
}
export function normalizeFormDefinition(form = {}) {
  const base = createDefaultForm(form); const fields = Array.isArray(base.schema?.fields) ? base.schema.fields.map(normalizeField) : []; const knownIds = new Set(fields.map((f) => f.id)); const order = Array.isArray(base.layout?.order) ? base.layout.order.filter((id) => knownIds.has(id)) : fields.map((f) => f.id); for (const field of fields) if (!order.includes(field.id)) order.push(field.id); return { ...form, ...base, schema: { ...base.schema, fields }, layout: { ...base.layout, order } };
}
export function validateFormDefinition(form = {}) {
  const errors = []; if (!String(form.name || "").trim()) errors.push({ path: "name", message: "Name is required" }); if (!String(form.slug || "").trim()) errors.push({ path: "slug", message: "Slug is required" }); const fields = form.schema?.fields; if (!Array.isArray(fields)) errors.push({ path: "schema.fields", message: "Fields must be an array" }); const seen = new Set(); for (const field of fields || []) { if (!field.id) errors.push({ path: "schema.fields", message: "Every field needs an id" }); if (seen.has(field.id)) errors.push({ path: `schema.fields.${field.id}`, message: "Duplicate field id" }); seen.add(field.id); if (!FORM_COMPONENT_TYPES.includes(field.type)) errors.push({ path: `schema.fields.${field.id}.type`, message: `Unsupported field type ${field.type}` }); } return { ok: errors.length === 0, errors };
}
export function validateSubmissionData(form = {}, data = {}) {
  const errors = []; for (const field of form.schema?.fields || []) { const meta = FORM_COMPONENT_REGISTRY[field.type] || {}; if (!meta.data || field.type === "hidden") continue; const value = data[field.id]; if (field.required && (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0))) errors.push({ field: field.id, message: `${field.label || field.id} is required` }); } return { ok: errors.length === 0, errors };
}

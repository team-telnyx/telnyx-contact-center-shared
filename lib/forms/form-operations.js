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

function isPlainObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object || {}, key); }
function firstDefined(source = {}, keys = []) {
  for (const key of keys) if (hasOwn(source, key) && source[key] !== undefined) return source[key];
  return undefined;
}
function normalizeBooleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value || "").toLowerCase().trim();
  if (["true", "yes", "on", "enabled", "show", "shown", "checked"].includes(text)) return true;
  if (["false", "no", "off", "disabled", "hide", "hidden", "unchecked"].includes(text)) return false;
  return value;
}
function normalizeNumberValue(value) { const number = Number(value); return Number.isFinite(number) ? number : value; }
function setIfMissing(target, key, value) {
  if (value === undefined || value === null) return;
  if (!hasOwn(target, key) || target[key] === undefined || target[key] === null || target[key] === "") target[key] = value;
}
function moveAlias(source, target, canonical, aliases = [], transform = (value) => value, { deleteAliases = true } = {}) {
  const value = firstDefined(source, aliases);
  setIfMissing(target, canonical, value === undefined ? undefined : transform(value));
  if (deleteAliases) for (const alias of aliases) if (alias !== canonical) delete target[alias];
}
function normalizeDirectionValue(value) {
  const text = String(value || "").toLowerCase().trim();
  if (["horizontal", "h", "inline", "row"].includes(text)) return "horizontal";
  if (["vertical", "v", "stacked", "column", "col"].includes(text)) return "vertical";
  return undefined;
}
function normalizeFlexDirectionValue(value) {
  const text = String(value || "").toLowerCase().trim();
  if (["row", "horizontal", "inline"].includes(text)) return "row";
  if (["column", "col", "vertical", "stacked"].includes(text)) return "column";
  return undefined;
}
function normalizeOptionsAlias(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((option, index) => {
    if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") return { label: String(option), value: String(option) };
    if (!isPlainObject(option)) return { label: `Option ${index + 1}`, value: `option_${index + 1}` };
    const valueCandidate = option.value ?? option.id ?? option.key ?? option.label ?? option.name ?? option.text ?? `option_${index + 1}`;
    return { ...option, label: option.label ?? option.name ?? option.text ?? String(valueCandidate), value: String(valueCandidate) };
  });
}
function normalizeStatsItemsAlias(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item, index) => {
    if (isPlainObject(item)) return { ...item, title: item.title ?? item.label ?? item.value ?? `Metric ${index + 1}`, description: item.description ?? item.subtitle ?? item.caption ?? "", icon: item.icon ?? item.iconName ?? "" };
    return { title: String(item), description: "", icon: "" };
  });
}
function normalizeAccordionItemsAlias(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item, index) => {
    if (isPlainObject(item)) return { ...item, title: item.title ?? item.label ?? item.heading ?? `Item ${index + 1}`, content: item.content ?? item.body ?? item.description ?? item.text ?? "", defaultOpen: Boolean(item.defaultOpen ?? item.default_open ?? item.open ?? item.expanded ?? false) };
    return { title: String(item), content: "", defaultOpen: false };
  });
}
function normalizeAccordionBehavior(value) {
  const normalized = String(value || "").toLowerCase().replace(/[\s_-]+/g, "_");
  if (["multiple", "multi", "many"].includes(normalized)) return { type: "multiple", collapsible: true };
  if (["single", "one"].includes(normalized)) return { type: "single", collapsible: false };
  if (["single_collapsible", "collapsible", "single_collapse", "one_collapsible"].includes(normalized)) return { type: "single", collapsible: true };
  return undefined;
}
function normalizeDateTimeMode(value) {
  const normalized = String(value || "").toLowerCase().replace(/[\s_]+/g, "-");
  if (["date", "time", "datetime-local"].includes(normalized)) return normalized;
  if (["datetime", "date-time", "date-and-time"].includes(normalized)) return "datetime-local";
  return undefined;
}
function normalizeImageMode(value) {
  const normalized = String(value || "").toLowerCase().replace(/[\s_]+/g, "-");
  if (["inline", "background"].includes(normalized)) return normalized;
  if (["bg", "background-image", "cover"].includes(normalized)) return "background";
  return undefined;
}
function normalizeFieldTypeAlias(type) { return type === "code_block" ? "codeblock" : type; }
function fieldTypeForPatch(field = {}, patch = {}) { return normalizeFieldTypeAlias(patch.type || field.type || "text"); }
function fieldProducesDataType(type) { return ["text", "textarea", "select", "radio", "checkbox", "switch", "slider", "datetime", "hidden"].includes(type); }
function fieldSupportsOptions(type) { return ["select", "radio", "checkbox"].includes(type); }
function mergeAliasProps(nextPatch, props, canonical, aliases = [], transform = (value) => value) {
  const value = firstDefined(props, [canonical, ...aliases]) ?? firstDefined(nextPatch, [canonical, ...aliases]);
  setIfMissing(props, canonical, value === undefined ? undefined : transform(value));
  for (const alias of aliases) { delete props[alias]; delete nextPatch[alias]; }
}

export function normalizeAiFieldPatch(field = {}, patch = {}) {
  const nextPatch = { ...(patch || {}) };
  if (nextPatch.type === "code_block") nextPatch.type = "codeblock";
  const type = fieldTypeForPatch(field, nextPatch);
  const props = isPlainObject(nextPatch.props) ? { ...nextPatch.props } : {};

  moveAlias(nextPatch, nextPatch, "helpText", ["helpText", "help_text", "help", "hint", "descriptionText"], (v) => v, { deleteAliases: false });
  moveAlias(nextPatch, nextPatch, "defaultValue", ["defaultValue", "default_value", "default", "value", "initialValue", "initial_value"], (v) => v, { deleteAliases: false });
  if (nextPatch.required !== undefined) nextPatch.required = normalizeBooleanValue(nextPatch.required);
  if (fieldProducesDataType(type)) {
    moveAlias(nextPatch, nextPatch, "variableName", ["variableName", "variable_name", "variable", "varName", "fieldVariableName"], (v) => v, { deleteAliases: false });
    if (!hasOwn(nextPatch, "variableName") && typeof nextPatch.name === "string") nextPatch.variableName = nextPatch.name;
  }
  if (fieldSupportsOptions(type)) {
    const optionsAlias = normalizeOptionsAlias(firstDefined(nextPatch, ["options", "choices", "items", "values"]));
    if (optionsAlias && !hasOwn(nextPatch, "options")) nextPatch.options = optionsAlias;
    const direction = normalizeDirectionValue(firstDefined(props, ["direction", "layout", "orientation", "optionLayout", "option_layout", "optionsLayout", "options_layout"]) ?? firstDefined(nextPatch, ["direction", "layout", "orientation", "optionLayout", "option_layout", "optionsLayout", "options_layout"]));
    if (direction && !hasOwn(props, "direction")) props.direction = direction;
    ["layout", "orientation", "optionLayout", "option_layout", "optionsLayout", "options_layout"].forEach((key) => { delete props[key]; delete nextPatch[key]; });
  }

  mergeAliasProps(nextPatch, props, "padding", ["pad", "spacing", "inset"]);
  mergeAliasProps(nextPatch, props, "align", ["alignment", "textAlign", "text_align", "horizontalAlign", "horizontalAlignment"]);
  mergeAliasProps(nextPatch, props, "color", ["textColor", "text_color", "foregroundColor"]);
  mergeAliasProps(nextPatch, props, "bold", ["isBold", "fontBold"], normalizeBooleanValue);
  mergeAliasProps(nextPatch, props, "size", ["textSize", "text_size"]);
  mergeAliasProps(nextPatch, props, "borderWidth", ["border_width", "border", "lineWidth", "line_width"], normalizeNumberValue);
  mergeAliasProps(nextPatch, props, "borderColor", ["border_color", "lineColor", "line_color"]);
  mergeAliasProps(nextPatch, props, "borderRadius", ["border_radius", "radius"], normalizeNumberValue);
  mergeAliasProps(nextPatch, props, "gap", ["spacingGap", "gutter"], normalizeNumberValue);

  mergeAliasProps(nextPatch, props, "layoutByChild", ["childLayout", "child_layout", "childrenLayout", "children_layout"]);
  if (isPlainObject(props.layoutByChild)) {
    props.layoutByChild = Object.fromEntries(Object.entries(props.layoutByChild).map(([childId, layout]) => {
      const item = isPlainObject(layout) ? { ...layout } : {};
      mergeAliasProps({}, item, "align", ["alignment", "textAlign", "text_align", "horizontalAlign", "horizontalAlignment"]);
      mergeAliasProps({}, item, "verticalAlign", ["vertical", "vertical_align", "vAlign", "verticalAlignment", "vertical_alignment"]);
      mergeAliasProps({}, item, "columnSpan", ["colSpan", "column_span", "spanColumns"], normalizeNumberValue);
      mergeAliasProps({}, item, "rowSpan", ["row_span", "spanRows"], normalizeNumberValue);
      return [childId, item];
    }));
  }

  if (["section", "row", "flex", "card"].includes(type)) mergeAliasProps(nextPatch, props, "children", ["childIds", "child_ids"]);
  if (["flex", "spacer"].includes(type)) mergeAliasProps(nextPatch, props, "direction", ["layout", "orientation", "flexDirection", "flex_direction"], type === "flex" ? (v) => normalizeFlexDirectionValue(v) || v : (v) => normalizeDirectionValue(v) || v);
  if (type === "flex") {
    mergeAliasProps(nextPatch, props, "justify", ["justifyContent", "justify_content", "mainAlign", "mainAlignment"]);
    mergeAliasProps(nextPatch, props, "wrap", ["flexWrap", "flex_wrap"], normalizeBooleanValue);
  }
  if (["columns", "grid"].includes(type)) mergeAliasProps(nextPatch, props, "columns", ["columnCount", "column_count", "cols", ...(type === "columns" ? ["count"] : [])], normalizeNumberValue);
  if (type === "columns") mergeAliasProps(nextPatch, props, "slots", ["columnsChildren", "columnChildren", "column_children", "columnsContent", "columnSlots"]);
  if (type === "grid") {
    mergeAliasProps(nextPatch, props, "rows", ["rowCount", "row_count"], normalizeNumberValue);
    mergeAliasProps(nextPatch, props, "cells", ["gridCells", "grid_cells"]);
  }

  if (["image", "avatar"].includes(type)) mergeAliasProps(nextPatch, props, "src", ["imageUrl", "image_url", "url", "image", "avatarUrl", "avatar_url"]);
  if (["hero", "card"].includes(type)) mergeAliasProps(nextPatch, props, "imageUrl", ["image_url", "image", "imageSrc", "image_src", "src", "url", "backgroundImage", "background_image"]);
  if (["image", "avatar", "hero", "card"].includes(type)) {
    mergeAliasProps(nextPatch, props, "imageTitle", ["image_title", "titleText", "imageAlt", "image_alt", "altText", "alt_text"]);
    mergeAliasProps(nextPatch, props, "imageScale", ["image_scale", "scale", "zoom"], normalizeNumberValue);
  }
  if (type === "hero") {
    mergeAliasProps(nextPatch, props, "quote", ["eyebrow", "kicker"]);
    mergeAliasProps(nextPatch, props, "title", ["headline", "heading"]);
    mergeAliasProps(nextPatch, props, "description", ["body", "subtitle", "subTitle"]);
    mergeAliasProps(nextPatch, props, "buttons", ["actions", "ctas", "cta"]);
    const rawImageMode = firstDefined(props, ["imageMode", "image_mode", "mode", "backgroundMode"]) ?? firstDefined(nextPatch, ["imageMode", "image_mode", "mode", "backgroundMode"]);
    const imageMode = normalizeImageMode(rawImageMode) || (props.background === true || nextPatch.background === true ? "background" : undefined) || (props.inline === true || nextPatch.inline === true ? "inline" : undefined);
    if (imageMode && !hasOwn(props, "imageMode")) props.imageMode = imageMode;
    ["image_mode", "background", "backgroundMode", "inline"].forEach((key) => { delete props[key]; delete nextPatch[key]; });
  }
  if (type === "avatar") {
    mergeAliasProps(nextPatch, props, "alt", ["altText", "alt_text"]);
    mergeAliasProps(nextPatch, props, "fallback", ["initials", "fallbackText", "fallback_text"]);
    mergeAliasProps(nextPatch, props, "shape", ["avatarShape", "avatar_shape"]);
    mergeAliasProps(nextPatch, props, "fallbackColor", ["fallback_color", "fallbackTextColor", "fallback_text_color"]);
  }
  if (type === "badge") {
    mergeAliasProps(nextPatch, props, "text", ["badgeText", "badge_text", "title"]);
    if (!hasOwn(props, "text") && typeof nextPatch.label === "string") props.text = nextPatch.label;
    mergeAliasProps(nextPatch, props, "variant", ["style", "badgeVariant", "badge_variant"]);
  }
  if (type === "card") {
    mergeAliasProps(nextPatch, props, "title", ["heading"]);
    mergeAliasProps(nextPatch, props, "description", ["body", "subtitle", "subTitle"]);
    mergeAliasProps(nextPatch, props, "mode", ["variant", "style", "cardMode", "card_mode"]);
  }
  if (type === "accordion") {
    const behavior = normalizeAccordionBehavior(firstDefined(props, ["behavior", "behaviour", "type"]) ?? firstDefined(nextPatch, ["behavior", "behaviour", "type"]));
    if (behavior) { setIfMissing(props, "type", behavior.type); setIfMissing(props, "collapsible", behavior.collapsible); }
    mergeAliasProps(nextPatch, props, "collapsible", ["canCollapse", "can_collapse"], normalizeBooleanValue);
    mergeAliasProps(nextPatch, props, "variant", ["style", "accordionVariant", "accordion_variant"]);
    const items = normalizeAccordionItemsAlias(firstDefined(props, ["items", "entries", "sections", "questions"]) ?? firstDefined(nextPatch, ["items", "entries", "sections", "questions"]));
    if (items && !hasOwn(props, "items")) props.items = items;
    const defaultOpen = firstDefined(props, ["defaultOpen", "default_open", "open"]) ?? firstDefined(nextPatch, ["defaultOpen", "default_open", "open"]);
    if (defaultOpen !== undefined && Array.isArray(props.items)) props.items = props.items.map((item, index) => ({ ...item, defaultOpen: Array.isArray(defaultOpen) ? defaultOpen.includes(item.id || item._id || item.title || index) : Boolean(defaultOpen) }));
    ["behavior", "behaviour", "style", "entries", "sections", "questions", "defaultOpen", "default_open", "open"].forEach((key) => { delete props[key]; delete nextPatch[key]; });
  }
  if (type === "stats") {
    const items = normalizeStatsItemsAlias(firstDefined(props, ["items", "metrics", "stats"]) ?? firstDefined(nextPatch, ["items", "metrics", "stats"]));
    if (items && !hasOwn(props, "items")) props.items = items;
  }
  if (["label", "richtext"].includes(type)) {
    if (type === "richtext") mergeAliasProps(nextPatch, props, "richtext", ["richText", "rich_text", "content", "text", "body"]);
    if (type === "label") mergeAliasProps(nextPatch, props, "text", ["content"]);
  }
  if (type === "codeblock") {
    mergeAliasProps(nextPatch, props, "code", ["content", "text"]);
    mergeAliasProps(nextPatch, props, "language", ["lang", "syntax"]);
    mergeAliasProps(nextPatch, props, "maxHeight", ["max_height", "height"], normalizeNumberValue);
    mergeAliasProps(nextPatch, props, "showLineNumbers", ["show_line_numbers", "lineNumbers", "line_numbers"], normalizeBooleanValue);
  }
  if (type === "context_value") moveAlias(nextPatch, nextPatch, "contextPath", ["contextPath", "context_path", "path"], (v) => v, { deleteAliases: false });
  if (type === "datetime") {
    const mode = normalizeDateTimeMode(firstDefined(props, ["mode", "dateMode", "date_mode", "inputMode", "input_mode", "datetimeMode", "datetime_mode", "inputType", "input_type"]) ?? firstDefined(nextPatch, ["mode", "dateMode", "date_mode", "inputMode", "input_mode", "datetimeMode", "datetime_mode", "inputType", "input_type"]));
    if (mode && !hasOwn(props, "mode")) props.mode = mode;
  }
  if (type === "switch") {
    mergeAliasProps(nextPatch, props, "onText", ["on_text", "onLabel", "on_label", "trueText", "true_text", "on"]);
    mergeAliasProps(nextPatch, props, "offText", ["off_text", "offLabel", "off_label", "falseText", "false_text", "off"]);
    mergeAliasProps(nextPatch, props, "switchActiveTrackColor", ["activeTrackColor", "active_track_color", "trackActiveColor", "trackActiveColor", "activeColor", "onColor", "trackColor"]);
    mergeAliasProps(nextPatch, props, "switchThumbColor", ["thumbColor", "thumb_color"]);
  }
  if (type === "slider") {
    mergeAliasProps(nextPatch, props, "min", ["minimum"], normalizeNumberValue);
    mergeAliasProps(nextPatch, props, "max", ["maximum"], normalizeNumberValue);
    mergeAliasProps(nextPatch, props, "step", ["increment"], normalizeNumberValue);
    mergeAliasProps(nextPatch, props, "sliderRangeColor", ["rangeColor", "range_color", "activeRangeColor", "active_range_color", "activeColor"]);
    mergeAliasProps(nextPatch, props, "sliderThumbColor", ["thumbColor", "thumb_color"]);
    mergeAliasProps(nextPatch, props, "sliderTrackColor", ["trackColor", "track_color"]);
  }
  if (type === "button") {
    mergeAliasProps(nextPatch, props, "variant", ["style", "buttonVariant", "button_variant"]);
    mergeAliasProps(nextPatch, props, "dataActionFlowId", ["data_action_flow_id", "actionFlowId", "action_flow_id", "dataActionId", "data_action_id", "flowId", "flow_id"]);
    mergeAliasProps(nextPatch, props, "dataActionLabel", ["data_action_label", "actionLabel", "action_label", "flowLabel", "flow_label"]);
  }

  if (Object.keys(props).length || nextPatch.props) nextPatch.props = props;
  return nextPatch;
}

// Backwards-compatible local name used by earlier callers/tests.
const normalizeFieldAliasPatch = normalizeAiFieldPatch;

function mergeFieldPatch(field = {}, patch = {}) {
  const normalizedPatch = normalizeFieldAliasPatch(field, patch);
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
    const field = normalizeField(normalizeFieldAliasPatch({}, operation.field || operation));
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
    next.schema.pages = next.schema.pages.map((page) => page.id === id ? { ...page, title: patch.title ?? patch.name ?? page.title, description: patch.description ?? patch.desc ?? patch.helpText ?? page.description, icon: patch.icon ?? patch.pageIcon ?? patch.page_icon ?? page.icon ?? "" } : page);
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
  else if (op === "setFormSchemaOptions") { next.schema = { ...next.schema }; const showNavigationButtons = operation.showNavigationButtons ?? operation.show_navigation_buttons ?? operation.showNavigation ?? operation.show_navigation ?? operation.navigationButtons ?? operation.navigation_buttons ?? operation.showNavButtons ?? operation.show_nav_buttons; if (showNavigationButtons !== undefined) next.schema.showNavigationButtons = Boolean(normalizeBooleanValue(showNavigationButtons)); }
  else throw new Error(`Unsupported form operation: ${op || "unknown"}`);
  return normalizeFormDefinition(next);
}
export function applyFormOperations(form, operations = []) { const result = ensureArray(operations).reduce((acc, op) => applyFormOperation(acc, op), form); const validation = validateFormDefinition(result); return { form: result, validation }; }
export function validateFormOperations(operations = []) { const allowed = new Set(["addField", "updateField", "removeField", "moveField", "addToLayout", "addPage", "updatePage", "removePage", "movePage", "setBinding", "setQueueAssignment", "setDataTargetProposal", "setFormSchemaOptions"]); const errors = []; ensureArray(operations).forEach((op, index) => { const type = op.type || op.op; if (!allowed.has(type)) errors.push({ index, message: `Unsupported operation ${type}` }); }); return { ok: errors.length === 0, errors }; }

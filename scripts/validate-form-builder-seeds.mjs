#!/usr/bin/env node
import { FORM_COMPONENT_REGISTRY, FORM_COMPONENT_TYPES, getFieldChildIds, normalizeFormDefinition, validateFormDefinition } from "../lib/forms/form-schema.js";
import { getFormTemplates, getFormTemplateMediaAssets, getFormDataActionFlows } from "../lib/forms/form-templates.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateTemplate(template) {
  const normalized = normalizeFormDefinition(template);
  const validation = validateFormDefinition(normalized);
  assert(validation.ok, `${template.slug}: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  assert(Array.isArray(normalized.schema?.pages) && normalized.schema.pages.length > 0, `${template.slug}: missing schema.pages`);
  for (const page of normalized.schema.pages) assert(page.icon, `${template.slug}/${page.id}: missing page icon`);
  const fields = normalized.schema.fields || [];
  const variables = new Set();
  for (const field of fields) {
    assert(FORM_COMPONENT_TYPES.includes(field.type), `${template.slug}/${field.id}: unsupported type ${field.type}`);
    assert(!field.bindingPath && !field.binding_path, `${template.slug}/${field.id}: Binding path should not be used`);
    if (FORM_COMPONENT_REGISTRY[field.type]?.data) {
      assert(field.variableName, `${template.slug}/${field.id}: missing variableName`);
      assert(!variables.has(field.variableName), `${template.slug}/${field.id}: duplicate variableName ${field.variableName}`);
      variables.add(field.variableName);
    }
    if (["select", "radio"].includes(field.type)) {
      assert(Array.isArray(field.options), `${template.slug}/${field.id}: options must be an array`);
      for (const option of field.options) assert(typeof option === "object" && option.label && option.value, `${template.slug}/${field.id}: options must be structured objects`);
    }
    if (["image", "hero", "card", "avatar"].includes(field.type) && field.props?.imageScale !== undefined) {
      const scale = Number(field.props.imageScale);
      assert(scale >= 50 && scale <= 200, `${template.slug}/${field.id}: imageScale outside 50-200`);
    }
  }
  const childIds = new Set(fields.flatMap(getFieldChildIds));
  for (const page of normalized.schema.pages) {
    for (const fieldId of page.fields || []) assert(!childIds.has(fieldId), `${template.slug}/${page.id}: nested child ${fieldId} is duplicated as a page root`);
  }
  return { slug: template.slug, name: template.name, fields: fields.length, pages: normalized.schema.pages.length };
}

function validateFlow(flow) {
  const nodes = flow.nodes || [];
  const edges = flow.edges || [];
  const ids = new Set(nodes.map((node) => node.id));
  assert(nodes.some((node) => node.data?.nodeType === "form_submit"), `${flow.id}: missing Form Submit initiator`);
  assert(nodes.some((node) => node.data?.nodeType === "form_submit_status"), `${flow.id}: missing Form Submit Status node`);
  assert(nodes.some((node) => node.data?.nodeType === "data_action"), `${flow.id}: missing Data Action node`);
  assert(nodes.filter((node) => node.data?.nodeType === "form_submit").length === 1, `${flow.id}: expected exactly one Form Submit initiator`);
  for (const edge of edges) {
    assert(ids.has(edge.source), `${flow.id}: edge ${edge.id} has unknown source ${edge.source}`);
    assert(ids.has(edge.target), `${flow.id}: edge ${edge.id} has unknown target ${edge.target}`);
  }
  return { id: flow.id, name: flow.name, nodes: nodes.length, edges: edges.length };
}

const templateResults = getFormTemplates().map(validateTemplate);
const media = getFormTemplateMediaAssets();
const flowResults = getFormDataActionFlows().map(validateFlow);
assert(media.length >= 3, "expected at least 3 seeded media assets");
for (const asset of media) {
  assert(asset.url && asset.filename, `media asset missing url/filename: ${asset.title || asset.filename}`);
  assert(asset.metadata?.formTemplateSeed || asset.metadata?.seed, `${asset.filename}: missing seed metadata`);
}

console.log(JSON.stringify({ ok: true, templates: templateResults, media: media.length, flows: flowResults }, null, 2));

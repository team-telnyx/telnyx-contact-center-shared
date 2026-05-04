import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadFormOperations() {
  // This repo is consumed by Next.js, while package.json is not ESM-typed.
  // Copy the ESM form modules to .mjs files so this lightweight validation can run with plain Node.
  const dir = await mkdtemp(join(tmpdir(), "form-ops-"));
  const schemaSource = await readFile("lib/forms/form-schema.js", "utf8");
  const operationsSource = (await readFile("lib/forms/form-operations.js", "utf8")).replace('"./form-schema.js"', '"./form-schema.mjs"');
  await writeFile(join(dir, "form-schema.mjs"), schemaSource);
  await writeFile(join(dir, "form-operations.mjs"), operationsSource);
  return import(join(dir, "form-operations.mjs"));
}

const { applyFormOperations } = await loadFormOperations();

const baseForm = {
  name: "Validation form",
  slug: "validation-form",
  schema: {
    fields: [
      { id: "first_name", type: "text", label: "First name", variableName: "first_name" },
      { id: "last_name", type: "text", label: "Last name", variableName: "last_name" },
      {
        id: "select_channel",
        type: "radio",
        label: "Select channel",
        variableName: "select_channel",
        options: [
          { label: "Voice", value: "voice" },
          { label: "SMS", value: "sms" },
        ],
        props: { direction: "vertical", dataActionFlowId: "flow_123" },
      },
    ],
    pages: [{ id: "customer_data", title: "Customer Data", fields: ["first_name", "last_name", "select_channel"] }],
  },
  layout: { order: ["first_name", "last_name", "select_channel"] },
};

function apply(operations, form = baseForm) {
  const result = applyFormOperations(form, operations);
  assert.equal(result.validation.ok, true, JSON.stringify(result.validation.errors));
  return result.form;
}
function field(form, id) { return form.schema.fields.find((item) => item.id === id); }

{
  const form = apply([{ type: "addField", pageId: "customer_data", index: 0, field: { id: "hero_top", type: "hero", label: "Hero", props: { title: "Hero" } } }]);
  assert.deepEqual(form.schema.pages[0].fields, ["hero_top", "first_name", "last_name", "select_channel"]);
}

{
  const form = apply([{ type: "moveField", fieldId: "select_channel", index: 0 }]);
  assert.deepEqual(form.schema.pages[0].fields, ["select_channel", "first_name", "last_name"]);
}

{
  const form = apply([{ type: "updateField", fieldId: "select_channel", patch: { props: { direction: "horizontal" } } }]);
  const updated = field(form, "select_channel");
  assert.deepEqual(updated.options.map((option) => option.value), ["voice", "sms"]);
  assert.equal(updated.props.dataActionFlowId, "flow_123");
  assert.equal(updated.props.direction, "horizontal");
}

{
  const form = apply([{ type: "updateField", fieldId: "select_channel", patch: { props: { layout: "horizontal" } } }]);
  const updated = field(form, "select_channel");
  assert.equal(updated.props.direction, "horizontal");
  assert.equal(updated.props.layout, undefined);
}

{
  const form = apply([{ type: "addField", field: { id: "customer_tier", type: "select", label: "Tier", variable: "customer_tier", choices: ["Gold", { name: "Silver", id: "silver" }], default: "silver" } }]);
  const updated = field(form, "customer_tier");
  assert.deepEqual(updated.options.map((option) => [option.label, option.value]), [["Gold", "Gold"], ["Silver", "silver"]]);
  assert.equal(updated.variableName, "customer_tier");
  assert.equal(updated.defaultValue, "silver");
}

{
  const form = apply([{ type: "addField", field: { id: "hero_bg", type: "hero", label: "Hero", backgroundImage: "https://example.com/hero.jpg", background: true, scale: 125, eyebrow: "VIP" } }]);
  const props = field(form, "hero_bg").props;
  assert.equal(props.imageUrl, "https://example.com/hero.jpg");
  assert.equal(props.imageMode, "background");
  assert.equal(props.imageScale, 125);
  assert.equal(props.quote, "VIP");
}

{
  const form = apply([{ type: "addField", field: { id: "agent_avatar", type: "avatar", label: "Agent", imageUrl: "https://example.com/a.png", initials: "AG", shape: "rounded", zoom: 140 } }]);
  const props = field(form, "agent_avatar").props;
  assert.equal(props.src, "https://example.com/a.png");
  assert.equal(props.fallback, "AG");
  assert.equal(props.shape, "rounded");
  assert.equal(props.imageScale, 140);
}

{
  const form = apply([{ type: "addField", field: { id: "badge_alias", type: "badge", label: "VIP", style: "outline", size: "lg", color: "#ff00aa" } }]);
  const props = field(form, "badge_alias").props;
  assert.equal(props.text, "VIP");
  assert.equal(props.variant, "outline");
  assert.equal(props.size, "lg");
  assert.equal(props.color, "#ff00aa");
}

{
  const form = apply([{ type: "addField", field: { id: "faq", type: "accordion", behaviour: "multiple", style: "card", sections: [{ heading: "Q1", body: "A1", open: true }] } }]);
  const props = field(form, "faq").props;
  assert.equal(props.type, "multiple");
  assert.equal(props.collapsible, true);
  assert.equal(props.variant, "card");
  assert.equal(props.items[0].title, "Q1");
  assert.equal(props.items[0].content, "A1");
}

{
  const form = apply([{ type: "addField", field: { id: "score", type: "slider", label: "Score", variableName: "score", minimum: 1, maximum: 10, step: 0.5, rangeColor: "#00f", thumbColor: "#0f0", trackColor: "#ccc", value: 7 } }]);
  const updated = field(form, "score");
  assert.equal(updated.defaultValue, 7);
  assert.equal(updated.props.min, 1);
  assert.equal(updated.props.max, 10);
  assert.equal(updated.props.step, 0.5);
  assert.equal(updated.props.sliderRangeColor, "#00f");
  assert.equal(updated.props.sliderThumbColor, "#0f0");
  assert.equal(updated.props.sliderTrackColor, "#ccc");
}

{
  const form = apply([{ type: "addField", field: { id: "enabled", type: "switch", label: "Enabled", variableName: "enabled", on: "Yes", off: "No", activeTrackColor: "#123456", thumbColor: "#ffffff" } }]);
  const props = field(form, "enabled").props;
  assert.equal(props.onText, "Yes");
  assert.equal(props.offText, "No");
  assert.equal(props.switchActiveTrackColor, "#123456");
  assert.equal(props.switchThumbColor, "#ffffff");
}

{
  const form = apply([{ type: "addField", field: { id: "callback_at", type: "datetime", label: "Callback", variableName: "callback_at", inputMode: "datetime" } }]);
  assert.equal(field(form, "callback_at").props.mode, "datetime-local");
}

{
  const form = apply([{ type: "addField", field: { id: "submit_btn", type: "button", label: "Run", style: "secondary", flowId: "flow_abc", actionLabel: "Run flow" } }]);
  const props = field(form, "submit_btn").props;
  assert.equal(props.variant, "secondary");
  assert.equal(props.dataActionFlowId, "flow_abc");
  assert.equal(props.dataActionLabel, "Run flow");
}

{
  const form = apply([{ type: "addField", field: { id: "grid_alias", type: "grid", rowCount: 3, cols: 4, gridCells: { "0:0": ["first_name"] }, gutter: 20, props: { layoutByChild: { first_name: { alignment: "center", vertical: "bottom", colSpan: 2, row_span: 3 } } } } }]);
  const props = field(form, "grid_alias").props;
  assert.equal(props.rows, 3);
  assert.equal(props.columns, 4);
  assert.equal(props.gap, 20);
  assert.deepEqual(props.cells["0:0"], ["first_name"]);
  assert.equal(props.layoutByChild.first_name.align, "center");
  assert.equal(props.layoutByChild.first_name.verticalAlign, "bottom");
  assert.equal(props.layoutByChild.first_name.columnSpan, 2);
  assert.equal(props.layoutByChild.first_name.rowSpan, 3);
}

{
  const form = apply([{ type: "addField", field: { id: "flex_alias", type: "flex", orientation: "vertical", justifyContent: "center", flexWrap: "off", gap: 8, childIds: ["first_name"] } }]);
  const props = field(form, "flex_alias").props;
  assert.equal(props.direction, "column");
  assert.equal(props.justify, "center");
  assert.equal(props.wrap, false);
  assert.equal(props.gap, 8);
  assert.deepEqual(props.children, ["first_name"]);
}

{
  const form = apply([{ type: "setFormSchemaOptions", showNavigation: "yes" }]);
  assert.equal(form.schema.showNavigationButtons, true);
}

{
  const form = apply([{ type: "addField", field: { id: "code", type: "code_block", label: "Code", content: "console.log(1)", lang: "javascript", lineNumbers: true, max_height: 240 } }]);
  const props = field(form, "code").props;
  assert.equal(field(form, "code").type, "codeblock");
  assert.equal(props.code, "console.log(1)");
  assert.equal(props.language, "javascript");
  assert.equal(props.showLineNumbers, true);
  assert.equal(props.maxHeight, 240);
}

{
  const form = apply([{ type: "addField", field: { id: "ctx", type: "context_value", label: "Caller", path: "caller.from_number" } }]);
  assert.equal(field(form, "ctx").contextPath, "caller.from_number");
}

console.log("form operations validation passed");

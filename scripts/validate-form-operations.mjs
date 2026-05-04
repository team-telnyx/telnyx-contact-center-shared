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

{
  const { form, validation } = applyFormOperations(baseForm, [
    { type: "addField", pageId: "customer_data", index: 0, field: { id: "hero_top", type: "hero", label: "Hero", props: { title: "Hero" } } },
  ]);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.deepEqual(form.schema.pages[0].fields, ["hero_top", "first_name", "last_name", "select_channel"]);
}

{
  const { form, validation } = applyFormOperations(baseForm, [
    { type: "moveField", fieldId: "select_channel", index: 0 },
  ]);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.deepEqual(form.schema.pages[0].fields, ["select_channel", "first_name", "last_name"]);
}

{
  const { form, validation } = applyFormOperations(baseForm, [
    { type: "updateField", fieldId: "select_channel", patch: { props: { direction: "horizontal" } } },
  ]);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const field = form.schema.fields.find((item) => item.id === "select_channel");
  assert.deepEqual(field.options.map((option) => option.value), ["voice", "sms"]);
  assert.equal(field.props.dataActionFlowId, "flow_123");
  assert.equal(field.props.direction, "horizontal");
}

{
  const { form, validation } = applyFormOperations(baseForm, [
    { type: "updateField", fieldId: "select_channel", patch: { props: { layout: "horizontal" } } },
  ]);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const field = form.schema.fields.find((item) => item.id === "select_channel");
  assert.equal(field.props.direction, "horizontal");
  assert.equal(field.props.layout, undefined);
}

console.log("form operations validation passed");

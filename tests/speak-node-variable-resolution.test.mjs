import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  getAllVariableNames,
  replaceTemplateVariables,
} from "../lib/variable-utils.js";

function flowWithOutboundPayloadVariable(payloadVariable = "contact_data") {
  return {
    globalVariables: {},
    edges: [],
    nodes: [
      {
        id: "outbound",
        data: {
          nodeType: "outbound_campaign",
          config: { payloadVariable },
        },
      },
      {
        id: "speak",
        data: {
          nodeType: "speak",
          config: {
            payload:
              "Welcome to Contact Center Services {{contact_data.first_name}}!",
          },
        },
      },
    ],
  };
}

test("Speak node TTS payload resolves {{contact_data.first_name}} before Telnyx speak command", () => {
  const payload = replaceTemplateVariables(
    "Welcome to Contact Center Services {{contact_data.first_name}}! Please wait.",
    {
      contact_data: { first_name: "Leszek" },
    },
  );

  assert.equal(
    payload,
    "Welcome to Contact Center Services Leszek! Please wait.",
  );
});

test("contact_data remains a compatibility alias for outbound contact_record payloads", () => {
  const payload = replaceTemplateVariables("Hi {{contact_data.first_name}}", {
    contact_record: { first_name: "Ada" },
  });

  assert.equal(payload, "Hi Ada");
});

test("Speak node variable picker exposes outbound contact_data dotted fields", () => {
  const variables = getAllVariableNames(flowWithOutboundPayloadVariable("contact_data"));

  assert.ok(variables.includes("contact_data"));
  assert.ok(variables.includes("contact_data.first_name"));
  assert.ok(variables.includes("contact_data.last_name"));
});

test("Speak editor uses VariableTextarea so typing {{ opens variable suggestions", async () => {
  const source = await readFile(
    new URL("../components/voice-flow/SpeakNodeEditor.jsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /<VariableTextarea/);
  assert.match(source, /availableVariables=\{availableVariables\}/);
});

test("VariableTextarea opens picker immediately after bare {{ with provided variables", async () => {
  const source = await readFile(
    new URL("../components/voice-flow/VariableTextarea.jsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /lastOpenBraces !== -1/);
  assert.match(source, /setShowPicker\(true\)/);
  assert.match(source, /filteredVars\.length > 0/);
});

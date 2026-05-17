import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageSourcePromise = readFile(
  new URL("../app/(portal)/admin/call-flows/page.jsx", import.meta.url),
  "utf8"
);

test("call flows list recognizes outbound campaign as an initiator", async () => {
  const source = await pageSourcePromise;
  const initiatorFindBlock = source.slice(
    source.indexOf("const initiatorNode = Array.isArray(flow.nodes)"),
    source.indexOf("if (!initiatorNode)")
  );

  assert.match(
    initiatorFindBlock,
    /node\.data\?\.nodeType === "outbound_campaign"/,
    "outbound campaign nodes should not fall through to the None initiator badge"
  );
  assert.match(source, /initiatorType === "outbound_campaign"[\s\S]*Outbound Campaign/, "outbound campaigns should render an explicit badge label");
});

test("call flows initiator badges use distinct colors per initiator", async () => {
  const source = await pageSourcePromise;
  const colorExpectations = {
    incoming_call: "bg-sky-500/10",
    http_request: "bg-orange-500/10",
    form_submit: "bg-violet-500/10",
    outbound_campaign: "bg-emerald-500/10",
  };

  for (const [initiatorType, colorClass] of Object.entries(colorExpectations)) {
    assert.match(
      source,
      new RegExp(`initiatorType === "${initiatorType}"[\\s\\S]*${colorClass.replaceAll("/", "\\/")}`),
      `${initiatorType} should use the ${colorClass} badge color`
    );
  }
});

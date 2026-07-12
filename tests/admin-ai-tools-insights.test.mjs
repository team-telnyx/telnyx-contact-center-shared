import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("AI Assistants rail places Tools Library and Insights directly after AI Assistants", async () => {
  const menu = await readFile(new URL("config/menu.jsx", root), "utf8");
  const rail = await readFile(new URL("components/assistants/AiAssistantsSectionNav.jsx", root), "utf8");
  assert.match(
    rail,
    /label: "AI Assistants"[\s\S]*?label: "Tools Library"[\s\S]*?label: "Insights"/
  );
  assert.match(menu, /title: "AI Assistants"/);
  assert.match(rail, /href: "\/admin\/tools-library"/);
  assert.match(rail, /href: "\/admin\/insights"/);
});

test("Tools Library includes the demo portal management and sheet workflows", async () => {
  const page = await readFile(new URL("app/(portal)/admin/tools-library/page.jsx", root), "utf8");
  const editor = await readFile(new URL("components/tools/ToolEditSheet.jsx", root), "utf8");
  for (const feature of ["New Tool", "Assign to assistants", "WebhookTestSheet", "Delete Tool", "Rows per page"]) {
    assert.match(page, new RegExp(feature));
  }
  for (const toolType of ["WebhookToolEditor", "HangupToolEditor", "TransferToolEditor", "HandoffToolEditor", "SendMessageToolEditor", "InviteToolEditor", "ReferToolEditor", "DTMFToolEditor", "RetrievalToolEditor", "SkipTurnToolEditor"]) {
    assert.match(editor, new RegExp(toolType));
  }
});

test("Insights includes insight and group editors with assignment APIs", async () => {
  const page = await readFile(new URL("app/(portal)/admin/insights/page.jsx", root), "utf8");
  assert.match(page, /title="Insights"/);
  assert.match(page, /function InsightEditor/);
  assert.match(page, /function GroupEditor/);
  assert.match(page, /buildJsonSchema/);
  assert.match(page, /insights\/\$\{encodeURIComponent\(id\)\}\/assign/);
  assert.match(page, /insights\/\$\{encodeURIComponent\(id\)\}\/unassign/);

  const collection = await readFile(new URL("app/api/ai/conversations/insight-groups/route.js", root), "utf8");
  const item = await readFile(new URL("app/api/ai/conversations/insight-groups/[id]/route.js", root), "utf8");
  const assign = await readFile(new URL("app/api/ai/conversations/insight-groups/[id]/insights/[insightId]/assign/route.js", root), "utf8");
  const unassign = await readFile(new URL("app/api/ai/conversations/insight-groups/[id]/insights/[insightId]/unassign/route.js", root), "utf8");
  assert.match(collection, /export async function POST/);
  assert.match(item, /export async function PUT/);
  assert.match(item, /export async function DELETE/);
  assert.match(assign, /export async function POST/);
  assert.match(unassign, /export async function DELETE/);
});

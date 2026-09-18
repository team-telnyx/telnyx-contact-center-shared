import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("the workflow item editor exposes an MCP binding editor for slot items", async () => {
  const page = await read("app/(portal)/admin/workflows/[id]/page.jsx");

  assert.match(page, /import SlotMcpBindingEditor from "@\/components\/admin\/SlotMcpBindingEditor"/);
  assert.match(page, /<SlotMcpBindingEditor/);
  // Bindings only make sense on slots; other item types must not send one.
  assert.match(page, /mcp_binding: form\.type === "slot" \? form\.mcp_binding : null/);
});

test("the binding survives the form round trip", async () => {
  const page = await read("app/(portal)/admin/workflows/[id]/page.jsx");

  // Loaded into form state, reset when a different item is selected, and
  // compared for unsaved changes - otherwise Save stays disabled after editing
  // only the binding.
  assert.match(page, /mcp_binding: item\.mcp_binding \|\| null/);
  assert.match(page, /JSON\.stringify\(form\.mcp_binding \?\? null\) !== JSON\.stringify\(item\.mcp_binding \?\? null\)/);
});

test("the binding editor drives server and tool selection from the MCP registry", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  assert.match(editor, /\/api\/admin\/mcp-servers\?page=1&pageSize=100/);
  assert.match(editor, /\/api\/admin\/mcp-servers\/\$\{encodeURIComponent\(serverId\)\}\/tools/);
  // Every trigger the runner supports must be reachable from the UI.
  for (const trigger of ["on_fill", "on_result", "on_complete", "manual_submit"]) {
    assert.ok(editor.includes(`"${trigger}"`), `trigger ${trigger} must be selectable`);
  }
});

test("the editor omits systemId, which the server injects", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  // Seeding it into the argument rows would invite an admin to override the
  // value that DEFAULT_TOOL_ARGUMENTS guarantees.
  assert.match(editor, /if \(name === "systemId"\) continue;/);
});

test("argument values keep their JSON type", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  // the reference workflow rejects "false" where it expects false, and the lookup flags in the
  // integration samples are booleans.
  assert.match(editor, /raw === "true" \|\| raw === "false"/);
});

test("the editor exposes repeat behaviour and defaults submit triggers to once", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  assert.match(editor, /once_per_session/);
  assert.match(editor, /on_argument_change/);
  assert.match(editor, /\["on_complete", "manual_submit"\]\.includes\(binding\?\.trigger\) \? "once_per_session"/);
  assert.match(editor, /trigger === "manual_submit" \? \{ execution_policy: "once_per_session" \}/);
});

test("add argument and add output keep blank draft rows visible while typing", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  // fromRows intentionally omits empty keys, so the row editor needs local
  // draft state or a freshly-added blank row disappears immediately.
  assert.match(editor, /const \[draftRows, setDraftRows\] = useState\(rows\)/);
  assert.match(editor, /setDraftRows\(\(current\) => \[\.\.\.current, \{ key: "", value: "" \}\]\)/);
  assert.match(editor, /const updateRows = \(next\) => \{/);
  assert.match(editor, /setDraftRows\(next\);\s*onChange\(next\);/);
});

// Codex review on #1375: KeyValueRows' draftRows state survives switching to
// a DIFFERENT workflow item, because ItemEditor/SlotMcpBindingEditor/
// KeyValueRows are all rendered without a key that changes on item switch.
// The draft-vs-committed equality check in the reconciliation effect can't
// tell "same item, unrelated re-render" apart from "different item whose
// committed rows also happen to be []" — so a stale draft (a value typed
// before its key) leaks into the newly-selected item, and completing its key
// commits that value to the WRONG binding.
//
// Round 2 (same PR): slotName is the wrong remount key on two counts —
// it's live-edited on every keystroke while renaming a slot (remounting
// mid-type and discarding an in-progress draft row), and slot_name only has
// a non-unique DB index, so two items sharing a name would never remount at
// all. itemId (the item's DB primary key) is stable and unique. server_id/
// tool_name are folded in too because selecting a different server/tool
// resets arguments/outputs to {} WITHIN the same item — the same "both sides
// are []" blind spot the effect has for item switches applies there too.
test("the argument and output row editors remount on a real item, server, or tool switch, not just a re-render", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  assert.match(
    editor,
    /const rowEditorKey = `\$\{itemId \?\? ""\}:\$\{serverId\}:\$\{toolName\}`;/,
  );
  assert.match(
    editor,
    /<KeyValueRows key=\{rowEditorKey\} rows=\{argumentRows\}/,
  );
  assert.match(
    editor,
    /<KeyValueRows key=\{rowEditorKey\} rows=\{outputRows\}/,
  );
  // The old, too-narrow key must be gone.
  assert.doesNotMatch(editor, /<KeyValueRows key=\{slotName\}/);
});

test("the workflow item editor passes the item's stable id into the binding editor", async () => {
  const page = await read("app/(portal)/admin/workflows/[id]/page.jsx");
  assert.match(page, /<SlotMcpBindingEditor[\s\S]{0,200}itemId=\{item\.id\}/);
});

test("the editor makes MCP write ownership explicit through output mappings", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");
  assert.match(editor, /MCP writes only the slot names listed on the left/);
  assert.match(editor, /other slots remain conversation\/LLM-driven/);
  assert.match(editor, /Leave target blank to display choices on this binding's item while writing only the declared output mappings/);
});

test("the server dropdown reads the field the API actually returns", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");
  const route = await read("app/api/admin/mcp-servers/route.js");

  // GET /api/admin/mcp-servers responds { ok, rows, count }. Reading `servers`
  // yields an empty dropdown and no way to configure a binding at all - and a
  // test that only asserts the URL would never notice.
  assert.match(route, /NextResponse\.json\(\{ ok: true, rows/);
  assert.match(editor, /Array\.isArray\(data\.rows\) \? data\.rows : \[\]/);
  assert.ok(!/data\.servers/.test(editor), "must not read a field the API does not return");
});

test("result keys default to something slot-specific", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  // Pickup and dropoff both use lookup_addresses; results and candidates are
  // keyed only by result_key, so a tool-name default makes one overwrite the
  // other and leaves on_result unable to tell the legs apart.
  assert.match(editor, /\$\{slotName\}_\$\{nextToolName\}/);
});

test("a schema-declared string argument is not coerced to a number", async () => {
  const editor = await read("components/admin/SlotMcpBindingEditor.jsx");

  // the reference workflow ids look numeric but are strings (facilityId "1562", contractId "10"),
  // and callMcpTool validates against the schema before invoking.
  assert.match(editor, /const declared = schemaProperties\?\.\[key\]\?\.type;/);
  // `includes`, not `startsWith`: a template can be embedded in surrounding
  // text ("facility-{{slots.id}}"), and that is still a template rather than a
  // numeric literal to coerce.
  assert.match(editor, /if \(declared === "string" \|\| raw\.includes\("\{\{"\)\)/);
});

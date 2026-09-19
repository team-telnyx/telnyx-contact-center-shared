import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Reported live: the read-back suggestion card wraps its text in literal
// quote marks ("{suggestion.text}") — fine for a single spoken line, but the
// read-back's new multi-line "Title: value" list (see
// buildTransportReadBack in lib/agent-assist/readback.mjs) put a stray quote
// mark at the start of the first line and the end of the last line, breaking
// the fixed left/right alignment of the list.

test("suggestion text is only wrapped in quote marks when it's a single line; a multi-line suggestion renders unquoted so its alignment isn't broken", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.doesNotMatch(source, /\n\s*"\{suggestion\.text\}"\s*\n/);
  assert.match(
    source,
    /\{suggestion\.text\?\.includes\("\\n"\) \? suggestion\.text : `"\$\{suggestion\.text\}"`\}/
  );
});

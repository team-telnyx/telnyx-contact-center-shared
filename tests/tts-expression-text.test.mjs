import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTtsExpressionText,
  stripTtsExpressionTags,
} from "../lib/ai/tts-expression-text.mjs";

test("TTS expression tags become labelled badges and are stripped from subtitles", () => {
  const text =
    'Great, thank you! <break time="0.3s" /> Do you use <emotion value="warm">electricity</emotion> or gas? [laughter]';
  const parts = parseTtsExpressionText(text);
  assert.deepEqual(
    parts.map((part) => (part.type === "text" ? part.value : `<${part.kind}:${part.label}>`)),
    [
      "Great, thank you! ",
      "<break:0.3s pause>",
      " Do you use ",
      "<emotion:warm>",
      "electricity",
      " or gas? ",
      "<laughter:laughter>",
    ]
  );
  assert.equal(
    stripTtsExpressionTags(text),
    "Great, thank you!  Do you use electricity or gas?"
  );
  assert.equal(stripTtsExpressionTags("<break/>plain"), "plain");
  assert.equal(parseTtsExpressionText("no tags").length, 1);
});

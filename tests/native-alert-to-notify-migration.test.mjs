// Guards the project convention that user-facing notifications use the custom
// `notify` toast (from @/components/ToastNotify), never the native window.alert
// / alert(). Covers the files migrated away from native alert().

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function readCode(rel) {
  const src = readFileSync(join(repoRoot, rel), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return { src, code };
}

const FILES = [
  "components/site-header.jsx",
  "components/voice-flow/EdgeVariableMapper.jsx",
  "components/contact-center/AgentDesktop.jsx",
  "components/contact-center/QueueActivationPanel.jsx",
  "components/contact-center/TransferModal.jsx",
  "components/contact-center/CampaignActivationSelector.jsx",
];

for (const rel of FILES) {
  test(`${rel} uses notify, not native alert()`, () => {
    const { src, code } = readCode(rel);
    assert.ok(!/window\.alert\s*\(/.test(code), "no window.alert");
    assert.ok(!/(^|[^.\w])alert\s*\(/.test(code), "no bare alert()");
    assert.ok(
      /from\s+["']@\/components\/ToastNotify["']/.test(src),
      "should import notify from ToastNotify",
    );
    assert.ok(/notify\s*\(/.test(src), "should call notify()");
  });
}

test("repo-wide: no native alert() remains in migrated component set", () => {
  for (const rel of FILES) {
    const { code } = readCode(rel);
    const matches = code.match(/(^|[^.\w])alert\s*\(/g) || [];
    assert.equal(matches.length, 0, `${rel} still has ${matches.length} alert() call(s)`);
  }
});

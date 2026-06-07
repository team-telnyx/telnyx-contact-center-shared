import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import test from "node:test";

const trackedJs = execFileSync("git", ["ls-files", "*.js"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

function isClientish(file, src) {
  const firstLines = src.split("\n").slice(0, 5).join("\n");
  return firstLines.includes("use client")
    || file.startsWith("hooks/")
    || file.startsWith("components/")
    || file.startsWith("lib/stores/")
    || file === "lib/color-utils.js"
    || file === "lib/expression-engine.js"
    || file === "proxy.js";
}

test("Remaining server-side tracked JS files do not use legacy console diagnostics", async () => {
  const offenders = [];
  for (const file of trackedJs) {
    const src = await readFile(file, "utf8");
    if (isClientish(file, src)) continue;
    if (/\bconsole\.(log|warn|error|info|debug)\b/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("Runtime logging helper exposes approved fallback topic loggers", async () => {
  const src = await readFile("lib/runtime-logging.mjs", "utf8");
  for (const topic of ["platform.api", "platform.db", "contact-center.interactions", "voice.flow", "security.admin"]) {
    assert.match(src, new RegExp(`createDiagnosticLogger\\(\\s*["']${topic.replace(".", "\\.")}["']\\s*\\)`));
  }
});

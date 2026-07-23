import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const proxyPath = new URL("../proxy.js", import.meta.url);

test("production CORS has no placeholder origins or wildcard preflight", async () => {
  const source = await readFile(proxyPath, "utf8");

  assert.doesNotMatch(source, /cc\.domain\.com|app\.domain\.com/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin", "\*"/);
  assert.match(source, /process\.env\.NODE_ENV === "production"[\s\S]*\? \[\]/);
  assert.match(source, /origin && !isAllowedOrigin[\s\S]*status: 403/);
});

test("proxy matcher includes API routes so CORS policy is actually applied", async () => {
  const source = await readFile(proxyPath, "utf8");
  const matcher = source.match(/matcher:\s*\[([\s\S]*?)\]/)?.[1] || "";
  assert.doesNotMatch(matcher, /\(\?!api\|/);
});

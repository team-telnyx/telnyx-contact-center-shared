import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("System menu opens the dashboard directly", async () => {
  const menu = await read("config/menu.jsx");

  assert.match(
    menu,
    /title: "System",[\s\S]*?url: "\/admin\/system\/dashboard"/,
  );
});

test("legacy System landing page redirects to the dashboard", async () => {
  const page = await read("app/(portal)/admin/system/page.jsx");

  assert.match(page, /redirect\("\/admin\/system\/dashboard"\)/);
  assert.doesNotMatch(page, /System administration|visibleSystemItems/);
});

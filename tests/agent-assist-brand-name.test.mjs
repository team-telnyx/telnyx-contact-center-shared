import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("generate-suggestion resolves brand from app_settings.brand_name when client sends none", async () => {
  const route = await read("../app/api/agent-assist/workflow/generate-suggestion/route.js");
  // Helper reads the global brand.
  assert.match(route, /SELECT brand_name FROM app_settings WHERE id = 'default'/);
  // Effective brand = client brandName || configured global brand.
  assert.match(route, /const effectiveBrandName =/);
  assert.match(route, /await getConfiguredBrandName\(pool\)/);
  // Builders receive the resolved brand, not the raw (empty) client value.
  const usesEffective = route.match(/brandName: effectiveBrandName/g) || [];
  assert.ok(usesEffective.length >= 3, "all three builder calls use effectiveBrandName");
});

test("app_settings schema + API carry brand_name", async () => {
  const schema = await read("../lib/postgres-schema.mjs");
  assert.match(schema, /brand_name TEXT/);
  assert.match(schema, /ALTER TABLE app_settings ADD COLUMN brand_name TEXT/);
  const api = await read("../app/api/app-settings/route.js");
  assert.match(api, /brandName: settings\.brand_name \|\| null/);
  assert.match(api, /brand_name = \$8/);          // UPDATE writes it
  assert.match(api, /brand_name\s*\n\s*\) VALUES/);// INSERT column list includes it
});

test("settings PUT preserves the brand when the payload omits brandName (Codex #1184)", async () => {
  const api = await read("../app/api/app-settings/route.js");
  // Reads the current brand and keeps it when brandName is undefined (colors/logos save).
  assert.match(api, /SELECT id, brand_name FROM app_settings/);
  assert.match(api, /const existingBrandName = checkResult\.rows\[0\]\?\.brand_name/);
  assert.match(api, /brandName === undefined\s*\n\s*\? existingBrandName/);
});

test("admin Settings page has a Brand/Company Name field wired to the API", async () => {
  const page = await read("../app/(portal)/settings/page.jsx");
  // State + load + save + input.
  assert.match(page, /const \[brandName, setBrandName\] = useState\(""\)/);
  assert.match(page, /setBrandName\(data\.brandName \|\| ""\)/);
  // Included in the save PUT body ONLY when the field changed (else omitted so
  // the API preserves a concurrently-changed DB brand).
  assert.match(page, /\.\.\.\(brandName !== lastSavedBrandNameRef\.current \? \{ brandName \} : \{\}\)/);
  assert.match(page, /Brand \/ Company Name/);
  assert.match(page, /id="brand-name"/);
  assert.match(page, /placeholder="e\.g\. Global Medical Response"/);
});

test("Reset to Defaults PRESERVES the brand and restores the field (Codex #1187: no wipe, no stale)", async () => {
  const page = await read("../app/(portal)/settings/page.jsx");
  // Tracks the last-saved brand and refreshes it on load + save.
  assert.match(page, /const lastSavedBrandNameRef = useRef\(""\)/);
  assert.match(page, /lastSavedBrandNameRef\.current = data\.brandName \|\| ""/);
  assert.match(page, /lastSavedBrandNameRef\.current = brandName;/);
  // Reset restores the field to the saved value (discards a pending edit) instead of clearing it.
  assert.match(page, /setBrandName\(lastSavedBrandNameRef\.current\);/);
  // Reset PUT does NOT send a brandName KEY (omitted -> API preserves it in the DB).
  const resetBody = page.slice(page.indexOf("Save complete defaults to database"), page.indexOf("Save complete defaults to database") + 500);
  assert.doesNotMatch(resetBody, /brandName:/);
});

test("settings PUT self-heals a missing brand_name column BEFORE selecting/writing it (Codex)", async () => {
  const api = await read("../app/api/app-settings/route.js");
  assert.match(api, /ALTER TABLE app_settings ADD COLUMN brand_name TEXT/);
  // The inline column guard must run before the SELECT id, brand_name.
  const idxGuard = api.indexOf("ADD COLUMN brand_name TEXT");
  const idxSelect = api.indexOf("SELECT id, brand_name FROM app_settings");
  assert.ok(idxGuard > 0 && idxSelect > 0 && idxGuard < idxSelect, "brand_name column guard precedes the SELECT");
});

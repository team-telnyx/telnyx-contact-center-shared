import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const ignoredDirs = new Set([".git", ".next", "node_modules"]);
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".md"]);

async function walk(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if ([...sourceExtensions].some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

test("project does not import or depend on sonner", async () => {
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const yarnLock = await readFile(new URL("../yarn.lock", import.meta.url), "utf8");
  const packageLock = await readFile(new URL("../package-lock.json", import.meta.url), "utf8");
  assert.doesNotMatch(packageJson, /"sonner"\s*:/, "package.json should not depend on sonner");
  assert.doesNotMatch(yarnLock, /sonner@|sonner:/, "yarn.lock should not resolve sonner");
  assert.doesNotMatch(packageLock, /"sonner"\s*:|node_modules\/sonner/, "package-lock.json should not resolve sonner");

  const files = await walk(root);
  const offenders = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (rel === "tests/no-sonner-toast.test.mjs") continue;
    const source = await readFile(file, "utf8");
    if (/from ["']sonner["']|@\/components\/ui\/sonner/.test(source)) {
      offenders.push(rel);
    }
  }

  assert.deepEqual(offenders, [], `Do not import sonner directly: ${offenders.join(", ")}`);
});

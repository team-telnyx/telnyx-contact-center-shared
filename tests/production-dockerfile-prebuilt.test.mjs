import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const dockerfile = await readFile(new URL("../docker/production/Dockerfile", import.meta.url), "utf8");

test("production Docker image is built before container startup", () => {
  assert.match(
    dockerfile,
    /RUN\s+(?:[^\n]*&&\s*)?yarn build\b/,
    "Docker build must produce the Next.js production build at image-build time",
  );
});

test("production startup script does not rebuild Next.js", () => {
  const startupScript = dockerfile.match(/RUN echo '([\s\S]*?)' > \/app\/start-prod\.sh/)?.[1] ?? "";

  assert.ok(startupScript.includes("node scripts/ensure-pg.mjs"), "startup should still run DB/schema initialization");
  assert.ok(startupScript.includes("exec yarn start"), "startup should still launch the prebuilt app");
  assert.doesNotMatch(startupScript, /yarn build\b/, "startup must not rebuild Next.js during rolling deploys");
  assert.doesNotMatch(startupScript, /Building application with database connection available/, "startup log must not imply runtime builds");
});

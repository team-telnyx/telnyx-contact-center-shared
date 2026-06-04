import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const jwtPath = new URL("../lib/jwt.js", import.meta.url);

test("JWT signing secrets fall back to NEXTAUTH_SECRET when JWT-specific env vars are absent", async () => {
  const src = await readFile(jwtPath, "utf8");

  assert.match(
    src,
    /process\.env\.ACCESS_JWT_SECRET\s*\|\|\s*process\.env\.JWT_SECRET\s*\|\|\s*process\.env\.NEXTAUTH_SECRET/,
    "access token signing must not use a zero-length key when only NEXTAUTH_SECRET is configured",
  );
  assert.match(
    src,
    /process\.env\.REFRESH_JWT_SECRET\s*\|\|\s*process\.env\.JWT_SECRET\s*\|\|\s*process\.env\.NEXTAUTH_SECRET/,
    "refresh token signing must not use a zero-length key when only NEXTAUTH_SECRET is configured",
  );
});

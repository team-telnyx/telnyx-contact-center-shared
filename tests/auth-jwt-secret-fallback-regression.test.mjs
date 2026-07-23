import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveJwtSecrets,
  validateJwtSecrets,
} from "../lib/jwt-secrets.mjs";

test("JWT signing secrets fall back to NEXTAUTH_SECRET when JWT-specific env vars are absent", async () => {
  const nextAuthSecret = "n".repeat(32);
  assert.deepEqual(resolveJwtSecrets({ NEXTAUTH_SECRET: nextAuthSecret }), {
    nextAuthSecret,
    accessSecret: nextAuthSecret,
    refreshSecret: nextAuthSecret,
  });
});

test("JWT-specific signing secrets stay independent", () => {
  const nextAuthSecret = "n".repeat(32);
  const accessSecret = "a".repeat(32);
  const refreshSecret = "r".repeat(32);
  assert.deepEqual(
    validateJwtSecrets({
      NEXTAUTH_SECRET: nextAuthSecret,
      ACCESS_JWT_SECRET: accessSecret,
      REFRESH_JWT_SECRET: refreshSecret,
    }),
    { nextAuthSecret, accessSecret, refreshSecret },
  );
});

test("missing or weak authentication secrets fail with a clear error", () => {
  assert.throws(
    () => validateJwtSecrets({}),
    /Authentication secrets are missing or shorter than 32 characters/,
  );
  assert.throws(
    () => validateJwtSecrets({ NEXTAUTH_SECRET: "too-short" }),
    /nextAuthSecret, accessSecret, refreshSecret/,
  );
});

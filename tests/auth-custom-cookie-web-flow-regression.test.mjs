import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const authServerPath = new URL("../lib/auth-server.js", import.meta.url);
const loginFormPath = new URL("../components/login-form.jsx", import.meta.url);

test("getAuthenticatedUser accepts the custom session cookie used by /api/auth/signin", async () => {
  const src = await readFile(authServerPath, "utf8");

  assert.match(src, /import\s+\{\s*headers\s*,\s*cookies\s*\}\s+from\s+"next\/headers"/);
  assert.match(src, /cookies\(\)/);
  assert.match(src, /get\("session"\)/);
  assert.match(src, /verifyAccessToken\(token\)/);
});

test("credentials login form uses the custom app auth endpoint that issues compatible cookies", async () => {
  const src = await readFile(loginFormPath, "utf8");

  assert.match(src, /fetch\("\/api\/auth\/signin"/);
  assert.doesNotMatch(src, /signIn\("credentials"/);
  assert.match(src, /credentials:\s*"include"/);
});

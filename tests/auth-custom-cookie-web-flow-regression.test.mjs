import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const authServerPath = new URL("../lib/auth-server.js", import.meta.url);
const loginFormPath = new URL("../components/login-form.jsx", import.meta.url);
const proxyPath = new URL("../proxy.js", import.meta.url);
const dashboardStatsPath = new URL("../app/api/dashboard/stats/route.js", import.meta.url);
const ccStatsAgentsPath = new URL("../app/api/contact-center/stats/agents/route.js", import.meta.url);
const ccStatsQueuesPath = new URL("../app/api/contact-center/stats/queues/route.js", import.meta.url);

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

test("route proxy accepts custom session cookie before falling back to NextAuth", async () => {
  const src = await readFile(proxyPath, "utf8");

  assert.match(src, /import\s+\{\s*verifyAccessToken\s*\}\s+from\s+"\.\/lib\/jwt"/);
  assert.match(src, /request\.cookies\.get\("session"\)/);
  assert.match(src, /verifyAccessToken\(customSessionCookie\?\.value\)/);
  assert.match(src, /if\s*\(customSessionPayload\?\.sub\)\s*\{\s*return\s+NextResponse\.next\(\);\s*\}/s);

  const customSessionCheckIndex = src.indexOf('request.cookies.get("session")');
  const nextAuthFallbackIndex = src.indexOf("return withAuth(");
  assert.ok(customSessionCheckIndex >= 0, "custom session cookie check must exist");
  assert.ok(nextAuthFallbackIndex >= 0, "NextAuth fallback must still exist");
  assert.ok(
    customSessionCheckIndex < nextAuthFallbackIndex,
    "custom session cookie must be accepted before NextAuth redirects protected routes"
  );
});

test("dashboard and contact-center stats APIs use the shared custom-cookie auth bridge", async () => {
  for (const routePath of [dashboardStatsPath, ccStatsAgentsPath, ccStatsQueuesPath]) {
    const src = await readFile(routePath, "utf8");

    assert.match(src, /getAuthenticatedUser/);
    assert.doesNotMatch(src, /getServerSession\(authOptions\)/);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertPublicHostname,
  isBlockedOutboundAddress,
} from "../lib/security/outbound-url.mjs";

const root = new URL("../", import.meta.url);

test("outbound webhook address checks block private and reserved ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.10",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedOutboundAddress(address), true, address);
  }

  assert.equal(isBlockedOutboundAddress("93.184.216.34"), false);
  assert.equal(isBlockedOutboundAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("outbound webhook hostname checks reject local names and private DNS answers", async () => {
  await assert.rejects(() => assertPublicHostname("localhost"), /not publicly routable/);
  await assert.rejects(
    () =>
      assertPublicHostname("metadata.example", {
        lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    /private or reserved/
  );
  await assert.rejects(
    () =>
      assertPublicHostname("mixed.example", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.2", family: 4 },
        ],
      }),
    /private or reserved/
  );
});

test("outbound webhook hostname checks allow public DNS answers", async () => {
  await assert.doesNotReject(() =>
    assertPublicHostname("webhook.example", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    })
  );
});

test("dynamic variables webhook tester requires admin auth and a server allowlist", async () => {
  const source = await readFile(
    new URL("app/api/assistants/test-dynamic-variables/route.js", root),
    "utf8"
  );

  assert.match(source, /getAuthenticatedUser/);
  assert.match(source, /isAdmin\(user\)/);
  assert.match(source, /DYNAMIC_VARIABLE_WEBHOOK_TEST_ALLOWED_URLS/);
  assert.match(source, /allowedUrl === targetUrl\.toString\(\)/);
  assert.match(source, /fetch\(configuredTarget,/);
  assert.doesNotMatch(source, /fetch\(targetUrl(?:\.toString\(\))?,/);
  assert.match(source, /assertPublicHostname\(targetHostname\)/);
  assert.match(source, /redirect: "error"/);
  assert.doesNotMatch(source, /fetch\(url,/);
});

test("webhook URL templates do not replace an id placeholder with itself", async () => {
  const paths = [
    "app/api/assistants/webhook-configs/route.js",
    "components/assistants/IntegrationsTab.jsx",
    "config/demo-entities.js",
  ];
  const sources = await Promise.all(
    paths.map((path) => readFile(new URL(path, root), "utf8"))
  );

  for (const [index, source] of sources.entries()) {
    assert.doesNotMatch(source, /\.replace\(["']\{id\}["'],\s*["']\{id\}["']\)/, paths[index]);
  }
});

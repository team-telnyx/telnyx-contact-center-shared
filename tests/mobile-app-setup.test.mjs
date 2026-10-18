import assert from "node:assert/strict";
import test from "node:test";
import { imageSize } from "image-size";
import {
  buildMobileAppSetup,
  createMobileSetupQrPng,
  MOBILE_SETUP_QR_OPTIONS,
  resolveMobileAppBaseUrl,
} from "../lib/mobile-app-setup.mjs";

test("mobile setup link uses the configured HTTPS host and encoded organization name", () => {
  const setup = buildMobileAppSetup({
    baseUrl: "https://CC.Acme.com:8443/",
    organizationName: "Acme Support & Sales",
  });

  assert.equal(setup.address, "cc.acme.com:8443");
  assert.equal(
    setup.setupLink,
    "novumcx-telnyx://setup?host=cc.acme.com:8443&name=Acme%20Support%20%26%20Sales",
  );
  assert.equal(new URL(setup.setupLink).searchParams.get("host"), "cc.acme.com:8443");
  assert.equal(new URL(setup.setupLink).searchParams.get("name"), "Acme Support & Sales");
});

test("development HTTP instances keep the full origin in the host parameter", () => {
  const setup = buildMobileAppSetup({
    baseUrl: "http://10.0.0.5:3000/",
    organizationName: "Local CC",
  });

  assert.equal(setup.address, "http://10.0.0.5:3000");
  assert.equal(new URL(setup.setupLink).searchParams.get("host"), "http://10.0.0.5:3000");
});

test("public URL resolution rejects unsupported path-prefix deployments", () => {
  assert.throws(
    () => resolveMobileAppBaseUrl({ APP_BASE_URL: "https://portal.example.com/cc", NODE_ENV: "production" }),
    /path prefixes/i,
  );
});

test("install link is optional and only accepts HTTP(S)", () => {
  assert.equal(buildMobileAppSetup({ baseUrl: "https://cc.example.com" }).installUrl, null);
  assert.equal(
    buildMobileAppSetup({ baseUrl: "https://cc.example.com", installUrl: "https://apps.apple.com/app/id123" }).installUrl,
    "https://apps.apple.com/app/id123",
  );
  assert.equal(
    buildMobileAppSetup({ baseUrl: "https://cc.example.com", installUrl: "javascript:alert(1)" }).installUrl,
    null,
  );
});

test("email QR output is a 400px PNG with the required rendering options", async () => {
  const setup = buildMobileAppSetup({
    baseUrl: "https://cc.example.com",
    organizationName: "Example Support",
  });
  const png = await createMobileSetupQrPng(setup.setupLink);
  const dimensions = imageSize(png);

  assert.equal(dimensions.width, 400);
  assert.equal(dimensions.height, 400);
  assert.equal(MOBILE_SETUP_QR_OPTIONS.errorCorrectionLevel, "M");
  assert.equal(MOBILE_SETUP_QR_OPTIONS.margin, 4);
  assert.equal(MOBILE_SETUP_QR_OPTIONS.color.light, "#ffffff");
});

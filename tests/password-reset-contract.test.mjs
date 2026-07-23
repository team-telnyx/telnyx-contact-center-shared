import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { normalizeEmailFromValue } from "../lib/email-config.mjs";

const root = new URL("../", import.meta.url);

test("password reset API and server action share the token-generating implementation", async () => {
  const [apiRoute, serverAction, implementation] = await Promise.all([
    readFile(new URL("app/api/auth/forgot-password/route.js", root), "utf8"),
    readFile(new URL("app/actions/auth.js", root), "utf8"),
    readFile(new URL("lib/password-reset.js", root), "utf8"),
  ]);

  assert.match(apiRoute, /requestPasswordReset/);
  assert.match(serverAction, /requestPasswordReset/);
  assert.match(implementation, /randomBytes\(32\)/);
  assert.match(implementation, /reset_password_token/);
  assert.match(implementation, /sendPasswordResetEmail/);
  assert.match(implementation, /if \(!user\)[\s\S]*return \{ ok: true \}/);
});

test("Mailgun failures preserve the provider error and HTTP status in logs", async () => {
  const source = await readFile(
    new URL("lib/email-notifications.js", root),
    "utf8",
  );
  const start = source.indexOf("export async function sendEmailNotification");
  const end = source.indexOf("export async function generateRegistrationEmailHTML");
  const sendEmailSource = source.slice(start, end);

  assert.match(source, /function logEmailDeliveryFailure/);
  assert.match(source, /"email_delivery_failed"/);
  assert.match(source, /operation: "mailgun_send"/);
  assert.match(sendEmailSource, /status: response\.status/);
  assert.match(sendEmailSource, /reason: "provider_rejected"/);
  assert.match(sendEmailSource, /reason: "missing_configuration"/);
  assert.doesNotMatch(
    sendEmailSource,
    /typeof error !== "undefined"/,
    "the delivery path must log the actual in-scope error",
  );
});

test("Mailgun sender normalization removes dotenv quotes retained by docker --env-file", () => {
  assert.equal(
    normalizeEmailFromValue(
      '"Telnyx Contact Center <no-reply@telnyx.com>"',
    ),
    "Telnyx Contact Center <no-reply@telnyx.com>",
  );
  assert.equal(
    normalizeEmailFromValue('"Telnyx Contact Center" <no-reply@telnyx.com>'),
    '"Telnyx Contact Center" <no-reply@telnyx.com>',
  );
});

test("password reset pages use the available configurable auth artwork", async () => {
  const pages = await Promise.all([
    readFile(new URL("app/forgot-password/page.jsx", root), "utf8"),
    readFile(new URL("app/reset-password/[token]/page.jsx", root), "utf8"),
    readFile(new URL("app/activate/[token]/page.jsx", root), "utf8"),
  ]);

  for (const page of pages) {
    assert.match(page, /AuthBrandLogo/);
    assert.match(page, /AuthRightImage/);
    assert.doesNotMatch(
      page,
      /telnyx_green_transparent\.png|cc_space\.jpg|telnyx_main\.png/,
    );
  }
});

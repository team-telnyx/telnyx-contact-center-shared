import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveAvatarSessionToken,
  fetchPublicLiveAvatars,
  HeyGenLiveAvatarError,
} from "../lib/ai/heygen-liveavatar.mjs";

const avatars = [
  ["11111111-1111-4111-8111-111111111111", "Ann Therapist", "voice-ann"],
  ["22222222-2222-4222-8222-222222222222", "Ann Doctor", "voice-ann"],
  ["33333333-3333-4333-8333-333333333333", "Shawn Therapist", "voice-shawn"],
  ["44444444-4444-4444-8444-444444444444", "Dexter Lawyer", "voice-dexter"],
  ["55555555-5555-4555-8555-555555555555", "June Host", "voice-june"],
  ["66666666-6666-4666-8666-666666666666", "Adrian Guide", "voice-adrian"],
].map(([id, name, voiceId]) => ({
  id,
  name,
  type: "VIDEO",
  status: "ACTIVE",
  preview_url: `https://files2.heygen.ai/${id}.webp`,
  is_expired: false,
  default_voice: { id: voiceId, name: voiceId },
  is_1080p: true,
}));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("catalog returns five distinct public identities", async () => {
  const fetchImpl = async () =>
    jsonResponse({ code: 1000, data: { results: avatars } });
  const result = await fetchPublicLiveAvatars({ fetchImpl, limit: 5 });

  assert.equal(result.avatars.length, 5);
  assert.equal(result.allAvatars.length, 6);
  assert.deepEqual(
    result.avatars.map((avatar) => avatar.name),
    ["Ann Therapist", "Shawn Therapist", "Dexter Lawyer", "June Host", "Adrian Guide"]
  );
});

test("session token request uses the server-side key and LITE mode", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).includes("/avatars/public")) {
      return jsonResponse({ code: 1000, data: { results: avatars } });
    }
    return jsonResponse({
      code: 1000,
      data: { session_id: "session-1", session_token: "short-lived-token" },
    });
  };

  const result = await createLiveAvatarSessionToken({
    avatarId: avatars[0].id,
    apiKey: "secret-key",
    fetchImpl,
  });
  const tokenRequest = requests[0];
  const body = JSON.parse(tokenRequest.options.body);

  assert.equal(result.sessionToken, "short-lived-token");
  assert.equal(tokenRequest.options.headers["X-API-KEY"], "secret-key");
  assert.equal(body.mode, "LITE");
  assert.equal(body.avatar_id, avatars[0].id);
});

test("sandbox sessions use LiveAvatar's required Wayne avatar", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).includes("/avatars/public")) {
      return jsonResponse({ code: 1000, data: { results: avatars } });
    }
    return jsonResponse({
      code: 1000,
      data: { session_id: "session-1", session_token: "short-lived-token" },
    });
  };

  const result = await createLiveAvatarSessionToken({
    avatarId: avatars[0].id,
    apiKey: "secret-key",
    fetchImpl,
    sandbox: true,
  });
  const body = JSON.parse(requests[0].options.body);

  assert.equal(body.avatar_id, "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a");
  assert.equal(body.is_sandbox, true);
  assert.equal(result.sandbox, true);
});

test("credit errors are classified for client waveform fallback", async () => {
  const fetchImpl = async () =>
    jsonResponse({ code: 4001, message: "Insufficient credits" }, 402);

  await assert.rejects(
    createLiveAvatarSessionToken({
      avatarId: avatars[0].id,
      apiKey: "secret-key",
      fetchImpl,
    }),
    (error) =>
      error instanceof HeyGenLiveAvatarError &&
      error.reason === "credits_exhausted"
  );
});

test("session startup does not refetch the public avatar catalog", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return jsonResponse({
      code: 1000,
      data: { session_id: "session-1", session_token: "short-lived-token" },
    });
  };

  await createLiveAvatarSessionToken({
    avatarId: avatars[0].id,
    apiKey: "secret-key",
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/v1\/sessions\/token$/);
});

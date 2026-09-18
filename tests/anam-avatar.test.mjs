import assert from "node:assert/strict";
import test from "node:test";

import {
  AnamAvatarError,
  assertAnamAvatar,
  createAnamSessionToken,
  fetchAnamAvatars,
} from "../lib/ai/anam-avatar.mjs";

const AVATAR_ID = "edf6fdcb-acab-44b8-b974-ded72665ee26";

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function rawAvatar(id, name, variant, extra = {}) {
  return {
    id,
    displayName: name,
    variantName: variant,
    imageUrl: `https://cdn.example.com/${id}.jpg`,
    portraitImageUrl: `https://cdn.example.com/${id}-portrait.jpg`,
    landscapeImageUrl: `https://cdn.example.com/${id}-landscape.jpg`,
    idleVideoUrl: `https://cdn.example.com/${id}.mp4`,
    availableVersions: ["cara-3", "cara-4"],
    activeVersion: "cara-4",
    ...extra,
  };
}

test("Anam catalog follows pagination and normalizes selectable avatar media", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("page=1")) {
      return response({
        data: [rawAvatar(AVATAR_ID, "Mia", "studio")],
        meta: { lastPage: 2 },
      });
    }
    return response({
      data: [
        rawAvatar(
          "071b0286-4cce-4808-bee2-e642f1062de3",
          "Liv",
          "home",
          { isFavourite: true }
        ),
      ],
      meta: { lastPage: 2 },
    });
  };

  const result = await fetchAnamAvatars({
    fetchImpl,
    apiKey: "secret",
    featuredLimit: 1,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.equal(result.allAvatars.length, 2);
  assert.equal(result.avatars[0].identityName, "Liv");
  assert.equal(result.allAvatars[0].name, "Mia — studio");
  assert.equal(result.allAvatars[0].avatarModel, "cara-4");
  assert.match(result.allAvatars[0].portraitPreviewUrl, /portrait/);
});

test("Anam avatar validation uses the authenticated server API", async () => {
  const avatar = await assertAnamAvatar(AVATAR_ID, {
    apiKey: "secret",
    fetchImpl: async (url, options) => {
      assert.match(url, new RegExp(`${AVATAR_ID}$`));
      assert.equal(options.headers.Authorization, "Bearer secret");
      return response(rawAvatar(AVATAR_ID, "Mia", "studio"));
    },
  });
  assert.equal(avatar.id, AVATAR_ID);
});

test("Anam session tokens enable audio passthrough without exposing the API key", async () => {
  let request;
  const result = await createAnamSessionToken({
    avatarId: AVATAR_ID,
    avatarModel: "cara-4",
    apiKey: "secret",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ sessionToken: "short-lived-token" });
    },
  });

  assert.equal(result.sessionToken, "short-lived-token");
  assert.match(request.url, /\/v1\/auth\/session-token$/);
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    personaConfig: {
      avatarId: AVATAR_ID,
      enableAudioPassthrough: true,
      avatarModel: "cara-4",
    },
  });
});

test("Anam API failures expose stable fallback reasons", async () => {
  await assert.rejects(
    () =>
      createAnamSessionToken({
        avatarId: AVATAR_ID,
        apiKey: "secret",
        fetchImpl: async () =>
          response({ message: "Concurrent session limit reached" }, { status: 429 }),
      }),
    (error) =>
      error instanceof AnamAvatarError &&
      error.reason === "capacity_reached" &&
      error.status === 429
  );
});

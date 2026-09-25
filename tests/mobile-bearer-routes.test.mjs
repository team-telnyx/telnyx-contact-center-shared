import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

// The mobile client authenticates with a bearer token and has no NextAuth
// cookie, because it never signs in through a browser. A route that calls
// `getServerSession` on top of `withPermission` therefore answers 401 to it
// *after* authorisation has already passed — and the client, seeing a 401,
// refreshes. Refresh tokens are single-use (app/api/auth/refresh/route.js
// removes the one it consumed), so a screen that polls turns one unreachable
// route into a rotated-away session and signs the agent out for good.
//
// These are the routes the mobile app reads. They are pinned here rather than
// left to review: the check that broke them was invisible, passed every web
// test, and only showed up as "Your session has expired" on a phone.

const MOBILE_ROUTES = [
  "app/api/contact-center/interactions/[id]/device-handoff/route.js",
  "app/api/contact-center/video/[id]/route.js",
  "app/api/contact-center/video/[id]/token/route.js",
  "app/api/contact-center/video/[id]/transfer/route.js",
  "app/api/contact-center/video/[id]/supervise/route.js",
  "app/api/contact-center/monitor/directory/route.js",
  "app/api/contact-center/outbound-dialer/mobile/route.js",
  "app/api/contact-center/outbound-dialer/campaigns/route.js",
  "app/api/contact-center/outbound-dialer/campaigns/[campaignId]/execution/route.js",
  "app/api/contact-center/media/pexels/route.js",
  "app/api/contacts/route.js",
  "app/api/admin/numbers/[id]/route.js",
  "app/api/admin/connections/route.js",
  "app/api/admin/messaging-profiles/route.js",
  "app/api/contact-center/interactions/[id]/conversation/route.js",
  "app/api/admin/media-library/route.js",
  "app/api/admin/media-library/[mediaName]/stream/route.js",
  "app/api/tts/voices/route.js",
  "app/api/tts/speech/route.js",
  "app/api/user/auth-methods/route.js",
  "app/api/auth/update-password/route.js",
  "app/api/user/notification-sounds/route.js",
  "app/api/user/skills/route.js",
  "app/api/contact-center/sms/[id]/route.js",
  "app/api/contact-center/sms/[id]/copilot/route.js",
  "app/api/contact-center/sms/[id]/transfer/route.js",
  "app/api/contact-center/whatsapp/[id]/route.js",
  "app/api/contact-center/whatsapp/[id]/copilot/route.js",
  "app/api/contact-center/whatsapp/[id]/transfer/route.js",
  "app/api/contact-center/whatsapp/[id]/templates/route.js",
  "app/api/contact-center/whatsapp/[id]/messages/route.js",
  "app/api/contact-center/whatsapp/[id]/attachments/[attachmentId]/route.js",
  "app/api/contact-center/chat/[id]/route.js",
  "app/api/contact-center/chat/[id]/copilot/route.js",
  "app/api/contact-center/chat/[id]/transfer/route.js",
  "app/api/contact-center/chat/[id]/messages/route.js",
  "app/api/contact-center/chat/[id]/attachments/[attachmentId]/route.js",
  "app/api/contact-center/email/[id]/attachments/[messageId]/[index]/route.js",
  "app/api/contact-center/reporting/route.js",
  "app/api/contact-center/monitor/dashboard/route.js",
  "app/api/contact-center/monitor/interactions/route.js",
  "app/api/contact-center/agent/queues/route.js",
  "app/api/contact-center/agent/status/route.js",
  "app/api/contact-center/agent/interactions/route.js",
  "app/api/contact-center/agent/campaigns/route.js",
  "app/api/contact-center/stats/agents/route.js",
  "app/api/contact-center/interactions/[id]/intents/route.js",
  "app/api/contact-center/calls/supervise/route.js",
  "app/api/admin/system-dashboard/route.js",
  "app/api/admin/queues/route.js",
  "app/api/admin/users/route.js",
  "app/api/admin/numbers/route.js",
  "app/api/user/contacts/route.js",
  "app/api/user/statuses/route.js",
  "app/api/voice/token/route.js",
  "app/api/voice/direct-intent/route.js",
  "app/api/dashboard/stats/route.js",
  "app/api/user/profile/route.js",
  "app/api/mobile/v1/devices/[deviceId]/route.js",
  "app/api/contact-center/agent/queues/activate/route.js",
  "app/api/contact-center/agent/queues/deactivate/route.js",
  "app/api/contact-center/agent/pending-wrapup/route.js",
  "app/api/contact-center/agent/session/route.js",
  "app/api/contact-center/agent/stream/route.js",
  "app/api/contact-center/interactions/[id]/route.js",
  "app/api/contact-center/interactions/[id]/wrapup-codes/route.js",
  "app/api/contact-center/interactions/[id]/wrapup/route.js",
  "app/api/contact-center/calls/[callControlId]/switch-supervisor-role/route.js",
  "app/api/user/status-stream/route.js",
  "app/api/mobile/v1/devices/route.js",
  "app/api/auth/me/route.js",
  "app/api/auth/signin/route.js",
  "app/api/auth/refresh/route.js",
  "app/api/auth/logout/route.js",
];

// The status catalogue carries no user data and is read before sign-in — the
// app fetches it with no credentials at all. It is the one route here that is
// public on purpose rather than by omission.
const PUBLIC_BY_DESIGN = new Set(["app/api/user/statuses/route.js"]);

// The authentication routes are what issue the token the guard checks, so
// they cannot be behind it. They do their own work and are exempt from the
// guard rule only — the cookie rule below still applies to them.
const IS_THE_AUTHENTICATION = new Set([
  "app/api/auth/me/route.js",
  "app/api/auth/signin/route.js",
  "app/api/auth/refresh/route.js",
  "app/api/auth/logout/route.js",
]);

const sources = new Map(
  await Promise.all(
    MOBILE_ROUTES.map(async (path) => [
      path,
      await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
    ]),
  ),
);

describe("routes the mobile client reads", () => {
  for (const [path, source] of sources) {
    it(`${path} does not require a browser cookie`, () => {
      // The rule is not "never call getServerSession" — `auth/me` calls it
      // legitimately, after authenticating by either means, to pick up the
      // avatar an OAuth session carries. The rule is that it must never
      // *gate* the request: a cookie is something a bearer-token client
      // cannot produce, so refusing on its absence refuses the app outright.
      const gatesOnCookie = /if\s*\(\s*!\s*session\??[.?]/.test(source)
        && /getServerSession\s*\(/.test(source);
      assert.ok(
        !gatesOnCookie,
        "This route refuses when `getServerSession` finds no NextAuth cookie. " +
          "A bearer-token client cannot produce one, so the route answers 401 " +
          "after withPermission has already authorised the caller — and the " +
          "client, seeing 401, rotates its single-use refresh token away. Use " +
          "`authz.user`, which the guard has already resolved.",
      );
    });

    it(`${path} is behind the permission guard`, { skip: PUBLIC_BY_DESIGN.has(path) || IS_THE_AUTHENTICATION.has(path) }, () => {
      // The counterpart to the rule above: dropping the cookie check is only
      // safe because every export goes through `withPermission`.
      assert.match(
        source,
        /export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*withPermission\(/,
        "Every exported handler must be wrapped in withPermission.",
      );
    });
  }

  it("covers every route the app actually calls", async () => {
    // A route added to the client without being added here would reintroduce
    // the bug silently, so the list is checked against the client's own
    // endpoint file when it is available.
    const endpoints = new URL(
      "../../telnyx-contact-center-mobile/Packages/CCKit/Sources/CCKit/",
      import.meta.url,
    );
    let declared;
    try {
      const { readdir } = await import("node:fs/promises");
      const walk = async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true });
        const files = await Promise.all(
          entries.map((entry) =>
            entry.isDirectory()
              ? walk(new URL(`${entry.name}/`, dir))
              : Promise.resolve(entry.name.endsWith(".swift") ? [new URL(entry.name, dir)] : []),
          ),
        );
        return files.flat();
      };
      const swift = await walk(endpoints);
      const bodies = await Promise.all(swift.map((file) => readFile(file, "utf8")));
      // Everything up to the closing quote. An interpolation — `\\(id)`, or
      // `\\(active ? "activate" : "deactivate")`, whose own quote ends the
      // match early — becomes one wildcard segment.
      declared = new Set(
        bodies
          .join("\n")
          .match(/path:\s*"api\/[^"]*/g)
          ?.map((match) =>
            match
              .replace(/path:\s*"/, "")
              .replace(/\\\([^)]*\)/g, "*")
              .replace(/\\\(.*$/, "*")
              .replace(/\/$/, ""),
          )
          ?? [],
      );
    } catch {
      return; // The mobile checkout is not always beside this one.
    }

    // Segment by segment, with a dynamic segment on either side — `[id]` in a
    // route directory, an interpolation in the client — standing for exactly
    // one segment. The first version of this matched any route whose parent
    // directory held a guarded sibling, so `api/user/profile` counted as
    // covered because `api/user/statuses` was, and it let through the very
    // thing the test exists to catch.
    const covered = MOBILE_ROUTES.map((path) =>
      path
        .replace(/^app\//, "")
        .replace(/\/route\.js$/, "")
        .replace(/\[[^\]]+\]/g, "*")
        .split("/"),
    );
    const matches = (a, b) =>
      a.length === b.length && a.every((segment, i) => segment === b[i] || segment === "*" || b[i] === "*");
    const missing = [...declared].filter(
      (path) => !covered.some((known) => matches(known, path.split("/"))),
    );

    assert.deepStrictEqual(
      missing,
      [],
      `The mobile client calls these routes, which this test does not guard: ${missing.join(", ")}`,
    );
  });
});

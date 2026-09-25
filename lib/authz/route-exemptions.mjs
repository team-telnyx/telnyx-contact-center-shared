/**
 * Routes that are deliberately not behind a user session.
 *
 * Every other `app/api/** /route.js` must go through a recognised guard
 * (see tests/authz-route-contract.test.mjs). Add a route here only with a
 * reason that names the mechanism that protects it instead.
 */
export const ROUTE_EXEMPTIONS = {
  // Authentication flow — establishes the session, cannot require one.
  "auth/[...nextauth]": "NextAuth sign-in and callback endpoints",
  "auth/signin": "mobile sign-in with username and password; issues the JWT",
  "auth/refresh": "mobile token refresh; verifies the refresh token itself",
  "auth/logout": "closes the session named by the refresh token",
  "auth/google-signin": "Google identity exchange; verifies the Google token",
  "auth/forgot-password": "starts password reset by e-mail",
  "auth/reset-password": "consumes a reset_password_token",
  "auth/activate": "consumes an activation_token",
  "auth/invite/[token]": "consumes an invite token",

  // Operational probes — no user data.
  "health": "liveness probe for load balancers and the deploy wizard",
  "version": "public build identity (the internal documentation)",
  "pg/status": "stub kept for legacy health checks; returns constants only",
  "user/statuses": "documented public list of agent status names",

  // Provider webhooks — authenticated by the provider signature or a shared token.
  "voice/webhook": "Telnyx Call Control webhook; verifyTelnyxSignature",
  "voice/webhook/incoming/[flowId]": "Telnyx Call Control webhook; verifyTelnyxSignature",
  "webhooks/telnyx/conversation-insights": "Telnyx webhook; verifyTelnyxSignature",
  "webhooks/telnyx/email": "Telnyx webhook; verifyTelnyxSignature",
  "webhooks/telnyx/sms": "Telnyx webhook; verifyTelnyxSignature",
  "webhooks/telnyx/whatsapp": "Telnyx webhook; verifyTelnyxSignature",
  "video/mobile-screen": "ReplayKit authentication uses an expiring HMAC capability bound to an active assignment segment, room and agent; validated on every request without exposing the account bearer token",
  "video/webhook": "Telnyx Video Rooms webhook; verifyTelnyxSignature",
  "video/media/[id]": "waiting-playlist video fetched by the visitor's widget; read-only, addressed by an unguessable id, no user data",
  "call-generator/webhook": "Telnyx webhook for generated calls; validated inside receiveGeneratorWebhook",
  "provisioning/cti-webhook": "hardphone CTI webhook; verifyTelnyxSignature",
  "voice/flows/trigger/[flowId]": "external flow trigger; per-flow x-flow-token",

  // Device and end-customer surfaces — identified by device or by a scoped token.
  "provisioning/[filename]": "hardphone configuration fetched by the device (MAC-based filename, vendor user agent, every request logged)",
  "provisioning/events/[vendor]": "hardphone vendor event callbacks (MAC-based, logged)",
  "call-generator/test-audio/[marker]": "test audio served only when CC_LIVE_VOICE_TESTS=true, fixed marker names",
  "public/whatsapp-media/[attachmentId]": "signed, expiring media link (verifyWhatsAppMediaToken)",
  "widgets/[publicId]/bootstrap": "public website widget bootstrap; origin allowlist per widget",
  "widgets/[publicId]/sessions": "public website widget session start; origin allowlist per widget",
  "widgets/[publicId]/cobrowse/pairings": "public visitor pairing issuance; signed origin-bound widget bootstrap, published feature flag and admission rate limits",
  "widgets/[publicId]/avatar-session": "public website widget avatar session token; widget voice session token, avatar of the published revision only",
  "widget-sessions/[...action]": "widget session API; widget session token",
  "widget-cobrowse/[...action]": "visitor co-browse state and consent; exact origin plus hashed pairing or rotating session credential",
  "widgets/handoff": "widget handoff; x-cc-widget-handoff-token",

  // Decision D-18: branding images are rendered on the sign-in page before any session exists.
  "media/[...path]": "public images only (branding, profile pictures); extension allowlist, flat namespace, no listing",
  "app-settings": "GET returns the public branding used by the sign-in page; PUT goes through withPermission",

  // Session probes and machine integrations that carry their own contract.
  "auth/me": "profile probe; answers { isAuth: false } instead of 401 so clients can render the signed-out state",
  "contacts/dynamic-variables/[limit]": "AI assistant dynamic-variable webhook; telnyx-ai-api-key or Telnyx signature",
};

/** Source patterns that count as a recognised guard. */
export const GUARD_PATTERNS = [
  /withPermission\(/,
  /requirePermission\(/,
  /getAuthenticatedUser\(/,
  /requireAuth\(/,
  /getServerSession\(/,
  /withEmailUser\(/,
  /withSmsUser\(/,
  /withWhatsAppUser\(/,
  /withWidgetAdmin\(/,
  /requireOutboundSupervisor\(/,
  /requireAiApiKey\(/,
  /verifyTelnyxSignature\(/,
];

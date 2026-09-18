import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const BOOTSTRAP_TTL_SECONDS = 5 * 60;

function signingSecret() {
  const value = String(process.env.WIDGET_SESSION_SIGNING_SECRET || process.env.NEXTAUTH_SECRET || "").trim();
  if (value.length < 32) {
    throw new Error("WIDGET_SESSION_SIGNING_SECRET must contain at least 32 characters");
  }
  return value;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function signature(value) {
  return createHmac("sha256", signingSecret()).update(`cc-widget-bootstrap-v1:${value}`).digest("base64url");
}

export function createWidgetBootstrapToken({ publicId, revisionId, origin, now = Date.now() }) {
  const payload = encode(
    JSON.stringify({
      typ: "widget-bootstrap",
      wid: publicId,
      rid: revisionId,
      org: origin,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + BOOTSTRAP_TTL_SECONDS,
    })
  );
  return `${payload}.${signature(payload)}`;
}

export function verifyWidgetBootstrapToken(token, { publicId, now = Date.now() }) {
  const [payload, suppliedSignature, extra] = String(token || "").split(".");
  if (!payload || !suppliedSignature || extra) throw new Error("Invalid widget bootstrap token");

  const expected = signature(payload);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid widget bootstrap token");
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid widget bootstrap token");
  }
  const current = Math.floor(now / 1000);
  if (
    claims.typ !== "widget-bootstrap" ||
    claims.wid !== publicId ||
    typeof claims.rid !== "string" ||
    typeof claims.org !== "string" ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= current || !Number.isInteger(claims.iat) || claims.iat > current + 30
  ) {
    throw new Error("Expired or mismatched widget bootstrap token");
  }
  return claims;
}

const TEST_GRANT_TTL_SECONDS = 12 * 60 * 60;

function testGrantSignature(value) {
  return createHmac("sha256", signingSecret()).update(`cc-widget-test-grant-v1:${value}`).digest("base64url");
}

// A test grant lets the signed-in widget test page bootstrap one widget from
// one origin without that origin being on the widget's allowlist. The loader
// sends no cookies, so the grant is the proof that an authorised user opened
// the page.
export function createWidgetTestGrant({ publicId, origin, userId, now = Date.now() }) {
  const payload = encode(
    JSON.stringify({
      typ: "widget-test-grant",
      wid: publicId,
      org: origin,
      sub: String(userId),
      exp: Math.floor(now / 1000) + TEST_GRANT_TTL_SECONDS,
    })
  );
  return `${payload}.${testGrantSignature(payload)}`;
}

export function verifyWidgetTestGrant(token, { publicId, origin, now = Date.now() }) {
  const [payload, suppliedSignature, extra] = String(token || "").split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(testGrantSignature(payload));
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    claims.typ !== "widget-test-grant" ||
    claims.wid !== publicId ||
    claims.org !== origin ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= Math.floor(now / 1000)
  ) {
    return null;
  }
  return claims;
}

export function createOpaqueSessionToken() {
  return `wss_${randomBytes(32).toString("base64url")}`;
}

// Derive the same opaque token for an idempotently retried session creation.
// Only its hash is stored; the signing namespace is separate from bootstrap.
export function widgetSessionToken(sessionId) {
  return `wss_${createHmac("sha256", signingSecret()).update(`cc-widget-session-v1:${sessionId}`).digest("base64url")}`;
}

// Separate capabilities for provider-to-server handoff. Neither value is sent
// in public bootstrap/session responses or accepted from host-page context.
export function widgetHandoffToken(sessionId) {
  return createHmac("sha256", signingSecret()).update(`cc-widget-handoff-session-v1:${sessionId}`).digest("base64url");
}

export function widgetHandoffServiceToken(installationId) {
  return createHmac("sha256", signingSecret()).update(`cc-widget-handoff-service-v1:${installationId}`).digest("base64url");
}

export function equalWidgetSecret(supplied, expected) {
  const left=Buffer.from(String(supplied||"")),right=Buffer.from(String(expected||""));
  return left.length===right.length && timingSafeEqual(left,right);
}

export function attachmentAccessToken({attachmentId,sessionId,now=Date.now()}) {
  const payload=encode(JSON.stringify({a:attachmentId,s:sessionId,e:Math.floor(now/300000)*300000+600000}));
  const mac=createHmac("sha256",signingSecret()).update(`cc-widget-attachment-v1:${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}
export function verifyAttachmentAccessToken(token,{attachmentId,now=Date.now()}) {
  const [payload,mac,extra]=String(token||"").split(".");
  if(!payload||!mac||extra)throw new Error("Invalid attachment token");
  const expected=createHmac("sha256",signingSecret()).update(`cc-widget-attachment-v1:${payload}`).digest("base64url");
  if(mac.length!==expected.length||!timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw new Error("Invalid attachment token");
  const claims=JSON.parse(Buffer.from(payload,"base64url").toString());
  if(claims.a!==attachmentId||typeof claims.s!=="string"||!Number.isFinite(claims.e)||claims.e<=now)throw new Error("Expired attachment token");
  return claims;
}

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function bearerToken(request) {
  const authorization = String(request.headers.get("authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

// The ingress must append the peer address and prevent direct access to Next.
// Read from the trusted (right) end, never from a client-supplied leading entry.
export function widgetAdmissionKey(request) {
  const hops = Number(process.env.WIDGET_TRUSTED_PROXY_HOPS || 1);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) throw new Error("Invalid widget proxy hop configuration");
  const forwarded = String(request.headers.get("x-forwarded-for") || "").split(",").map(value=>value.trim());
  let address = request.ip || forwarded.at(-hops) || "";
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) address = address.slice(7);
  if (isIP(address) === 6) address = new URL(`http://[${address}]/`).hostname;
  else if (isIP(address) !== 4) address = "unattributed";
  return createHmac("sha256",signingSecret()).update(`cc-widget-admission-v1:${address}`).digest("hex");
}

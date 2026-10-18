import { createHmac, timingSafeEqual } from "node:crypto";
import { getPostgresPool } from "../postgres.mjs";
import { effectiveAccess, can } from "../authz/effective.mjs";
import { hasAuthSession } from "../auth-refresh-sessions.mjs";
import { telnyxAvatarSocketUrl } from "./telnyx-avatar-socket-url.mjs";

const PURPOSE = "cc-assistant-call-v1";
const secret = (env) => {
  if (!env.NEXTAUTH_SECRET || env.NEXTAUTH_SECRET.length < 32) throw new Error("Assistant call authentication is not configured");
  return env.NEXTAUTH_SECRET;
};
const sign = (value, env) => createHmac("sha256", secret(env)).update(`${PURPOSE}.${value}`).digest();

// A short-lived, assistant-scoped capability. It contains no Telnyx credentials.
// User/session permissions are checked again by the relay and during the call.
export function issueAssistantCallSession(claims, { env = process.env, now = Date.now() } = {}) {
  const body = Buffer.from(JSON.stringify({ ...claims, purpose: PURPOSE, exp: Math.floor(now / 1000) + 120 })).toString("base64url");
  return `${body}.${sign(body, env).toString("base64url")}`;
}

export function readAssistantCallSession(token, origin, { env = process.env, now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length > 8192) throw new Error("Sign in to Contact Center and try again");
  const [body, signature, extra] = token.split(".");
  const actual = Buffer.from(signature || "", "base64url"), expected = sign(body, env);
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid call authorization");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  if (claims.purpose !== PURPOSE || !Number.isFinite(claims.exp) || claims.exp <= now / 1000 || claims.exp > now / 1000 + 121 || !claims.userId || !claims.assistantId || !origin || claims.origin !== origin) throw new Error("Call authorization expired. Try again");
  if (claims.scope !== undefined && claims.scope !== WORKFLOW_TEST_SCOPE) throw new Error("Invalid call authorization");
  if (claims.scope === WORKFLOW_TEST_SCOPE && (typeof claims.workflowId !== "string" || !claims.workflowId)) throw new Error("Invalid call authorization");
  return claims;
}

// The workflow "Test AI Agent" page issues voice-only sessions scoped to a
// workflow. They are authorized by the workflow permission instead of the
// assistant permission, and the workflow must still point at the same assistant.
export const WORKFLOW_TEST_SCOPE = "workflow-test";

export function assistantCallPermission(claims) {
  return claims?.scope === WORKFLOW_TEST_SCOPE ? "workflows:ai" : "ai_assistants:test";
}

export async function authorizeAssistantCaller(claims, pool = getPostgresPool(), { resolveAccess = effectiveAccess } = {}) {
  if (!pool) throw new Error("Contact Center authentication is unavailable");
  const user = (await pool.query("SELECT * FROM users WHERE id=$1", [claims.userId])).rows[0];
  if (!user || user.active === false || !can(await resolveAccess(user), assistantCallPermission(claims))) throw new Error("You no longer have permission to call this assistant");
  if (claims.scope === WORKFLOW_TEST_SCOPE) {
    const workflow = (await pool.query("SELECT ai_assistant_id FROM aa_workflows WHERE id=$1", [claims.workflowId])).rows[0];
    if (!workflow || workflow.ai_assistant_id !== claims.assistantId) throw new Error("The workflow's assistant changed. Reopen Test AI Agent and try again");
  }
  if (claims.sessionId) {
    if (claims.sessionKind === "bearer") {
      if (!hasAuthSession(user, claims.sessionId)) throw new Error("Your Contact Center session has ended");
    } else {
      const tracked = await pool.query("SELECT id FROM cc_user_sessions WHERE user_id=$1 AND session_token=$2 AND logout_at IS NULL", [claims.userId, claims.sessionId]);
      if (!tracked.rowCount) throw new Error("Your Contact Center session has ended");
    }
  }
  return user;
}

export function assistantCallSocketUrl(requestUrl, env = process.env, options = {}) {
  const url = new URL(telnyxAvatarSocketUrl(requestUrl, env, options));
  url.pathname = url.pathname.replace(/\/widget-avatar$/, "/assistant-call");
  return url.href;
}

export function assistantCallSettings(assistant) {
  const avatar = assistant.avatar_settings;
  return { assistantId: assistant.id, name: assistant.name, avatar: avatar ? { enabled: true, provider: "telnyx", avatarId: avatar.avatar_id, avatarModel: avatar.model, backgroundId: avatar.background_id } : null };
}

import crypto from "crypto";
import { getSecretByName, updateSecret, upsertSecretByName } from "@/lib/secrets.js";
import { getPostgresPool } from "@/lib/postgres.mjs";

const TELNYX_MCP_RESOURCE = "https://api.telnyx.com/v2/mcp";
const TELNYX_OAUTH_AUTHORIZE_URL = "https://api.telnyx.com/v2/oauth/authorize";
const TELNYX_OAUTH_TOKEN_URL = "https://api.telnyx.com/v2/oauth/token";
const TELNYX_OAUTH_REGISTER_URL = "https://api.telnyx.com/v2/oauth/register";

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createPkcePair() {
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function createOAuthState() {
  return base64Url(crypto.randomBytes(24));
}

export function browserSafeBaseUrl(request) {
  const configuredBase = process.env.NEXT_PUBLIC_BASE_URL || process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || null;
  const baseUrl = new URL(configuredBase || new URL(request.url).origin);
  if (baseUrl.hostname === "0.0.0.0" || baseUrl.hostname === "::") {
    baseUrl.hostname = "localhost";
  }
  return baseUrl.origin;
}

export function getMcpOAuthRedirectUri(request) {
  return `${browserSafeBaseUrl(request)}/api/admin/mcp-servers/oauth/callback`;
}

function pendingSecretName(state) {
  return `mcp_oauth_pending_${state}`;
}

export function tokenSecretName(serverId) {
  return `mcp_oauth_${serverId}`;
}

async function registerTelnyxOAuthClient({ serverName, redirectUri }) {
  const response = await fetch(TELNYX_OAUTH_REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: `${serverName || "Contact Center"} MCP Connector`,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "admin",
      token_endpoint_auth_method: "none",
    }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.client_id) {
    throw new Error(data?.error_description || data?.error || "Failed to register Telnyx OAuth client");
  }
  return data;
}

export async function beginTelnyxMcpOAuth({ server, request, userId }) {
  const redirectUri = getMcpOAuthRedirectUri(request);
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createOAuthState();
  const client = await registerTelnyxOAuthClient({ serverName: server.name, redirectUri });

  await upsertSecretByName({
    name: pendingSecretName(state),
    description: `Pending Telnyx MCP OAuth state for ${server.name || server.id}`,
    created_by: userId || null,
    value: JSON.stringify({
      server_id: server.id,
      state,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      client_secret: client.client_secret || null,
      resource: TELNYX_MCP_RESOURCE,
      created_at: new Date().toISOString(),
    }),
  });

  const authorizationUrl = new URL(TELNYX_OAUTH_AUTHORIZE_URL);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", "admin");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", TELNYX_MCP_RESOURCE);

  return { authorizationUrl: authorizationUrl.toString(), state };
}

function applyOAuthClientAuth({ headers, body, tokenSession }) {
  const clientId = tokenSession.client_id;
  const clientSecret = tokenSession.client_secret;
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
  }
}

async function requestOAuthToken({ tokenSession, params }) {
  const body = new URLSearchParams(params);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  applyOAuthClientAuth({ headers, body, tokenSession });
  const response = await fetch(TELNYX_OAUTH_TOKEN_URL, { method: "POST", headers, body, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.error || "Failed to obtain Telnyx MCP OAuth token");
  }
  return data;
}

function toTokenSecretValue({ tokenSession, tokenResponse }) {
  const expiresIn = Number(tokenResponse.expires_in || 3600);
  return JSON.stringify({
    ...tokenSession,
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || tokenSession.refresh_token || null,
    token_type: tokenResponse.token_type || "Bearer",
    scope: tokenResponse.scope || tokenSession.scope || "admin",
    expires_at: Date.now() + Math.max(60, expiresIn) * 1000,
    updated_at: new Date().toISOString(),
  });
}

export async function finishTelnyxMcpOAuth({ code, state, userId }) {
  const pending = await getSecretByName(pendingSecretName(state));
  if (!pending?.value) throw new Error("OAuth state not found or expired");
  const tokenSession = JSON.parse(pending.value);
  if (tokenSession.state !== state) throw new Error("OAuth state mismatch");

  const tokenResponse = await requestOAuthToken({
    tokenSession,
    params: {
      grant_type: "authorization_code",
      code,
      code_verifier: tokenSession.code_verifier,
      redirect_uri: tokenSession.redirect_uri,
      resource: tokenSession.resource || TELNYX_MCP_RESOURCE,
    },
  });

  const name = tokenSecretName(tokenSession.server_id);
  await upsertSecretByName({
    name,
    description: `Telnyx MCP OAuth tokens for server ${tokenSession.server_id}`,
    created_by: userId || null,
    value: toTokenSecretValue({ tokenSession, tokenResponse }),
  });

  const pool = getPostgresPool();
  const serverUpdate = await pool.query(
    `UPDATE mcp_servers
     SET auth_type = 'oauth_authorization_code', auth_secret_name = $2, auth_scheme = $3, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL`,
    [tokenSession.server_id, name, tokenSession.resource || TELNYX_MCP_RESOURCE],
  );
  if (serverUpdate.rowCount < 1) {
    throw new Error(`MCP server '${tokenSession.server_id}' was not found while saving OAuth session`);
  }

  return { serverId: tokenSession.server_id, secretName: name };
}

export async function getValidTelnyxMcpOAuthAccessToken(secretName) {
  const secret = await getSecretByName(secretName);
  if (!secret?.value) throw new Error(`OAuth token secret '${secretName}' not found`);
  const tokenSession = JSON.parse(secret.value);
  if (tokenSession.access_token && Number(tokenSession.expires_at || 0) > Date.now() + 60_000) {
    return tokenSession.access_token;
  }
  if (!tokenSession.refresh_token) {
    throw new Error("Telnyx MCP OAuth session has expired and no refresh token is available; reconnect from MCP Server settings.");
  }
  const tokenResponse = await requestOAuthToken({
    tokenSession,
    params: {
      grant_type: "refresh_token",
      refresh_token: tokenSession.refresh_token,
      resource: tokenSession.resource || TELNYX_MCP_RESOURCE,
    },
  });
  await updateSecret(secret.id, { value: toTokenSecretValue({ tokenSession, tokenResponse }) });
  return tokenResponse.access_token;
}

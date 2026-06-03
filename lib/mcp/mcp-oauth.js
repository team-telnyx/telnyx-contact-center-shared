import crypto from "crypto";
import { getSecretByName, updateSecret, upsertSecretByName } from "@/lib/secrets.js";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { discoverMcpServerAuth } from "@/lib/mcp/mcp-auth-discovery.js";

const DEFAULT_OAUTH_SCOPE = "admin";

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
  const hostname = baseUrl.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "0.0.0.0" || hostname === "::") {
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

export async function getPendingTelnyxMcpOAuthServerId(state) {
  if (!state) return null;
  const pending = await getSecretByName(pendingSecretName(state));
  if (!pending?.value) return null;
  try {
    const tokenSession = JSON.parse(pending.value);
    return tokenSession?.server_id || null;
  } catch {
    return null;
  }
}

async function registerOAuthClient({ serverName, redirectUri, discovery }) {
  if (!discovery?.registrationEndpoint) {
    throw new Error("This OAuth-protected MCP server does not expose a dynamic client registration endpoint.");
  }
  const response = await fetch(discovery.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: `${serverName || "Contact Center"} MCP Connector`,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: discovery.scope || DEFAULT_OAUTH_SCOPE,
      token_endpoint_auth_method: "none",
    }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.client_id) {
    throw new Error(data?.error_description || data?.error || "Failed to register MCP OAuth client");
  }
  return data;
}

export async function beginTelnyxMcpOAuth({ server, request, userId }) {
  const redirectUri = getMcpOAuthRedirectUri(request);
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createOAuthState();
  const discovery = await discoverMcpServerAuth({ url: server.url, type: server.type || "http" });
  if (!discovery?.detected || discovery.authType !== "oauth_authorization_code") {
    throw new Error("OAuth Authorization Code was not discovered for this MCP server.");
  }
  if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint) {
    throw new Error("OAuth authorization server metadata is incomplete for this MCP server.");
  }
  const client = await registerOAuthClient({ serverName: server.name, redirectUri, discovery });
  const resource = discovery.resource || server.auth_scheme || server.url;
  const scope = discovery.scope || DEFAULT_OAUTH_SCOPE;

  await upsertSecretByName({
    name: pendingSecretName(state),
    description: `Pending MCP OAuth state for ${server.name || server.id}`,
    created_by: userId || null,
    value: JSON.stringify({
      server_id: server.id,
      state,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      client_secret: client.client_secret || null,
      token_endpoint_auth_method: client.token_endpoint_auth_method || "none",
      resource,
      scope,
      token_endpoint: discovery.tokenEndpoint,
      authorization_endpoint: discovery.authorizationEndpoint,
      authorization_server: discovery.authorizationServer || null,
      created_at: new Date().toISOString(),
    }),
  });

  const authorizationUrl = new URL(discovery.authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  if (scope) authorizationUrl.searchParams.set("scope", scope);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (resource) authorizationUrl.searchParams.set("resource", resource);

  return { authorizationUrl: authorizationUrl.toString(), state };
}

function applyOAuthClientAuth({ headers, body, tokenSession, grantType }) {
  const clientId = tokenSession.client_id;
  const clientSecret = tokenSession.client_secret;
  const authMethod = tokenSession.token_endpoint_auth_method || "none";

  // Public PKCE clients registered with token_endpoint_auth_method="none" must
  // not send Basic auth or client_id on refresh; some providers return invalid_client.
  // Telnyx returns invalid_client for refresh requests that include client auth here.
  if (grantType === "refresh_token" && authMethod === "none") return;

  if (authMethod === "client_secret_basic" && clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    return;
  }

  if (authMethod === "client_secret_post" && clientSecret) {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    return;
  }

  if (clientId) body.set("client_id", clientId);
}

async function requestOAuthToken({ tokenSession, params }) {
  const tokenEndpoint = tokenSession.token_endpoint;
  if (!tokenEndpoint) throw new Error("OAuth token endpoint is missing from the MCP OAuth session.");
  const body = new URLSearchParams(params);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  applyOAuthClientAuth({ headers, body, tokenSession, grantType: params?.grant_type });
  const response = await fetch(tokenEndpoint, { method: "POST", headers, body, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.error || "Failed to obtain MCP OAuth token");
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
    scope: tokenResponse.scope || tokenSession.scope || DEFAULT_OAUTH_SCOPE,
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
      ...(tokenSession.resource ? { resource: tokenSession.resource } : {}),
    },
  });

  const name = tokenSecretName(tokenSession.server_id);
  await upsertSecretByName({
    name,
    description: `MCP OAuth tokens for server ${tokenSession.server_id}`,
    created_by: userId || null,
    value: toTokenSecretValue({ tokenSession, tokenResponse }),
  });

  const pool = getPostgresPool();
  const serverUpdate = await pool.query(
    `UPDATE mcp_servers
     SET auth_type = 'oauth_authorization_code', auth_secret_name = $2, auth_scheme = $3, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL`,
    [tokenSession.server_id, name, tokenSession.resource || null],
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
    throw new Error("MCP OAuth session has expired and no refresh token is available; reconnect from MCP Server settings.");
  }
  const tokenResponse = await requestOAuthToken({
    tokenSession,
    params: {
      grant_type: "refresh_token",
      refresh_token: tokenSession.refresh_token,
      ...(tokenSession.resource ? { resource: tokenSession.resource } : {}),
    },
  });
  await updateSecret(secret.id, { value: toTokenSecretValue({ tokenSession, tokenResponse }) });
  return tokenResponse.access_token;
}

// Pure helpers for OAuth 2.0 client_credentials token requests used by MCP
// server auth. Kept free of app imports so the request shape can be unit tested.

export const TELNYX_OAUTH_TOKEN_URL = "https://api.telnyx.com/v2/oauth/token";
export const TELNYX_MCP_RESOURCE = "https://api.telnyx.com/v2/mcp";

function optionalString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

// RFC 6749 §2.3.1: the client identifier and secret are encoded with
// application/x-www-form-urlencoded BEFORE being joined with ":" and Base64'd.
// Without this a secret containing ":" or "%" — both common in generated
// secrets — is parsed by the provider as different credentials and rejected.
// URLSearchParams performs exactly this encoding (space as "+").
function formUrlEncode(value) {
  return new URLSearchParams({ v: String(value ?? "") }).toString().slice(2);
}

/**
 * Accepts either a JSON secret or a `client_id:client_secret` / newline pair.
 * The JSON form may carry provider overrides so any OAuth 2.0 provider works,
 * not only the Telnyx token endpoint.
 */
export function parseOAuthClientCredentials(secretValue) {
  const raw = String(secretValue || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const clientId = String(parsed.client_id || parsed.clientId || "").trim();
    const clientSecret = String(parsed.client_secret || parsed.clientSecret || "").trim();
    if (clientId && clientSecret) {
      return {
        clientId,
        clientSecret,
        tokenUrl: optionalString(parsed.token_url || parsed.tokenUrl),
        scope: optionalString(parsed.scope),
        audience: optionalString(parsed.audience),
        resource: optionalString(parsed.resource),
        authStyle: optionalString(parsed.auth_style || parsed.authStyle)?.toLowerCase() || null,
      };
    }
  } catch {
    // Fall through to delimiter formats.
  }

  const separator = raw.includes("\n") ? "\n" : raw.includes(":") ? ":" : null;
  if (!separator) return null;
  const [clientId, ...rest] = raw.split(separator);
  const clientSecret = rest.join(separator);
  if (!String(clientId || "").trim() || !String(clientSecret || "").trim()) return null;
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    tokenUrl: null,
    scope: null,
    audience: null,
    resource: null,
    authStyle: null,
  };
}

/**
 * Builds the token endpoint request. Telnyx authenticates the client with HTTP
 * Basic; most other providers (Microsoft Entra ID included) document
 * client_secret_post, and Entra ID v2 rejects the v1-only `resource`
 * parameter, so `resource` is only sent when it was configured explicitly.
 */
export function buildClientCredentialsTokenRequest({
  clientId,
  clientSecret,
  tokenUrl,
  scope,
  resource,
  audience,
  authStyle,
} = {}) {
  const endpoint = tokenUrl || TELNYX_OAUTH_TOKEN_URL;
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (scope) body.set("scope", scope);
  if (resource) body.set("resource", resource);
  if (audience) body.set("audience", audience);

  const useBasicClientAuth = (authStyle || (endpoint === TELNYX_OAUTH_TOKEN_URL ? "basic" : "post")) === "basic";
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (useBasicClientAuth) {
    const basic = `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }

  return { endpoint, headers, body };
}

/**
 * Resolves which token endpoint, scope and resource a server should use.
 * Telnyx issues resource-scoped tokens, so the resource stays required for its
 * endpoint. External providers declare what they need inside the secret.
 */
export function resolveClientCredentialsConfig({ credentials, authScheme, isTelnyxMcpResource = false }) {
  const tokenUrl = credentials?.tokenUrl || TELNYX_OAUTH_TOKEN_URL;
  const usesTelnyxTokenEndpoint = tokenUrl === TELNYX_OAUTH_TOKEN_URL;
  const resource =
    credentials?.resource ||
    (isTelnyxMcpResource
      ? TELNYX_MCP_RESOURCE
      : usesTelnyxTokenEndpoint
        ? String(authScheme || "").trim()
        : "");
  if (usesTelnyxTokenEndpoint && !resource) {
    throw new Error("OAuth Client Credentials authentication requires auth_scheme to contain the OAuth resource URL");
  }
  return {
    tokenUrl,
    resource,
    scope: credentials?.scope || (usesTelnyxTokenEndpoint ? "admin" : ""),
    audience: credentials?.audience || null,
    authStyle: credentials?.authStyle || null,
  };
}

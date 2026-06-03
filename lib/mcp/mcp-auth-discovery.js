const MCP_PROTOCOL_VERSION = "2025-06-18";
const TELNYX_MCP_RESOURCE = "https://api.telnyx.com/v2/mcp";

export function parseWwwAuthenticateResourceMetadata(headerValue) {
  const value = String(headerValue || "");
  const match = value.match(/resource_metadata\s*=\s*"([^"]+)"/i) || value.match(/resource_metadata\s*=\s*([^,\s]+)/i);
  return match?.[1] || null;
}

export function buildOAuthProtectedResourceMetadataCandidates(resourceUrl) {
  try {
    const parsed = new URL(resourceUrl);
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const origin = parsed.origin;
    const candidates = [];
    if (pathname) candidates.push(`${origin}/.well-known/oauth-protected-resource/${pathname}`);
    candidates.push(`${origin}/.well-known/oauth-protected-resource`);
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

function buildAuthorizationServerMetadataCandidates(issuer) {
  try {
    const parsed = new URL(issuer);
    const issuerPath = parsed.pathname.replace(/\/+$/g, "");
    const candidates = [
      `${parsed.origin}/.well-known/oauth-authorization-server${issuerPath && issuerPath !== "/" ? issuerPath : ""}`,
      `${parsed.origin}/.well-known/openid-configuration${issuerPath && issuerPath !== "/" ? issuerPath : ""}`,
      `${parsed.origin}/.well-known/oauth-authorization-server`,
      `${parsed.origin}/.well-known/openid-configuration`,
    ];
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

async function fetchJson(url, { method = "GET", body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json, text/event-stream",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
    cache: "no-store",
  });
  const text = await response.text().catch(() => "");
  let data = null;
  const eventMatch = text.match(/^data:\s*(.+)$/m);
  const jsonText = eventMatch?.[1] || text;
  try {
    data = jsonText ? JSON.parse(jsonText) : null;
  } catch {
    data = null;
  }
  return { response, data, text };
}

async function probeMcpEndpointForResourceMetadata(url) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "telnyx-contact-center-auth-discovery", version: "0.1.0" },
    },
  });
  const { response } = await fetchJson(url, { method: "POST", body });
  return parseWwwAuthenticateResourceMetadata(response.headers.get("WWW-Authenticate"));
}

async function readFirstJson(candidates) {
  for (const url of candidates) {
    try {
      const { response, data } = await fetchJson(url);
      if (response.ok && data && typeof data === "object") return { url, data };
    } catch (_) {}
  }
  return null;
}

export function summarizeOAuthDiscovery({ resourceMetadata, authorizationServerMetadata }) {
  if (!resourceMetadata?.authorization_servers?.length || !authorizationServerMetadata?.token_endpoint) return null;
  const resource = resourceMetadata.resource || null;
  const grants = Array.isArray(authorizationServerMetadata.grant_types_supported)
    ? authorizationServerMetadata.grant_types_supported
    : [];
  const scopes = Array.isArray(authorizationServerMetadata.scopes_supported)
    ? authorizationServerMetadata.scopes_supported
    : [];
  const codeChallenges = Array.isArray(authorizationServerMetadata.code_challenge_methods_supported)
    ? authorizationServerMetadata.code_challenge_methods_supported
    : [];
  const supportsAuthorizationCode = Boolean(authorizationServerMetadata.authorization_endpoint) &&
    (grants.length === 0 || grants.includes("authorization_code"));
  const supportsClientCredentials = resource === TELNYX_MCP_RESOURCE && grants.includes("client_credentials");
  const authType = supportsAuthorizationCode ? "oauth_authorization_code" : supportsClientCredentials ? "oauth_client_credentials" : "bearer";
  return {
    authType,
    resource,
    resourceName: resourceMetadata.resource_name || resourceMetadata.resource || "OAuth protected MCP resource",
    authorizationServer: authorizationServerMetadata.issuer || resourceMetadata.authorization_servers[0],
    authorizationEndpoint: authorizationServerMetadata.authorization_endpoint || null,
    tokenEndpoint: authorizationServerMetadata.token_endpoint,
    registrationEndpoint: authorizationServerMetadata.registration_endpoint || null,
    scope: scopes.includes("admin") ? "admin" : scopes[0] || null,
    pkce: codeChallenges.includes("S256"),
    grantTypes: grants,
    tokenEndpointAuthMethods: authorizationServerMetadata.token_endpoint_auth_methods_supported || [],
  };
}

export async function discoverMcpServerAuth({ url, type = "http" }) {
  if (!url) throw new Error("MCP server URL is required");
  if (type && type !== "http") {
    return { detected: false, authType: "unknown", message: "OAuth discovery is available for HTTP MCP servers." };
  }

  const metadataUrls = [];
  const challengedMetadataUrl = await probeMcpEndpointForResourceMetadata(url).catch(() => null);
  if (challengedMetadataUrl) metadataUrls.push(challengedMetadataUrl);
  metadataUrls.push(...buildOAuthProtectedResourceMetadataCandidates(url));

  const protectedResource = await readFirstJson([...new Set(metadataUrls)]);
  if (!protectedResource?.data?.authorization_servers?.length) {
    return { detected: false, authType: "none", message: "No OAuth protected resource metadata was discovered." };
  }

  const authServer = protectedResource.data.authorization_servers[0];
  const authorizationServer = await readFirstJson(buildAuthorizationServerMetadataCandidates(authServer));
  const summary = summarizeOAuthDiscovery({
    resourceMetadata: protectedResource.data,
    authorizationServerMetadata: authorizationServer?.data,
  });
  if (!summary) {
    return {
      detected: true,
      authType: "bearer",
      resource: protectedResource.data.resource || url,
      resourceName: protectedResource.data.resource_name || protectedResource.data.resource || "OAuth protected MCP resource",
      authorizationServer: authServer,
      protectedResourceMetadataUrl: protectedResource.url,
      message: "OAuth protected resource metadata was found, but authorization server metadata is incomplete.",
    };
  }
  return {
    detected: true,
    ...summary,
    protectedResourceMetadataUrl: protectedResource.url,
    authorizationServerMetadataUrl: authorizationServer?.url || null,
    message: summary.authType === "oauth_authorization_code"
      ? "OAuth Authorization Code + PKCE was auto-detected for this MCP server."
      : summary.authType === "oauth_client_credentials"
        ? "OAuth Client Credentials was auto-detected for this MCP server."
        : "Bearer authentication was auto-detected for this MCP server.",
  };
}

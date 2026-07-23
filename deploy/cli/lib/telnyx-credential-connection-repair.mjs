const DEFAULT_BASE_PATH = 'https://api.telnyx.com';
export const REQUIRED_SIP_URI_CALLING_PREFERENCE = 'unrestricted';

function normalizeBasePath(basePath) {
  return String(basePath || DEFAULT_BASE_PATH).replace(/\/$/, '');
}

function authHeaders(apiKey) {
  if (!apiKey) throw new Error('TELNYX_API_KEY is required');
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function requestJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, init);
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    if (response.ok) {
      throw new Error(`Telnyx returned invalid JSON for ${init.method || 'GET'} ${url}`);
    }
  }

  if (!response.ok) {
    const detail =
      payload?.errors?.[0]?.detail ||
      payload?.errors?.[0]?.message ||
      payload?.message ||
      raw ||
      `HTTP ${response.status}`;
    throw new Error(
      `Telnyx API ${response.status} on ${init.method || 'GET'} ${url}: ${detail}`,
    );
  }

  return payload;
}

export async function getCredentialConnection({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  connectionId,
} = {}) {
  if (!connectionId) throw new Error('Credential Connection ID is required');
  const url = `${normalizeBasePath(basePath)}/v2/credential_connections/${encodeURIComponent(connectionId)}`;
  const payload = await requestJson(fetchImpl, url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  if (!payload?.data?.id) {
    throw new Error('Telnyx Credential Connection response is missing data.id');
  }
  return payload.data;
}

export async function auditCredentialConnection(options = {}) {
  const connection = await getCredentialConnection(options);
  const currentPreference = connection.sip_uri_calling_preference ?? null;
  return {
    id: connection.id,
    name: connection.connection_name || connection.name || null,
    currentPreference,
    requiredPreference: REQUIRED_SIP_URI_CALLING_PREFERENCE,
    compliant: currentPreference === REQUIRED_SIP_URI_CALLING_PREFERENCE,
  };
}

export async function repairCredentialConnection({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  connectionId,
} = {}) {
  const before = await auditCredentialConnection({
    fetchImpl,
    basePath,
    apiKey,
    connectionId,
  });
  if (before.compliant) {
    return { outcome: 'already-compliant', before, after: before };
  }

  const url = `${normalizeBasePath(basePath)}/v2/credential_connections/${encodeURIComponent(connectionId)}`;
  await requestJson(fetchImpl, url, {
    method: 'PATCH',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      sip_uri_calling_preference: REQUIRED_SIP_URI_CALLING_PREFERENCE,
    }),
  });

  // Verify with a fresh GET. This protects the repair command from a Telnyx
  // endpoint accepting a field while silently ignoring it.
  const after = await auditCredentialConnection({
    fetchImpl,
    basePath,
    apiKey,
    connectionId,
  });
  if (!after.compliant) {
    throw new Error(
      `Telnyx accepted the PATCH but sip_uri_calling_preference is still ${JSON.stringify(after.currentPreference)}`,
    );
  }

  return { outcome: 'repaired', before, after };
}

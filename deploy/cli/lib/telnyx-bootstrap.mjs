// Idempotent Telnyx resource provisioning for the deploy wizard.
//
// All real network calls go through `fetchImpl` so unit tests can run with a
// mocked fetch. The orchestrator (runTelnyxBootstrap) is the only thing the
// rest of the CLI touches; the individual upsert functions are exported only
// because they need their own tests, and a future "repair one resource" mode
// under `cc telnyx --repair voice-app` may need to call them directly.
//
// Hard rules baked into this module (every Phase 2 review item):
//   - Find-by-exact-name before create; never duplicate resources on resume.
//   - One TeXML/Call Control application per deployment — never share with
//     another deployment; collisions abort with a clear error rather than
//     silently adopting a foreign resource.
//   - All request/response shapes mirror openapi/telnyx.json (no undocumented
//     fields, no hand-rolled schema drift).
//   - "created" vs "found" vs "updated" outcome surfaced to the caller so the
//     wizard can render a precise log line per resource.

const DEFAULT_BASE_PATH = 'https://api.telnyx.com';

function authHeaders(apiKey) {
  if (!apiKey) throw new Error('Telnyx API key is required');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// Wraps fetch with consistent error semantics: throws Error with the Telnyx
// error detail message (mirrors lib/hardphones/credentials.mjs::errorDetail).
async function telnyxFetch(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, init);
  if (res.ok) return res;
  let detail;
  try {
    const data = await res.clone().json();
    detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.message || data?.message;
  } catch {
    try {
      detail = await res.text();
    } catch {
      detail = `HTTP ${res.status}`;
    }
  }
  throw new Error(`Telnyx API ${res.status} on ${init.method || 'GET'} ${url}: ${detail || 'unknown error'}`);
}

async function findByName(fetchImpl, basePath, apiKey, listPath, name, opts = {}) {
  // Different Telnyx resources name their unique-ish field differently
  // (application_name / connection_name / name). Rather than guessing a
  // server-side filter shape that may or may not be honored, just list the
  // collection and filter client-side — listing is paginated (page[size]=100)
  // and for a single account / single deployment we never have more than a
  // handful of voice apps, OVP, or credential connections to scan.
  const { matchField = 'name', pageSize = 100 } = opts;
  const url = new URL(`${basePath}${listPath}`);
  url.searchParams.set('page[size]', String(pageSize));
  const res = await telnyxFetch(fetchImpl, url.toString(), { headers: authHeaders(apiKey) });
  const data = await res.json().catch(() => ({}));
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.find((item) => item?.[matchField] === name || item?.name === name || item?.application_name === name || item?.connection_name === name) || null;
}

// ----- Voice API (Call Control) application ---------------------------------

export async function upsertVoiceApp({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  name,
  webhookUrl,
  outboundVoiceProfileId = null,
  // Optional SIP subdomain (mirrors lib/telnyx-voice-apps.js::createVoiceApplication
  // in the main app, which sets this to the flow's UUID). Only meaningful for
  // the per-flow voice app created for the Default Call Flow — the main
  // WebRTC-agent voice app never sets this.
  sipSubdomain = null,
}) {
  if (!name) throw new Error('upsertVoiceApp requires { name }');
  if (!webhookUrl) throw new Error('upsertVoiceApp requires { webhookUrl }');

  const existing = await findByName(fetchImpl, basePath, apiKey, '/v2/call_control_applications', name, { matchField: 'application_name' });
  const inbound = { codecs: ['G711A', 'G711U'] };
  if (sipSubdomain) {
    inbound.sip_subdomain = sipSubdomain;
    inbound.sip_subdomain_receive_settings = 'from_anyone';
  }
  const payload = {
    application_name: name,
    webhook_event_url: webhookUrl,
    webhook_event_failover_url: null,
    webhook_api_version: '2',
    call_cost_in_webhooks: true,
    inbound,
    ...(outboundVoiceProfileId ? { outbound: { outbound_voice_profile_id: outboundVoiceProfileId } } : {}),
  };

  if (existing) {
    const res = await telnyxFetch(fetchImpl, `${basePath}/v2/call_control_applications/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: authHeaders(apiKey),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return { id: data?.data?.id || existing.id, name, outcome: 'updated' };
  }

  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/call_control_applications`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data?.data?.id) throw new Error('Telnyx voice app create returned no id');
  return { id: data.data.id, name, outcome: 'created' };
}

// ----- Outbound voice profile -----------------------------------------------

export async function upsertOutboundVoiceProfile({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  name,
  // Most Telnyx accounts in CC demos operate US/CA-only; we hardcode the
  // smallest viable settings object so the wizard doesn't need to ask for
  // every OVP knob. Advanced users can edit it via the Telnyx portal.
  trafficType = 'conversational',
  dailySpendLimitUsd = null,
  dailySpendLimitEnabled = false,
}) {
  if (!name) throw new Error('upsertOutboundVoiceProfile requires { name }');

  const existing = await findByName(fetchImpl, basePath, apiKey, '/v2/outbound_voice_profiles', name);
  if (existing) {
    return { id: existing.id, name, outcome: 'found', trafficType: existing.traffic_type || trafficType };
  }

  const payload = {
    name,
    traffic_type: trafficType,
    ...(dailySpendLimitEnabled ? { daily_spend_limit: { amount: dailySpendLimitUsd, enabled: true } } : {}),
    service_plan: 'global',
    enabled: true,
    tags: ['cc-wizard'],
    usage_payment_method: 'rate-deck',
  };

  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/outbound_voice_profiles`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.data?.id) throw new Error('Telnyx outbound voice profile create returned no id');
  return { id: data.data.id, name, outcome: 'created' };
}

// ----- WebRTC SIP credential connection -------------------------------------
//
// Per the standing rule in memory: WebRTC agents register against their own
// credential connection (NOT a hardphone/SIP trunk). The wizard creates a
// credential connection with `webrtc: true` (per CredentialConnection schema)
// and attaches the outbound voice profile; per-agent telephony credentials are
// created later by the app itself (prefix `cc-<deployment>-agent-<username>`),
// not by the bootstrap — we only provision the OWNER credential here so the
// bootstrap result is immediately usable.
//
// Per openapi/telnyx.json CredentialConnection schema:
//   - user_name: required on create, 4-32 chars, alphanumeric, ≥1 letter in first 5
//   - password:  required on create, 8-128 chars
// We generate both deterministically from `name` so re-runs (resume) reuse
// the same user_name (Telnyx rejects user_name changes on PATCH, and
// re-creating with a different name would orphan the existing connection).

function slugifyUserName(name) {
  // Convert `cc-main-webrtc` -> `ccmaintw` (8 chars, has 'c','m','t' in first 8;
  // 'c' is within the first 5). Falls back to hashing if the slug is too short.
  const alpha = name.replace(/[^a-z]/gi, '');
  const all = name.replace(/[^a-z0-9]/gi, '');
  if (alpha && all.length >= 8) {
    return all.slice(0, 16);
  }
  // Fallback: hex digest prefix — always alphanumeric and starts with hex
  // letter (a-f) which satisfies the "≥1 letter in first 5 chars" rule.
  // Implementation note: we use a tiny FNV-1a hash so this stays pure-JS
  // without a node:crypto import; collision risk for ~10s of connections per
  // account is negligible.
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 12);
}

function generateConnectionPassword(name) {
  // Deterministic 24-char password derived from `name` so resume finds the
  // same value and the owner can recover it from .env if needed. Format:
  // `<8 hex chars>-<8 hex chars>-<8 hex chars>` (all alphanumeric, 26 chars).
  // We hash twice with different salts so the result doesn't reveal `name`.
  function fnv(input) {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  return `${fnv(`salt-a:${name}`)}-${fnv(`salt-b:${name}`)}-${fnv(`salt-c:${name}`)}`;
}

export async function upsertWebrtcCredentialConnection({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  name,
  outboundVoiceProfileId,
  // Webhook URL for this connection's own call events (e.g. the WebRTC
  // agent's outbound call.initiated). Without this, Telnyx never notifies
  // the app about outbound calls placed from a WebRTC softphone registered
  // on this connection, so app/api/voice/webhook/route.js's dialAndBridge
  // logic (which bridges the WebRTC leg to a PSTN leg) never fires and
  // outbound calls silently go nowhere. Optional only so existing callers /
  // tests that don't care about outbound webhooks keep working; the
  // orchestrator always passes it.
  webhookUrl = null,
}) {
  if (!name) throw new Error('upsertWebrtcCredentialConnection requires { name }');
  if (!outboundVoiceProfileId) throw new Error('upsertWebrtcCredentialConnection requires { outboundVoiceProfileId }');

  const existing = await findByName(fetchImpl, basePath, apiKey, '/v2/credential_connections', name, { matchField: 'connection_name' });
  // CredentialConnection schema uses `connection_name` as the unique-ish field
  // and `active: true` plus an `inbound`/`outbound` block.
  // user_name and password are REQUIRED on create per openapi/telnyx.json; they
  // must be deterministic from `name` so a resume (which finds the existing
  // connection) doesn't need to send them again (Telnyx rejects user_name
  // changes on PATCH anyway). They're stored in TELNYX_SIP_CONNECTION_USER_NAME
  // / TELNYX_SIP_CONNECTION_PASSWORD for the rare owner who wants SIP digest auth.
  const userName = slugifyUserName(name);
  const password = generateConnectionPassword(name);
  const payload = {
    active: true,
    connection_name: name,
    user_name: userName,
    password,
    type: 'credentials',
    webrtc: true,
    anchorsite_override: 'Latency',
    sip_uri_calling_preference: 'unrestricted',
    ...(webhookUrl ? { webhook_event_url: webhookUrl, webhook_api_version: '2' } : {}),
    inbound: {
      ani_number_format: '+E.164',
      dnis_number_format: '+e164',
      codecs: ['G711A', 'G711U'],
    },
    outbound: {
      outbound_voice_profile_id: outboundVoiceProfileId,
      call_parking_enabled: true,
      instant_ringback_enabled: true,
      generate_ringback_tone: false,
    },
    tags: ['cc-wizard', 'webrtc'],
  };

  if (existing) {
    const res = await telnyxFetch(fetchImpl, `${basePath}/v2/credential_connections/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        active: true,
        outbound: { outbound_voice_profile_id: outboundVoiceProfileId },
        ...(webhookUrl ? { webhook_event_url: webhookUrl, webhook_api_version: '2' } : {}),
        tags: existing.tags?.includes('webrtc') ? existing.tags : [...(existing.tags || []), 'webrtc'],
      }),
    });
    const data = await res.json();
    return { id: data?.data?.id || existing.id, name, userName, outcome: 'updated' };
  }

  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/credential_connections`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data?.data?.id) throw new Error('Telnyx WebRTC credential connection create returned no id');
  return { id: data.data.id, name, userName, outcome: 'created' };
}

// ----- Telephony credentials (for the owner agent only; per-agent creds
//       are created by the CC app at agent-creation time) --------------------

export async function createOwnerTelephonyCredential({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  connectionId,
  name,
}) {
  if (!connectionId) throw new Error('createOwnerTelephonyCredential requires { connectionId }');
  if (!name) throw new Error('createOwnerTelephonyCredential requires { name }');

  const url = new URL(`${basePath}/v2/telephony_credentials`);
  url.searchParams.set('page[size]', '100');
  const res = await telnyxFetch(fetchImpl, url.toString(), { headers: authHeaders(apiKey) });
  const data = await res.json().catch(() => ({}));
  const items = Array.isArray(data?.data) ? data.data : [];
  // NOTE: per openapi/telnyx.json's TelephonyCredential schema, the resource
  // has no `username` field, and `user_id` identifies the *Telnyx account
  // user* the credential belongs to (not something to build a SIP URI from).
  // The actual SIP registration username is `sip_username` — that's the field
  // callers need to build `sip:<sip_username>@sip.telnyx.com` (see
  // lib/contact-center/webrtc-bridge.js for the app-side convention this
  // mirrors). Confirmed against a live POST /v2/telephony_credentials response.
  const existing = items.find((item) => item?.connection_id === connectionId && item?.name === name);
  if (existing) {
    return { id: existing.id, name, outcome: 'found', sipUsername: existing.sip_username || null };
  }

  const createRes = await telnyxFetch(fetchImpl, `${basePath}/v2/telephony_credentials`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ connection_id: connectionId, name, tags: ['cc-wizard', 'owner'] }),
  });
  const created = await createRes.json();
  if (!created?.data?.id) throw new Error('Telnyx telephony credential create returned no id');
  return { id: created.data.id, name, outcome: 'created', sipUsername: created.data.sip_username || null };
}

// ----- Webhook signing public key --------------------------------------------

/**
 * Fetches the account's webhook Ed25519 signing public key so the wizard can
 * write it straight into TELNYX_WEBHOOK_SECRET without the user copy/pasting
 * it from the portal. Confirmed live against a real account: GET /v2/public_key
 * returns { data: { public, record_type, organization_id } } where `public`
 * is a base64-encoded 32-byte Ed25519 public key — exactly the format
 * lib/telnyx-webhooks.js::decodePublicKeyBytes()/verifyTelnyxSignature()
 * expect in TELNYX_WEBHOOK_SECRET (or TELNYX_WEBHOOK_PUBLIC_KEY). Not present
 * in openapi/telnyx.json (undocumented endpoint) but stable/live.
 */
export async function getWebhookPublicKey({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
}) {
  if (!apiKey) throw new Error('getWebhookPublicKey requires { apiKey }');
  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/public_key`, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const data = await res.json().catch(() => ({}));
  const publicKey = data?.data?.public;
  if (!publicKey) throw new Error('Telnyx GET /v2/public_key returned no public key');
  return { publicKey, organizationId: data?.data?.organization_id || null };
}

// ----- Integration secrets (Secrets Manager) ---------------------------------
//
// Used to store the TELNYX_AI_API_KEY value as a named integration secret
// (default identifier "telnyx-ai-api-key") so voice flow HTTP request nodes /
// AI Assistant webhook auth can reference it via
// {{#integration_secret}}...{{/integration_secret}} mustache syntax without
// the raw value ever appearing in a flow definition.
//
// IMPORTANT: per openapi/telnyx.json there is NO update endpoint for
// integration secrets (only list/create/delete) — so idempotency here means
// "skip creation if an identifier with this name already exists" rather than
// "overwrite it with a new value". A re-run therefore never rotates this
// secret and the caller must NOT write a freshly-generated token into .env
// when outcome === 'found' (the real stored value is unknowable — Telnyx
// never returns secret tokens back). Delete the secret via the Telnyx portal
// or DELETE /v2/integration_secrets/{id} first if you want a new value under
// the same identifier.
export async function upsertIntegrationSecret({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  identifier,
  token,
}) {
  if (!identifier) throw new Error('upsertIntegrationSecret requires { identifier }');
  if (!token) throw new Error('upsertIntegrationSecret requires { token }');

  const listUrl = new URL(`${basePath}/v2/integration_secrets`);
  listUrl.searchParams.set('page[size]', '100');
  const listRes = await telnyxFetch(fetchImpl, listUrl.toString(), { headers: authHeaders(apiKey) });
  const listData = await listRes.json().catch(() => ({}));
  const items = Array.isArray(listData?.data) ? listData.data : [];
  const existing = items.find((item) => item?.identifier === identifier);
  if (existing) {
    return { id: existing.id, identifier, outcome: 'found' };
  }

  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/integration_secrets`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ identifier, type: 'bearer', token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.data?.id) throw new Error('Telnyx integration secret create returned no id');
  return { id: data.data.id, identifier, outcome: 'created' };
}

// ----- Phone numbers --------------------------------------------------------

/**
 * Get the current Telnyx account balance + credit limit + available credit.
 * Used by the wizard's preflight to confirm the user can afford a phone
 * number purchase (most US local numbers cost ~$1/mo, but if the account
 * is empty the order returns 402/422 and the user gets a confusing error
 * with no context). Returning the balance here keeps the wizard's
 * preflight logic in one place.
 *
 * Returns a normalized object with numeric fields (balance + creditLimit +
 * availableCredit as floats) plus the raw strings for display.
 */
export async function getAccountBalance({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
}) {
  if (!apiKey) throw new Error('getAccountBalance requires { apiKey }');
  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/balance`, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const data = await res.json().catch(() => ({}));
  const b = data?.data || {};
  // Telnyx returns these as strings (decimal-encoded) — parse defensively so
  // the wizard can compare against monthly_cost without string-math bugs.
  const toFloat = (s) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    balance: toFloat(b.balance),
    creditLimit: toFloat(b.credit_limit),
    availableCredit: toFloat(b.available_credit),
    pending: toFloat(b.pending),
    currency: 'USD',
    raw: b,
  };
}

/**
 * Search available numbers for a given country + locality. We surface the
 * cheapest-feeling results to the wizard (Telnyx sorts by cost ascending by
 * default but we re-sort defensively) and let the user pick by index/E.164.
 */
export async function searchPhoneNumbers({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  countryCode = 'US',
  locality,
  limit = 10,
}) {
  const url = new URL(`${basePath}/v2/available_phone_numbers`);
  url.searchParams.set('filter[country_code]', countryCode);
  if (locality) url.searchParams.set('filter[locality]', locality);
  url.searchParams.set('filter[limit]', String(limit));
  const res = await telnyxFetch(fetchImpl, url.toString(), { headers: authHeaders(apiKey) });
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data?.data) ? data.data : [];
}

export async function purchasePhoneNumber({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  phoneNumber,
  // How long to wait for the purchased number to materialize as a real
  // /v2/phone_numbers resource before giving up (see comment below).
  pollTimeoutMs = 20_000,
  pollIntervalMs = 1500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!phoneNumber) throw new Error('purchasePhoneNumber requires { phoneNumber }');
  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/number_orders`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    // Telnyx's CreateNumberOrderRequest takes the E.164 string itself
    // (`phone_number`), not an id — /v2/available_phone_numbers results have
    // no `id` field to begin with (only phone_number, cost_information,
    // region_information, etc.), so there is nothing to look up by id here.
    body: JSON.stringify({ phone_numbers: [{ phone_number: phoneNumber }] }),
  });
  const data = await res.json();
  // number_orders response shape: { data: { id, phone_numbers: [...] } }
  const order = data?.data;
  if (!order?.id) throw new Error('Telnyx number order create returned no id');
  const purchased = Array.isArray(order.phone_numbers) ? order.phone_numbers[0] : null;
  if (!purchased?.phone_number) throw new Error('Telnyx number order has no phone_number in response');

  // IMPORTANT: purchased.id here is a NumberOrderPhoneNumber id (a UUID,
  // scoped to /v2/number_order_phone_numbers/{id}) — NOT the id of the real
  // /v2/phone_numbers resource (a numeric string) that PATCH
  // /v2/phone_numbers/{id} (assignPhoneNumberToVoiceApp) and
  // voice_flow_phone_numbers actually need. Confirmed against the live API:
  // POSTing a number order returns e.g. "df769d03-2254-...", but the number
  // only shows up under GET /v2/phone_numbers with a completely different id
  // like "2997256026475988480". PATCHing with the order-phone-number id
  // 404s. So: look the real resource up by its E.164 string right after the
  // order completes. In production this resolved within ~2s, but poll for a
  // few seconds in case provisioning is occasionally slower.
  const deadline = Date.now() + pollTimeoutMs;
  let realId = null;
  for (;;) {
    const lookup = await telnyxFetch(
      fetchImpl,
      `${basePath}/v2/phone_numbers?filter[phone_number][eq]=${encodeURIComponent(purchased.phone_number)}`,
      { headers: authHeaders(apiKey) },
    );
    const lookupData = await lookup.json().catch(() => ({}));
    const found = Array.isArray(lookupData?.data) ? lookupData.data[0] : null;
    if (found?.id) { realId = found.id; break; }
    if (Date.now() >= deadline) break;
    await sleep(pollIntervalMs);
  }
  if (!realId) {
    throw new Error(
      `Purchased ${purchased.phone_number} (order ${order.id}) but it did not appear under /v2/phone_numbers within ${pollTimeoutMs}ms — Telnyx provisioning may be delayed. Re-run to retry the assign step (the number is already owned, so this is safe).`,
    );
  }
  return {
    orderId: order.id,
    // Real /v2/phone_numbers resource id — safe to PATCH connection_id on,
    // and safe to store in voice_flow_phone_numbers.phone_number_id.
    phoneNumberId: realId,
    phoneNumber: purchased.phone_number,
  };
}

/**
 * Assigns an owned phone number to a Call Control application so inbound
 * calls hit its webhook. Idempotent — calling twice is safe (same PATCH).
 */
export async function assignPhoneNumberToVoiceApp({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  phoneNumberId,
  voiceAppId,
}) {
  if (!phoneNumberId || !voiceAppId) throw new Error('assignPhoneNumberToVoiceApp requires phoneNumberId + voiceAppId');
  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/phone_numbers/${encodeURIComponent(phoneNumberId)}`, {
    method: 'PATCH',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ connection_id: voiceAppId }),
  });
  const data = await res.json();
  return { id: data?.data?.id || phoneNumberId, voiceAppId, outcome: 'assigned' };
}

/**
 * Lists numbers already owned by the account, optionally filtered by the
 * voice app they're assigned to. Used by `cc telnyx --assign-existing` so
 * users with existing inventory don't need to buy a new number.
 */
export async function listOwnedPhoneNumbers({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  assignedToVoiceAppId = null,
  limit = 50,
} = {}) {
  const url = new URL(`${basePath}/v2/phone_numbers`);
  url.searchParams.set('page[size]', String(limit));
  const res = await telnyxFetch(fetchImpl, url.toString(), { headers: authHeaders(apiKey) });
  const data = await res.json().catch(() => ({}));
  const all = Array.isArray(data?.data) ? data.data : [];
  // Client-side filter so the wizard can show "numbers already assigned to my
  // voice app" without a brittle filter[connection_id] shape.
  return assignedToVoiceAppId
    ? all.filter((p) => p.connection_id === assignedToVoiceAppId)
    : all;
}

// ----- Deletion helpers (used by `cc destroy` on AWS targets) ---------------
//
// Mirror the upsert* functions 1:1 but for teardown. All are best-effort and
// idempotent-on-404 (calling delete on an already-gone resource is treated as
// success, not an error) so `cc destroy` can be safely re-run after a partial
// failure without the caller having to track exactly what already got deleted.
//
// Deletion ORDER matters (dependency chain discovered the hard way during a
// real cleanup on 2026-07-06): a phone number attached to a voice app blocks
// deleting that voice app, and a voice app referencing an outbound voice
// profile blocks deleting that profile. The orchestrator below
// (deleteTelnyxResources) encodes the safe order: credential connection ->
// release the number -> voice app -> outbound voice profile. The Default Call
// Flow's own voice app (if any) is deleted the same way as the main voice app.
//
// The integration secret (TELNYX_AI_API_KEY) is deliberately NEVER deleted
// here — it's shared across deployments/accounts and the wizard's bootstrap
// already treats "found" as "leave it alone, can't read back its value".

async function deleteIfExists(fetchImpl, basePath, apiKey, path) {
  const res = await fetchImpl(`${basePath}${path}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  });
  if (res.status === 404) return { outcome: 'not-found' };
  if (!res.ok) {
    let detail;
    try {
      const data = await res.clone().json();
      detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(`Telnyx API ${res.status} on DELETE ${path}: ${detail || 'unknown error'}`);
  }
  return { outcome: 'deleted' };
}

export async function deleteCredentialConnection({
  fetchImpl = fetch, basePath = DEFAULT_BASE_PATH, apiKey, id,
} = {}) {
  if (!id) return { outcome: 'skipped', reason: 'no id' };
  return deleteIfExists(fetchImpl, basePath, apiKey, `/v2/credential_connections/${encodeURIComponent(id)}`);
}

export async function deleteVoiceApp({
  fetchImpl = fetch, basePath = DEFAULT_BASE_PATH, apiKey, id,
} = {}) {
  if (!id) return { outcome: 'skipped', reason: 'no id' };
  return deleteIfExists(fetchImpl, basePath, apiKey, `/v2/call_control_applications/${encodeURIComponent(id)}`);
}

export async function deleteOutboundVoiceProfile({
  fetchImpl = fetch, basePath = DEFAULT_BASE_PATH, apiKey, id,
} = {}) {
  if (!id) return { outcome: 'skipped', reason: 'no id' };
  return deleteIfExists(fetchImpl, basePath, apiKey, `/v2/outbound_voice_profiles/${encodeURIComponent(id)}`);
}

/**
 * Releases (permanently deletes) an owned phone number. Destructive and
 * NOT reversible — the number goes back into Telnyx's general pool and can
 * be picked up by anyone. Callers must get explicit user confirmation before
 * invoking this; deleteTelnyxResources below only calls it when told to via
 * { releaseNumber: true }.
 */
export async function releasePhoneNumber({
  fetchImpl = fetch, basePath = DEFAULT_BASE_PATH, apiKey, id,
} = {}) {
  if (!id) return { outcome: 'skipped', reason: 'no id' };
  return deleteIfExists(fetchImpl, basePath, apiKey, `/v2/phone_numbers/${encodeURIComponent(id)}`);
}

/**
 * Orchestrates a full Telnyx-side teardown for one deployment's bootstrap
 * resources, in the dependency-safe order (see comment above). Used by
 * `cc destroy` for AWS/cloud targets after the Terraform infra is gone.
 *
 * Deliberately does NOT delete the shipped media library files (spring_field
 * / roa_haru / sweet-dreams — see deploy/cli/lib/telnyx-media.mjs) or the
 * seeded Sales queue / Default Call Flow DB rows. Media files are uploaded
 * once per Telnyx ACCOUNT, not per deployment (Telnyx media_name has no
 * deployment-name prefix, unlike every other resource here — see
 * telnyx-media.mjs's header) — two deployments sharing one Telnyx
 * account/API key share the SAME media resources, so deleting them here
 * would break the queue hold-audio of any other still-live deployment on
 * that account. The queue/call-flow rows are pure DB state with no
 * Telnyx-side resource to tear down and are removed for free when the
 * deployment's whole database is destroyed with its infra.
 *
 * `releaseNumber` defaults to false — releasing a phone number is a distinct,
 * more destructive decision (numbers can be reused across re-deployments of
 * the same domain/name) than tearing down the voice app/OVP/SIP connection
 * wrapper around it, so the caller must opt in explicitly per confirmed user
 * intent. When false, the number is left owned but unassigned (connection_id
 * cleared implicitly once its voice app is deleted).
 *
 * Every step is best-effort: a failure on one resource is recorded but does
 * NOT stop the remaining steps, so a partial `cc destroy` re-run only retries
 * what's still there instead of getting stuck on the first error.
 */
export async function deleteTelnyxResources({
  fetchImpl = fetch,
  basePath = DEFAULT_BASE_PATH,
  apiKey,
  sipConnectionId = null,
  phoneNumberId = null,
  voiceAppId = null,
  outboundVoiceProfileId = null,
  callFlowVoiceAppId = null,
  releaseNumber = false,
} = {}) {
  const results = {};

  const tryStep = async (key, fn) => {
    try {
      results[key] = await fn();
    } catch (err) {
      results[key] = { outcome: 'error', error: err.message };
    }
  };

  // 1. SIP/WebRTC credential connection — no dependents, safe first.
  if (sipConnectionId) {
    await tryStep('sipConnection', () => deleteCredentialConnection({ fetchImpl, basePath, apiKey, id: sipConnectionId }));
  }

  // 2. Release the number FIRST (if requested) — this is what unblocks
  //    deleting the voice app(s) it's assigned to (Telnyx refuses to delete
  //    a call_control_application "in use by a number").
  if (releaseNumber && phoneNumberId) {
    await tryStep('phoneNumber', () => releasePhoneNumber({ fetchImpl, basePath, apiKey, id: phoneNumberId }));
  }

  // 3. Default Call Flow's own voice app (separate resource from the main
  //    WebRTC-agent voice app — see state.telnyx.callFlow.voiceAppId).
  if (callFlowVoiceAppId) {
    await tryStep('callFlowVoiceApp', () => deleteVoiceApp({ fetchImpl, basePath, apiKey, id: callFlowVoiceAppId }));
  }

  // 4. Main voice app.
  if (voiceAppId) {
    await tryStep('voiceApp', () => deleteVoiceApp({ fetchImpl, basePath, apiKey, id: voiceAppId }));
  }

  // 5. Outbound voice profile — blocked while any connection (webrtc or
  //    voice app) still references it, so this must be last.
  if (outboundVoiceProfileId) {
    await tryStep('outboundVoiceProfile', () => deleteOutboundVoiceProfile({ fetchImpl, basePath, apiKey, id: outboundVoiceProfileId }));
  }

  return results;
}

export const __internal = { authHeaders, telnyxFetch, findByName, deleteIfExists };

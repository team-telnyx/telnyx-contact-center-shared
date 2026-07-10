import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEFAULT_BASE_PATH = 'https://api.telnyx.com';

// Telnyx Media Storage API client for the deploy wizard's Telnyx
// provisioning step — uploads the fixed set of audio files the shipped
// Default Call Flow / seeded "Sales" queue reference by media_name (see
// lib/default-call-flow-template.mjs and
// lib/seeded-default-queue-template.mjs's header comments), so a fresh
// Telnyx account has them available before the app's first inbound call.
//
// Same idempotency contract as telnyx-bootstrap.mjs's upsert* functions:
// find-by-name first (GET /v2/media/{name} — 404 means "doesn't exist yet"),
// only upload when missing. Telnyx media_name is globally unique PER
// ACCOUNT, not per-deployment (there is no deployment-name prefix the way
// voice apps/OVPs/SIP connections get one — see
// telnyx-bootstrap-orchestrator.mjs's nameForDeployment) — multiple
// deployments sharing one Telnyx account/API key will find-and-reuse the
// SAME media files rather than creating per-deployment duplicates. This is
// intentional: media files are inert, shared assets (no per-deployment
// config or Telnyx-side coupling), so re-uploading the same audio for every
// deployment would just waste storage. It also means deleteTelnyxResources
// (`cc destroy`) deliberately does NOT delete media files — see
// telnyx-bootstrap.mjs's deleteTelnyxResources docstring for the equivalent
// per-deployment-resource cleanup this is intentionally excluded from.
//
// All calls go through injectable fetchImpl, same pattern as
// telnyx-bootstrap.mjs, for unit-testability without a live account.

function authHeaders(apiKey) {
  if (!apiKey) throw new Error('Telnyx API key is required');
  return { Authorization: `Bearer ${apiKey}` };
}

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

/**
 * Looks up a single media resource by its exact media_name. Returns null on
 * a 404 (not found — the expected "needs uploading" case), throws on any
 * other error status (auth failure, etc.) via telnyxFetch.
 */
export async function findMedia({
  fetchImpl = fetch, basePath = DEFAULT_BASE_PATH, apiKey, name,
} = {}) {
  if (!name) throw new Error('findMedia requires { name }');
  const res = await fetchImpl(`${basePath}/v2/media/${encodeURIComponent(name)}`, {
    headers: authHeaders(apiKey),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    // Reuse telnyxFetch's error-detail extraction for any non-404 failure.
    await telnyxFetch(fetchImpl, `${basePath}/v2/media/${encodeURIComponent(name)}`, { headers: authHeaders(apiKey) });
  }
  const data = await res.json().catch(() => ({}));
  return data?.data || null;
}

/**
 * Uploads a local file to Telnyx Media Storage under the given media_name,
 * skipping the upload entirely if a resource with that name already exists
 * (idempotent — safe to call on every wizard run / resume). TTL is set to
 * the API's maximum (~20 years, same value the app's own
 * app/api/admin/media-library upload route already uses) since these are
 * permanent, shipped assets, not transient recordings.
 *
 * `readFileImpl` is injectable for tests; production callers rely on the
 * default (real filesystem read of the shipped asset under
 * deploy/cli/assets/media/).
 */
export async function upsertMedia({
  fetchImpl = fetch, basePath = DEFAULT_BASE_PATH, apiKey, name, filePath,
  readFileImpl = readFile,
} = {}) {
  if (!name) throw new Error('upsertMedia requires { name }');
  if (!filePath) throw new Error('upsertMedia requires { filePath }');

  const existing = await findMedia({
    fetchImpl, basePath, apiKey, name,
  });
  if (existing) {
    return { name, outcome: 'found', contentType: existing.content_type || null };
  }

  const buffer = await readFileImpl(filePath);
  const form = new FormData();
  const blob = new Blob([buffer], { type: 'audio/mpeg' });
  form.append('media', blob, basename(filePath));
  form.append('media_name', name);
  // Maximum allowed by the API (630720000s = ~20 years) — mirrors the app's
  // own media-library upload route (app/api/admin/media-library/route.js).
  form.append('ttl_secs', '630719999');

  const res = await telnyxFetch(fetchImpl, `${basePath}/v2/media`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  return { name, outcome: 'created', contentType: data?.data?.content_type || null };
}

/**
 * Uploads every entry in `files` (each `{ name, filePath }`), continuing
 * past individual failures (mirrors telnyx-bootstrap.mjs's
 * deleteTelnyxResources's "best-effort, one failure doesn't block the
 * rest" contract) so a transient failure on one file doesn't prevent the
 * other two from uploading. Returns a { name: result } map; each result is
 * either the upsertMedia() success shape or { outcome: 'error', error }.
 */
export async function ensureMediaFiles({
  fetchImpl = fetch, basePath = DEFAULT_BASE_PATH, apiKey, files = [],
  readFileImpl = readFile, log = () => {},
} = {}) {
  const results = {};
  for (const file of files) {
    try {
      // eslint-disable-next-line no-await-in-loop -- small fixed list (3 files), sequential keeps log output ordered and per-file error handling simple.
      const result = await upsertMedia({
        fetchImpl, basePath, apiKey, name: file.name, filePath: file.filePath, readFileImpl,
      });
      results[file.name] = result;
      log(`  ${result.outcome === 'created' ? '✔' : '✔'} Media file  "${file.name}"  ${result.outcome}`);
    } catch (err) {
      results[file.name] = { name: file.name, outcome: 'error', error: err.message };
      log(`  ✖ Media file  "${file.name}"  failed: ${err.message}`);
    }
  }
  return results;
}

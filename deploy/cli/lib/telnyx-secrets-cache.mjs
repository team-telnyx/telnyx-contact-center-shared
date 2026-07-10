import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// Durable side-channel cache for ONE-TIME secrets that Telnyx never lets us
// read back after creation (currently: TELNYX_AI_API_KEY, the integration
// secret's token — see telnyx-bootstrap-orchestrator.mjs's
// upsertIntegrationSecret comment: create/list/delete only, no update/read).
//
// Why this exists: Telnyx bootstrap now runs BEFORE the .env is written /
// container is built (see runWizard's step order, changed in #1153). On a
// completely fresh deploy, docker/production/.env doesn't exist yet at the
// moment the secret is created, so there's nothing on disk to fall back to
// if the process crashes between "secret created in Telnyx" and "provision
// step writes .env" (a window that now spans an entire docker build, 1-3
// minutes). Persisting the value here the moment it's created closes that
// gap: even a hard crash mid-build leaves the token recoverable on the next
// `cc up` resume, instead of the token being unrecoverable forever (the app
// would then need the secret manually recreated in the Telnyx portal).
//
// File is gitignored alongside .cc-credentials.txt / .cc-state.json, mode
// 0600. Deliberately NOT cleared after a successful .env write — keeping it
// around is a harmless, permanent backup copy (same convention as
// .cc-credentials.txt for the owner password), and avoids an extra failure
// mode where cleanup itself could race with a crash.

function cachePath(deployDir) {
  return join(deployDir, '.cc-telnyx-secrets.json');
}

export async function readSecretsCache(deployDir) {
  try {
    const raw = await readFile(cachePath(deployDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merges `updates` into the on-disk cache (only overwrites keys present in
 * `updates`; leaves any other previously-cached keys untouched) and persists
 * with restrictive permissions. Swallows errors (logged via `log`, not
 * thrown) — a read-only host / chmod failure shouldn't fail the whole
 * deployment; the on-screen output + the eventual .env write are still the
 * primary source of truth.
 */
export async function mergeSecretsCache(deployDir, updates, { log = () => {} } = {}) {
  if (!deployDir || !updates || Object.keys(updates).length === 0) return;
  const path = cachePath(deployDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    const existing = await readSecretsCache(deployDir);
    const merged = { ...existing, ...updates };
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { await chmod(path, 0o600); } catch { /* mode on writeFile is sufficient on POSIX */ }
  } catch (err) {
    log(`  ⚠ Could not persist one-time Telnyx secret cache to ${path}: ${err.message}`);
  }
}

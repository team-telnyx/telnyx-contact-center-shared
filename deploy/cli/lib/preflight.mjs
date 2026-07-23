import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

const execFileAsync = promisify(execFile);

// Preflight check registry. Each check returns { status: 'ok'|'warn'|'fail', label, detail, hint }.
// Phase 1 scope: Local target only (Docker, compose, ports, Telnyx API key).
// Cloud-provider checks (AWS CLI, az, doctl, gcloud, HCLOUD_TOKEN) are added in Phase 4
// alongside their terraform roots — the registry is structured (checksFor(target)) so
// adding a provider's checks later doesn't touch this file's existing entries.

// Default ports each target needs free on the *host*. Cloud targets don't expose app ports
// on the user's machine (they run on the remote VM), so the host-port list is local-only.
// 5432 is included for the default Local Docker Postgres container. Users who already run
// Postgres locally can either pick a different host port (the wizard re-runs preflight after
// mapping) or point the wizard at their existing Postgres via the port-conflict step.
export const LOCAL_PORTS = [3000, 3001, 5432];

export function defaultPortsFor(target) {
  if (target === 'local') return [...LOCAL_PORTS];
  return [];
}

export function findFreePortInRange(start = 5433, end = 5440, host = '0.0.0.0') {
  // Returns the first port in [start, end] that binds cleanly, or null if none free.
  // Sequential bind+close is intentionally synchronous-per-port so we don't race the
  // kernel's TIME_WAIT reuse and report a false-positive free port.
  return new Promise((resolve) => {
    let port = start;
    const tryNext = () => {
      if (port > end) return resolve(null);
      const candidate = port;
      port += 1;
      const server = net.createServer();
      server.once('error', () => {
        tryNext();
      });
      server.once('listening', () => {
        server.close(() => resolve(candidate));
      });
      server.listen(candidate, host);
    };
    tryNext();
  });
}

async function commandVersion(cmd, args = ['--version'], execImpl = execFileAsync) {
  try {
    const { stdout } = await execImpl(cmd, args);
    return stdout != null ? stdout.trim().split('\n')[0] : '';
  } catch (err) {
    return null;
  }
}

export async function checkDocker({ execImpl = execFileAsync } = {}) {
  const version = await commandVersion('docker', ['--version'], execImpl);
  if (version === null) {
    return {
      key: 'docker', status: 'fail', label: 'Docker',
      detail: 'not found',
      hint: 'Install Docker Desktop (macOS/Windows) or Docker Engine (Linux): https://docs.docker.com/get-docker/',
    };
  }
  try {
    await execImpl('docker', ['info']);
    return { key: 'docker', status: 'ok', label: 'Docker', detail: `${version} running` };
  } catch {
    return {
      key: 'docker', status: 'fail', label: 'Docker',
      detail: `${version} installed, daemon not reachable`,
      hint: 'Start Docker Desktop, or `sudo systemctl start docker` on Linux.',
    };
  }
}

export async function checkDockerCompose({ execImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execImpl('docker', ['compose', 'version']);
    return { key: 'compose', status: 'ok', label: 'Docker Compose', detail: stdout.trim().split('\n')[0] };
  } catch {
    return {
      key: 'compose', status: 'fail', label: 'Docker Compose',
      detail: 'not found (docker compose plugin missing)',
      hint: 'Docker Compose v2 ships with recent Docker Desktop/Engine; upgrade Docker or install the compose plugin.',
    };
  }
}
async function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export function hintForBusyPort(port) {
  // 5432 has its own hint because the most common cause is "I already have a local Postgres
  // for development" — the wizard's port-conflict step offers to point at it instead of
  // telling the user to stop it. Other ports are usually app port collisions.
  if (port === 5432) {
    return 'Port 5432 is in use, usually by a local Postgres. In the wizard pick "use existing Postgres" to point at it, or "different host port" to map Docker Postgres onto (e.g.) 5433.';
  }
  return `Stop whatever is listening on ${port}, or edit docker/production/compose.yaml port mappings.`;
}

export async function checkPorts(ports = LOCAL_PORTS) {
  const results = await Promise.all(ports.map((p) => isPortFree(p)));
  const busy = ports.filter((_, i) => !results[i]);
  if (busy.length === 0) {
    return { key: 'ports', status: 'ok', label: 'Ports', detail: `${ports.join('/')} free` };
  }
  // Aggregate hints per busy port so 5432 gets its own guidance.
  const hints = busy.map((p) => hintForBusyPort(p));
  return {
    key: 'ports', status: 'fail', label: 'Ports',
    detail: `${busy.join(', ')} already in use`,
    hint: hints.join(' '),
  };
}

/**
 * Verifies a connection to an *existing* Postgres reachable at host:port with the
 * given credentials. Used by the port-conflict step when the user picks "use existing
 * Postgres". Returns { ok, version, error } — `version` is the server version string
 * on success so the UI can show "PostgreSQL 17.7 on localhost:5433" without a second probe.
 *
 * We use `psql` (already a documented dependency for the bootstrap path) rather than
 * pulling in the pg driver just for a connectivity check. PGPASSWORD avoids leaking
 * the secret via argv on shared hosts.
 */
export async function checkExistingPostgres({ host, port, user, password, execImpl = execFileAsync } = {}) {
  if (!host || !port || !user) {
    return { ok: false, error: 'host/port/user required' };
  }
  const env = { ...process.env, PGPASSWORD: password || '' };
  try {
    const { stdout, stderr } = await execImpl(
      'psql',
      ['-h', host, '-p', String(port), '-U', user, '-d', 'postgres', '-tAc', 'select version();'],
      { env },
    );
    const version = (stdout || '').trim().split('\n')[0] || '';
    if (!version) {
      return { ok: false, error: (stderr || '').trim() || 'no response from psql' };
    }
    return { ok: true, version };
  } catch (err) {
    // psql exits non-zero on auth failure / unreachable / wrong port — surface a short reason.
    const msg = (err && err.message) || 'psql failed';
    return { ok: false, error: msg.split('\n').slice(-2).join(' ').trim() };
  }
}

/**
 * Checks whether a database with the given name already exists on the existing Postgres.
 * Returns { exists, error }. Used to refuse to silently overwrite another app's data —
 * the wizard requires an explicit DROP confirmation (or a fresh DB name) if the DB exists.
 */
export async function checkPostgresDatabaseExists({ host, port, user, password, database, execImpl = execFileAsync } = {}) {
  const env = { ...process.env, PGPASSWORD: password || '' };
  try {
    const { stdout } = await execImpl(
      'psql',
      ['-h', host, '-p', String(port), '-U', user, '-d', 'postgres', '-tAc',
        `SELECT 1 FROM pg_database WHERE datname='${String(database).replace(/'/g, "''")}';`],
      { env },
    );
    return { exists: (stdout || '').trim() === '1', error: null };
  } catch (err) {
    return { exists: false, error: (err && err.message) || 'psql failed' };
  }
}

/**
 * Optional dependency — only required when the user picks "use existing Postgres" in the
 * port-conflict step. Warn (don't fail) so the wizard still proceeds to that step and can
 * surface a clearer "install psql and re-run" message there.
 */
export async function checkPsql({ execImpl = execFileAsync } = {}) {
  const version = await commandVersion('psql', ['--version'], execImpl);
  if (!version) {
    return {
      key: 'psql', status: 'warn', label: 'psql (optional)',
      detail: 'not found — only required if you point the wizard at an existing local Postgres',
      hint: 'brew install postgresql@17 (macOS) or apt install postgresql-client (Linux).',
    };
  }
  return { key: 'psql', status: 'ok', label: 'psql (optional)', detail: version };
}

/**
 * Validates a Telnyx API key with a cheap, side-effect-free GET call and (when
 * reachable) surfaces balance so the wizard can warn before a number purchase.
 */
export async function checkTelnyxApiKey({ apiKey, fetchImpl = fetch, basePath = 'https://api.telnyx.com' } = {}) {
  if (!apiKey) {
    return {
      key: 'telnyx-key', status: 'fail', label: 'Telnyx API key',
      detail: 'not provided',
      hint: 'Get one from https://portal.telnyx.com/#/app/api-keys, or set TELNYX_API_KEY in your shell.',
    };
  }
  try {
    const res = await fetchImpl(`${basePath}/v2/available_phone_numbers?filter[limit]=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        key: 'telnyx-key', status: 'fail', label: 'Telnyx API key',
        detail: 'rejected (invalid or revoked)',
        hint: 'Double-check the key in https://portal.telnyx.com/#/app/api-keys',
      };
    }
    if (!res.ok) {
      return {
        key: 'telnyx-key', status: 'warn', label: 'Telnyx API key',
        detail: `unexpected response (HTTP ${res.status}) — continuing, will be re-validated in the Telnyx bootstrap step`,
      };
    }
    return { key: 'telnyx-key', status: 'ok', label: 'Telnyx API key', detail: 'valid' };
  } catch (err) {
    return {
      key: 'telnyx-key', status: 'warn', label: 'Telnyx API key',
      detail: `could not reach Telnyx API (${err.message}) — will re-check before bootstrap`,
    };
  }
}

// Minimum US number monthly cost is currently ~$1.00 (see telnyx-bootstrap.mjs
// pickPhoneNumber's own $0.10-buffer check), but the wizard needs a preflight
// gate to happen BEFORE any Telnyx object is created — otherwise the user goes
// through the docker-build step first and only discovers the funding issue at
// the very end (Step 7 / Telnyx bootstrap), 2-3 minutes into the run. This
// check just wants a low, hardcoded bar the wizard can actually explain to
// the user in a single line ("~$5.00 min recommended to cover a number plus a
// bit of usage") rather than trying to compute the exact cheapest candidate's
// price (that would require an extra live number search here too).
export const MIN_TELNYX_BALANCE_USD = 5.0;

/**
 * Confirms the Telnyx account has enough available credit to cover a phone
 * number purchase (mandatory step 7 of the wizard) before the user sinks time
 * into docker build + compose up. Distinct from the fundability check inside
 * `pickPhoneNumber` (which compares against the *actual* cheapest candidate
 * found) — this one is a cheap, no-search preflight sanity check using a fixed
 * floor so we can fail fast with a clear "go fund your account" message.
 */
export async function checkTelnyxBalance({ apiKey, fetchImpl = fetch, basePath = 'https://api.telnyx.com', minBalanceUsd = MIN_TELNYX_BALANCE_USD } = {}) {
  if (!apiKey) {
    return {
      key: 'telnyx-balance', status: 'warn', label: 'Telnyx account balance',
      detail: 'no API key yet — will be checked once you provide one',
    };
  }
  try {
    const res = await fetchImpl(`${basePath}/v2/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      // Already reported by checkTelnyxApiKey — don't double-report as a
      // separate fail here, just warn so the overall check list stays readable.
      return {
        key: 'telnyx-balance', status: 'warn', label: 'Telnyx account balance',
        detail: 'could not check (API key rejected — see Telnyx API key check above)',
      };
    }
    if (!res.ok) {
      return {
        key: 'telnyx-balance', status: 'warn', label: 'Telnyx account balance',
        detail: `unexpected response (HTTP ${res.status}) — will be re-checked before number purchase`,
      };
    }
    const data = await res.json().catch(() => ({}));
    const b = data?.data || {};
    const toFloat = (s) => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };
    const availableCredit = toFloat(b.available_credit);
    const balance = toFloat(b.balance);
    if (availableCredit < minBalanceUsd) {
      return {
        key: 'telnyx-balance', status: 'fail', label: 'Telnyx account balance',
        detail: `$${availableCredit.toFixed(2)} available — need at least $${minBalanceUsd.toFixed(2)} to cover a mandatory phone number purchase`,
        hint: `Fund your Telnyx account at https://portal.telnyx.com/#/app/payment/billing-payments, then re-run.`,
      };
    }
    return {
      key: 'telnyx-balance', status: 'ok', label: 'Telnyx account balance',
      detail: `$${availableCredit.toFixed(2)} available (balance $${balance.toFixed(2)})`,
    };
  } catch (err) {
    return {
      key: 'telnyx-balance', status: 'warn', label: 'Telnyx account balance',
      detail: `could not reach Telnyx API (${err.message}) — will re-check before number purchase`,
    };
  }
}

export async function checkCloudflared({ required = false, execImpl = execFileAsync } = {}) {
  const version = await commandVersion('cloudflared', ['--version'], execImpl);
  if (!version) {
    return required
      ? {
          key: 'cloudflared', status: 'fail', label: 'cloudflared (required — no public domain given)',
          detail: 'not found — required to auto-start a public webhook tunnel since no domain was provided',
          hint: 'brew install cloudflared (macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/, then re-run',
        }
      : {
          key: 'cloudflared', status: 'warn', label: 'cloudflared (optional)',
          detail: 'not found — needed only if you want a public webhook tunnel for Local target',
          hint: 'brew install cloudflared (macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
        };
  }
  return {
    key: 'cloudflared',
    status: 'ok',
    label: required ? 'cloudflared (required — will auto-start a tunnel)' : 'cloudflared (optional)',
    detail: version,
  };
}

/**
 * Runs the check set appropriate for a target. Phase 1 implements 'local' fully;
 * cloud provider entries are stubbed (added in Phase 4 per-provider PRs).
 *
 * 'existing-postgres' is a Local sub-mode where the user pointed the wizard at their
 * own Postgres: the bundled postgres container is skipped, the port-5432 check no
 * longer applies, and `psql` is required (not optional).
 */
export function checksFor(target, { existingPostgres = false } = {}) {
  if (target === 'local') {
    if (existingPostgres) {
      // Existing-Postgres mode: skip the bundled port check (host has its own Postgres
      // listening on 5432 by definition) but require psql for the connection probe.
      return ['docker', 'compose', 'psql', 'telnyx-key', 'telnyx-balance', 'cloudflared'];
    }
    return ['docker', 'compose', 'ports', 'telnyx-key', 'telnyx-balance', 'cloudflared'];
  }
  // Cloud targets (aws/azure/gcp): docker+compose still apply
  // (cloud-init installs Docker on the VM, but the CLI itself needs a working
  // local Docker for --build fallback / local testing) plus provider CLI checks
  // land here in Phase 4.
  return ['docker', 'compose', 'telnyx-key', 'telnyx-balance'];
}

export async function runPreflight({
  target,
  apiKey,
  ports,
  existingPostgres = false,
  // True when the Local target has no public domain configured — the wizard
  // will auto-start a cloudflared quick tunnel, so cloudflared itself becomes
  // a hard requirement (not merely a nice-to-have) for this run.
  needsTunnel = false,
  execImpl = execFileAsync,
  fetchImpl = fetch,
} = {}) {
  const wanted = checksFor(target, { existingPostgres });
  const effectivePorts = ports ?? (existingPostgres ? [] : defaultPortsFor(target));
  const runners = {
    docker: () => checkDocker({ execImpl }),
    compose: () => checkDockerCompose({ execImpl }),
    ports: () => checkPorts(effectivePorts),
    psql: () => checkPsql({ execImpl }),
    'telnyx-key': () => checkTelnyxApiKey({ apiKey, fetchImpl }),
    'telnyx-balance': () => checkTelnyxBalance({ apiKey, fetchImpl }),
    cloudflared: () => checkCloudflared({ required: needsTunnel, execImpl }),
  };
  const results = [];
  for (const key of wanted) {
    if (!runners[key]) continue;
    results.push(await runners[key]());
  }
  const hasFail = results.some((r) => r.status === 'fail');
  const hasWarn = results.some((r) => r.status === 'warn');
  return { results, canContinue: !hasFail, hasWarn, ports: effectivePorts };
}

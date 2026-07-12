import { randomBytes } from 'node:crypto';

// Generates docker/production/.env from docker/production/sample.env.
//
// Design: rather than hand-maintaining a duplicate list of every sample.env key
// (which silently drifts when someone adds a new var), we parse sample.env at
// generation time and rewrite each `KEY=` line in place. This makes "generated
// file has every key sample.env has" true by construction, and the parity test
// below still asserts it so a future refactor can't quietly break that guarantee.
//
// Only ~4 values are meant to be prompted interactively by the wizard: Telnyx
// API key, owner email, owner password (or auto-generate), and the public base
// URL/domain (or localhost for local target). Everything else is either
// auto-generated (secrets) or defaulted (optional integrations, left blank —
// Telnyx resource IDs are filled in later by the telnyx-bootstrap step, not here).

const KEY_LINE_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseSampleEnvKeys(sampleEnvText) {
  const keys = [];
  for (const line of sampleEnvText.split('\n')) {
    const match = line.match(KEY_LINE_RE);
    if (match && !keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/**
 * Parses an existing .env's KEY=value lines into a plain map (unquoting the
 * same way renderEnvFile/serializeValue quotes them). Used to recover
 * one-time secrets (see STICKY_ONE_TIME_ENV_KEYS) that a fresh env-generation
 * pass would otherwise blank out, since Telnyx integration secrets have no
 * read-back / update endpoint — once created, the token value is only ever
 * known to us at creation time.
 */
export function parseEnvValues(envText) {
  const values = {};
  for (const line of String(envText || '').split('\n')) {
    const match = line.match(KEY_LINE_RE);
    if (!match) continue;
    let [, key, rawValue] = match;
    if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
      rawValue = rawValue.slice(1, -1).replace(/\\"/g, '"');
    }
    values[key] = rawValue;
  }
  return values;
}

// Env keys that are written ONCE from a value we can never re-derive or
// re-read from Telnyx (integration secrets have create/list/delete only, no
// update/read-back — see telnyx-bootstrap-orchestrator.mjs's
// upsertIntegrationSecret comment). If a later run's Telnyx bootstrap finds
// the secret already exists (outcome 'found'), it correctly omits the key
// from envUpdates rather than writing a token Telnyx never actually
// registered — but runLocalProvisionStep regenerates the WHOLE .env from
// sample.env on every run, which would otherwise blank these keys back out.
// Preserve whatever is already on disk for these specific keys whenever the
// current run doesn't supply a fresh value.
export const STICKY_ONE_TIME_ENV_KEYS = ['TELNYX_AI_API_KEY'];

export function randomBase64Secret(bytesLen = 32) {
  return randomBytes(bytesLen).toString('base64');
}

export function randomHexSecret(bytesLen = 32) {
  return randomBytes(bytesLen).toString('hex');
}

export function randomPassword(bytesLen = 18) {
  // base64url-ish, no padding chars, safe to paste into shells/.env without quoting
  return randomBytes(bytesLen).toString('base64').replace(/[+/=]/g, '').slice(0, 20);
}

export function requiredPromptFields() {
  return [
    { key: 'telnyxApiKey', label: 'Telnyx API key', secret: true },
    { key: 'ownerEmail', label: 'Owner admin email' },
    { key: 'ownerPassword', label: 'Owner admin password (leave blank to auto-generate)', secret: true, optional: true },
    { key: 'baseUrl', label: 'Public base URL (e.g. https://cc.example.com, or http://localhost:3000 for local)' },
  ];
}

function emailDomain(email) {
  const at = String(email || '').indexOf('@');
  return at >= 0 ? email.slice(at + 1) : '';
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Builds the full key -> value map for every key sample.env defines, given the
 * ~4 interactively-collected answers plus the postgres wiring chosen in the
 * port-conflict step (`postgresMode` ∈ {null, 'bundled', 'existing'} + the
 * `existingPostgres` host/port/user/database/password block).
 *
 * `target` ('local' | cloud provider name) only affects POSTGRES_HOST convenience
 * default (compose service name vs a cloud-init-provided host) — everything else
 * is target-agnostic.
 *
 * When the user picked 'existing' Postgres, we suppress the bundled container
 * via `COMPOSE_PROFILES=no-with-pg` (compose v2 picks up env-set profiles) and
 * write the connection params straight into .env. The bundled container's
 * POSTGRES_* secrets are still written (unused) so a later flip back to bundled
 * is a one-line edit.
 */
export function buildEnvValues({ sampleKeys, answers, target = 'local', postgresMode = null, existingPostgres = null } = {}) {
  const baseUrl = (answers.baseUrl || '').replace(/\/$/, '');
  const host = hostFromUrl(baseUrl);
  const ownerPassword = answers.ownerPassword || randomPassword();
  // Track which values we auto-generated vs. which came from the user. The
  // wizard needs to surface the auto-generated ones (currently the owner
  // password) so the user can actually log in — without this, picking the
  // "auto-generate" branch is a one-way trip to "I can't authenticate".
  const generatedSecrets = {};
  if (!answers.ownerPassword) generatedSecrets.ownerPassword = ownerPassword;
  const domainForAllowedEmails = answers.allowedEmailDomains || emailDomain(answers.ownerEmail) || 'domain.com';

  const mode = postgresMode || 'bundled';
  const existing = mode === 'existing' && existingPostgres ? existingPostgres : null;

  const defaults = {
    DEBUG: '',
    APP_ENV: 'production',
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: baseUrl,
    ALLOWED_DEV_ORIGINS: host,
    NEXT_PUBLIC_BASE_URL: baseUrl,
    NEXTAUTH_URL: baseUrl,
    APP_BASE_URL: baseUrl,
    NEXTAUTH_SECRET: randomBase64Secret(32),
    ALLOWED_EMAIL_DOMAINS: domainForAllowedEmails,
    DEFAULT_OWNER_EMAIL: answers.ownerEmail || '',
    DEFAULT_OWNER_PASSWORD: ownerPassword,
    // NOTE: sample.env defaults POSTGRES_HOST to "localhost", which is wrong
    // once the app runs inside the compose network — the Postgres container
    // is reachable at the service name "postgres". Existing-Postgres mode
    // overrides this with the user-supplied host (or `host.docker.internal`
    // on macOS/Windows so the in-container app can reach a host-local server).
    POSTGRES_HOST: existing
      ? (existing.host || (target === 'local' ? 'host.docker.internal' : 'postgres'))
      : (target === 'local' ? 'postgres' : (answers.postgresHost || 'postgres')),
    POSTGRES_PORT: existing ? String(existing.port || 5432) : '5432',
    POSTGRES_DB: existing?.database || 'contact_center',
    POSTGRES_USER: existing?.user || 'contact_center',
    POSTGRES_PASSWORD: existing?.password || randomBase64Secret(24).replace(/[+/=]/g, ''),
    // Compose-mode wiring: read by the wizard + compose.yaml. Bundled = default
    // (container starts). Existing = wizard/user added `no-with-pg` to COMPOSE_PROFILES
    // so the bundled container is suppressed and the app talks to existing.host:port.
    POSTGRES_MODE: mode,
    // Host port the bundled Postgres container is mapped onto. Only consumed by
    // compose.yaml when mode=bundled and 5432 is already taken on the host.
    // Stringified explicitly so values map keys are all strings — test assertions
    // and downstream string interpolation (sample.env rewriter, compose.yaml ${})
    // can rely on a string value here regardless of how the caller passes it.
    POSTGRES_HOST_PORT: answers.postgresHostPort != null ? String(answers.postgresHostPort) : '5432',
    // Blank by default (Local target's bundled compose Postgres has no TLS
    // enforcement). The AWS cloud path overrides this to 'true' in
    // aws-cloud.mjs's provisionAwsInfra (dbOverrides) once the RDS endpoint
    // is known — RDS Postgres enforces `rds.force_ssl=1` by default, so an
    // unset/false value here would make every AWS deploy fail with
    // "no pg_hba.conf entry for host ... no encryption" (confirmed via a
    // real E2E run, 2026-07-06, cc-test3). Existing-Postgres mode (any
    // target) also leaves this blank — the user's own Postgres may or may
    // not enforce TLS; they can set POSTGRES_SSL by hand in that case.
    POSTGRES_SSL: '',
    // compose v2 picks up COMPOSE_PROFILES from the environment, so a single env var
    // is enough to suppress the bundled Postgres container.
    COMPOSE_PROFILES: mode === 'existing' ? 'no-with-pg' : 'with-pg',
    // Per-deployment named-volume slug. The compose `volumes:` block turns this
    // into the actual Docker volume name `cc-postgres-<slug>`. Defaults to the
    // deployment name when known, falling back to 'main'. Changing this value
    // (or running a new deployment with a different name) is the supported way
    // to start from a clean Postgres volume without inheriting data from a
    // previous install that may have left the database in a broken state
    // (e.g. a volume from before the role/db was added, which causes Postgres
    // to log "Skipping initialization" and leave the cluster without the
    // expected user).
    POSTGRES_VOLUME_NAME: answers.postgresVolumeName || 'main',
    EMAIL_API_KEY: '',
    EMAIL_DOMAIN: '',
    EMAIL_FROM: '',
    THREAT_NOTIFICATION_ADDRESS: '',
    TELNYX_BASE_PATH: 'https://api.telnyx.com',
    TELNYX_API_KEY: answers.telnyxApiKey || '',
    TELNYX_WEBHOOK_SECRET: '',
    // Filled in later by deploy/cli/lib/telnyx-bootstrap.mjs (Phase 2 / wizard Step 7):
    TELNYX_CALL_CONTROL_ID: '',
    TELNYX_OUTBOUND_VOICE_PROFILE: '',
    TELNYX_MESSAGING_PROFILE_ID: '',
    TELNYX_SIP_CONNECTION_ID: '',
    // Default Call Flow's own dedicated Telnyx voice app id (separate from
    // TELNYX_CALL_CONTROL_ID, the main WebRTC-agent voice app — see the
    // standing "one TeXML app per thing" rule). Filled in by
    // ensureCoreTelnyxObjects during Telnyx provisioning, read by
    // lib/seed-default-call-flow.mjs at app boot to wire the seeded flow's
    // incoming_call node. Blank means "Default Call Flow not seeded" (e.g.
    // Telnyx bootstrap didn't complete) — the app just has no flow yet.
    TELNYX_DEFAULT_FLOW_VOICE_APP_ID: '',
    // NOTE: no TELNYX_OWNER_TELEPHONY_CREDENTIAL_ID / _USER_NAME here — the
    // owner's telephony credential is created lazily by the app itself
    // (createUserTelephonyCredentials, called from NextAuth on first login)
    // exactly like it is for every other user, so pre-seeding these was
    // pure duplication of an idempotent app-side mechanism.
    // Defaulted to 'auto' at generation time (Telnyx WebRTC SDK picks the
    // best region automatically); the Telnyx bootstrap step re-writes this
    // same value in-place, so this default only matters if that step is
    // skipped (e.g. --buyNumber=false / bootstrap failure).
    NEXT_PUBLIC_TELNYX_WEBRTC_REGION: 'auto',
    TELNYX_AI_API_KEY: '',
    TELNYX_AI_API_KEY_REF: '',
    DYNAMIC_VARIABLE_WEBHOOK_TEST_ALLOWED_URLS: '',
    TELNYX_SUPERVISOR_FROM_NUMBER: '',
    TELNYX_MAIN_FROM_NUMBER: '',
    // Telnyx resource id (not the E.164 string) for the purchased number —
    // needed by lib/seed-default-call-flow.mjs at app boot to write the
    // voice_flow_phone_numbers join row without a Telnyx API round-trip.
    // Filled in by runTelnyxBootstrap alongside TELNYX_MAIN_FROM_NUMBER.
    TELNYX_MAIN_FROM_NUMBER_ID: '',
    // Object storage (Bug #14 fix): local target (and any manual/non-wizard
    // cloud deploy) defaults to the local-disk driver, which needs none of
    // these — blank is the correct default. AWS cloud deploys overwrite
    // STORAGE_PROVIDER/BUCKET/REGION/ENDPOINT with real values in
    // provisionAwsInfra (deploy/cli/lib/aws-cloud.mjs) right after
    // `terraform apply`, once the bucket actually exists; ACCESS_KEY/
    // SECRET_KEY stay blank there too since the EC2 instance role is used
    // instead (see lib/storage/s3-driver.mjs's cfg()).
    STORAGE_PROVIDER: '',
    STORAGE_BUCKET: '',
    STORAGE_REGION: '',
    STORAGE_ENDPOINT: '',
    STORAGE_FORCE_PATH_STYLE: 'false',
    STORAGE_ACCESS_KEY: '',
    STORAGE_SECRET_KEY: '',
    GOOGLE_ID: '',
    GOOGLE_SECRET: '',
    SECRETS_ENCRYPTION_KEY: randomHexSecret(32),
  };

  const values = {};
  const missingKeys = [];
  for (const key of sampleKeys) {
    if (key in defaults) {
      values[key] = defaults[key];
    } else {
      // Unknown key added to sample.env that we haven't taught envgen about yet:
      // don't silently drop it, surface it so the parity test / a real run fails loudly.
      values[key] = '';
      missingKeys.push(key);
    }
  }
  return { values, missingKeys, generatedSecrets };
}

function serializeValue(value) {
  const str = String(value ?? '');
  if (str === '') return '';
  if (/[\s#\"'\\]/.test(str)) {
    // Escape backslashes first, then quotes — reversing the order would
    // double-escape the backslashes introduced by the quote replacement.
    const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return str;
}

/**
 * Renders the final .env content by rewriting sample.env's KEY= lines in place,
 * preserving all comments/blank lines/ordering — so the generated file remains
 * as self-documenting as sample.env itself.
 */
export function renderEnvFile(sampleEnvText, values) {
  return sampleEnvText
    .split('\n')
    .map((line) => {
      const match = line.match(KEY_LINE_RE);
      if (!match) return line;
      const [, key] = match;
      if (!(key in values)) return line;
      return `${key}=${serializeValue(values[key])}`;
    })
    .join('\n');
}

/**
 * In-place update for an existing .env (e.g. one already on disk in the CC
 * deploy directory) — only the keys present in `updates` are touched; comments,
 * blank lines, key ordering and the rest of the values are preserved exactly.
 * Used by the Telnyx bootstrap step (Phase 2) to write back resource IDs
 * (TELNYX_CALL_CONTROL_ID, TELNYX_SIP_CONNECTION_ID, …) without re-running
 * envgen and clobbering user-edited values.
 *
 * Idempotent: calling twice with the same map is a no-op on the second call.
 */
export function applyEnvUpdates(existingEnvText, updates) {
  const updatedKeys = new Set();
  const lines = existingEnvText.split('\n');
  const rewritten = lines.map((line) => {
    const match = line.match(KEY_LINE_RE);
    if (!match) return line;
    const [, key] = match;
    if (!(key in updates)) return line;
    updatedKeys.add(key);
    return `${key}=${serializeValue(updates[key])}`;
  });
  // Append any update keys that were not already in the file (e.g. if sample.env
  // has been trimmed locally and the bootstrap wants to add a new one). We add
  // them at the bottom as `KEY=value` lines so the user can move them up if
  // they care about ordering.
  const missingKeys = Object.keys(updates).filter((k) => !updatedKeys.has(k));
  if (missingKeys.length > 0) {
    if (rewritten.length > 0 && rewritten[rewritten.length - 1] !== '') {
      rewritten.push('');
    }
    for (const key of missingKeys) {
      rewritten.push(`${key}=${serializeValue(updates[key])}`);
      updatedKeys.add(key);
    }
  }
  return { content: rewritten.join('\n'), updatedKeys: Array.from(updatedKeys) };
}

/**
 * Full pipeline: sample.env text + wizard answers -> generated .env text.
 * Throws if sample.env contains keys envgen doesn't know how to default,
 * rather than silently emitting a blank value for something that might be required.
 *
 * Returns `{ content, values, sampleKeys, generatedSecrets }`:
 *   - `content` — the rendered .env file
 *   - `values` — every key -> value that was applied (debugging + tests)
 *   - `sampleKeys` — every key found in sample.env (parity test feed)
 *   - `generatedSecrets` — auto-generated secret values that the user did NOT
 *     supply themselves. Currently only `ownerPassword` — when the user
 *     pressed Enter at the "leave blank to auto-generate" prompt, we need to
 *     tell them what we picked, otherwise they cannot log in. The wizard writes
 *     these to `deploy/.cc-credentials.txt` (chmod 600) and prints them in the
 *     final summary.
 */
export function generateEnvFile({ sampleEnvText, answers, target = 'local', postgresMode = null, existingPostgres = null } = {}) {
  const sampleKeys = parseSampleEnvKeys(sampleEnvText);
  const { values, missingKeys, generatedSecrets } = buildEnvValues({ sampleKeys, answers, target, postgresMode, existingPostgres });
  if (missingKeys.length > 0) {
    throw new Error(
      `envgen.mjs doesn't have defaults for new sample.env keys: ${missingKeys.join(', ')}. ` +
      'Add them to buildEnvValues() defaults before generating.',
    );
  }
  return { content: renderEnvFile(sampleEnvText, values), values, sampleKeys, generatedSecrets };
}

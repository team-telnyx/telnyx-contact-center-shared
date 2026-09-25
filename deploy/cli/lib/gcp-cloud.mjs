import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  writeTfvars, terraformInit, terraformPlan, terraformApply, terraformDestroy, terraformOutputs, terraformVersion,
  terraformStateList, terraformStateRm,
  createTerraformLineFilter,
} from './terraform.mjs';
import {
  buildAndPackageImage,
} from './cloud-deploy.mjs';
import {
  deploySingleNodeGcp,
} from './gcp-deploy.mjs';
import { parseEnvValues } from './envgen.mjs';

const execFileAsync = promisify(execFileCb);

// All of cc-database-gcp/cc-secrets-gcp/cc-storage-gcp's *_secret_name
// outputs return the FULLY-QUALIFIED Secret Manager resource name
// ("projects/<num>/secrets/<id>" — see e.g. cc-database-gcp/outputs.tf's
// db_secret_name = google_secret_manager_secret.db.name). `gcloud secrets
// versions access/add` wants just the bare secret id for --secret /
// the positional SECRET arg — passing the full "projects/.../secrets/..."
// string there makes gcloud append it onto its own REST path, producing a
// doubled "secrets/projects/.../secrets/<id>" URL and a 404 (confirmed via
// a real E2E run: "Could not populate app/env secret ... 404 ...
// /secrets/projects/.../secrets/cc-gcp1-db-credentials/versions/latest").
// cc-compute-single-gcp's main.tf
// already strips this down to the bare id for the VM startup-script
// (local.app_env_secret_id = element(split("/", var.app_env_secret_name),
// ...)) — this helper is the same fix for the JS-side gcloud CLI calls.
// Idempotent: a bare id passed in (no "/") is returned unchanged.
function toSecretId(secretName) {
  if (!secretName) return secretName;
  const parts = String(secretName).split('/');
  return parts[parts.length - 1];
}

// GCP cloud-target counterpart to aws-cloud.mjs — Terraform apply +
// build/ship/deploy orchestration for the `gcp` target. Phase 1/2 scope:
// single-node only (no HA/multi-node terraform root exists yet — see
// deploy/terraform/gcp/single-node's own header), no HTTPS Load Balancer
// (the AWS ALB+ACM equivalent is intentionally deferred — see
// cc-compute-single-gcp module header). The app is reached over plain HTTP
// on the instance's public IP (or the operator's own domain, pointed at
// that IP by hand — the wizard prints the exact instruction in the summary,
// same as the AWS no-ALB fallback path).
//
// Two structural differences from the AWS path that shape this whole module:
//   1. No SSM RunCommand equivalent — GCP's analogous mechanism (OS Config
//      guest policies) is heavier to set up for a single ad-hoc command per
//      deploy. Instead this uses `gcloud compute ssh --tunnel-through-iap
//      --command=...`, which needs no agent beyond the IAP firewall rule
//      cc-network-gcp already opens (see gcp-deploy.mjs for the actual
//      remote-script mechanics).
//   2. Image artifact ships to GCS instead of S3 (`gcloud storage cp`
//      instead of `aws s3 cp`) — see gcp-deploy.mjs's uploadArtifactToGcs.

const REPO_ROOT_FROM_DEPLOY_DIR = (deployDir) => join(deployDir, '..');

function terraformRootFor(deployDir) {
  // Single-node only for now — mirrors terraformRootFor(deployDir, 'single')
  // in aws-cloud.mjs, just without a topology parameter since there's only
  // one root. Kept as a function (not a constant) for parity with the AWS
  // module's shape and so a future HA root slots in the same way.
  return join(deployDir, 'terraform', 'gcp', 'single-node');
}

export { terraformRootFor };

/**
 * GCP preflight additions beyond preflight.mjs's existing checks (Docker,
 * Terraform version, Telnyx key/balance): gcloud CLI presence, active
 * authentication, and that the configured project is reachable. Called from
 * runPreflightStep when state.target === 'gcp'.
 */
export async function checkGcpCloudPreflight({
  projectId, execImpl = execFileAsync,
} = {}) {
  const results = [];

  const tfVersion = await terraformVersion({ execImpl });
  if (!tfVersion) {
    results.push({
      key: 'terraform', status: 'fail', label: 'Terraform',
      detail: 'not found',
      hint: 'Install Terraform >= 1.7: brew install hashicorp/tap/terraform (macOS) or https://developer.hashicorp.com/terraform/install',
    });
  } else {
    const [major, minor] = tfVersion.split('.').map(Number);
    const ok = major > 1 || (major === 1 && minor >= 7);
    results.push(ok
      ? { key: 'terraform', status: 'ok', label: 'Terraform', detail: `${tfVersion} (>= 1.7 required)` }
      : { key: 'terraform', status: 'fail', label: 'Terraform', detail: `${tfVersion} — too old`, hint: 'Upgrade to Terraform >= 1.7.' });
  }

  let gcloudVersion = null;
  try {
    const { stdout } = await execImpl('gcloud', ['--version']);
    gcloudVersion = String(stdout || '').trim().split('\n')[0] || 'installed';
    results.push({ key: 'gcloud', status: 'ok', label: 'gcloud CLI', detail: gcloudVersion });
  } catch {
    results.push({
      key: 'gcloud', status: 'fail', label: 'gcloud CLI',
      detail: 'not found',
      hint: 'Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install, then `gcloud auth login` and `gcloud auth application-default login`.',
    });
    // No point probing auth/project without the CLI itself.
    return results;
  }

  try {
    const { stdout } = await execImpl('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=json']);
    const accounts = JSON.parse(stdout || '[]');
    if (accounts.length === 0) throw new Error('no active account');
    results.push({
      key: 'gcloud-auth', status: 'ok', label: 'gcloud auth',
      detail: `authenticated as ${accounts[0].account}`,
    });
  } catch (err) {
    results.push({
      key: 'gcloud-auth', status: 'fail', label: 'gcloud auth',
      detail: 'no active account',
      hint: 'Run `gcloud auth login` (for CLI calls) and `gcloud auth application-default login` (for Terraform).',
    });
    return results;
  }

  // Also required: Application Default Credentials, which Terraform's google
  // provider reads — distinct from `gcloud auth login`'s own credentials.
  try {
    await execImpl('gcloud', ['auth', 'application-default', 'print-access-token']);
    results.push({ key: 'gcloud-adc', status: 'ok', label: 'Application Default Credentials', detail: 'present' });
  } catch {
    results.push({
      key: 'gcloud-adc', status: 'fail', label: 'Application Default Credentials',
      detail: 'not found — Terraform\'s google provider needs these separately from `gcloud auth login`',
      hint: 'Run `gcloud auth application-default login`.',
    });
  }

  if (projectId) {
    try {
      const { stdout } = await execImpl('gcloud', ['projects', 'describe', projectId, '--format=json']);
      const parsed = JSON.parse(stdout);
      results.push({
        key: 'gcp-project', status: 'ok', label: 'GCP project',
        detail: `${projectId} (${parsed.lifecycleState || 'ACTIVE'})`,
      });
    } catch (err) {
      results.push({
        key: 'gcp-project', status: 'fail', label: 'GCP project',
        detail: `could not describe project "${projectId}" — does it exist, and does the active account have access?`,
        hint: 'Double-check the project id (not the project NAME/number) and IAM permissions.',
      });
    }
  }

  return results;
}

/**
 * Writes the tfvars file for the GCP single-node root from the wizard's
 * collected answers. Explicit key mapping (like writeAwsTfvars), not a
 * generic pass-through, so drift between wizard field names and Terraform
 * variable names is visible/testable at this one call site.
 */
export async function writeGcpTfvars({ deployDir, state } = {}) {
  const root = terraformRootFor(deployDir);
  const vars = {
    project_id: state.infra?.gcpProjectId,
    region: state.region,
    zone: state.infra?.gcpZone,
    deployment_name: state.deploymentName,
    domain: state.domain || '',
    admin_ssh_source_ranges: ['35.235.240.0/20'],
    machine_type: state.gcpMachineType || 'e2-standard-2',
    db_tier: state.gcpDbTier || 'db-custom-1-3840',
    portainer_agent_enabled: Boolean(state.portainer?.agentEnabled),
    portainer_agent_port: state.portainer?.agentPort || 9001,
    portainer_server_cidrs: state.portainer?.serverCidrs || [],
    // Phase 3: HTTPS Load Balancer + Google-managed cert. Set by the
    // wizard's runGcpLbStep based on whether the operator opted in — false
    // (default) keeps the Phase 1/2 behavior (plain HTTP on the instance's
    // public IP). Mirrors writeAwsTfvars's alb_enabled gate.
    lb_enabled: Boolean(state.infra?.lbEnabled),
    // Cloud DNS automation (parity with AWS's dns_zone_id/dnsManaged gate)
    // — only takes effect when BOTH lbEnabled and dnsManaged are true;
    // gcpDnsManaged alone (without lbEnabled) or gcpDnsZoneName alone
    // (without explicit operator consent, i.e. dnsManaged) are each
    // insufficient on their own, matching runGcpDnsStep's own gating.
    dns_managed_zone: (state.infra?.lbEnabled && state.infra?.gcpDnsManaged) ? (state.infra?.gcpDnsZoneName || '') : '',
  };
  await writeTfvars(root, vars);
  return { root, vars };
}

/**
 * Full GCP provisioning pass: terraform init/plan/apply, populate the
 * app/env Secret Manager secret (mirroring provisionAwsInfra's Secrets
 * Manager write — every TELNYX_* id/secret is already known because Telnyx
 * bootstrap runs before this step, per the same ordering rule as AWS), then
 * build+ship+deploy the app image over an IAP-tunneled SSH command.
 */
export async function provisionGcpInfra({
  state, io, answers, deployDir, extraEnvUpdates = {},
  execImpl = execFileAsync, spawnImpl = spawn, sleep,
  onLine,
} = {}) {
  const root = terraformRootFor(deployDir);

  const initStep = (io.longStep || io.step)('Running terraform init...');
  try {
    await terraformInit({ cwd: root, execImpl });
    initStep.succeed('terraform init complete');
  } catch (err) {
    initStep.fail(`terraform init failed: ${err.message}`);
    return { state, aborted: true };
  }

  const planStep = (io.longStep || io.step)('Running terraform plan...');
  let plan;
  try {
    plan = await terraformPlan({ cwd: root, execImpl });
    planStep.succeed(`Plan ready: ${plan.summary ? `${plan.summary.toAdd} to add, ${plan.summary.toChange} to change, ${plan.summary.toDestroy} to destroy` : 'see output'}`);
  } catch (err) {
    planStep.fail(`terraform plan failed: ${err.message}`);
    return { state, aborted: true };
  }

  const confirmed = await io.confirm('Apply this Terraform plan?', false);
  if (!confirmed) {
    io.log('Aborted — nothing was created.');
    return { state, aborted: true };
  }

  const applyStep = (io.longStep || io.step)('Applying Terraform (this can take several minutes for Cloud SQL)...', { timeoutMs: 15 * 60_000 });
  try {
    const filterLine = createTerraformLineFilter();
    await terraformApply({
      cwd: root,
      planFile: plan.planFile,
      spawnImpl,
      onLine: (line) => {
        const filtered = filterLine(line);
        if (filtered !== null) applyStep.info?.(filtered);
        if (onLine) onLine(line);
      },
    });
    applyStep.succeed('Infrastructure created');
  } catch (err) {
    applyStep.fail(`terraform apply failed: ${err.message}`);
    return { state, aborted: true };
  }

  const outputs = await terraformOutputs({ cwd: root, execImpl });

  let nextState = {
    ...state,
    infra: {
      ...state.infra,
      terraformDir: root,
      publicIp: outputs.public_ip || null,
      appUrl: outputs.app_url || answers.baseUrl,
      instanceName: outputs.instance_name || null,
      instanceIds: [outputs.instance_id].filter(Boolean),
      storageBucket: outputs.storage_bucket || null,
      dbSecretName: outputs.db_secret_name || null,
      appEnvSecretName: outputs.app_env_secret_name || null,
      storageHmacSecretName: outputs.storage_hmac_secret_name || null,
      // Phase 3: only present when lb_enabled=true (the terraform outputs
      // are null otherwise — see gcp/single-node's outputs.tf). lbCertName
      // is the google_compute_managed_ssl_certificate resource name, used
      // by cc status / the wizard's post-apply cert-status poll to check
      // provisioning progress (gcloud compute ssl-certificates describe).
      lbIp: outputs.lb_ip || null,
      lbCertName: outputs.cert_name || null,
    },
  };

  const projectId = state.infra?.gcpProjectId;

  // Populate the app/env Secret Manager secret — the GCP equivalent of
  // provisionAwsInfra's `aws secretsmanager put-secret-value` write. Same
  // "one write, no restart-after-the-fact" property: extraEnvUpdates
  // (Telnyx ids) are already known by this point.
  const envUpdateStep = io.step('Populating runtime secret in Secret Manager...');
  try {
    let dbOverrides = {};
    if (nextState.infra.dbSecretName) {
      const { stdout: dbSecretRaw } = await execImpl('gcloud', [
        'secrets', 'versions', 'access', 'latest',
        '--secret', toSecretId(nextState.infra.dbSecretName),
        '--project', projectId,
      ]);
      const dbSecret = JSON.parse(dbSecretRaw);
      dbOverrides = {
        POSTGRES_HOST: dbSecret.host,
        POSTGRES_PORT: String(dbSecret.port || 5432),
        POSTGRES_DB: dbSecret.dbname,
        POSTGRES_USER: dbSecret.username,
        POSTGRES_PASSWORD: dbSecret.password,
        // Cloud SQL instances created after Google's 2024 default-encryption
        // rollout require encrypted connections even over the private-IP/VPC
        // path (no plaintext, no cert pinning required from the app's side).
        // Same effective setting as the AWS RDS path's POSTGRES_SSL=true fix
        // (see aws-cloud.mjs's provisionAwsInfra for that incident) — set
        // proactively here rather than waiting to hit the same class of
        // "no encryption" connection failure against Cloud SQL.
        POSTGRES_SSL: 'true',
        COMPOSE_PROFILES: 'no-with-pg',
      };
    }

    let storageOverride = {};
    if (nextState.infra.storageHmacSecretName) {
      const { stdout: hmacSecretRaw } = await execImpl('gcloud', [
        'secrets', 'versions', 'access', 'latest',
        '--secret', toSecretId(nextState.infra.storageHmacSecretName),
        '--project', projectId,
      ]);
      const hmac = JSON.parse(hmacSecretRaw);
      storageOverride = {
        STORAGE_PROVIDER: 's3',
        STORAGE_BUCKET: nextState.infra.storageBucket,
        // GCS's S3-compatible interop endpoint has no per-region variants
        // the way S3 does — "auto" is the documented placeholder value for
        // this driver's STORAGE_REGION field when the endpoint itself
        // already pins the location (see lib/storage/s3-driver.mjs).
        STORAGE_REGION: 'auto',
        STORAGE_ENDPOINT: 'https://storage.googleapis.com',
        STORAGE_FORCE_PATH_STYLE: 'true',
        STORAGE_ACCESS_KEY: hmac.access_id || '',
        STORAGE_SECRET_KEY: hmac.secret || '',
      };
    }

    // When the HTTPS Load Balancer is enabled, the compute module's URL map
    // (cc-compute-single-gcp's google_compute_url_map.app) routes streaming
    // traffic ONLY for the `ws.<domain>` host header to the 3001 backend —
    // and the very same lb_enabled=true also removes direct access to the
    // instance's app ports (cc-network-gcp's allow_app_ports is
    // count-gated off in that case). Without WS_BASE_URL/STREAMING_WS_URL
    // set explicitly here, lib/voice-flow-engine.js's runtime fallback
    // builds `wss://<NEXT_PUBLIC_BASE_URL host>:3001` — i.e. straight at
    // the bare domain on port 3001, which is neither routed by the LB (only
    // the ws. subdomain is) nor reachable at all (the direct-access
    // firewall rule is gone), so Telnyx streaming/hardphone clients would
    // never connect. Point it at the ws. subdomain the LB's url_map
    // actually serves instead.
    let wsUrlOverride = {};
    if (nextState.infra.lbEnabled && state.domain) {
      wsUrlOverride = { WS_BASE_URL: `wss://ws.${state.domain}` };
    }

    const envMap = { ...answers.envValues, ...extraEnvUpdates, ...dbOverrides, ...storageOverride, ...wsUrlOverride };
    const envText = Object.entries(envMap).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
    // execFile-based execImpl (unlike a real shell) has no stdin-piping
    // support, so `--data-file -` (read from stdin) isn't usable here the
    // way a hand-typed `gcloud ... --data-file -` invocation would work.
    // Write the env text to a throwaway temp file and pass that path as
    // --data-file instead — functionally identical, and still never touches
    // disk anywhere inside the repo (system tmp dir only, deleted right
    // after the call whether it succeeds or fails).
    const tmpEnvPath = join(tmpdir(), `cc-gcp-app-env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await writeFile(tmpEnvPath, envText, 'utf8');
      await execImpl('gcloud', [
        'secrets', 'versions', 'add', toSecretId(nextState.infra.appEnvSecretName),
        '--data-file', tmpEnvPath,
        '--project', projectId,
      ]);
    } finally {
      await unlink(tmpEnvPath).catch(() => {});
    }
    envUpdateStep.succeed('Runtime secret populated');
  } catch (err) {
    envUpdateStep.fail(`Could not populate app/env secret: ${err.message}`);
    return { state: nextState, aborted: true };
  }

  // Build + ship + deploy the image.
  const repoRoot = REPO_ROOT_FROM_DEPLOY_DIR(deployDir);
  const imageTag = `telnyx-contact-center:${state.deploymentName}-${Date.now().toString(36)}`;
  const buildStep = (io.longStep || io.step)('Building Docker image locally (first build can take 1-3 min)...', { timeoutMs: 5 * 60_000 });
  let artifact;
  try {
    artifact = await buildAndPackageImage({
      repoRoot, imageTag, outDir: repoRoot, execImpl,
      buildArgs: {
        // Prefer the wizard's resolved external URL (answers.baseUrl —
        // always https:// once a domain was given, per resolveBaseUrl)
        // over Terraform's own `app_url` output. Without lb_enabled (Phase
        // 1/2 default), Terraform's app_url is plain http://<domain or ip>
        // because it only describes what the INSTANCE itself serves — but
        // the actual supported public entrypoint for a real domain is
        // always the operator's own TLS reverse proxy/CDN in front of it,
        // which serves https://. Baking the http:// terraform output into
        // NEXT_PUBLIC_BASE_URL here would ship a client bundle whose
        // API/origin URLs point at the wrong scheme, breaking things like
        // browser fetch() same-origin checks or triggering mixed-content
        // blocks once the operator's HTTPS proxy is in front of it. Only
        // fall back to the terraform output when there's no baseUrl at all
        // (e.g. a domain-less demo reached via the raw instance IP).
        NEXT_PUBLIC_BASE_URL: answers.baseUrl || nextState.infra.appUrl,
        NEXT_PUBLIC_TELNYX_WEBRTC_REGION: answers.envValues?.NEXT_PUBLIC_TELNYX_WEBRTC_REGION || '',
      },
    });
    buildStep.succeed('Image built and packaged');
  } catch (err) {
    buildStep.fail(`Docker build failed: ${err.message}`);
    return { state: nextState, aborted: true };
  }

  const deployStep = (io.longStep || io.step)('Deploying to node via IAP-tunneled SSH (this can take a few minutes)...', { timeoutMs: 10 * 60_000 });
  try {
    await deploySingleNodeGcp({
      instanceName: nextState.infra.instanceName,
      zone: state.infra?.gcpZone,
      project: projectId,
      bucket: nextState.infra.storageBucket,
      artifact,
      appEnvSecretName: nextState.infra.appEnvSecretName,
      appPort: 3000,
      streamingWsPort: 3001,
      execImpl,
      ...(sleep ? { sleep } : {}),
    });
    deployStep.succeed('Deployed and healthy');
  } catch (err) {
    deployStep.fail(`Deploy failed: ${err.message}`);
    return { state: nextState, aborted: true };
  }

  return { state: nextState, aborted: false, outputs };
}

/**
 * Describes a google_compute_managed_ssl_certificate's current status via
 * `gcloud compute ssl-certificates describe`. Returns the raw
 * managed.status string (PROVISIONING, ACTIVE, FAILED_NOT_VISIBLE, etc.)
 * — see https://cloud.google.com/load-balancing/docs/ssl-certificates/troubleshooting
 * for the full status enum. Never throws on a not-yet-visible cert (the
 * gcloud call itself can fail transiently right after `terraform apply`
 * creates the resource) — returns status: null instead so callers can
 * treat that the same as PROVISIONING (keep polling) rather than a hard
 * error.
 */
export async function describeManagedCertificate({
  certName, project, execImpl = execFileAsync,
} = {}) {
  if (!certName) throw new Error('describeManagedCertificate requires { certName }');
  try {
    const { stdout } = await execImpl('gcloud', [
      'compute', 'ssl-certificates', 'describe', certName,
      '--global', '--project', project, '--format=json',
    ]);
    const parsed = JSON.parse(stdout);
    return {
      status: parsed?.managed?.status || null,
      domainStatus: parsed?.managed?.domainStatus || {},
    };
  } catch {
    return { status: null, domainStatus: {} };
  }
}

/**
 * Polls describeManagedCertificate until status is ACTIVE (issued and
 * attached), or a terminal failure status is reported, or the timeout
 * elapses. This is the GCP equivalent of acm.mjs's waitForCertificateIssued
 * — the key structural difference (see cc-compute-single-gcp's HTTPS LB
 * header) is that there is no separate "request, then validate" phase to
 * orchestrate: the certificate resource already exists the moment
 * `terraform apply` finishes, and Google's CA polls the domain's own DNS
 * record on its own schedule. All this function does is wait for THAT
 * process to converge, once the operator has pointed DNS at `lbIp`.
 *
 * Long default timeout (30 min, matching ACM's) because DNS propagation +
 * Google's own polling interval can take that long — sometimes longer for
 * a freshly-created record, since this is a best-effort wait the wizard
 * doesn't block forever on (see runGcpLbStep: a timeout here doesn't fail
 * the deployment, it just tells the operator to re-check with `cc status`
 * later).
 */
export async function waitForManagedCertificate({
  certName, project, execImpl = execFileAsync,
  timeoutMs = 30 * 60_000, intervalMs = 15_000,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt,
} = {}) {
  if (!certName) throw new Error('waitForManagedCertificate requires { certName }');
  const start = now();
  let attempts = 0;
  let lastStatus = null;
  while (now() - start < timeoutMs) {
    attempts += 1;
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    const result = await describeManagedCertificate({ certName, project, execImpl });
    lastStatus = result.status;
    const elapsedMs = now() - start;
    if (onAttempt) onAttempt({ attempt: attempts, status: lastStatus, elapsedMs });
    if (lastStatus === 'ACTIVE') return { issued: true, attempts, elapsedMs, status: lastStatus };
    if (lastStatus === 'FAILED_NOT_VISIBLE' || lastStatus === 'FAILED_CAA_CHECKING' || lastStatus === 'FAILED_CAA_FORBIDDEN') {
      return {
        issued: false, attempts, elapsedMs, status: lastStatus, terminal: true,
      };
    }
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    await sleep(intervalMs);
  }
  return {
    issued: false, attempts, elapsedMs: now() - start, status: lastStatus, terminal: false,
  };
}

/**
 * `cc update` for GCP: rebuilds the app image from the CURRENT working tree
 * and reships it to the already-provisioned instance, reusing every
 * identifier `provisionGcpInfra` already recorded in `state.infra`
 * (instanceName, gcpZone, storageBucket, appEnvSecretName). Mirrors
 * redeployAwsApp's aws-cloud.mjs counterpart exactly in shape and the same
 * "never touch Terraform, never touch the Secrets Manager write" rules —
 * see that function's docstring for the full rationale (infra changes are
 * a `cc destroy` + `cc up` job, not this one; the Secret Manager secret
 * already holds the correct runtime config from the last deploy and this
 * command has no new information to add to it).
 *
 * Requires `state.infra.instanceName`/`storageBucket`/`appEnvSecretName` to
 * already be populated (i.e. a prior successful `cc up`) — throws a clear
 * error rather than silently no-op'ing if `cc update` is run before any
 * infra exists.
 */
/**
 * GCP counterpart to aws-cloud.mjs's updateAwsEnvSecret — read-merge-write
 * against the app/env Secret Manager secret so `cc telnyx` can land fresh
 * Telnyx resource ids/secrets without clobbering anything else already
 * there. See updateAwsEnvSecret's docstring for the full rationale (same
 * read-merge-write contract, same reason `cc update`'s redeployGcpApp never
 * does this on its own).
 */
export async function updateGcpEnvSecret({ state, envUpdates = {}, execImpl = execFileAsync } = {}) {
  if (!state.infra?.appEnvSecretName) {
    throw new Error('No GCP app/env secret recorded for this deployment yet — run `cc up` first.');
  }
  const projectId = state.infra?.gcpProjectId;
  const { stdout: envRaw } = await execImpl('gcloud', [
    'secrets', 'versions', 'access', 'latest',
    '--secret', toSecretId(state.infra.appEnvSecretName),
    '--project', projectId,
  ]);
  const currentEnv = parseEnvValues(envRaw);
  const merged = { ...currentEnv, ...envUpdates };
  const envText = Object.entries(merged).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
  // Same temp-file-as-stdin workaround as provisionGcpInfra's env write —
  // execFile-based execImpl can't pipe stdin the way a hand-typed
  // `--data-file -` invocation would.
  const tmpEnvPath = join(tmpdir(), `cc-gcp-app-env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmpEnvPath, envText, 'utf8');
    await execImpl('gcloud', [
      'secrets', 'versions', 'add', toSecretId(state.infra.appEnvSecretName),
      '--data-file', tmpEnvPath,
      '--project', projectId,
    ]);
  } finally {
    await unlink(tmpEnvPath).catch(() => {});
  }
  return merged;
}

export async function redeployGcpApp({
  state, io, deployDir, execImpl = execFileAsync, sleep,
} = {}) {
  if (!state.infra?.instanceName || !state.infra?.storageBucket || !state.infra?.appEnvSecretName) {
    throw new Error('No GCP infrastructure recorded for this deployment yet — run `cc up` first (cc update only reships a new build to already-provisioned infra).');
  }
  const projectId = state.infra?.gcpProjectId;

  // Same build-time NEXT_PUBLIC_* rationale as redeployAwsApp (aws-cloud.mjs)
  // — these vars are baked into the JS bundle at build time, so they have
  // to be sourced from the durable copy (Secret Manager) rather than
  // guessed, since state.mjs deliberately never stores app config.
  const readEnvStep = io.step('Reading current runtime config from Secret Manager...');
  let currentEnv = {};
  try {
    const { stdout: envRaw } = await execImpl('gcloud', [
      'secrets', 'versions', 'access', 'latest',
      '--secret', toSecretId(state.infra.appEnvSecretName),
      '--project', projectId,
    ]);
    currentEnv = parseEnvValues(envRaw);
    readEnvStep.succeed('Runtime config read');
  } catch (err) {
    readEnvStep.fail(`Could not read current app/env secret: ${err.message}`);
    return { aborted: true };
  }

  const repoRoot = REPO_ROOT_FROM_DEPLOY_DIR(deployDir);
  const imageTag = `telnyx-contact-center:${state.deploymentName}-${Date.now().toString(36)}`;
  const buildStep = (io.longStep || io.step)('Building Docker image locally (first build can take 1-3 min)...', { timeoutMs: 5 * 60_000 });
  let artifact;
  try {
    artifact = await buildAndPackageImage({
      repoRoot, imageTag, outDir: repoRoot, execImpl,
      // See redeployAwsApp's identical comment (aws-cloud.mjs) — every
      // NEXT_PUBLIC_* build ARG the Dockerfile declares is unrecoverable
      // after the image is built, so forward the full current set from the
      // Secret Manager secret rather than just the two vars this function
      // resolves directly.
      buildArgs: {
        ...Object.fromEntries(Object.entries(currentEnv).filter(([k]) => k.startsWith('NEXT_PUBLIC_'))),
        NEXT_PUBLIC_BASE_URL: currentEnv.NEXT_PUBLIC_BASE_URL || state.infra.appUrl || '',
        NEXT_PUBLIC_TELNYX_WEBRTC_REGION: currentEnv.NEXT_PUBLIC_TELNYX_WEBRTC_REGION || 'auto',
      },
    });
    buildStep.succeed('Image built and packaged');
  } catch (err) {
    buildStep.fail(`Docker build failed: ${err.message}`);
    return { aborted: true };
  }

  const deployStep = (io.longStep || io.step)('Deploying to node via IAP-tunneled SSH (this can take a few minutes)...', { timeoutMs: 10 * 60_000 });
  try {
    await deploySingleNodeGcp({
      instanceName: state.infra.instanceName,
      zone: state.infra?.gcpZone,
      project: projectId,
      bucket: state.infra.storageBucket,
      artifact,
      appEnvSecretName: state.infra.appEnvSecretName,
      appPort: 3000,
      streamingWsPort: 3001,
      execImpl,
      ...(sleep ? { sleep } : {}),
    });
    deployStep.succeed('Deployed and healthy');
  } catch (err) {
    deployStep.fail(`Deploy failed: ${err.message}`);
    return { aborted: true };
  }

  return { aborted: false, imageTag };
}

/**
 * Tears down a GCP deployment's Terraform-managed infrastructure. Mirrors
 * destroyAwsInfra's plan-then-confirm-then-apply shape.
 *
 * Deliberately does NOT touch Telnyx resources — same separation of
 * concerns as the AWS path (cc.mjs's cleanupTelnyxResourcesInteractive
 * handles that, shared across every target).
 */
export async function destroyGcpInfra({
  state, io, deployDir, execImpl = execFileAsync, spawnImpl = spawn, onLine,
} = {}) {
  const root = state.infra?.terraformDir || terraformRootFor(deployDir);

  const initStep = (io.longStep || io.step)('Running terraform init...');
  try {
    await terraformInit({ cwd: root, execImpl });
    initStep.succeed('terraform init complete');
  } catch (err) {
    initStep.fail(`terraform init failed: ${err.message}`);
    return { aborted: true };
  }

  // Pre-destroy state reconciliation for resources whose provider-level
  // destroy behavior needed a `deletion_policy = "ABANDON"` fix to avoid
  // GCP backend races/restrictions at destroy time — see each resource's
  // own .tf comment for its specific rationale:
  //   - cc-database-gcp's google_sql_database/google_sql_user: Postgres
  //     refuses the provider's default explicit DELETE-database/DROP-ROLE
  //     calls (live connections / owned objects).
  //   - cc-network-gcp's google_service_networking_connection: GCP's
  //     backend VPC-peering cleanup for a just-deleted Cloud SQL instance
  //     lags behind the instance delete API call returning success, so an
  //     immediate peering-connection delete right after loses the race
  //     ("Producer services ... are still using this connection").
  // Terraform reads deletion_policy from the STATE at destroy time, not
  // from the current .tf source — a deployment whose `apply` ran before
  // ABANDON was added to source has state that still expects the old
  // default, and no later `cc destroy` re-run against that same state can
  // pick up the newer default merely by the .tf file having changed.
  // Proactively removing these addresses from state before every destroy
  // achieves the same end result ABANDON would have (skip the explicit
  // delete call, let the instance/VPC-level destroy take them with it) —
  // unconditionally, not just for "legacy" deployments, since `terraform
  // state list` can't actually tell us whether a given state already
  // carries the newer deletion_policy value. Confirmed via two real E2E
  // destroy failures against a live GCP project, one per resource, both on
  // a deployment whose state predated the respective ABANDON fix being
  // merged. Best-effort and
  // silent-if-nothing-to-do: terraformStateRm treats an already-absent
  // address as success (e.g. a deployment where Terraform itself already
  // dropped these earlier in a prior partial destroy run).
  try {
    const addresses = await terraformStateList({ cwd: root, execImpl });
    const abandonPolicyAddresses = addresses.filter((a) => (
      a === 'module.database.google_sql_user.app'
      || a === 'module.database.google_sql_database.main'
      || a === 'module.network.google_service_networking_connection.private_services'
    ));
    for (const address of abandonPolicyAddresses) {
      // eslint-disable-next-line no-await-in-loop -- at most 3 addresses, sequential is fine and keeps error handling per-address.
      await terraformStateRm({ cwd: root, address, execImpl });
    }
  } catch {
    // Never block destroy on this best-effort reconciliation — if it fails
    // (e.g. very old terraform binary without `state rm`), destroy just
    // proceeds and may hit the original error, same as before this step
    // existed. Not worth its own io.step/user-visible failure path for a
    // one-time legacy-state fixup.
  }

  const planStep = (io.longStep || io.step)('Running terraform plan -destroy...');
  let plan;
  try {
    plan = await terraformPlan({ cwd: root, destroy: true, execImpl });
    planStep.succeed(`Plan ready: ${plan.summary ? `${plan.summary.toDestroy} resource(s) to destroy` : 'see output'}`);
  } catch (err) {
    planStep.fail(`terraform plan -destroy failed: ${err.message}`);
    return { aborted: true };
  }

  if (plan.summary && plan.summary.toDestroy === 0) {
    io.log('Nothing to destroy — no Terraform-managed resources found for this deployment.');
    return { aborted: false, destroyed: 0 };
  }

  const confirmed = await io.confirm(
    `This will PERMANENTLY destroy ${plan.summary ? plan.summary.toDestroy : 'the'} GCP resource(s) for "${state.deploymentName}" (Compute Engine, Cloud SQL, VPC, GCS bucket, Secret Manager — see the plan above). This cannot be undone. Continue?`,
    false,
  );
  if (!confirmed) {
    io.log('Aborted — nothing was destroyed.');
    return { aborted: true };
  }

  const destroyStep = (io.longStep || io.step)('Applying terraform destroy (this can take several minutes for Cloud SQL)...', { timeoutMs: 15 * 60_000 });
  try {
    const filterLine = createTerraformLineFilter();
    await terraformDestroy({
      cwd: root,
      planFile: plan.planFile,
      spawnImpl,
      onLine: (line) => {
        const filtered = filterLine(line);
        if (filtered !== null) destroyStep.info?.(filtered);
        if (onLine) onLine(line);
      },
    });
    destroyStep.succeed('Infrastructure destroyed');
  } catch (err) {
    destroyStep.fail(`terraform destroy failed: ${err.message}`);
    io.log('  → Some resources may already be gone — re-run `cc destroy` to retry the remainder (terraform destroy is safe to re-run against a partial state).');
    return { aborted: true };
  }

  return { aborted: false, destroyed: plan.summary ? plan.summary.toDestroy : null };
}

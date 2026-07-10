import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

// State file lives at deploy/.cc-state.json (gitignored). It records wizard
// answers and per-step completion so `cc up` can resume an interrupted run,
// and so `status`/`logs`/`update`/`destroy`/`telnyx` can reuse prior answers
// (target, region, deployment name, resource IDs) without re-asking.
//
// Deliberately excludes secrets: passwords/API keys are never written here,
// only non-sensitive identifiers (deployment name, region, resource IDs, URLs).

export const STATE_VERSION = 2;

export function defaultState() {
  return {
    version: STATE_VERSION,
    createdAt: null,
    updatedAt: null,
    consent: null, // { acceptedAt }
    target: null, // 'local' | 'aws' | 'azure' | 'gcp'
    size: null, // 'small' | 'medium' | 'large' | 'custom'
    nodes: null, // number
    region: null, // provider region code, null for local
    // AWS-only. Auto-resolved (never asked) in runRegionStep from AWS's
    // published EC2 Instance Connect IP ranges for the chosen region — lets
    // the EC2 console's browser "Connect" button reach port 22 without
    // opening it to the public internet. See aws-instance-connect-cidrs.mjs.
    awsAdminSshCidrs: [],
    deploymentName: null,
    domain: null,
    ownerEmail: null,
    postgres: {
      // 'bundled' (default) — the wizard starts the docker compose Postgres container.
      // 'existing'  — the user pointed us at a Postgres they already run locally
      //               (because port 5432 was already taken); envgen omits the bundled
      //               container via COMPOSE_PROFILES and writes the host/port/user
      //               the user gave us into the .env instead.
      mode: null, // 'bundled' | 'existing'
      host: null,
      port: null,
      user: null,
      database: null,
      // Secret is NEVER persisted (we only need it for the connection probe + env
      // write-back). If the user re-runs the wizard after a reboot they'll be asked
      // again, same as for the Telnyx API key.
    },
    // When the user keeps bundled mode but the host's 5432 is taken, we expose the
    // bundled container on a different host port (e.g. 5433) and rewrite compose.yaml
    // to map hostPort:5432 -> container:5432. Null = default 5432.
    postgresHostPort: null,
    telnyx: {
      voiceAppId: null,
      outboundVoiceProfileId: null,
      sipConnectionId: null,
      // Default Call Flow's own dedicated Telnyx voice app id (separate from
      // voiceAppId, the main WebRTC-agent voice app). Created during Telnyx
      // provisioning (Step 7) for every target — local AND cloud — with a
      // webhook URL derived from the fixed SEEDED_DEFAULT_FLOW_ID, so the
      // app itself can seed the matching `voice_flows` DB row at boot
      // (lib/seed-default-call-flow.mjs) without the wizard ever needing
      // direct Postgres access (which AWS RDS's private subnet blocks).
      defaultFlowVoiceAppId: null,
      phoneNumber: null,
      phoneNumberId: null,
      messagingProfileId: null,
      // Per-file outcome map from ensureMediaFiles (deploy/cli/lib/telnyx-media.mjs)
      // — { spring_field: { outcome, ... }, roa_haru: {...}, 'sweet-dreams': {...} }.
      // Diagnostics-only, see runTelnyxBootstrapStep's comment on this field.
      mediaFiles: null,
      // Sub-step completion inside the 'telnyx' wizard step (Step 7). Recorded
      // granularly (unlike the coarse `steps.telnyx` flag below) so a crash
      // mid-bootstrap — e.g. the credential connection call 422s after the
      // voice app + OVP already succeeded — can resume by creating only what's
      // still missing instead of re-running the whole orchestrator blind.
      // Each entry is 'pending' | 'done'. The orchestrator itself is already
      // idempotent (find-by-name), so this is a fast-path / user-visibility
      // layer on top of that safety net, not a substitute for it.
      subSteps: {
        outboundVoiceProfile: 'pending',
        voiceApp: 'pending',
        sipConnection: 'pending',
        defaultFlowVoiceApp: 'pending',
        phoneNumber: 'pending',
      },
    },
    infra: {
      // cloud-only: terraform working dir, last-known public IP/URL
      terraformDir: null,
      publicIp: null,
      appUrl: null,
      // AWS cloud targets only. 'single' | 'ha' — decided by the sizing/node-count
      // answers (Large size or an explicit >=2 node count routes to 'ha'). Recorded
      // here (not just derivable from `nodes`) so status/update/destroy don't have
      // to re-derive topology from sizing rules that might change over time.
      awsTopology: null,
      // Populated after `terraform apply` (Phase 4). instanceIds is always an array
      // (length 1 for single-node) so status/update/cloud-deploy.mjs share one shape.
      instanceIds: [],
      albDnsName: null,
      albZoneId: null,
      appTargetGroupArn: null,
      streamingWsTargetGroupArn: null,
      storageBucket: null,
      dbSecretName: null,
      appEnvSecretName: null,
      // AWS single-node only — null until runAwsDnsStep resolves it (true = ALB +
      // ACM in front of the instance, false = plain HTTP directly on the
      // instance, no on-instance TLS). Always true for 'ha' topology (ALB is
      // mandatory there and runAwsDnsStep sets it accordingly). null means "not
      // yet asked" so a resume can tell "never decided" apart from "decided no".
      albEnabled: null,
      // Whether runAwsDnsStep found the domain's hosted zone in THIS AWS
      // account and can manage its A/alias record automatically. false means
      // the operator must point their own DNS at the deployment by hand (the
      // final summary prints the exact instruction either way).
      dnsManaged: false,
      dnsZoneId: null,
      // Multi-node/HA only: ACM certificate ARN + issuance state, so a Ctrl-C
      // mid-validation (plan §4c) can resume without requesting a fresh cert.
      acm: {
        certificateArn: null,
        issued: false,
        // true only when THIS wizard run requested a brand-new certificate
        // (runAwsDnsStep found no existing candidate covering the domain, or
        // the operator explicitly chose "Request a new certificate" over an
        // offered existing one). false when the operator picked an
        // already-existing certificate from the list (e.g. a wildcard like
        // *.example.com someone else issued for other deployments).
        // `cc destroy` uses this to decide whether it's safe to offer
        // deleting the certificate: it must NEVER delete a certificate it
        // didn't create, since that could be backing other, unrelated
        // deployments. Defaults to false (the safe/conservative direction)
        // so state files from before this field existed never trigger an
        // unintended deletion prompt.
        createdByWizard: false,
      },
      // GCP cloud target only (Phase 1/2 — single-node only, no HA yet).
      // `region`/`instanceIds`/`publicIp`/`appUrl`/`storageBucket`/
      // `dbSecretName`/`appEnvSecretName`/`terraformDir` above are already
      // generic enough to be shared with AWS. These are the fields with no
      // AWS equivalent.
      gcpProjectId: null,
      // Zone within `state.region` the Compute Engine instance lives in
      // (e.g. "us-central1-a"). Cloud SQL/GCS are regional, only the VM
      // needs a zone.
      gcpZone: null,
      // Secret Manager resource name for the storage HMAC key/secret pair
      // the app's S3-compatible storage driver uses to talk to GCS (see
      // cc-storage-gcp module) — has no AWS equivalent since S3 access is
      // via the instance's IAM role there, not a bearer credential.
      storageHmacSecretName: null,
      // GCE instance name (Terraform output instance_name) — kept distinct
      // from instanceIds[0] (the numeric instance_id) because gcloud CLI
      // commands (ssh, describe) address instances by NAME, not by the
      // numeric id AWS-style tooling uses.
      instanceName: null,
      // GCP cloud target only, Phase 3. HTTPS Load Balancer + Google-managed
      // SSL certificate — the GCP equivalent of AWS's albEnabled/acm. Unlike
      // AWS's ACM (separate request/validate/poll dance), a
      // google_compute_managed_ssl_certificate is a single Terraform
      // resource whose lifecycle IS the validation — see
      // cc-compute-single-gcp's HTTPS Load Balancer module header for the
      // full explanation. null means "not yet asked" (same convention as
      // AWS's albEnabled) so resume can tell "never decided" apart from
      // "decided no".
      lbEnabled: null,
      // Global static IP of the Load Balancer's forwarding rules (Terraform
      // output lb_ip) — the address the operator must point the domain's
      // DNS A record at. Null until lbEnabled=true and terraform apply has
      // run.
      lbIp: null,
      // Name of the google_compute_managed_ssl_certificate resource
      // (Terraform output cert_name), used to poll gcloud compute
      // ssl-certificates describe for issuance status.
      lbCertName: null,
      // Azure cloud target only (Phase 1/2/3 — single-node only, no HA
      // yet, mirroring GCP's own current scope). Subscription id is asked
      // once in runRegionStep (Terraform's azurerm provider needs it
      // explicitly — no account-wide default the way AWS CLI has a
      // default profile/region). `location` reuses the generic
      // `state.region` field (Azure's own term for what AWS/GCP call a
      // region) — no separate azureLocation field needed.
      azureSubscriptionId: null,
      // Resource group name (Terraform output resource_group_name) — every
      // other Azure resource for this deployment lives inside it, and `az
      // vm run-command`/`az storage blob`/`az keyvault secret` calls all
      // need it explicitly (Azure has no single "account" scope requests
      // implicitly resolve into, unlike AWS's default VPC or the instance
      // id's own account, or GCP's project id already covering everything).
      azureResourceGroup: null,
      // VM name (Terraform output vm_name) — `az vm run-command invoke`
      // addresses instances by name, not a numeric id (same reasoning GCP's
      // instanceName field has over instanceIds[0]).
      vmName: null,
      keyVaultName: null,
      // Azure Blob Storage equivalent of storageBucket — kept as a
      // separate field (not reusing storageBucket) since Storage Account
      // name and Container name are two distinct Azure identifiers (see
      // cc-storage-azure), unlike a single S3/GCS bucket name.
      storageAccount: null,
      storageContainer: null,
      // Phase 3: Application Gateway v2 + Key Vault-backed TLS cert — the
      // Azure equivalent of AWS's albEnabled/acm. Reuses the SAME
      // `lbEnabled` field GCP already defined above rather than adding a
      // third near-identical boolean — target is mutually exclusive
      // per-deployment (a given .cc-state.json is either gcp OR azure,
      // never both), so one shared field is unambiguous and avoids yet
      // another provider-specific name for what is conceptually the same
      // "front this deployment with a managed load balancer" toggle. null
      // means "not yet asked" (same convention as AWS/GCP) so resume can
      // tell "never decided" apart from "decided no".
      appgwPublicIp: null,
      // Azure DNS automation — mirrors gcpDnsManaged/gcpDnsZoneName (zone
      // NAME) but Azure DNS zones are addressed by name+resource-group,
      // not a single globally-unique id/name the way Route53/Cloud DNS
      // are, so a matching zoneResourceGroup field is required alongside
      // the zone name (see cc-network-azure's dns_zone_resource_group var).
      azureDnsManaged: null,
      azureDnsZoneName: null,
      azureDnsZoneResourceGroup: null,
      // Azure Application Gateway TLS certificate provisioning mode — how
      // the cert under Key Vault secret "<deploymentName>-tls-cert" (the
      // exact name cc-compute-single-azure's ssl_certificate block reads,
      // see that module's header) got there. null means "not yet decided"
      // (same convention as lbEnabled/azureDnsManaged) so a resume can
      // tell "never asked" apart from "decided". Three real modes:
      //   'existing'   — operator picked an already-imported certificate
      //                  from THIS deployment's Key Vault (found by
      //                  azure-keyvault-cert.mjs's findCertificatesForDomain)
      //                  and it was copied to the expected secret name.
      //   'letsencrypt' — the wizard issued a fresh cert itself via ACME
      //                  DNS-01 (azure-acme.mjs), only offered when Azure
      //                  DNS is managing the zone (azureDnsManaged=true —
      //                  DNS-01 needs the wizard to create the challenge
      //                  TXT record, which requires zone control).
      //   'manual'     — operator will import their own PFX by hand
      //                  (runAzureLbStep's original, still-supported
      //                  fallback — the only option when Key Vault doesn't
      //                  exist yet on a totally fresh deployment, or when
      //                  the operator simply prefers to manage their own
      //                  cert / already has a purchased one).
      azureTlsCertSource: null,
      // Name of the source certificate object in Key Vault when
      // azureTlsCertSource='existing' (before it was copied to the
      // "<deploymentName>-tls-cert" name Terraform expects) — kept for
      // `cc status`/diagnostics, not read by Terraform itself.
      azureTlsCertSourceName: null,
    },
    // AWS cloud targets only, opt-in (plan §4i). Agent-only — no bundled Portainer
    // server. Lets the user manage this deployment's node(s) from their OWN existing
    // Portainer server. Recorded here so `cc status`/`cc update` don't need to re-ask.
    portainer: {
      agentEnabled: false,
      agentPort: 9001,
      serverCidrs: [],
    },
    // Local target only: when the user left "Public domain" blank, the wizard
    // auto-starts a cloudflared quick tunnel (see lib/tunnel.mjs) instead of
    // making them run one by hand and manually patch the Telnyx webhook.
    // Quick tunnels have no stable hostname, so `url` always reflects the
    // MOST RECENT tunnel process, not a permanent address — resuming a
    // deployment starts a fresh tunnel (new random subdomain) and re-points
    // the Telnyx webhook at it (upsertVoiceApp is a safe find-by-name PATCH).
    tunnel: {
      mode: null, // null | 'cloudflare-quick' | 'user-provided' (domain was given)
      url: null,
      pid: null,
    },
    steps: {
      // one entry per wizard step; 'pending' | 'done' | 'skipped'
      consent: 'pending',
      target: 'pending',
      size: 'pending',
      region: 'pending',
      params: 'pending',
      // 'port-conflict' is reached only when preflight reports a busy port (typically 5432).
      // It is skipped on a clean preflight and on resume when there was nothing to resolve.
      'port-conflict': 'pending',
      preflight: 'pending',
      telnyx: 'pending',
      provision: 'pending',
      summary: 'pending',
    },
  };
}

/**
 * Ordered step list mirrored here (also exported from wizard.mjs as
 * ORDERED_STEPS) so state.mjs's own helpers (nextPendingStep,
 * describeIncompleteDeployment when called without an explicit list) have a
 * sensible default without importing wizard.mjs (which would create a
 * circular import: wizard.mjs already imports from state.mjs).
 */
export const DEFAULT_ORDERED_STEPS = [
  'consent', 'target', 'size', 'region', 'params', 'port-conflict', 'preflight', 'telnyx', 'provision', 'summary',
];

export function statePath(deployDir) {
  return `${deployDir}/.cc-state.json`;
}

export async function loadState(deployDir) {
  const path = statePath(deployDir);
  if (!existsSync(path)) return defaultState();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== STATE_VERSION) {
      // Unknown/older version: don't guess-migrate silently, start fresh but
      // preserve the file on disk (caller can inspect) by not overwriting yet.
      return defaultState();
    }
    // Merge onto defaults so new fields introduced later don't crash old state files.
    return deepMerge(defaultState(), parsed);
  } catch {
    return defaultState();
  }
}

export async function saveState(deployDir, state) {
  const path = statePath(deployDir);
  await mkdir(dirname(path), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  if (!next.createdAt) next.createdAt = next.updatedAt;
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function markStep(state, stepName, status = 'done') {
  if (!(stepName in state.steps)) {
    throw new Error(`Unknown wizard step: ${stepName}`);
  }
  return {
    ...state,
    steps: { ...state.steps, [stepName]: status },
  };
}

export function isStepDone(state, stepName) {
  // 'skipped' is a valid terminal state too (e.g. the Region step is skipped
  // entirely for the Local target) — resume should not get stuck retrying it.
  const status = state.steps?.[stepName];
  return status === 'done' || status === 'skipped';
}

/**
 * Resume plan: given ordered step names, return the first step that isn't
 * done (or skipped) yet. Returns null when every step is resolved.
 */
export function nextPendingStep(state, orderedSteps) {
  for (const stepName of orderedSteps) {
    if (!isStepDone(state, stepName)) return stepName;
  }
  return null;
}

/**
 * Detects whether a previous `cc up` run got partway through a deployment
 * without finishing (crashed, was Ctrl-C'd, or the terminal was closed).
 * Used at the top of `runWizard` to decide whether to prompt the user with
 * "resume where you left off, or start fresh?" instead of silently re-running
 * every step from scratch (which would re-create/re-confirm things the user
 * already answered, and — for the Telnyx step specifically — relies on
 * find-by-name idempotency alone to avoid duplicating cloud resources).
 *
 * A deployment counts as "incomplete" when consent was given (so this isn't
 * just a first-time run) but the terminal step (`summary`) never completed.
 * We deliberately don't require any *specific* step to be done/pending — even
 * a crash during `params` (before any external resource exists) should offer
 * resume, since the user's answers (deployment name, domain, etc.) are still
 * worth reusing.
 */
export function hasIncompleteDeployment(state) {
  if (!state || !state.deploymentName) return false;
  if (!isStepDone(state, 'consent')) return false;
  return !isStepDone(state, 'summary');
}

/**
 * Human-readable one-line summary of where an interrupted deployment left
 * off, for the resume prompt. Not exhaustive — just enough detail for the
 * user to recognize "yes, that's the run that crashed" versus "no, start over".
 */
export function describeIncompleteDeployment(state, orderedSteps = DEFAULT_ORDERED_STEPS) {
  const pending = nextPendingStep(state, orderedSteps) || 'summary';
  const when = state.updatedAt ? new Date(state.updatedAt).toLocaleString() : 'an earlier run';
  const doneParts = [];
  if (state.telnyx?.subSteps) {
    const doneSub = Object.entries(state.telnyx.subSteps)
      .filter(([, v]) => v === 'done')
      .map(([k]) => k);
    if (doneSub.length > 0) doneParts.push(`Telnyx: ${doneSub.join(', ')} already created`);
  }
  return {
    deploymentName: state.deploymentName,
    target: state.target,
    updatedAt: state.updatedAt,
    when,
    nextStep: pending,
    detail: doneParts.join('; '),
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

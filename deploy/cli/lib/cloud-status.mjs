import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import {
  terraformInit, terraformOutputs,
} from './terraform.mjs';
import { terraformRootFor as terraformRootForAws } from './aws-cloud.mjs';
import { terraformRootFor as terraformRootForGcp } from './gcp-cloud.mjs';
import { terraformRootFor as terraformRootForAzure } from './azure-cloud.mjs';

const execFileAsync = promisify(execFileCb);

// `cc status` for cloud targets (Phase 3 of the cloud-wizard work).
// Provider-agnostic on purpose — both providers expose the same surface
// here (terraform outputs, managed resource count, /api/health probe),
// and the cloud wizard always records the per-deployment terraform dir
// in `state.infra.terraformDir` after a successful apply, so the
// per-provider `terraformRootFor` lookup below is only ever reached for
// legacy state files written before that field existed.
//
// Module split off from cc.mjs so the formatting + probing logic can be
// unit-tested independently and so a future cloud target gets the same
// status report for free — just make sure their wizard writes
// `state.infra.terraformDir` like the others and add their own
// provider-specific field block in printCloudStatus.

const TERRAFORM_ROOT_FOR = {
  aws: terraformRootForAws,
  gcp: terraformRootForGcp,
  azure: terraformRootForAzure,
};

/**
 * Best-effort `terraform state list` count. The full list isn't surfaced
 * (status should be a one-pager, not a dump); just the number of managed
 * resources so the operator knows whether anything's actually still alive
 * (vs an orphaned state file after a partial destroy).
 *
 * Returns `null` on any failure (init failed, state file gone, providers
 * unavailable, etc.) — never throws, so a broken status lookup can't block
 * the rest of the status report.
 */
export async function terraformManagedResourceCount({ terraformDir, execImpl = execFileAsync, log = () => {} } = {}) {
  if (!terraformDir || !existsSync(terraformDir)) return null;
  try {
    const { stdout } = await execImpl(
      'terraform',
      // NOTE: `terraform state list` only accepts `-state=path` and `-id=id`
      // (see https://developer.hashicorp.com/terraform/cli/commands/state/list)
      // — `-no-color`/`-input=false` are NOT supported by this subcommand
      // (unlike plan/apply/destroy, which do accept them). Passing them here
      // makes the real CLI reject the invocation outright, which this
      // function's catch then silently downgrades to a warning — so on a
      // real deployment `cc status` was ALWAYS falling back to "could not
      // list resources" and never actually printed a managed-resource count,
      // even against perfectly healthy state.
      ['state', 'list'],
      { cwd: terraformDir, maxBuffer: 1024 * 1024 * 8 },
    );
    const lines = String(stdout || '').split('\n').filter((l) => l.trim().length > 0);
    return lines.length;
  } catch (err) {
    log(`  ⚠ Could not list terraform-managed resources: ${err.message}`);
    return null;
  }
}

/**
 * Lightweight health probe against the app URL. Returns one of:
 *   { ok: true,  statusCode, body }
 *   { ok: false, reason }   — network error, timeout, non-2xx, etc.
 * Never throws — callers can always render something useful regardless of
 * whether the network was reachable.
 *
 * `AbortSignal.timeout(...)` is used so a totally-stuck endpoint (firewall
 * blackhole) returns within 5s instead of hanging the whole status command.
 */
export async function probeAppHealth({ url, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!url) return { ok: false, reason: 'no url' };
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}`, statusCode: res.status, body: body.slice(0, 200) };
    }
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON, just a status string */ }
    return { ok: true, statusCode: res.status, body, parsed };
  } catch (err) {
    return { ok: false, reason: err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : err.message };
  }
}

/**
 * Resolves which terraform root dir to read state from. Honors an explicit
 * `state.infra.terraformDir` first (set by the wizard after a successful
 * apply), falling back to a per-provider derivation only for legacy state
 * files written before that field existed. AWS's `terraformRootFor` takes
 * a `topology` second arg; pass `state.infra.awsTopology || 'single'` to
 * land on the right root.
 */
function resolveTerraformRoot({ state, deployDir }) {
  if (state.infra?.terraformDir) return state.infra.terraformDir;
  const lookup = TERRAFORM_ROOT_FOR[state.target];
  if (!lookup) return null;
  // Legacy AWS state files (predating infra.terraformDir/infra.awsTopology)
  // still need the right topology guess to land on the correct terraform
  // root — destroyAwsInfra's own legacy fallback derives 'ha' from
  // `state.nodes >= 2`, so mirror that here rather than hardcoding
  // 'single'. Getting this wrong for an old HA install means `cc status`
  // silently reads the WRONG terraform root's (nonexistent) state and
  // reports an empty/incorrect deployment instead of the real one.
  if (state.target === 'aws') return lookup(deployDir, state.infra?.awsTopology || (state.nodes >= 2 ? 'ha' : 'single'));
  return lookup(deployDir);
}

/**
 * Prints the cloud deployment status to stdout. Same one-pager shape the
 * wizard's printSummary uses (the final-step equivalent of status), so an
 * operator who just finished `cc up` sees the same fields a day later via
 * `cc status`.
 *
 * Never throws — every individual probe is wrapped, so a single failure
 * (e.g. health endpoint unreachable) only downgrades the corresponding line
 * to a warning instead of aborting the whole report.
 *
 * Returns the raw { outputs, managedCount, health } object as well so unit
 * tests can assert on it directly without scraping stdout.
 */
export async function printCloudStatus({
  state, deployDir, execImpl = execFileAsync, fetchImpl = fetch, log = console.log,
} = {}) {
  const target = state.target;
  const region = state.region;
  const deploymentName = state.deploymentName;

  log(`  Target           ${target} (${region || 'n/a'})`);
  log(`  Deployment       ${deploymentName || '—'}`);
  // Provider-specific topology/project lines — each cloud target adds its
  // own field block here in the same shape.
  if (target === 'aws') log(`  AWS topology     ${state.infra?.awsTopology || (state.nodes >= 2 ? 'ha' : 'single')}`);
  if (target === 'gcp') {
    log(`  GCP project      ${state.infra?.gcpProjectId || '—'}`);
    if (state.infra?.lbEnabled) {
      log(`  HTTPS LB IP      ${state.infra?.lbIp || '—'}`);
      log(`  Cloud DNS        ${state.infra?.gcpDnsManaged ? `managed (zone "${state.infra.gcpDnsZoneName}")` : 'not managed by Terraform'}`);
    }
  }
  if (target === 'azure') {
    log(`  Azure subscription  ${state.infra?.azureSubscriptionId || '—'}`);
    log(`  Resource group      ${state.infra?.azureResourceGroup || '—'}`);
    if (state.infra?.lbEnabled) {
      log(`  App Gateway IP      ${state.infra?.appgwPublicIp || '—'}`);
      log(`  Azure DNS           ${state.infra?.azureDnsManaged ? `managed (zone "${state.infra.azureDnsZoneName}")` : 'not managed by Terraform'}`);
    }
  }
  log('');

  const terraformDir = resolveTerraformRoot({ state, deployDir });
  let outputs = null;
  let managedCount = null;
  if (terraformDir) {
    log(`  Terraform dir    ${terraformDir}`);
    // Re-init defensively (matches provision/destroy's pattern) so a `cc
    // clean`-style operation that nuked .terraform/ doesn't 500 here.
    const initStep = (label) => {
      log(`  • ${label}`);
    };
    initStep('terraform init (best-effort)...');
    try {
      await terraformInit({ cwd: terraformDir, execImpl });
    } catch (err) {
      log(`    ⚠ terraform init failed: ${err.message} — output/state reads below may be skipped`);
    }
    try {
      outputs = await terraformOutputs({ cwd: terraformDir, execImpl });
    } catch (err) {
      log(`  ⚠ Could not read terraform outputs: ${err.message}`);
    }
    managedCount = await terraformManagedResourceCount({ terraformDir, execImpl, log: (m) => log(`    ${m}`) });
    if (managedCount !== null) log(`  Managed resources ${managedCount}`);
    log('');
  } else {
    log(`  Terraform dir    (none recorded in state — no infra to query)`);
    log('');
  }

  // App URL — prefer the live output (what the wizard would resolve against
  // today), fall back to what was recorded at the time of provisioning.
  const appUrl = outputs?.app_url || state.infra?.appUrl;
  log(`  App URL          ${appUrl || '—'}`);
  if (state.infra?.publicIp) log(`  Public IP        ${state.infra.publicIp}`);
  if (state.infra?.albDnsName) log(`  ALB DNS name     ${state.infra.albDnsName}`);
  if (state.infra?.instanceName) log(`  Instance name    ${state.infra.instanceName}`);
  if (state.infra?.instanceIds?.length) {
    log(`  Instance ids     ${state.infra.instanceIds.join(', ')}`);
  }
  if (state.infra?.storageBucket) log(`  Storage bucket   ${state.infra.storageBucket}`);
  if (state.infra?.vmName) log(`  VM name          ${state.infra.vmName}`);
  if (state.infra?.storageAccount) log(`  Storage account  ${state.infra.storageAccount}`);

  // Health probe — best-effort, never throws.
  if (appUrl) {
    const health = await probeAppHealth({ url: appUrl, fetchImpl });
    if (health.ok) {
      const dbStatus = health.parsed?.database ? `, database: ${health.parsed.database}` : '';
      log(`  Health           ✔ ${appUrl}/api/health (HTTP ${health.statusCode}${dbStatus})`);
    } else {
      log(`  Health           ⚠ ${health.reason}`);
    }
  }
  log('');

  log(`  Telnyx resources:`);
  log(`    Voice app        ${state.telnyx?.voiceAppId || '—'}`);
  log(`    OVP              ${state.telnyx?.outboundVoiceProfileId || '—'}`);
  log(`    WebRTC SIP conn  ${state.telnyx?.sipConnectionId || '—'}`);
  log(`    Phone number     ${state.telnyx?.phoneNumber || '—'}`);

  return { outputs, managedCount };
}

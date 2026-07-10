#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runWizard, nonInteractiveIo, defaultIo, runTelnyxBootstrapStep, resolveBaseUrl,
} from './lib/wizard.mjs';
import { pickPhoneNumber } from './lib/telnyx-bootstrap-orchestrator.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { runPreflight } from './lib/preflight.mjs';
import { composeUp, composeDown, composeLogs, composePs } from './lib/compose.mjs';
import { startQuickTunnel, stopTunnel, isProcessAlive } from './lib/tunnel.mjs';
import { destroyAwsInfra, redeployAwsApp, updateAwsEnvSecret } from './lib/aws-cloud.mjs';
import { destroyGcpInfra, redeployGcpApp, updateGcpEnvSecret } from './lib/gcp-cloud.mjs';
import { destroyAzureInfra, redeployAzureApp, updateAzureEnvSecret } from './lib/azure-cloud.mjs';
import { deleteTelnyxResources } from './lib/telnyx-bootstrap.mjs';
import { applyEnvUpdates } from './lib/envgen.mjs';
import { deleteCertificate } from './lib/acm.mjs';
import { buildCleanPlan, performClean } from './lib/clean.mjs';
import { printCloudStatus } from './lib/cloud-status.mjs';
import * as ui from './lib/ui.mjs';

const execFileAsync = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
// cc.mjs always lives at deploy/cli/cc.mjs, so deploy/ is one level up.
const DEPLOY_DIR = join(__dirname, '..');
const REPO_ROOT = join(DEPLOY_DIR, '..');
const COMPOSE_DIR = join(REPO_ROOT, 'docker', 'production');
const SAMPLE_ENV_PATH = join(COMPOSE_DIR, 'sample.env');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--non-interactive') flags.nonInteractive = true;
    else if (arg === '--config') { flags.config = rest[i + 1]; i += 1; }
    else if (arg === '-f' || arg === '--follow') flags.follow = true;
    else if (arg === '--volumes' || arg === '-v') flags.volumes = true;
    else if (arg === '--no-number') flags.noNumber = true;
    else if (arg === '--country') { flags.country = rest[i + 1]; i += 1; }
    else positionals.push(arg);
  }
  return { command, flags, positionals };
}

async function cmdUp({ flags }) {
  let io = defaultIo();
  if (flags.nonInteractive) {
    if (!flags.config) {
      console.error('Error: --non-interactive requires --config <answers.json>');
      process.exitCode = 1;
      return;
    }
    const raw = await readFile(flags.config, 'utf8');
    const answers = JSON.parse(raw);
    io = nonInteractiveIo(answers);
  }
  const result = await runWizard({ deployDir: DEPLOY_DIR, sampleEnvPath: SAMPLE_ENV_PATH, io, execImpl: execFileAsync });
  if (result.aborted) process.exitCode = 1;
}

async function cmdDoctor() {
  const state = await loadState(DEPLOY_DIR);
  const target = state.target || 'local';
  ui.header('Preflight checks', `target: ${target}`);

  // Resolve the Telnyx API key for the doctor command from three sources, in order:
  //   1. process.env.TELNYX_API_KEY — works in both TTY and non-TTY (CI), preferred
  //      for any scripted use; also matches the existing hint text.
  //   2. Interactive prompt when stdin is a TTY — the wizard is itself interactive,
  //      so asking here mirrors that flow. Enter (empty input) skips the Telnyx check
  //      (renders a warn row instead of a fail), which matches what the wizard does
  //      before the user has reached the API-key step.
  //   3. Non-TTY without env var — print a hint and let the Telnyx check render a
  //      warn row. We deliberately don't exit with code 1 for the missing key alone
  //      since doctor should still report the rest of the environment.
  let apiKey = process.env.TELNYX_API_KEY || null;
  if (!apiKey) {
    if (Boolean(process.stdin && process.stdin.isTTY)) {
      const entered = await ui.askSecret('Telnyx API key (Enter to skip the Telnyx check)');
      apiKey = (entered || '').trim() || null;
      if (!apiKey) {
        console.log('  → No Telnyx API key supplied — the Telnyx check will be skipped (run with TELNYX_API_KEY set, or in a TTY, to include it).');
      }
    } else {
      console.log('  → No TELNYX_API_KEY in env and no TTY available — Telnyx check will be skipped. Set TELNYX_API_KEY and re-run to include it.');
    }
  }

  const { results, canContinue } = await runPreflight({ target, apiKey, needsTunnel: target === 'local' && !state.domain });
  for (const r of results) {
    ui.checkLine(r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'fail', r.label, r.detail);
    if (r.hint && r.status !== 'ok') console.log(`      → ${r.hint}`);
  }
  if (!canContinue) process.exitCode = 1;
}

async function cmdStatus() {
  const state = await loadState(DEPLOY_DIR);
  if (state.target === 'aws' || state.target === 'gcp' || state.target === 'azure') {
    ui.header('Cloud deployment status', `"${state.deploymentName || '(unnamed)'}" — ${state.target} ${state.region || ''}`.trim());
    try {
      await printCloudStatus({
        state, deployDir: DEPLOY_DIR, execImpl: execFileAsync,
      });
    } catch (err) {
      // printCloudStatus is documented as "never throws" — anything that
      // reaches this catch is a genuine bug we want to surface loudly.
      console.error(`cc status failed unexpectedly: ${err.stack || err.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (state.target && state.target !== 'local') {
    console.log(`Target: ${state.target} — cloud status for this provider ships in a later phase.`);
    return;
  }
  try {
    const { stdout } = await composePs({ cwd: COMPOSE_DIR });
    console.log(stdout || '(no containers running — try `./deploy/cc up`)');
  } catch (err) {
    console.error(`Could not read compose status: ${err.message}`);
    process.exitCode = 1;
  }
}

async function cmdLogs({ flags }) {
  try {
    const { stdout } = await composeLogs({ cwd: COMPOSE_DIR, follow: Boolean(flags.follow) });
    console.log(stdout);
  } catch (err) {
    console.error(`Could not read compose logs: ${err.message}`);
    process.exitCode = 1;
  }
}

async function cmdDestroy({ flags }) {
  const state = await loadState(DEPLOY_DIR);

  if (state.target && state.target !== 'local') {
    if (state.target === 'gcp') {
      return cmdDestroyGcp({ state, flags });
    }
    if (state.target === 'azure') {
      return cmdDestroyAzure({ state, flags });
    }
    if (state.target !== 'aws') {
      console.log(`Target: ${state.target} — Terraform destroy for this provider ships in a future phase. Nothing to do here yet.`);
      return;
    }
    return cmdDestroyAws({ state, flags });
  }

  const confirmed = await ui.confirm(
    flags.volumes
      ? 'This will stop containers AND delete all data volumes (Postgres, media, logs). Continue?'
      : 'This will stop containers (data volumes are preserved). Continue?',
    false,
  );
  if (!confirmed) {
    console.log('Aborted, nothing changed.');
    return;
  }
  try {
    await composeDown({ cwd: COMPOSE_DIR, volumes: Boolean(flags.volumes) });
    console.log('Stopped.');
    // Also stop any auto-started quick tunnel — it's a detached process, not
    // a docker container, so `compose down` never touches it and it would
    // otherwise keep running (and keep proxying to a now-dead container)
    // until manually killed.
    if (state.tunnel?.mode === 'cloudflare-quick' && state.tunnel?.pid && isProcessAlive(state.tunnel.pid)) {
      stopTunnel(state.tunnel.pid);
      console.log(`Stopped Cloudflare quick tunnel (pid ${state.tunnel.pid}).`);
    }
  } catch (err) {
    console.error(`docker compose down failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Local deployments create the exact same Telnyx-side resources as AWS
  // ones (voice app, outbound voice profile, WebRTC SIP connection, Default
  // Call Flow voice app, phone number — see lib/seed-default-call-flow.mjs
  // and the Step 7 bootstrap orchestrator, both target-agnostic since
  // PR #1175). Until this fix, `cc destroy` for local only ever tore down
  // the docker compose stack and left those Telnyx resources dangling with
  // no prompt at all — `cmdDestroyAws` was the only path that offered this
  // cleanup, purely because it was written first. There is nothing
  // AWS-specific about the Telnyx side of a destroy, so both targets now
  // share `cleanupTelnyxResourcesInteractive`.
  await cleanupTelnyxResourcesInteractive({ state });
}

/**
 * `cc destroy` for AWS targets — tears down the Terraform-managed
 * infrastructure (EC2, RDS, VPC, ALB, S3, Secrets Manager) via
 * destroyAwsInfra, then hands off to cleanupTelnyxResourcesInteractive for
 * the Telnyx-side cleanup shared with the local target.
 *
 * Added after a real 2026-07-06 incident where a failed `terraform apply`
 * (EIP quota exceeded) left a half-provisioned AWS deployment with no
 * built-in way to unwind it — the operator had to manually copy Terraform
 * state files and run `terraform destroy` + hand-curl the Telnyx API. This
 * makes that whole recovery a single `cc destroy` command.
 */
async function cmdDestroyAws({ state, flags }) {
  const io = defaultIo();
  io.header ? io.header('Destroy AWS deployment', `"${state.deploymentName || '(unnamed)'}" — region ${state.region || 'n/a'}`) : null;

  const infraResult = await destroyAwsInfra({ state, io, deployDir: DEPLOY_DIR });
  if (infraResult.aborted) {
    process.exitCode = 1;
    return;
  }

  await cleanupAcmCertificateInteractive({ state, io });
  await cleanupTelnyxResourcesInteractive({ state });
}

/**
 * `cc destroy` for GCP targets — tears down the Terraform-managed
 * infrastructure (Compute Engine, Cloud SQL, VPC, GCS bucket, Secret
 * Manager) via destroyGcpInfra, then hands off to
 * cleanupTelnyxResourcesInteractive for the Telnyx-side cleanup shared with
 * every target. No ACM-equivalent cleanup step here — GCP Phase 1/2 has no
 * managed-certificate concept at all (no HTTPS Load Balancer yet, see
 * cc-compute-single-gcp module header), so there is nothing analogous to
 * cleanupAcmCertificateInteractive to run.
 */
async function cmdDestroyGcp({ state, flags }) {
  const io = defaultIo();
  io.header ? io.header('Destroy GCP deployment', `"${state.deploymentName || '(unnamed)'}" — project ${state.infra?.gcpProjectId || 'n/a'}`) : null;

  const infraResult = await destroyGcpInfra({ state, io, deployDir: DEPLOY_DIR });
  if (infraResult.aborted) {
    process.exitCode = 1;
    return;
  }

  await cleanupTelnyxResourcesInteractive({ state });
}

/**
 * `cc destroy` for Azure targets — tears down the Terraform-managed
 * infrastructure (VM, Postgres Flexible Server, VNet, Storage Account,
 * Key Vault) via destroyAzureInfra (which also purges the soft-deleted Key
 * Vault so a same-named `cc up` afterward doesn't collide with the name —
 * see that function's docstring), then hands off to
 * cleanupTelnyxResourcesInteractive for the Telnyx-side cleanup shared
 * with every target. No ACM-equivalent cleanup step here — same reasoning
 * as cmdDestroyGcp (Application Gateway certs are operator-imported into
 * Key Vault, not a separate Terraform-external resource the way ACM
 * certificates are).
 */
async function cmdDestroyAzure({ state, flags }) {
  const io = defaultIo();
  io.header ? io.header('Destroy Azure deployment', `"${state.deploymentName || '(unnamed)'}" — subscription ${state.infra?.azureSubscriptionId || 'n/a'}`) : null;

  const infraResult = await destroyAzureInfra({ state, io, deployDir: DEPLOY_DIR });
  if (infraResult.aborted) {
    process.exitCode = 1;
    return;
  }

  await cleanupTelnyxResourcesInteractive({ state });
}

/**
 * Offers to delete the ACM certificate `cc up` requested for this
 * deployment's ALB — but ONLY when state.infra.acm.createdByWizard is true,
 * i.e. this wizard run actually minted the certificate via `acm
 * request-certificate` (runAwsDnsStep / resolveAlbCertificate). A
 * certificate the operator instead picked from an existing list (e.g. a
 * shared wildcard like *.example.com covering other deployments too) is
 * NEVER offered for deletion here — ACM has no "used by exactly one
 * deployment" concept, and deleting a certificate other ALBs still
 * reference would break their HTTPS with no warning.
 *
 * `createdByWizard` defaults to false for both brand-new state shapes and
 * state files written before this field existed, so the conservative
 * behavior (skip silently) is what happens unless the flag was explicitly
 * set true during a real "Request a new certificate" choice.
 */
async function cleanupAcmCertificateInteractive({ state, io }) {
  const acm = state.infra?.acm;
  if (!acm?.certificateArn || !acm?.createdByWizard) return;

  const deleteCert = await ui.confirm(
    `\nThis deployment's ACM certificate (${acm.certificateArn}) was requested by the wizard for this deployment only. Also delete it?`,
    true,
  );
  if (!deleteCert) {
    console.log('Skipped ACM certificate cleanup — left as-is.');
    return;
  }

  const step = ui.step('Deleting ACM certificate...');
  try {
    const result = await deleteCertificate({ certificateArn: acm.certificateArn, region: state.region });
    if (result.outcome === 'in-use') {
      step.warn(`Certificate still in use — could not delete: ${result.error}`);
      console.log('  → It may still be attached to a load balancer listener (give terraform destroy a moment to finish propagating, then delete it manually in the ACM console if it persists).');
      process.exitCode = 1;
    } else {
      step.succeed(`ACM certificate ${result.outcome === 'not-found' ? 'already gone' : 'deleted'}`);
    }
  } catch (err) {
    step.fail(`Could not delete ACM certificate: ${err.message}`);
    console.log(`  → Delete it manually if needed: aws acm delete-certificate --certificate-arn ${acm.certificateArn} --region ${state.region}`);
    process.exitCode = 1;
  }
}

/**
 * Shared Telnyx-side cleanup for `cc destroy`, regardless of target (local
 * or AWS): offers to delete the voice app, outbound voice profile, WebRTC
 * SIP connection, and Default Call Flow voice app recorded in
 * `state.telnyx`, with the phone number release as a separate, more
 * explicit opt-in.
 *
 * Telnyx cleanup is a SEPARATE confirmation from the infra teardown above
 * it (and the phone number release is a third, even more explicit opt-in)
 * because:
 *   - Infra (containers or Terraform-managed AWS resources) and Telnyx
 *     resources are independent failure domains — a user might want to keep
 *     the Telnyx voice app/number configured while re-provisioning the app
 *     infra under the same deployment name.
 *   - Releasing a phone number is irreversible and the number could be
 *     reused by anyone once released, so it needs its own explicit assent
 *     distinct from "yes, tear down the SIP connection wrapper around it".
 */
async function cleanupTelnyxResourcesInteractive({ state }) {
  const hasTelnyxResources = Boolean(
    state.telnyx?.sipConnectionId || state.telnyx?.voiceAppId
    || state.telnyx?.outboundVoiceProfileId || state.telnyx?.defaultFlowVoiceAppId,
  );
  if (!hasTelnyxResources) {
    console.log('\nNo Telnyx resource ids recorded in .cc-state.json — nothing to clean up on the Telnyx side.');
    return;
  }

  const cleanupTelnyx = await ui.confirm(
    '\nAlso clean up this deployment\'s Telnyx resources (voice app, outbound voice profile, WebRTC SIP connection)? The phone number itself is handled separately next.',
    false,
  );
  if (!cleanupTelnyx) {
    console.log('Skipped Telnyx cleanup — resources left as-is. Re-run `cc destroy` later to clean them up.');
    return;
  }

  const releaseNumber = state.telnyx?.phoneNumberId
    ? await ui.confirm(
      `Also RELEASE the phone number ${state.telnyx?.phoneNumber || state.telnyx?.phoneNumberId}? This is PERMANENT — the number returns to Telnyx's general pool and could be picked up by anyone. Say no to keep the number owned (just unassigned) for a future re-deploy.`,
      false,
    )
    : false;

  // Resolve the Telnyx API key the same way cmdDoctor does: prefer the env
  // var (scripted/CI use), fall back to an interactive prompt when attached
  // to a TTY. For AWS, destroyAwsInfra already tears down the app/env
  // Secrets Manager secret (recovery_window_in_days=0 → immediate delete)
  // before this runs, so there's no other place left to recover a
  // previously-known key from; for local, TELNYX_API_KEY only ever lived in
  // docker/production/.env, which the user may not have exported into their
  // shell — so the same fallback applies to both targets.
  let apiKey = process.env.TELNYX_API_KEY || null;
  if (!apiKey && Boolean(process.stdin && process.stdin.isTTY)) {
    const entered = await ui.askSecret('Telnyx API key (needed to clean up Telnyx resources — from https://portal.telnyx.com/#/app/api-keys)');
    apiKey = (entered || '').trim() || null;
  }
  if (!apiKey) {
    console.log('\nNo TELNYX_API_KEY in env — cannot clean up Telnyx resources. Set TELNYX_API_KEY and re-run `cc destroy`, or clean them up manually in the Telnyx portal:');
    if (state.telnyx?.sipConnectionId) console.log(`  - WebRTC SIP connection: ${state.telnyx.sipConnectionId}`);
    if (state.telnyx?.defaultFlowVoiceAppId) console.log(`  - Default Call Flow voice app: ${state.telnyx.defaultFlowVoiceAppId}`);
    if (state.telnyx?.voiceAppId) console.log(`  - Voice API application: ${state.telnyx.voiceAppId}`);
    if (state.telnyx?.outboundVoiceProfileId) console.log(`  - Outbound voice profile: ${state.telnyx.outboundVoiceProfileId}`);
    if (releaseNumber && state.telnyx?.phoneNumberId) console.log(`  - Phone number: ${state.telnyx.phoneNumber || state.telnyx.phoneNumberId}`);
    process.exitCode = 1;
    return;
  }

  const step = ui.step('Cleaning up Telnyx resources...');
  const results = await deleteTelnyxResources({
    apiKey,
    sipConnectionId: state.telnyx?.sipConnectionId,
    phoneNumberId: state.telnyx?.phoneNumberId,
    voiceAppId: state.telnyx?.voiceAppId,
    outboundVoiceProfileId: state.telnyx?.outboundVoiceProfileId,
    callFlowVoiceAppId: state.telnyx?.defaultFlowVoiceAppId,
    releaseNumber,
  });
  const anyError = Object.values(results).some((r) => r.outcome === 'error');
  if (anyError) {
    step.warn('Telnyx cleanup finished with some errors:');
    for (const [key, r] of Object.entries(results)) {
      if (r.outcome === 'error') console.log(`      ✖ ${key}: ${r.error}`);
      else console.log(`      ✔ ${key}: ${r.outcome}`);
    }
    process.exitCode = 1;
  } else {
    step.succeed('Telnyx resources cleaned up');
    for (const [key, r] of Object.entries(results)) {
      console.log(`      ✔ ${key}: ${r.outcome}`);
    }
  }
}

/**
 * `cc update` — rebuilds the app image from the current working tree and
 * reships it to whatever infrastructure this deployment already has,
 * WITHOUT touching that infrastructure at all: no `terraform apply`, no
 * instance/network/database changes for cloud targets, and for local just
 * the existing `docker compose up --build` (which only ever replaces the
 * app container, never recreates the Postgres volume or network). This is
 * the deliberate scope boundary from `cc up`: `cc up` can create/resize
 * infra, `cc update` only ever ships new application code onto infra that
 * already exists. An operator who actually needs an infra change (bigger
 * instance, different region, HA topology) still needs `cc destroy` + a
 * fresh `cc up` — this command intentionally cannot do that.
 */
async function cmdUpdate() {
  const state = await loadState(DEPLOY_DIR);
  const io = defaultIo();

  if (state.target === 'aws') {
    io.header('Update AWS deployment', `"${state.deploymentName || '(unnamed)'}" — region ${state.region || 'n/a'}`);
    try {
      const result = await redeployAwsApp({ state, io, deployDir: DEPLOY_DIR, execImpl: execFileAsync });
      if (result.aborted) process.exitCode = 1;
    } catch (err) {
      console.error(`cc update failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (state.target === 'gcp') {
    io.header('Update GCP deployment', `"${state.deploymentName || '(unnamed)'}" — project ${state.infra?.gcpProjectId || 'n/a'}`);
    try {
      const result = await redeployGcpApp({ state, io, deployDir: DEPLOY_DIR, execImpl: execFileAsync });
      if (result.aborted) process.exitCode = 1;
    } catch (err) {
      console.error(`cc update failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (state.target === 'azure') {
    io.header('Update Azure deployment', `"${state.deploymentName || '(unnamed)'}" — subscription ${state.infra?.azureSubscriptionId || 'n/a'}`);
    try {
      const result = await redeployAzureApp({ state, io, deployDir: DEPLOY_DIR, execImpl: execFileAsync });
      if (result.aborted) process.exitCode = 1;
    } catch (err) {
      console.error(`cc update failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (state.target && state.target !== 'local') {
    console.log(`Target: ${state.target} — cc update for this provider ships in a later phase.`);
    return;
  }

  // Local target: rebuild + restart the app container in place. compose up
  // --build only ever touches the app image/container — the Postgres
  // volume, network, and any other already-running services are untouched,
  // matching the "don't touch infra" contract for cloud targets above.
  io.header('Update local deployment', '');
  const existingMode = state.postgres?.mode === 'existing';
  const s = (io.longStep || io.step)('Rebuilding + restarting the app container...');
  try {
    await composeUp({
      cwd: COMPOSE_DIR,
      execImpl: execFileAsync,
      ...(existingMode ? { excludeProfiles: ['with-pg'] } : {}),
    });
    s.succeed('Container rebuilt and restarted');
  } catch (err) {
    s.fail(`docker compose up --build failed: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * `cc telnyx` — standalone re-run of the Telnyx bootstrap step, for every
 * target (local, AWS, GCP). Every upsert in telnyx-bootstrap-orchestrator.mjs
 * is find-by-name-first, so this is always safe to re-run: it repairs any
 * resource that's missing (e.g. the operator deleted the voice app by hand in
 * the Telnyx portal) and picks up a phone number if one hasn't been assigned
 * yet, without touching or duplicating anything that already exists.
 *
 * Telnyx bootstrap can hand back NEW information (a freshly created/repaired
 * voice app id, SIP connection id, or phone number) that the currently
 * running deployment doesn't know about yet. Every NEXT_PUBLIC_* var AND
 * every TELNYX_* id is baked into the app image at BUILD time (Local:
 * `docker build` ARGs sourced from .env; AWS/GCP: read from the app/env
 * Secrets Manager/Secret Manager secret into the image build), so the only
 * way to actually apply a change is:
 *   1. Merge the fresh envUpdates into whatever durably stores this
 *      deployment's runtime config (docker/production/.env for Local, the
 *      app/env secret for AWS/GCP) — read-merge-write, so anything else
 *      already there survives untouched.
 *   2. Rebuild the image and reship it — `docker compose up --build` for
 *      Local, redeployAwsApp/redeployGcpApp (the exact same code `cc update`
 *      uses) for cloud targets.
 * There is deliberately no lighter "just restart, skip the rebuild" path:
 * NEXT_PUBLIC_* values are unrecoverable from a running container's env at
 * runtime, so any change here always needs a full rebuild+redeploy to
 * actually take effect — same reasoning `cc update`'s redeployAwsApp/
 * redeployGcpApp already document for their own NEXT_PUBLIC_* handling.
 */
async function cmdTelnyx({ flags }) {
  const state0 = await loadState(DEPLOY_DIR);
  if (!state0.deploymentName || !state0.target) {
    console.error('No deployment found — run `./deploy/cc up` first (cc telnyx repairs/re-runs the Telnyx bootstrap step for an existing deployment).');
    process.exitCode = 1;
    return;
  }
  const io = defaultIo();
  io.header('Telnyx bootstrap', `"${state0.deploymentName}" — target: ${state0.target}`);

  // Resolve the Telnyx API key the same way cmdDoctor / cleanupTelnyxResourcesInteractive do.
  let apiKey = process.env.TELNYX_API_KEY || null;
  if (!apiKey && Boolean(process.stdin && process.stdin.isTTY)) {
    const entered = await ui.askSecret('Telnyx API key (from https://portal.telnyx.com/#/app/api-keys)');
    apiKey = (entered || '').trim() || null;
  }
  if (!apiKey) {
    console.error('No TELNYX_API_KEY in env and no TTY available to prompt for one — set TELNYX_API_KEY and re-run.');
    process.exitCode = 1;
    return;
  }

  let state = state0;

  // Resolve baseUrl by reusing whatever this deployment already has (Local:
  // the saved tunnel URL or the configured domain; AWS/GCP: the
  // Terraform-known app URL) rather than asking again — `cc telnyx` operates
  // on an EXISTING deployment, it shouldn't look like a fresh `cc up`.
  let baseUrl;
  if (state.target === 'local') {
    if (state.domain) {
      baseUrl = resolveBaseUrl(state.domain, 'local');
    } else if (state.tunnel?.mode === 'cloudflare-quick' && state.tunnel?.pid && isProcessAlive(state.tunnel.pid)) {
      baseUrl = state.tunnel.url;
      io.log(`  ✔ Reusing existing Cloudflare quick tunnel: ${baseUrl}`);
    } else if (state.tunnel?.mode === 'cloudflare-quick') {
      // Quick tunnels have no stable hostname — the previous process isn't
      // alive anymore, so the only option is to start a fresh one (which
      // means re-registering the Telnyx webhook, which runTelnyxBootstrapStep
      // does unconditionally anyway via its find-by-name upsert).
      io.log('  ⚠ No live tunnel process found — starting a fresh Cloudflare quick tunnel (new random hostname).');
      const tunnelStep = io.longStep('Starting Cloudflare quick tunnel (cloudflared)...');
      try {
        const tunnelInfo = await startQuickTunnel({ port: 3000, logPath: join(DEPLOY_DIR, '.cc-tunnel.log') });
        tunnelStep.succeed(`Tunnel live: ${tunnelInfo.url}`);
        baseUrl = tunnelInfo.url;
        state = { ...state, tunnel: { mode: 'cloudflare-quick', url: tunnelInfo.url, pid: tunnelInfo.pid } };
        await saveState(DEPLOY_DIR, state);
      } catch (err) {
        tunnelStep.fail(`Could not start cloudflared tunnel: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    } else {
      console.error('No public domain and no tunnel recorded for this deployment — run `./deploy/cc up` first to establish one.');
      process.exitCode = 1;
      return;
    }
  } else {
    baseUrl = state.infra?.appUrl || resolveBaseUrl(state.domain, state.target);
    if (!baseUrl) {
      console.error('No app URL recorded for this deployment — run `./deploy/cc up` first.');
      process.exitCode = 1;
      return;
    }
  }

  // Resolve which number to pass through: reuse an already-assigned one
  // (idempotent re-confirm/re-assign, never a second purchase), let the
  // operator pick a fresh one, or skip entirely with --no-number.
  let picked = null;
  if (state.telnyx?.phoneNumber) {
    picked = { id: state.telnyx.phoneNumberId, phone_number: state.telnyx.phoneNumber };
    io.log(`  ✔ Phone number — reusing ${state.telnyx.phoneNumber} from a previous run.`);
  } else if (!flags.noNumber) {
    const countryCode = flags.country || 'US';
    let pickResult;
    try {
      pickResult = await pickPhoneNumber({ apiKey, countryCode, log: (...args) => io.log(args.join(' ')) });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        console.error(`\n✖ ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    const { candidates } = pickResult;
    if (candidates.length === 0) {
      io.log('  ⚠ No phone numbers available for the requested country — continuing without a number (re-run later, or pass --country).');
    } else {
      const options = candidates.map((n) => {
        const cost = n?.cost_information?.monthly_cost || '?';
        return {
          label: `${n.phone_number}  $${cost}/mo`,
          value: { phone_number: n.phone_number, monthly_cost: cost },
          description: n.region_information?.region_name || n.locality || '',
        };
      });
      const choice = await io.select(`Pick a ${countryCode} phone number to assign to this deployment`, options);
      picked = { phone_number: choice.phone_number };
    }
  } else {
    io.log('  ℹ Skipping number purchase (--no-number).');
  }

  const telnyxRes = await runTelnyxBootstrapStep({
    state, io, answers: { telnyxApiKey: apiKey, baseUrl }, deployDir: DEPLOY_DIR, fetchImpl: fetch, pickedNumber: picked,
  });
  state = telnyxRes.state;
  await saveState(DEPLOY_DIR, state);

  const envUpdates = telnyxRes.result?.envUpdates || {};
  if (Object.keys(envUpdates).length === 0) {
    io.log('\nNo new Telnyx values to apply — nothing to rebuild.');
    return;
  }

  io.log('');
  io.log('Telnyx resources are current. Applying new values and rebuilding the app...');

  if (state.target === 'local') {
    const envPath = join(COMPOSE_DIR, '.env');
    let existingEnvText;
    try {
      existingEnvText = await readFile(envPath, 'utf8');
    } catch (err) {
      console.error(`Could not read ${envPath}: ${err.message} — run \`cc up\` first.`);
      process.exitCode = 1;
      return;
    }
    const { content } = applyEnvUpdates(existingEnvText, envUpdates);
    await writeFile(envPath, content, 'utf8');
    const existingMode = state.postgres?.mode === 'existing';
    const s = io.longStep('Rebuilding + restarting the app container...');
    try {
      await composeUp({
        cwd: COMPOSE_DIR,
        execImpl: execFileAsync,
        ...(existingMode ? { excludeProfiles: ['with-pg'] } : {}),
      });
      s.succeed('Container rebuilt and restarted');
    } catch (err) {
      s.fail(`docker compose up --build failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  } else if (state.target === 'aws') {
    try {
      await updateAwsEnvSecret({ state, envUpdates, execImpl: execFileAsync });
    } catch (err) {
      console.error(`Could not update the AWS app/env secret: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const result = await redeployAwsApp({ state, io, deployDir: DEPLOY_DIR, execImpl: execFileAsync });
    if (result.aborted) process.exitCode = 1;
  } else if (state.target === 'gcp') {
    try {
      await updateGcpEnvSecret({ state, envUpdates, execImpl: execFileAsync });
    } catch (err) {
      console.error(`Could not update the GCP app/env secret: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const result = await redeployGcpApp({ state, io, deployDir: DEPLOY_DIR, execImpl: execFileAsync });
    if (result.aborted) process.exitCode = 1;
  } else if (state.target === 'azure') {
    try {
      await updateAzureEnvSecret({ state, envUpdates, execImpl: execFileAsync });
    } catch (err) {
      console.error(`Could not update the Azure app/env secret: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const result = await redeployAzureApp({ state, io, deployDir: DEPLOY_DIR, execImpl: execFileAsync });
    if (result.aborted) process.exitCode = 1;
  } else {
    console.log(`Target: ${state.target} — cc telnyx rebuild/reship for this provider ships in a later phase. Telnyx resources were updated; the running deployment was NOT rebuilt.`);
  }

  io.log('');
  io.log('✔ Telnyx bootstrap re-run complete.');
  if (state.telnyx?.phoneNumber) io.log(`  Inbound number  ${state.telnyx.phoneNumber}`);
}

/**
 * `cc clean` wipes the wizard's per-checkout artifacts (.cc-state.json,
 * .cc-credentials.txt, .cc-telnyx-secrets.json, .env, .cc-tunnel.log,
 * cc.answers.json, plus each AWS topology's terraform.tfstate / tfvars /
 * .terraform/ directory) so the next `cc up` truly starts from scratch.
 *
 * Every existing file/dir is FIRST copied into
 * `deploy/.cc-backups/backup_<timestamp>/` (path preserved relative to the
 * repo root) and only removed after the copy is verified on disk. This
 * means a mistaken `cc clean` is recoverable from backup, and — crucially —
 * if the user ran it instead of `cc destroy` while real AWS infra was
 * still up, the Terraform state backup is enough to recover and finish a
 * `cc destroy` later.
 *
 * Special safety: when a `terraform.tfstate` file is found with non-empty
 * `resources`, the user gets a prominent warning (and the default flips
 * from "yes" to "no") before any destructive move, since deleting that file
 * without first running `cc destroy` orphans the AWS infrastructure it
 * tracks.
 */
async function cmdClean() {
  ui.header('Clean wizard artifacts', 'a fresh backup is written before anything is removed');

  const plan = await buildCleanPlan({ repoRoot: REPO_ROOT });
  const existing = plan.items.filter((i) => i.exists);

  if (existing.length === 0) {
    console.log('\nNothing to clean — repo is already free of wizard artifacts.');
    return;
  }

  console.log('\nFiles / directories that would be moved into a backup then deleted:');
  for (const item of existing) {
    const tag = item.kind === 'tfstate' && item.tfStateCheck?.live
      ? `   ← LIVE (${item.tfStateCheck.resourceCount} resource${item.tfStateCheck.resourceCount === 1 ? '' : 's'} tracked)`
      : '';
    console.log(`  - ${item.relPath}${tag}`);
  }

  if (plan.hasLiveTfState) {
    console.log('\n⚠  WARNING: One or more terraform.tfstate files still reference live AWS resources.');
    console.log('   Deleting them would orphan that infrastructure (Terraform would no longer');
    console.log('   know how to tear it down). If your goal is to remove AWS infra, run');
    console.log('   `./deploy/cc destroy` first. Use `cc clean` here ONLY if you are certain');
    console.log('   the tracked resources have already been deleted by other means.');
  }

  const defaultYes = !plan.hasLiveTfState;
  const confirmed = await ui.confirm(
    `\nProceed? A timestamped backup will be written to deploy/.cc-backups/ before any deletion.`,
    defaultYes,
  );
  if (!confirmed) {
    console.log('Aborted, nothing changed.');
    return;
  }

  const step = ui.step('Backing up and removing artifacts...');
  const result = await performClean({ items: plan.items, deployDir: DEPLOY_DIR, repoRoot: REPO_ROOT });
  step.succeed(`Moved ${result.movedCount} item${result.movedCount === 1 ? '' : 's'} to backup`);

  console.log(`\n✔ Backup written to: ${result.backupDir}`);
  console.log('  Every original file/dir was copied there before deletion — to recover, copy');
  console.log('  the file(s) back from the backup to their original path.');
  if (plan.hasLiveTfState) {
    console.log('\n⚠  Reminder: the terraform.tfstate backup above is the only thing that still maps');
    console.log('   to your AWS resources. Run `./deploy/cc destroy` (using the restored state)');
    console.log('   before deleting this backup directory.');
  }
}

function printHelp() {
  console.log(`Usage: cc <command> [options]

Commands:
  up          Run the interactive deployment wizard (or resume an interrupted run)
              --non-interactive --config <answers.json>   Skip prompts, use an answers file
  doctor      Run preflight checks only, no changes
  status      Show current deployment status
  logs        Show app logs
              -f, --follow                                 Stream logs
  update      Rebuild the app image from the current tree and reship it to
              already-provisioned infra (no terraform/infra changes)
  telnyx      Re-run / repair the Telnyx bootstrap step for an existing
              deployment (voice app, SIP connection, outbound profile,
              Default Call Flow voice app, phone number) and rebuild + reship
              the app if anything changed. Idempotent — safe to re-run.
              --no-number         Skip the phone number search/purchase flow
              --country <ISO2>    Country code for number search (default US)
  destroy     Tear down infra (double-confirmed)
              -v, --volumes                                  Also delete data volumes
  clean       Remove wizard artifacts (.cc-state.json, .cc-credentials.txt,
              terraform.tfstate, etc.) after writing a timestamped backup to
              deploy/.cc-backups/. Safe to re-run; safe to recover from.
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'up': return cmdUp({ flags });
    case 'doctor': return cmdDoctor();
    case 'status': return cmdStatus();
    case 'logs': return cmdLogs({ flags });
    case 'update': return cmdUpdate();
    case 'telnyx': return cmdTelnyx({ flags });
    case 'destroy': return cmdDestroy({ flags });
    case 'clean': return cmdClean();
    case undefined:
    case '-h':
    case '--help':
      return printHelp();
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});

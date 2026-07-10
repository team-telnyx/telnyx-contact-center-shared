import { join } from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as ui from './ui.mjs';
import {
  defaultState, loadState, saveState, markStep, isStepDone,
  hasIncompleteDeployment, describeIncompleteDeployment,
} from './state.mjs';
import { generateEnvFile, applyEnvUpdates, parseEnvValues, STICKY_ONE_TIME_ENV_KEYS } from './envgen.mjs';
import { readSecretsCache, mergeSecretsCache } from './telnyx-secrets-cache.mjs';
import { runPreflight, findFreePortInRange, checkExistingPostgres, checkPostgresDatabaseExists } from './preflight.mjs';
import { composeUp } from './compose.mjs';
import { waitForHealthy } from './health.mjs';
import { runTelnyxBootstrap, pickPhoneNumber } from './telnyx-bootstrap-orchestrator.mjs';
import { startQuickTunnel, isProcessAlive } from './tunnel.mjs';
import {
  checkAwsCloudPreflight, writeAwsTfvars, resolveAlbCertificate, provisionAwsInfra,
} from './aws-cloud.mjs';
import {
  checkGcpCloudPreflight, writeGcpTfvars, provisionGcpInfra, waitForManagedCertificate,
} from './gcp-cloud.mjs';
import {
  checkAzureCloudPreflight, writeAzureTfvars, provisionAzureInfra, provisionAzureKeyVaultOnly,
} from './azure-cloud.mjs';
import { resolveAdminSshCidrs } from './aws-instance-connect-cidrs.mjs';
import { AZURE_POPULAR_REGIONS, resolveValidAzureRegions } from './azure-regions.mjs';
import {
  listHostedZones, findZoneForHostname, findRecordForHost,
} from './route53.mjs';
import {
  listManagedZones, findZoneForHostname as findGcpZoneForHostname, findRecordForHost as findGcpRecordForHost,
} from './gcp-dns.mjs';
import {
  listDnsZones, findZoneForHostname as findAzureZoneForHostname, findRecordForHost as findAzureRecordForHost,
} from './azure-dns.mjs';
import { listCertificatesForDomain, findCertificateInOtherRegions } from './acm.mjs';
import { findCertificatesForDomain, copyCertificateToName } from './azure-keyvault-cert.mjs';
import { issueCertificateViaDns01, importPfxToKeyVault } from './azure-acme.mjs';

const { chalkGreen, chalkGray, persistGeneratedSecrets } = ui;

const execFileAsync = promisify(execFileCb);

// Phase 1 scope: Local target only. Steps 3 (Region) and most of Steps 6-7
// (cloud provisioning / Telnyx bootstrap) are stubs here — Region is skipped
// entirely for Local per the plan, and Telnyx bootstrap ships in Phase 2.
//
// The wizard is a linear step runner over deps.state, calling out to `io` for
// all user interaction so it can be driven by a script in tests (see
// test/wizard.test.mjs) instead of a real TTY.

// Telnyx bootstrap now runs BEFORE provision (see runWizard) so every
// TELNYX_* id/secret is known before the .env is written/container is built
// even once — no more "build, discover ids, patch .env, restart container"
// two-phase dance. Keep this order in sync with state.mjs's
// DEFAULT_ORDERED_STEPS (duplicated there to avoid a circular import).
export const ORDERED_STEPS = [
  'consent', 'target', 'size', 'region', 'params', 'port-conflict', 'preflight', 'telnyx', 'provision', 'summary',
];

export function defaultIo() {
  return {
    header: ui.header,
    log: (...args) => console.log(...args),
    confirm: ui.confirm,
    select: ui.select,
    ask: ui.ask,
    askSecret: ui.askSecret,
    checkLine: ui.checkLine,
    step: ui.step,
    longStep: ui.longStep,
  };
}

/**
 * Builds a non-interactive `io` implementation for `cc up --non-interactive
 * --config <answers.json>` (Task 1.4). Answers are matched by keyword against
 * the prompt text rather than by call order, so it stays robust if steps are
 * reordered/added later. Any prompt not covered by `answers` falls back to the
 * step's own default (ask) or throws (select/askSecret with no matching data),
 * since silently picking an arbitrary menu option would be unsafe for
 * unattended runs.
 */
export function nonInteractiveIo(answers, { log = (...args) => console.log(...args) } = {}) {
  function matchAsk(question) {
    const q = question.toLowerCase();
    if (q.includes('deployment name')) return answers.deploymentName;
    if (q.includes('domain')) return answers.domain ?? '';
    if (q.includes('owner admin email')) return answers.ownerEmail;
    // GCP project id / zone — must be checked before the generic 'region'
    // match below since "GCP zone within <region> for the Compute Engine
    // instance" also contains the word "region".
    if (q.includes('gcp project id')) return answers.gcpProjectId;
    if (q.includes('gcp zone')) return answers.gcpZone;
    if (q.includes('region')) return answers.region;
    // Port-conflict step — collect existing-Postgres wiring from the answers file
    // when the user is running unattended. Order matters: the more specific
    // "use a different database name" prompt must be matched before the generic
    // "database name" prompt, otherwise the rename input is silently ignored.
    if (q.includes('use a different database name')) return answers.existingPostgresDatabaseRename;
    if (q.includes('postgres host')) return answers.existingPostgresHost;
    if (q.includes('postgres port')) return answers.existingPostgresPort;
    if (q.includes('postgres user')) return answers.existingPostgresUser;
    if (q.includes('database name')) return answers.existingPostgresDatabase;
    return undefined;
  }
  function matchSecret(question) {
    const q = question.toLowerCase();
    if (q.includes('password')) return answers.ownerPassword ?? '';
    if (q.includes('telnyx api key')) return answers.telnyxApiKey;
    if (q.includes('postgres password')) return answers.existingPostgresPassword;
    return undefined;
  }
  return {
    header: () => {},
    log,
    confirm: async (question) => {
      const q = question.toLowerCase();
      if (q.includes('continue?')) return answers.consent !== false;
      if (q.includes('warning')) return answers.continueOnWarn !== false;
      if (q.includes('purchase ') && q.includes('$/mo')) {
        // Number purchase confirm in unattended mode. Default false so an
        // unattended CI run never charges a card without explicit opt-in —
        // call sites that want to purchase must set answers.buyNumber=true.
        return answers.buyNumber === true;
      }
      if (q.includes('reuse the existing database')) {
        return answers.reuseExistingDatabase === true;
      }
      if (q.includes('map the bundled postgres container onto host port')) {
        // Default true in unattended mode when the user explicitly opted into
        // a custom port (answers.portConflictChoice === 'different-host-port').
        return true;
      }
      if (q.includes('apply this terraform plan')) {
        // Unattended AWS runs must opt in explicitly (answers.applyTerraform=true) —
        // defaulting to auto-apply would let a scripted run silently create
        // billable cloud infra with no human in the loop.
        return answers.applyTerraform === true;
      }
      if (q.includes('enable a portainer agent')) {
        return answers.portainerAgentEnabled === true;
      }
      return true;
    },
    select: async (title, options) => {
      const t = title.toLowerCase();
      if (t.includes('where do you want to deploy')) {
        if (!answers.target) throw new Error('--non-interactive requires "target" in the answers file');
        return answers.target;
      }
      if (t.includes('expected scale')) {
        return answers.size || 'small';
      }
      if (t.includes('how do you want to resolve this')) {
        if (!answers.portConflictChoice) {
          throw new Error('--non-interactive requires "portConflictChoice" when port-conflict step is reached');
        }
        return answers.portConflictChoice;
      }
      if (t.includes('aws region for this deployment')) {
        return answers.region || 'eu-central-1';
      }
      if (t.includes('gcp region for this deployment')) {
        return answers.region || 'us-central1';
      }
      if (t.includes('azure region for this deployment')) {
        // Non-interactive mode bypasses the menu/validation entirely and
        // trusts the answers file directly — same "operator already knows
        // what they're doing in a scripted run" contract as every other
        // select() branch here. Unlike the interactive path, an invalid
        // region string will simply surface later as a real Terraform/ARM
        // error rather than being caught up front (no io.ask loop to catch
        // it against in this mock).
        return answers.region || 'westeurope';
      }
      throw new Error(`--non-interactive has no answer mapped for prompt: "${title}"`);
    },
    ask: async (question, defaultValue) => {
      const value = matchAsk(question);
      return value !== undefined ? value : defaultValue;
    },
    askSecret: async (question) => {
      const value = matchSecret(question);
      if (value === undefined) {
        throw new Error(`--non-interactive has no answer mapped for prompt: "${question}"`);
      }
      return value;
    },
    checkLine: (status, label, detail) => log(`${status}: ${label} ${detail || ''}`.trim()),
    // In non-interactive mode longStep degrades to a single-line log so CI logs
    // stay parseable (no \r overwrites, no spinner). The succeed/fail/warn methods
    // still print a final line so the overall outcome is visible.
    step: (label) => {
      log(`STEP: ${label}`);
      return {
        succeed: (m) => log(`OK: ${m}`),
        fail: (m) => log(`FAIL: ${m}`),
        warn: (m) => log(`WARN: ${m}`),
        info: (m) => log(m),
      };
    },
    longStep: (label) => {
      log(`STEP: ${label}`);
      return {
        succeed: (m) => log(`OK: ${m}`),
        fail: (m) => log(`FAIL: ${m}`),
        warn: (m) => log(`WARN: ${m}`),
        info: (m) => log(m),
        stop: () => {},
      };
    },
  };
}

export async function runIntroStep({ state, io }) {
  io.header('Telnyx Contact Center — Deployment Wizard', 'repo master');
  io.log('');
  io.log('This wizard will guide you through a full Contact Center deployment:');
  io.log('');
  io.log('  1. Choose target        — your laptop (Docker) or a cloud provider');
  io.log('  2. Choose size          — nodes & machine type based on expected users');
  io.log('  3. Choose region        — cloud targets only');
  io.log('  4. Deployment params    — name, domain, owner account, Telnyx API key');
  io.log('  5. Preflight checks     — verify required tools, credentials, domain');
  io.log('  6. Telnyx bootstrap     — voice app, WebRTC SIP connection, number');
  io.log('  7. Provision infra      — create VM(s)/containers, TLS via Caddy (cloud)');
  io.log('  8. Launch & verify      — start the app, wait for healthy, print summary');
  io.log('');
  io.log('Nothing is created before step 6, and every create is shown before it happens.');
  io.log('');
  const accepted = await io.confirm('Continue?', true);
  if (!accepted) {
    io.log('Nothing was changed.');
    return { state: markStep(state, 'consent', 'skipped'), aborted: true };
  }
  let next = { ...state, consent: { acceptedAt: new Date().toISOString() } };
  next = markStep(next, 'consent', 'done');
  return { state: next, aborted: false };
}

export async function runTargetStep({ state, io }) {
  const target = await io.select('Where do you want to deploy Contact Center?', [
    { label: 'Local machine (Docker Desktop / Docker Engine) — dev & evaluation', value: 'local' },
    { label: 'AWS (EC2 + EIP + Route53 optional)', value: 'aws', description: 'from ~$30/mo (t3a.medium)' },
    { label: 'Azure (VM + Public IP)', value: 'azure' },
    { label: 'GCP (Compute Engine)', value: 'gcp' },
  ]);
  let next = { ...state, target };
  next = markStep(next, 'target', 'done');
  return { state: next };
}

const SIZING = {
  small: { label: 'Small — up to 10 users', users: 10, defaultNodes: 1 },
  medium: { label: 'Medium — up to 100 users', users: 100, defaultNodes: 1 },
  large: { label: 'Large — up to 1000 users', users: 1000, defaultNodes: 3 },
};

export async function runSizeStep({ state, io }) {
  if (state.target === 'local') {
    // Local target always runs single-node/small — sizing menu is cloud-only.
    let next = { ...state, size: 'small', nodes: 1 };
    next = markStep(next, 'size', 'skipped');
    return { state: next };
  }
  const size = await io.select('Expected scale (concurrent agents using the app)?', [
    { label: 'Small — up to 10 users (demo / POC / small team)', value: 'small' },
    { label: 'Medium — up to 100 users (production, single site)', value: 'medium' },
    { label: 'Large — up to 1000 users (production, HA required)', value: 'large' },
  ]);
  const sizing = SIZING[size];
  let nodes = sizing.defaultNodes;
  if (size === 'large' && state.target !== 'aws') {
    io.log('⚠ HA multi-node is currently available for AWS only; deploying single-node for this provider.');
    nodes = 1;
  }
  let next = { ...state, size, nodes };
  // AWS topology follows directly from sizing: Large always routes to the
  // multi-node/HA Terraform root + ALB/ACM path (plan §4e sizing matrix);
  // Small/Medium always use single-node. Recorded here (not just derived
  // later from `nodes`) so a resumed run and the provision step agree on
  // which Terraform root to use without re-deriving the rule.
  if (state.target === 'aws') {
    next = { ...next, infra: { ...next.infra, awsTopology: size === 'large' ? 'ha' : 'single' } };
  }
  next = markStep(next, 'size', 'done');
  return { state: next };
}

// Common, well-supported AWS regions across the account types this wizard
// targets. Not exhaustive — the user can type any other valid region string,
// this is just a fast-path menu with EU + US coverage (matches where Telnyx
// PoPs and this project's userbase mostly sit).
const AWS_REGIONS = [
  { label: 'eu-central-1 — Frankfurt', value: 'eu-central-1' },
  { label: 'eu-west-1 — Ireland', value: 'eu-west-1' },
  { label: 'us-east-1 — N. Virginia', value: 'us-east-1' },
  { label: 'us-east-2 — Ohio', value: 'us-east-2' },
  { label: 'us-west-2 — Oregon', value: 'us-west-2' },
  { label: 'Other (type a region code)', value: '__other__' },
];

const GCP_REGIONS = [
  { label: 'us-central1 — Iowa', value: 'us-central1' },
  { label: 'us-east1 — South Carolina', value: 'us-east1' },
  { label: 'us-west1 — Oregon', value: 'us-west1' },
  { label: 'europe-west1 — Belgium', value: 'europe-west1' },
  { label: 'europe-west3 — Frankfurt', value: 'europe-west3' },
  { label: 'Other (type a region code)', value: '__other__' },
];

// Default zone suffix per region — GCP zones are `<region>-<letter>`, and
// `-a` is available in every region this menu lists. The wizard still lets
// the user override the full zone string via a follow-up prompt (see
// runRegionStep's gcp branch) rather than hardcoding this silently.
function defaultZoneForRegion(region) {
  return region ? `${region}-a` : '';
}

export async function runRegionStep({
  state, io, fetchImpl = fetch, execImpl,
}) {
  if (state.target === 'local') {
    let next = { ...state, region: null };
    next = markStep(next, 'region', 'skipped');
    return { state: next };
  }
  if (state.target === 'aws') {
    const choice = await io.select('AWS region for this deployment?', AWS_REGIONS);
    const region = choice === '__other__'
      ? await io.ask('AWS region code (e.g. ap-southeast-1)', 'eu-central-1')
      : choice;
    // Auto-resolve the SSH admin CIDR — no prompt. AWS publishes a narrow,
    // stable per-region IP range that its own EC2 console "Connect" button
    // (EC2 Instance Connect) originates from; opening port 22 to just that
    // range gives browser-based console SSH without exposing it to the
    // public internet or asking the user to know/paste their own IP. See
    // aws-instance-connect-cidrs.mjs for the source and fallback behavior.
    const awsAdminSshCidrs = await resolveAdminSshCidrs({ region, fetchImpl, io });
    let next = { ...state, region, awsAdminSshCidrs };
    next = markStep(next, 'region', 'done');
    return { state: next };
  }
  if (state.target === 'gcp') {
    // GCP has no account-wide default project the way AWS CLI has a default
    // profile/region — the wizard MUST ask for a project id explicitly
    // (Terraform's google provider needs one, and there is no safe
    // "guess it" fallback: creating billable resources in the wrong
    // project is a much worse failure mode than an extra prompt).
    //
    // A blank answer here (pressing Enter) must be rejected outright rather
    // than recorded as an empty string: checkGcpCloudPreflight only probes
    // project reachability inside `if (projectId)`, so an empty id would
    // silently skip that check, sail through preflight, and only surface as
    // a Terraform "project_id is required" failure AFTER Telnyx bootstrap
    // has already created live (billable) Telnyx resources for this run.
    // Looping here costs one extra prompt; not looping costs an operator a
    // half-created deployment with orphaned Telnyx state to clean up by hand.
    let projectId;
    do {
      // eslint-disable-next-line no-await-in-loop -- interactive prompt, must be sequential.
      projectId = await io.ask('GCP project id (must already exist — the wizard does not create projects)', '');
      if (!projectId) {
        io.log('  ⚠ A GCP project id is required — Terraform has no safe default and cannot guess which project to provision into.');
      }
    } while (!projectId);
    const choice = await io.select('GCP region for this deployment?', GCP_REGIONS);
    const region = choice === '__other__'
      ? await io.ask('GCP region code (e.g. asia-southeast1)', 'us-central1')
      : choice;
    const zone = await io.ask(
      `GCP zone within ${region} for the Compute Engine instance`,
      defaultZoneForRegion(region),
    );
    let next = {
      ...state, region, infra: { ...state.infra, gcpProjectId: projectId, gcpZone: zone },
    };
    next = markStep(next, 'region', 'done');
    return { state: next };
  }
  if (state.target === 'azure') {
    // Azure has no account-wide default subscription the way AWS CLI has a
    // default profile/region — Terraform's azurerm provider needs one
    // explicitly (subscription_id tfvar). Same "loop until non-empty,
    // never silently guess" rationale as GCP's project id prompt just
    // above: a blank answer here would sail through
    // checkAzureCloudPreflight's `if (subscriptionId)`-gated check and only
    // surface as a Terraform "subscription_id is required" failure AFTER
    // Telnyx bootstrap has already created live (billable) Telnyx
    // resources for this run.
    let subscriptionId;
    do {
      // eslint-disable-next-line no-await-in-loop -- interactive prompt, must be sequential.
      subscriptionId = await io.ask('Azure subscription id (run `az account show --query id -o tsv` if unsure)', '');
      if (!subscriptionId) {
        io.log('  ⚠ An Azure subscription id is required — Terraform has no safe default and cannot guess which subscription to provision into.');
      }
    } while (!subscriptionId);
    // Region menu mirrors the AWS/GCP branches above (curated fast-path
    // list + "Other" free-type escape hatch) — previously this was a bare
    // io.ask() with no menu and no validation at all, unlike AWS/GCP, which
    // both got fast-path menus back when their cloud roots landed. Unlike
    // AWS/GCP's small, stable region namespaces, Azure has 60+ physical
    // regions and its own authoritative live list via `az account
    // list-locations`, so a free-typed "Other" answer here is validated
    // against that (or the built-in fallback snapshot if `az` isn't
    // reachable yet) instead of being accepted blind — a typo'd region
    // name would otherwise sail through and only surface as an opaque
    // Terraform/ARM "location is not valid" failure well after Telnyx
    // bootstrap has already created live resources for this run.
    const regionChoice = await io.select('Azure region for this deployment?', AZURE_POPULAR_REGIONS);
    let region = regionChoice;
    if (regionChoice === '__other__') {
      const validRegions = await resolveValidAzureRegions({ execImpl, io });
      do {
        // eslint-disable-next-line no-await-in-loop -- interactive prompt, must be sequential.
        region = await io.ask('Azure region name (e.g. eastus2, uksouth — must match `az account list-locations`\' "name" field, not its display name)', 'westeurope');
        if (!validRegions.has(region)) {
          io.log(`  ⚠ "${region}" is not a recognized Azure region name. Examples: ${[...validRegions].slice(0, 6).join(', ')}, ...`);
        }
      } while (!validRegions.has(region));
    }
    let next = {
      ...state, region, infra: { ...state.infra, azureSubscriptionId: subscriptionId },
    };
    next = markStep(next, 'region', 'done');
    return { state: next };
  }
  // Full per-provider region menus land in Phase 4 alongside the terraform
  // roots for any future non-AWS/GCP/Azure target; no such target exists
  // right now (DigitalOcean/Hetzner were removed as unimplemented stubs —
  // see wizard.mjs history), so this is currently unreachable, but stays
  // in place as the fallback shape the next new cloud target's region step
  // starts from.
  const REGION_DEFAULTS = {};
  const region = await io.ask(
    `Deployment region for ${state.target}?`,
    REGION_DEFAULTS[state.target] || '',
  );
  let next = { ...state, region };
  next = markStep(next, 'region', 'done');
  return { state: next };
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31) || 'cc-main';
}

// Users sometimes paste a full URL (e.g. "https://demo.example.com" or
// even "https://demo.example.com/") when the prompt says "domain" —
// blindly prepending `https://` on top produces `https://https://...`, which
// then makes the health-check step wait forever on an unreachable URL. This
// normalizes whatever was typed (bare hostname, or a URL with any scheme)
// down to a single, correctly-schemed base URL with no trailing slash.
export function resolveBaseUrl(domain, target) {
  const trimmed = String(domain || '').trim();
  if (!trimmed) {
    return target === 'local' ? 'http://localhost:3000' : '';
  }
  // Already has a scheme (http:// or https://, case-insensitive) — use as-is,
  // just strip any trailing slash. Otherwise treat it as a bare hostname.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

// Portainer agent opt-in (plan §4i) — AWS and GCP cloud targets, agent-only
// (no bundled Portainer server; the user pairs the agent with their OWN
// existing Portainer instance). Runs after region/params are known, before
// preflight, so cloud-init/tfvars generation always has a definitive answer.
// Name kept as "Aws" for minimal diff against the existing AWS-only history,
// but the check below covers both cloud targets — both cc-network-gcp/
// cc-compute-single-gcp (GCP) and cc-network/cc-compute-single (AWS)
// terraform modules already accept the same portainer_agent_enabled/
// portainer_agent_port/portainer_server_cidrs variables.
export async function runAwsPortainerStep({ state, io }) {
  if (state.target !== 'aws' && state.target !== 'gcp') {
    return { state: { ...state, portainer: { ...state.portainer, agentEnabled: false } } };
  }
  const enabled = await io.confirm(
    'Enable a Portainer agent on the node(s) so you can manage this deployment from your own existing Portainer server? (No Portainer server is created — agent-only, opt-in)',
    false,
  );
  let portainer = { ...state.portainer, agentEnabled: enabled };
  if (enabled) {
    const cidrsRaw = await io.ask(
      'CIDR(s) allowed to reach the Portainer agent port (comma-separated, e.g. your Portainer server\'s IP/32 — leave blank to skip opening a security group rule and add it manually later)',
      '',
    );
    const serverCidrs = cidrsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    portainer = { ...portainer, serverCidrs };
  }
  return { state: { ...state, portainer } };
}

/**
 * AWS-only DNS/TLS decision step (plan's HTTPS-handling rewrite). Runs after
 * `runParamsStep` (needs `state.domain`, which is now mandatory for AWS —
 * see runParamsStep) and before Telnyx bootstrap/provisioning, since its
 * outcome (state.infra.albEnabled / acm certificate to reuse) feeds directly
 * into writeAwsTfvars.
 *
 * Caddy/Let's-Encrypt-on-the-instance has been removed entirely from the AWS
 * path (see cc-compute-single's user_data.sh.tpl) — every AWS deployment is
 * one of exactly three shapes going forward:
 *   1. Multi-node/HA — ALB + ACM mandatory (unchanged, already required by
 *      the load balancer's own architecture).
 *   2. Single-node, domain in a Route53 hosted zone on this account — the
 *      wizard offers to attach an ALB + ACM certificate (auto-validated via
 *      a Route53 CNAME it creates itself), and to manage the domain's A/
 *      alias record automatically once the ALB exists.
 *   3. Single-node, domain NOT in a Route53 zone here (external DNS
 *      provider, or the user declined) — no ALB, no TLS on the instance;
 *      the app is reachable over plain HTTP on the instance's public IP and
 *      the operator is responsible for their own reverse proxy/CDN/TLS if
 *      they want HTTPS. The wizard still tells them, in the final summary,
 *      to point an A record at the instance's public IP.
 */
export async function runAwsDnsStep({
  state, io, execImpl = execFileAsync,
  listHostedZonesImpl = listHostedZones,
  findZoneForHostnameImpl = findZoneForHostname,
  findRecordForHostImpl = findRecordForHost,
  listCertificatesForDomainImpl = listCertificatesForDomain,
  findCertificateInOtherRegionsImpl = findCertificateInOtherRegions,
}) {
  if (state.target !== 'aws') return { state };
  const domain = state.domain;
  const topology = state.infra?.awsTopology || (state.size === 'large' ? 'ha' : 'single');
  const mandatory = topology === 'ha';

  let wantsAlb = true;
  if (!mandatory) {
    wantsAlb = await io.confirm(
      `Set up HTTPS for ${domain} via an AWS Application Load Balancer (ALB) + ACM certificate? (No — the app is reached over plain HTTP directly on the instance; your own reverse proxy/CDN is responsible for TLS)`,
      true,
    );
  }

  if (!wantsAlb) {
    io.log(`  ℹ No ALB — ${domain} will need to point at this deployment's public IP once it's known (see the final summary for the exact instruction).`);
    return {
      state: {
        ...state,
        infra: { ...state.infra, albEnabled: false, dnsManaged: false, dnsZoneId: null },
      },
    };
  }

  let zones = [];
  try {
    zones = await listHostedZonesImpl({ execImpl });
  } catch (err) {
    io.log(`  ⚠ Could not list Route53 hosted zones (${err.message}) — continuing without DNS automation.`);
  }
  const zone = findZoneForHostnameImpl(zones, domain);

  if (!zone) {
    io.log(`  ⚠ ${domain} is not managed by a Route53 hosted zone on this AWS account.`);
    const proceedAnyway = await io.confirm(
      'Continue with the ALB anyway? The ACM certificate will need manual DNS validation (the wizard will print a CNAME for you to add at your own DNS provider).',
      true,
    );
    if (!proceedAnyway) {
      return {
        state: {
          ...state,
          infra: { ...state.infra, albEnabled: false, dnsManaged: false, dnsZoneId: null },
        },
      };
    }
    return {
      state: {
        ...state,
        infra: { ...state.infra, albEnabled: true, dnsManaged: false, dnsZoneId: null },
      },
    };
  }

  io.log(`  ✔ Found Route53 hosted zone "${zone.name}" covering ${domain}.`);
  let dnsManaged = true;
  try {
    const existing = await findRecordForHostImpl({ zoneId: zone.id, fqdn: domain, execImpl });
    if (existing) {
      io.log(`  ⚠ A DNS record already exists for ${domain} in this zone (type ${existing.type}).`);
      const overwrite = await io.confirm(`Overwrite it to point at this deployment?`, false);
      if (!overwrite) {
        io.log(`  ℹ Leaving the existing record untouched — you'll need to point ${domain} at this deployment's ALB yourself (see the final summary for the exact instruction).`);
        dnsManaged = false;
      }
    }
  } catch (err) {
    io.log(`  ⚠ Could not check for an existing record (${err.message}) — will attempt to create/update it anyway.`);
  }

  let acmCertificateArn = state.infra?.acm?.certificateArn || null;
  let acmIssued = state.infra?.acm?.issued || false;
  let acmCreatedByWizard = state.infra?.acm?.createdByWizard || false;
  try {
    const candidates = await listCertificatesForDomainImpl({ domain, region: state.region, execImpl });
    if (candidates.length > 0) {
      const choice = await io.select('Found existing ACM certificate(s) that cover this domain — use one, or request a new one?', [
        ...candidates.map((c) => ({ label: `${c.domainName}  (${c.certificateArn})`, value: c.certificateArn })),
        { label: 'Request a new certificate', value: '__new__' },
      ]);
      if (choice !== '__new__') {
        acmCertificateArn = choice;
        acmIssued = true; // listCertificatesForDomain only returns ISSUED certificates.
        acmCreatedByWizard = false; // reusing something that already existed — never ours to delete.
      } else {
        acmCreatedByWizard = true;
      }
    } else {
      // No certificate for this domain in the DEPLOYMENT'S region. Before
      // silently requesting a new one, check whether a usable certificate
      // exists in another region — ACM certs and Route53 domains aren't
      // region-bound themselves, but a certificate ARN can only be attached
      // to an ALB listener in the SAME region as the certificate (a hard AWS
      // limitation). Without this check the operator has no way to know
      // WHY the wizard is about to mint a brand new certificate when they
      // already have a perfectly good wildcard one — just in the wrong
      // region for this particular deployment.
      const elsewhere = await findCertificateInOtherRegionsImpl({
        domain, excludeRegion: state.region, regions: AWS_REGIONS.map((r) => r.value).filter((v) => v !== '__other__'), execImpl,
      }).catch(() => null);
      if (elsewhere) {
        io.log(`  ℹ Found ${elsewhere.certificates.map((c) => c.domainName).join(', ')} in ${elsewhere.region}, but this deployment is in ${state.region} — ACM certificates can only be attached to a load balancer in the SAME region they were issued in, so it can't be reused here. Requesting a new certificate for ${state.region} instead.`);
      }
      // No existing candidate anywhere usable — the certificate that gets
      // requested (in runAwsProvisionStep/resolveAlbCertificate, once
      // acmCertificateArn is still null here) will be ours to manage.
      acmCreatedByWizard = true;
    }
  } catch (err) {
    io.log(`  ⚠ Could not list existing ACM certificates (${err.message}) — a new one will be requested.`);
    acmCreatedByWizard = true;
  }

  return {
    state: {
      ...state,
      infra: {
        ...state.infra,
        albEnabled: true,
        dnsManaged,
        dnsZoneId: zone.id,
        acm: { certificateArn: acmCertificateArn, issued: acmIssued, createdByWizard: acmCreatedByWizard },
      },
    },
  };
}

export async function runParamsStep({ state, io }) {
  const deploymentName = slugify(await io.ask('Deployment name (used to name Telnyx & cloud resources)', 'cc-main'));
  let domain;
  if (state.target === 'aws' || state.target === 'gcp' || state.target === 'azure') {
    // Cloud targets have no Cloudflare-quick-tunnel fallback — a real public
    // domain is mandatory (Telnyx webhooks need a stable HTTPS URL, and for
    // AWS the DNS step right after this one needs a hostname to work with
    // either way, whether or not it's Route53-managed). GCP/Azure Phase 1/2
    // have no HTTPS Load Balancer / Application Gateway on by default (see
    // cc-compute-single-gcp/cc-compute-single-azure module headers), so
    // the operator's own reverse proxy/CDN is responsible for actually
    // terminating TLS at this domain — same caveat the AWS no-ALB path
    // already carries, just unconditional here since GCP/Azure have no
    // load-balancer equivalent enabled by default. Loop until the user
    // gives a non-empty answer instead of silently falling through to a
    // tunnel that doesn't exist for this target.
    do {
      // eslint-disable-next-line no-await-in-loop -- interactive prompt, must be sequential.
      domain = await io.ask(`Public domain for the app (required for ${state.target.toUpperCase()} — e.g. cc.example.com)`, '');
      if (!domain) {
        io.log(`⚠ ${state.target.toUpperCase()} deployments require a public domain — there is no Cloudflare-tunnel fallback for cloud targets. Telnyx webhooks need a stable HTTPS URL.`);
      }
    } while (!domain);
  } else {
    domain = await io.ask(
      'Public domain for the app, or your own tunnel URL (Enter to skip — auto-starts a Cloudflare quick tunnel instead)',
      '',
    );
    if (state.target !== 'local' && !domain) {
      io.log('⚠ Cloud targets need a public domain for Telnyx webhooks (HTTPS required). Consider a <ip>.nip.io fallback for demos.');
    }
    if (state.target === 'local' && !domain) {
      io.log('  ℹ No domain given — the wizard will auto-start a Cloudflare quick tunnel (cloudflared) pointed at localhost:3000 and use its https://*.trycloudflare.com URL as the Telnyx webhook. Requires the `cloudflared` CLI (checked in the next step).');
    }
  }
  const ownerEmail = await io.ask('Owner admin email', '');
  const ownerPassword = await io.askSecret('Owner admin password (leave blank to auto-generate)');
  const telnyxApiKey = await io.askSecret('Telnyx API key');

  const baseUrl = resolveBaseUrl(domain, state.target);

  let next = {
    ...state,
    deploymentName,
    domain: domain || null,
    ownerEmail,
    // secrets (ownerPassword/telnyxApiKey) are intentionally NOT stored in
    // `state` — they're only threaded through in-memory to the env-gen step.
  };
  next = markStep(next, 'params', 'done');
  return { state: next, answers: { deploymentName, domain, ownerEmail, ownerPassword, telnyxApiKey, baseUrl } };
}

function busyPortsFromPortsCheck(result) {
  // Pulls busy port numbers out of a failed ports check result's detail string.
  // detail format from checkPorts: "<busy joined by ', '> already in use"
  if (!result || result.key !== 'ports' || result.status !== 'fail') return [];
  return (result.detail.match(/\d+/g) || [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export async function runPortConflictStep({
  state,
  io,
  busyPorts,
  execImpl = execFileAsync,
}) {
  // Resolves a "port already in use" situation before re-running preflight. Two
  // non-abort outcomes:
  //   1) bundled Postgres + custom host port  → state.postgres.mode='bundled',
  //      state.postgresHostPort=<free port>; compose.yaml maps that host port
  //      onto the container's 5432. We also auto-pick a free port in 5433-5440
  //      as the recommended default.
  //   2) existing Postgres                    → state.postgres.mode='existing',
  //      state.postgres.{host,port,user,database}; compose.yaml suppresses the
  //      bundled container via COMPOSE_PROFILES=no-with-pg; .env points at it.
  //   3) abort                                → user explicitly gave up; wizard exits.
  //
  // Only the local target reaches this step (cloud targets don't bind host ports
  // at the user's machine).
  io.log('');
  io.log(`⚠ Port conflict — these host ports are in use: ${busyPorts.join(', ')}`);
  io.log('  The wizard can work around it two ways:');
  io.log('');
  // Build the menu — bundled-with-different-port is only useful for the app ports
  // (3000/3001), not 5432: moving the bundled Postgres off 5432 means the container
  // is no longer reachable via 5432 from the host, which the user typically doesn't
  // want. For 5432, "use existing Postgres" is the only non-abort option; we still
  // show "different host port" so users who really want to expose the bundled pg on
  // a non-standard port can do it.
  const has5432 = busyPorts.includes(5432);
  const choices = [];
  if (has5432) {
    choices.push({ value: 'existing', label: 'Use the Postgres I already have running locally' });
    choices.push({ value: 'different-host-port', label: 'Run the bundled Postgres on a different host port (e.g. 5433)' });
  } else {
    choices.push({ value: 'different-host-port', label: `Run Contact Center on different host ports (auto-pick free ports)` });
  }
  choices.push({ value: 'abort', label: 'Abort — I will free the ports manually and re-run' });

  const choice = await io.select('How do you want to resolve this?', choices);

  if (choice === 'abort') {
    return { state: markStep(state, 'port-conflict', 'skipped'), aborted: true };
  }

  if (choice === 'different-host-port') {
    const updates = {};
    for (const port of busyPorts) {
      if (port === 5432) {
        // Pick the first free port in 5433-5440; if none, fall back to asking the user.
        const suggested = await findFreePortInRange(5433, 5440);
        if (suggested) {
          const confirmed = await io.confirm(
            `Map the bundled Postgres container onto host port ${suggested}? (you can pick another below)`,
            true,
          );
          if (confirmed) {
            updates.postgresHostPort = suggested;
            continue;
          }
        }
        const entered = await io.ask('Host port for the bundled Postgres container', '5433');
        const parsed = Number(entered);
        if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
          updates.postgresHostPort = parsed;
        } else {
          io.log('  ✖ Invalid port — aborting port-conflict step');
          return { state, aborted: true };
        }
      } else {
        // App ports (3000/3001) — just bump to the next free port in a small range.
        const suggested = await findFreePortInRange(port + 1, port + 10);
        if (suggested) {
          updates[`hostPort${port}`] = suggested;
        }
      }
    }
    let next = markStep(state, 'port-conflict', 'done');
    next = { ...next, postgresHostPort: updates.postgresHostPort || null };
    return { state: next, aborted: false, updates };
  }

  // choice === 'existing' — collect credentials, probe, refuse to overwrite an
  // existing 'contact_center' database without an explicit confirm.
  if (choice === 'existing') {
    io.log('');
    io.log('Point Contact Center at an existing Postgres. The bundled container will be skipped.');
    const defaultHost = 'localhost';
    const defaultPort = '5432';
    const defaultUser = process.env.USER || 'postgres';
    const host = (await io.ask('Postgres host', defaultHost)) || defaultHost;
    const portStr = (await io.ask('Postgres port', defaultPort)) || defaultPort;
    const port = Number(portStr);
    const user = (await io.ask('Postgres user', defaultUser)) || defaultUser;
    const password = await io.askSecret('Postgres password (leave blank if peer/auth trust)');
    const database = (await io.ask('Database name', 'contact_center')) || 'contact_center';

    const probe = await checkExistingPostgres({ host, port, user, password, execImpl });
    if (!probe.ok) {
      io.log(`  ✖ Could not reach Postgres at ${host}:${port} as ${user} — ${probe.error}`);
      io.log('  Re-run the wizard after fixing the connection.');
      return { state: markStep(state, 'port-conflict', 'skipped'), aborted: true };
    }
    io.log(`  ✔ Connected: ${probe.version}`);

    const dbExists = await checkPostgresDatabaseExists({ host, port, user, password, database, execImpl });
    if (dbExists.error) {
      io.log(`  ⚠ Could not check whether '${database}' exists: ${dbExists.error}`);
    }
    if (dbExists.exists) {
      io.log(`  ⚠ A database called '${database}' already exists on this Postgres.`);
      const ok = await io.confirm(
        'Reuse the existing database? (No schema changes are applied automatically — your existing tables stay as-is.)',
        false,
      );
      if (!ok) {
        const rename = await io.ask('Use a different database name instead', `${database}_${Date.now().toString(36).slice(-4)}`);
        if (!rename) {
          io.log('  ✖ Aborting — no database name confirmed');
          return { state: markStep(state, 'port-conflict', 'skipped'), aborted: true };
        }
        // re-check
        const recheck = await checkPostgresDatabaseExists({ host, port, user, password, database: rename, execImpl });
        if (recheck.exists) {
          io.log(`  ✖ '${rename}' also exists. Pick another name and re-run.`);
          return { state: markStep(state, 'port-conflict', 'skipped'), aborted: true };
        }
        return {
          state: markStep({
            ...state,
            postgres: {
              mode: 'existing', host, port, user, database: rename,
            },
          }, 'port-conflict', 'done'),
          aborted: false,
          answers: { postgresMode: 'existing', existingPostgres: { host, port, user, password, database: rename } },
        };
      }
    }
    return {
      state: markStep({
        ...state,
        postgres: { mode: 'existing', host, port, user, database },
      }, 'port-conflict', 'done'),
      aborted: false,
      answers: { postgresMode: 'existing', existingPostgres: { host, port, user, password, database } },
    };
  }

  // Should be unreachable.
  return { state: markStep(state, 'port-conflict', 'skipped'), aborted: true };
}

export async function runPreflightStep({ state, io, answers, execImpl, fetchImpl, ports }) {
  io.log(`Preflight checks — target: ${state.target}${state.size ? ` (${state.size}, ${state.nodes} node${state.nodes === 1 ? '' : 's'})` : ''}`);
  io.log('');
  // If the user already resolved a port conflict earlier in this run, we already
  // know the effective ports (or that we're in existing-postgres mode where the
  // bundled 5432 check is skipped). Don't re-enter the port-conflict step on
  // resume: `state.postgres.mode === 'existing'` or `state.postgresHostPort` is
  // a sticky marker that the user has chosen their wiring.
  //
  // Defense-in-depth: seed `answers` with whatever sticky state we already have
  // BEFORE running preflight. Without this, a resume from .cc-state.json
  // (state.postgresHostPort=5433, answers.postgresHostPort=undefined) would
  // pass preflight (port 5433 is free, no conflict to resolve), then provision
  // would generate .env with POSTGRES_HOST_PORT=5432 and docker compose would
  // fail at bind time. runLocalProvisionStep also has this fallback, but
  // doing it here too means preflight's own port list is correct on resume
  // (otherwise we'd re-test 5432 instead of 5433 and report it as busy).
  if (!answers) answers = {};
  if (answers.postgresHostPort == null && state.postgresHostPort != null) {
    answers = { ...answers, postgresHostPort: state.postgresHostPort };
  }
  const existingPostgres = state.postgres?.mode === 'existing';
  // No domain given on the Local target => the wizard will auto-start a
  // cloudflared quick tunnel later in this step, so cloudflared becomes a
  // hard requirement here (not just a nice-to-have warning).
  const needsTunnel = state.target === 'local' && !state.domain;
  const portsForPreflight = ports ?? (
    existingPostgres
      ? []
      : (state.postgresHostPort && state.postgresHostPort !== 5432
          ? [3000, 3001, state.postgresHostPort]
          : undefined)
  );
  const { results, canContinue, hasWarn } = await runPreflight({
    target: state.target,
    apiKey: answers?.telnyxApiKey,
    execImpl,
    fetchImpl,
    existingPostgres,
    needsTunnel,
    ...(portsForPreflight ? { ports: portsForPreflight } : {}),
  });
  for (const r of results) {
    io.checkLine(r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'fail', r.label, r.detail);
    if (r.hint && r.status !== 'ok') io.log(`      → ${r.hint}`);
  }
  io.log('');
  // Recoverable: a busy host port on the local target. Hand off to the
  // port-conflict step (which will mutate state.postgres / state.postgresHostPort
  // and we re-run preflight below to confirm the chosen wiring clears the check).
  if (state.target === 'local' && !existingPostgres) {
    const portsResult = results.find((r) => r.key === 'ports');
    const busy = busyPortsFromPortsCheck(portsResult);
    if (busy.length > 0) {
      const pcRes = await runPortConflictStep({ state, io, busyPorts: busy, execImpl });
      if (pcRes.aborted) {
        return { state: pcRes.state, aborted: true, results };
      }
      state = pcRes.state;
      // Merge any answers the port-conflict step produced (postgresMode /
      // existingPostgres) so the later envgen + compose steps see them.
      if (pcRes.answers) {
        answers = { ...(answers || {}), ...pcRes.answers };
      }
      // Re-run preflight with the resolved wiring.
      const rerun = await runPreflight({
        target: state.target,
        apiKey: answers?.telnyxApiKey,
        execImpl,
        fetchImpl,
        existingPostgres: state.postgres?.mode === 'existing',
        // Carry the same tunnel requirement forward — otherwise a no-domain
        // Local run that also hits a port conflict would have a missing
        // cloudflared silently downgraded from "fail" to "warn" on this
        // rerun, letting preflight pass even though provisioning will still
        // need (and fail to start) the required tunnel right after.
        needsTunnel,
        ...(state.postgresHostPort && state.postgresHostPort !== 5432
            ? { ports: [3000, 3001, state.postgresHostPort] }
            : (state.postgres?.mode === 'existing' ? { ports: [] } : {})),
      });
      // Make sure envgen sees the chosen host port too — envgen reads
      // `answers.postgresHostPort`, the wizard stores `state.postgresHostPort`.
      if (state.postgresHostPort) answers = { ...(answers || {}), postgresHostPort: state.postgresHostPort };
      for (const r of rerun.results) {
        io.checkLine(r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'fail', r.label, r.detail);
        if (r.hint && r.status !== 'ok') io.log(`      → ${r.hint}`);
      }
      io.log('');
      if (!rerun.canContinue) {
        io.log('One or more required checks still failed after port-conflict resolution. Fix the issues above and re-run.');
        return { state, aborted: true, results: rerun.results, answers };
      }
      const proceedAfterRerun = await io.confirm('Preflight checks passed. Continue with deployment?', true);
      if (!proceedAfterRerun) {
        io.log('Aborted — nothing was created.');
        return { state, aborted: true, results: rerun.results, answers };
      }
      let next = markStep(state, 'preflight', 'done');
      return { state: next, aborted: false, results: rerun.results, hasWarn: rerun.hasWarn, answers };
    }
  }
  if (!canContinue) {
    io.log('One or more required checks failed. Fix the issues above and re-run `cc doctor` or `cc up`.');
    return { state, aborted: true, results, answers };
  }
  // AWS-specific additions: Terraform version, AWS CLI credentials, and the
  // IAM permission precheck (plan §4g). Run after the base checks pass so a
  // user missing Docker/Telnyx creds sees those errors first (base checks
  // are cheaper and more commonly the actual problem).
  let awsResults = [];
  if (state.target === 'aws') {
    const topology = state.infra?.awsTopology || (state.size === 'large' ? 'ha' : 'single');
    awsResults = await checkAwsCloudPreflight({
      topology, deploymentName: state.deploymentName, region: state.region, nodeCount: state.nodes || 1, execImpl,
    });
    for (const r of awsResults) {
      io.checkLine(r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'fail', r.label, r.detail);
      if (r.hint && r.status !== 'ok') io.log(`      → ${r.hint}`);
    }
    io.log('');
    const awsCanContinue = awsResults.every((r) => r.status !== 'fail');
    if (!awsCanContinue) {
      io.log('One or more AWS checks failed. Fix the issues above (see the hints) and re-run.');
      return { state, aborted: true, results: [...results, ...awsResults], answers };
    }
  }
  // GCP-specific additions: Terraform version, gcloud CLI, auth, ADC, and
  // project reachability (checkGcpCloudPreflight). Same "run after base
  // checks pass" ordering rationale as AWS.
  let gcpResults = [];
  if (state.target === 'gcp') {
    gcpResults = await checkGcpCloudPreflight({
      projectId: state.infra?.gcpProjectId, execImpl,
    });
    for (const r of gcpResults) {
      io.checkLine(r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'fail', r.label, r.detail);
      if (r.hint && r.status !== 'ok') io.log(`      → ${r.hint}`);
    }
    io.log('');
    const gcpCanContinue = gcpResults.every((r) => r.status !== 'fail');
    if (!gcpCanContinue) {
      io.log('One or more GCP checks failed. Fix the issues above (see the hints) and re-run.');
      return { state, aborted: true, results: [...results, ...gcpResults], answers };
    }
  }
  // Azure-specific additions: Terraform version, az CLI, auth, and
  // subscription reachability (checkAzureCloudPreflight). Same "run after
  // base checks pass" ordering rationale as AWS/GCP.
  let azureResults = [];
  if (state.target === 'azure') {
    azureResults = await checkAzureCloudPreflight({
      subscriptionId: state.infra?.azureSubscriptionId, execImpl,
    });
    for (const r of azureResults) {
      io.checkLine(r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'fail', r.label, r.detail);
      if (r.hint && r.status !== 'ok') io.log(`      → ${r.hint}`);
    }
    io.log('');
    const azureCanContinue = azureResults.every((r) => r.status !== 'fail');
    if (!azureCanContinue) {
      io.log('One or more Azure checks failed. Fix the issues above (see the hints) and re-run.');
      return { state, aborted: true, results: [...results, ...azureResults], answers };
    }
  }
  if (hasWarn) {
    const proceed = await io.confirm('Some checks have warnings. Continue anyway?', true);
    if (!proceed) return { state, aborted: true, results, answers };
  }
  // Explicit "go/no-go" moment, always shown once preflight is clean (with or
  // without warnings) — this is the LAST chance to back out before anything
  // gets created (Telnyx voice app, Terraform apply, docker build). Per the
  // wizard's own intro banner ("Nothing is created before step 6"), the
  // consent given at the very start of the run is a general acknowledgement,
  // not a final go-ahead once the user has actually seen their environment's
  // preflight results — a hasWarn=false clean run was previously the only
  // path with NO confirmation at all between preflight and real
  // side-effects starting.
  const proceedClean = await io.confirm('Preflight checks passed. Continue with deployment?', true);
  if (!proceedClean) {
    io.log('Aborted — nothing was created.');
    return { state, aborted: true, results: [...results, ...awsResults, ...gcpResults], answers };
  }
  let next = markStep(state, 'preflight', 'done');
  return { state: next, aborted: false, results: [...results, ...awsResults, ...gcpResults], hasWarn, answers };
}

/**
 * Auto-tunnel step (Local target, no domain given). Runs BEFORE Telnyx
 * bootstrap and BEFORE the Docker build (see runWizard's step order) so that:
 *   - answers.baseUrl is the real public tunnel URL by the time Telnyx
 *     objects (voice app webhook, WebRTC SIP connection webhook, Default
 *     Call Flow webhook) get created — no re-pointing webhooks after the
 *     fact.
 *   - NEXT_PUBLIC_BASE_URL (baked into the Next.js client bundle at `docker
 *     build` time — see docker/production/Dockerfile ARG/ENV
 *     NEXT_PUBLIC_BASE_URL) is correct on the ONE AND ONLY build. Previously
 *     the tunnel started inside the provision step (after the build), which
 *     was fine for the build itself but meant Telnyx bootstrap (which ran
 *     AFTER provision) had to patch .env and restart the container a second
 *     time to pick up the newly-created Telnyx ids — and `docker compose
 *     restart` doesn't even reload env_file, so that restart didn't work
 *     (see the removed restart logic previously in runTelnyxBootstrapStep).
 *     Moving Telnyx bootstrap before provision (and the tunnel before
 *     Telnyx bootstrap) means every value the app needs is known before the
 *     container is ever built — one build, zero restarts.
 */
export async function runLocalTunnelStep({
  state, io, answers, deployDir,
  startTunnelImpl = startQuickTunnel,
}) {
  if (state.domain) {
    // A public domain was given — no tunnel needed. Still record
    // tunnel.mode so printSummary/`cc destroy` know there's no cloudflared
    // process to manage.
    return { state: { ...state, tunnel: { mode: 'user-provided', url: null, pid: null } }, answers, aborted: false };
  }
  // Resume case: a previous run may have left a still-running tunnel
  // process behind (the tunnel is deliberately detached from the wizard so
  // it survives Ctrl-C / process exit). Reuse it instead of starting a
  // second one — quick tunnels get a brand-new random hostname every time,
  // so starting a redundant tunnel would mean re-registering the Telnyx
  // webhook for no reason (and leaking an orphaned cloudflared process).
  if (state.tunnel?.mode === 'cloudflare-quick' && state.tunnel?.pid && isProcessAlive(state.tunnel.pid)) {
    const url = state.tunnel.url;
    io.log(`  ✔ Reusing existing Cloudflare quick tunnel: ${url}`);
    return { state, answers: { ...answers, baseUrl: url }, aborted: false };
  }
  const tunnelLogPath = join(deployDir, '.cc-tunnel.log');
  const tunnelStep = (io.longStep || io.step)('Starting Cloudflare quick tunnel (cloudflared)...');
  try {
    const tunnelInfo = await startTunnelImpl({ port: 3000, logPath: tunnelLogPath });
    tunnelStep.succeed(`Tunnel live: ${tunnelInfo.url}`);
    io.log(`      (proxies localhost:3000 only — streaming/AI flows on port 3001 need a real domain or a named tunnel)`);
    const nextState = { ...state, tunnel: { mode: 'cloudflare-quick', url: tunnelInfo.url, pid: tunnelInfo.pid } };
    return { state: nextState, answers: { ...answers, baseUrl: tunnelInfo.url }, aborted: false };
  } catch (err) {
    tunnelStep.fail(`Could not start cloudflared tunnel: ${err.message}`);
    io.log('  → Install cloudflared (brew install cloudflared) or provide a public domain, then re-run.');
    return { state, answers, aborted: true };
  }
}

/**
 * Step 7 — Provision infra (Local target): writes docker/production/.env
 * (base wizard answers merged with `extraEnvUpdates` — the Telnyx resource
 * ids/secrets from the Telnyx bootstrap step, which now runs BEFORE this
 * step, see runWizard) and does the ONE AND ONLY `docker compose up
 * --build`. Because every env value the app needs (including all TELNYX_*
 * ids) is known before this step runs, there is no second write + restart
 * afterward — unlike the old provision-then-bootstrap-then-restart order,
 * which also silently didn't work (`docker compose restart` doesn't reload
 * env_file; see the removed restart logic).
 */
export async function runLocalProvisionStep({
  state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl,
  extraEnvUpdates = {},
}) {
  const sampleEnvText = await readFile(sampleEnvPath, 'utf8');
  // Inject the deployment slug as the Postgres volume name so each deployment
  // gets its own named Docker volume (cc-postgres-<slug>). On a brand-new host
  // this is a no-op (the volume is empty either way) but on a host that has
  // ever had an older, broken Postgres volume around, this is the difference
  // between "Skipping initialization / role contact_center does not exist" and
  // a clean, working install. See compose.yaml's `volumes:` block.
  //
  // Postgres wiring: prefer `answers.*` (set during the same wizard run when
  // port-conflict actually fires) but fall back to `state.*` for resume flows
  // where the previous run wrote `state.postgresHostPort` / `state.postgres.*`
  // but the in-memory `answers` map is fresh (only holds the params-step
  // answers: ownerEmail, ownerPassword, telnyxApiKey, baseUrl). Without this
  // fallback the second run would generate POSTGRES_HOST_PORT=5432 in .env
  // and docker compose would immediately fail with `bind: address already in
  // use` even though preflight had just confirmed the conflict-free port.
  const provisionAnswers = {
    ...answers,
    postgresVolumeName: slugify(state.deploymentName || 'main'),
    postgresHostPort: answers.postgresHostPort ?? state.postgresHostPort ?? null,
  };
  // If the user picked existing-Postgres in a previous run (and that
  // resolution is sticky in state.postgres.*), reconstruct the
  // existingPostgres block from state for envgen. The password is intentionally
  // NOT persisted in state (it's secret), so on resume the user has to
  // re-supply it via answers.existingPostgres.password if it differs from the
  // current value — that's the same UX as the Telnyx API key.
  const effectiveExistingPostgres =
    state.postgres?.mode === 'existing'
      ? {
          host: state.postgres.host,
          port: state.postgres.port,
          user: state.postgres.user,
          database: state.postgres.database,
          // Password precedence: fresh answer (set during this run) > state
          // (set if we ever choose to persist it later; currently never set)
          password: answers.existingPostgres?.password || state.postgres.password || '',
        }
      : null;
  const { content: baseContent, generatedSecrets } = generateEnvFile({
    sampleEnvText,
    answers: provisionAnswers,
    target: 'local',
    postgresMode: state.postgres?.mode || 'bundled',
    existingPostgres: effectiveExistingPostgres,
  });
  const composeCwd = join(deployDir, '..', 'docker', 'production');
  const envPath = join(composeCwd, '.env');
  // Recover sticky one-time secrets (currently just TELNYX_AI_API_KEY) if
  // this run's Telnyx bootstrap didn't supply a fresh value (either it found
  // the secret already existed in Telnyx — no read-back possible — or this
  // run's extraEnvUpdates simply doesn't include it). generateEnvFile always
  // rebuilds .env from scratch (blank for these keys by default), which
  // would otherwise silently blank out an already-working
  // TELNYX_AI_API_KEY and break AI webhook auth. Two sources, most durable
  // first:
  //   1. .cc-telnyx-secrets.json — written the instant the secret is
  //      created (see runTelnyxBootstrapStep), survives even a crash before
  //      any .env has ever been written.
  //   2. the existing .env on disk, if any (older deploys that predate the
  //      cache file, or a cache miss).
  // See PR review on #1153 and telnyx-secrets-cache.mjs.
  const secretsCache = await readSecretsCache(deployDir);
  let existingStickyValues = {};
  try {
    const existingEnvText = await readFile(envPath, 'utf8');
    existingStickyValues = parseEnvValues(existingEnvText);
  } catch {
    // No .env yet (first-ever run) — nothing to recover from here; the
    // secrets cache above is still checked.
  }
  const stickyRecovered = {};
  for (const key of STICKY_ONE_TIME_ENV_KEYS) {
    const hasFreshValue = Object.prototype.hasOwnProperty.call(extraEnvUpdates, key) && extraEnvUpdates[key];
    if (hasFreshValue) continue;
    if (secretsCache[key]) stickyRecovered[key] = secretsCache[key];
    else if (existingStickyValues[key]) stickyRecovered[key] = existingStickyValues[key];
  }
  // Merge in the Telnyx bootstrap step's resource ids/secrets (voice app,
  // SIP connection, owner credential, purchased number, ...) — Telnyx
  // bootstrap now runs BEFORE this step (see runWizard), so every TELNYX_*
  // value the app needs is already known here. This is what lets the
  // container be built ONCE with the full env, instead of building first
  // and restarting after a second .env write (which also didn't actually
  // work — `docker compose restart` doesn't reload env_file).
  const mergedEnvUpdates = { ...stickyRecovered, ...extraEnvUpdates };
  const content = Object.keys(mergedEnvUpdates).length > 0
    ? applyEnvUpdates(baseContent, mergedEnvUpdates).content
    : baseContent;
  await writeFile(envPath, content, 'utf8');

  // Surface auto-generated secrets (currently the owner password) both
  // on-screen and in a deploy/.cc-credentials.txt file with restrictive
  // permissions, so the user can actually log in. Without this, picking
  // "leave blank to auto-generate" leaves them locked out.
  if (generatedSecrets && Object.keys(generatedSecrets).length > 0) {
    await persistGeneratedSecrets({ deployDir, generatedSecrets });
    for (const [name, value] of Object.entries(generatedSecrets)) {
      io.log('');
      io.log(`  🔑 Auto-generated ${name}: ${chalkGreen(value)}`);
      io.log(`      Saved to deploy/.cc-credentials.txt (chmod 600)`);
    }
  }

  // existing-Postgres mode: suppress the bundled container via the `no-with-pg`
  // negative profile so compose v2 doesn't try to bind 5432 again.
  const existingMode = state.postgres?.mode === 'existing';
  // docker compose build on a cold cache runs the CC Next.js standalone build —
  // typically 60-180s on first run, so a spinner + elapsed timer is essential
  // so the user can tell the wizard is alive. ui.longStep() degrades to a plain
  // log line under non-TTY (CI / log file), so this works in unattended mode too.
  const composeLabel = existingMode
    ? 'Building + starting containers (existing Postgres, first build can take 1-3 min)...'
    : 'Building + starting containers (first build can take 1-3 min)...';
  const s = (io.longStep || io.step)(composeLabel);
  try {
    await composeUp({
      cwd: composeCwd,
      execImpl,
      ...(existingMode ? { excludeProfiles: ['with-pg'] } : {}),
    });
    s.succeed('Containers started');
  } catch (err) {
    s.fail(`docker compose up failed: ${err.message}`);
    return { state, aborted: true };
  }

  const healthUrl = `${answers.baseUrl.replace(/\/$/, '')}/api/health`;
  // Health probing is also long: app container may need ~30s to be ready even
  // after compose up returns (DB migrations, telemetry wiring, etc.).
  // Default timeout is 120s in waitForHealthy but can be configured via
  // WAIT_HEALTHY_TIMEOUT_MS for slow hosts; pass it to the spinner so the user
  // sees `(38s/120s)` and knows how much time is left before the wizard gives up.
  const healthTimeoutMs = Number(process.env.WAIT_HEALTHY_TIMEOUT_MS) || 120_000;
  const waitStep = (io.longStep || io.step)(`Waiting for ${healthUrl} ...`, { timeoutMs: healthTimeoutMs });
  const health = await waitForHealthy({ url: healthUrl, fetchImpl });
  if (health.healthy) {
    waitStep.succeed(`Healthy after ${Math.round(health.elapsedMs / 1000)}s`);
  } else {
    waitStep.fail(`Not healthy after ${Math.round(health.elapsedMs / 1000)}s: ${health.error?.message || 'unknown error'}`);
    return { state, aborted: true };
  }

  let next = markStep(state, 'provision', 'done');
  return { state: next, aborted: false, health, envPath, generatedSecrets, answers };
}

/**
 * Step 6 — Telnyx bootstrap (Local target). Runs BEFORE the Docker
 * provision step now (see runWizard) — creates the voice app, WebRTC SIP
 * connection, owner telephony credential, outbound voice profile, and
 * optionally purchases + assigns a phone number, all via find-by-name
 * upserts so it's safe to re-run on resume.
 *
 * Returns `envUpdates` (the TELNYX_* ids/secrets) instead of writing them to
 * disk itself — the caller (runWizard) threads that map into
 * runLocalProvisionStep's `extraEnvUpdates`, which merges it into the ONE
 * .env write before the ONE container build. This step used to run AFTER
 * provision and patch+restart the already-running container to pick up the
 * new ids — but `docker compose restart` doesn't reload env_file at all, so
 * that restart silently didn't apply the new values, and the fix would have
 * just been a second `compose up -d`. Running Telnyx bootstrap first
 * sidesteps needing a restart in the first place.
 *
 * `pickedNumber` flows through to the orchestrator when the caller already
 * has a candidate (the interactive path asks the user first, then re-invokes
 * with the picked candidate).
 */
export async function runTelnyxBootstrapStep({
  state,
  io,
  answers,
  deployDir,
  fetchImpl,
  pickedNumber = null,
}) {
  const apiKeyValue = answers.telnyxApiKey;
  const result = await runTelnyxBootstrap({
    fetchImpl,
    apiKey: apiKeyValue,
    deploymentName: state.deploymentName,
    baseUrl: answers.baseUrl,
    pickedNumber,
    log: (...args) => io.log(args.join(' ')),
  });

  // Persist sticky one-time secrets (currently TELNYX_AI_API_KEY) to a
  // durable side-channel cache the MOMENT they're created — before this
  // function even returns, let alone before the provision step's .env write
  // + docker build (which can take 1-3 minutes). Without this, a crash in
  // that window on a completely fresh deploy (no .env on disk yet to fall
  // back to) would lose the token forever, since Telnyx never lets us read
  // it back. See PR review on #1153 and telnyx-secrets-cache.mjs.
  if (deployDir) {
    const stickySubset = {};
    for (const key of STICKY_ONE_TIME_ENV_KEYS) {
      if (result.envUpdates?.[key]) stickySubset[key] = result.envUpdates[key];
    }
    await mergeSecretsCache(deployDir, stickySubset, { log: (m) => io.log(m) });
  }

  const next = markStep(state, 'telnyx', 'done');
  return {
    state: {
      ...next,
      telnyx: {
        ...next.telnyx,
        voiceAppId: result.voiceAppId,
        outboundVoiceProfileId: result.outboundVoiceProfileId,
        sipConnectionId: result.sipConnectionId,
        defaultFlowVoiceAppId: result.defaultFlowVoiceAppId,
        phoneNumber: result.phoneNumber,
        phoneNumberId: result.phoneNumberId,
        messagingProfileId: null,
        // Per-file outcome map from ensureMediaFiles (name -> { outcome,
        // ... } | { outcome: 'error', error }) — recorded purely for
        // `cc status`/diagnostics visibility (e.g. surfacing a media
        // upload that failed without aborting the rest of provisioning);
        // never read back to gate any resume logic, unlike
        // state.telnyx.subSteps.
        mediaFiles: result.mediaFiles || next.telnyx?.mediaFiles || null,
      },
    },
    result,
  };
}

/**
 * Step 7 (AWS cloud target) — Terraform provisioning + image build/ship/
 * deploy over SSM. Runs AFTER Telnyx bootstrap (same ordering rationale as
 * the Local target: every TELNYX_* id/secret must be known before the
 * app/env Secrets Manager secret is populated, so there's no
 * populate-then-update-then-restart dance). Mirrors runLocalProvisionStep's
 * contract but is backed by aws-cloud.mjs's provisionAwsInfra instead of
 * docker compose.
 */
export async function runAwsProvisionStep({
  state, io, answers, deployDir, extraEnvUpdates = {}, execImpl, fetchImpl, spawnImpl, sleep,
}) {
  const topology = state.infra?.awsTopology || (state.size === 'large' ? 'ha' : 'single');

  // Multi-node/HA needs an ISSUED ACM certificate before `terraform apply`
  // (the ALB listener references it directly) — resolve/wait for it here,
  // BEFORE writing tfvars, so writeAwsTfvars always has a real ARN in hand.
  let acmCertificateArn;
  let streamingWsDomainName;
  // ALB is mandatory for HA; for single-node it's only present when the
  // wizard's DNS step (runAwsDnsStep) resolved a Route53-managed domain and
  // set state.infra.albEnabled=true. Either way, an ALB needs an ISSUED ACM
  // certificate before `terraform apply` (the listener references it
  // directly) — resolve/wait for it here, BEFORE writing tfvars.
  const needsAlbCertificate = topology === 'ha' || Boolean(state.infra?.albEnabled);
  if (needsAlbCertificate) {
    const certStep = io.step('Resolving ACM certificate for the load balancer...');
    try {
      const cert = await resolveAlbCertificate({ state, region: state.region, execImpl, io });
      if (!cert.issued) {
        certStep.fail(`Certificate not yet issued (status: ${cert.status || 'unknown'}) — DNS validation may still be propagating.`);
        io.log('  → Re-run ./deploy/cc up once the CNAME above has propagated (usually a few minutes, sometimes longer).');
        const nextState = {
          ...state,
          infra: { ...state.infra, acm: { ...state.infra?.acm, certificateArn: cert.certificateArn, issued: false } },
        };
        return { state: nextState, aborted: true };
      }
      certStep.succeed('Certificate issued');
      acmCertificateArn = cert.certificateArn;
      streamingWsDomainName = cert.streamingWsDomainName;
    } catch (err) {
      certStep.fail(`ACM certificate resolution failed: ${err.message}`);
      return { state, aborted: true };
    }
    state = {
      ...state,
      infra: { ...state.infra, acm: { ...state.infra?.acm, certificateArn: acmCertificateArn, issued: true } },
    };
    await saveState(deployDir, state);
  }

  await writeAwsTfvars({
    deployDir, topology, state, acmCertificateArn, streamingWsDomainName,
  });

  // Build the same full env-values map runLocalProvisionStep would write to
  // .env, so provisionAwsInfra's Secrets Manager write carries every value
  // the app needs (DB wiring included) — not just the ~4 interactively
  // collected fields. `postgresMode` is always 'bundled' here: the AWS path
  // provisions its own RDS instance (cc-database module), there's no
  // "existing Postgres" concept for cloud targets. POSTGRES_HOST/PORT get
  // overwritten below from the Terraform-created RDS endpoint once known
  // (provisionAwsInfra doesn't have that until after apply, so this
  // pre-apply pass has placeholder DB connection values — harmless, since
  // the actual runtime env comes from the Secrets Manager secret this
  // function populates AFTER apply completes and the real endpoint is known).
  const sampleEnvText = await readFile(join(deployDir, '..', 'docker', 'production', 'sample.env'), 'utf8');
  const { content: envValuesMap, generatedSecrets } = (() => {
    const { content, generatedSecrets: gs } = generateEnvFile({
      sampleEnvText, answers, target: 'aws', postgresMode: 'bundled', existingPostgres: null,
    });
    return { content: parseEnvValues(content), generatedSecrets: gs };
  })();

  const provisionRes = await provisionAwsInfra({
    state, io, answers: { ...answers, envValues: envValuesMap }, deployDir, extraEnvUpdates,
    execImpl, fetchImpl, spawnImpl, ...(sleep ? { sleep } : {}),
  });
  state = provisionRes.state;
  if (provisionRes.aborted) {
    return { state, aborted: true };
  }

  if (generatedSecrets && Object.keys(generatedSecrets).length > 0) {
    await persistGeneratedSecrets({ deployDir, generatedSecrets });
    for (const [name, value] of Object.entries(generatedSecrets)) {
      io.log('');
      io.log(`  🔑 Auto-generated ${name}: ${chalkGreen(value)}`);
      io.log(`      Saved to deploy/.cc-credentials.txt (chmod 600)`);
    }
  }

  let next = markStep(state, 'provision', 'done');
  return { state: next, aborted: false, generatedSecrets, answers };
}

/**
 * Step 8 — Default Call Flow seeding. REMOVED from the wizard entirely
 * (2026-07-06): seeding now happens inside the app itself, at container
 * boot, via lib/seed-default-call-flow.mjs (called from
 * ensurePostgresSchema() alongside seed-default-owner.mjs /
 * seed-app-settings.mjs) — for BOTH the Local target and every cloud target.
 *
 * The old version of this step connected to Postgres DIRECTLY from the
 * wizard's own machine, which only ever worked for Local (a bundled compose
 * container reachable at localhost). AWS's RDS instance lives in a private
 * subnet the wizard has no route to, so cloud deployments always skipped
 * this step and shipped with no Default Call Flow — the gap this refactor
 * closes. The wizard's only remaining job for the flow is creating its
 * dedicated Telnyx voice app (ensureCoreTelnyxObjects, during Telnyx
 * provisioning — see telnyx-bootstrap-orchestrator.mjs), because that talks
 * to Telnyx's public API, which the operator's machine can always reach
 * regardless of target.
 */

export function printSummary({ state, answers, io, generatedSecrets = {} }) {
  io.header('Telnyx Contact Center is live 🎉');
  io.log('');
  io.log(`  App URL        ${answers.baseUrl}`);
  io.log(`  Owner login    ${answers.ownerEmail}`);
  // When the owner password was auto-generated (user pressed Enter at the
  // "leave blank to auto-generate" prompt), we MUST print it here — otherwise
  // the user has no way to log in. We also write it to .cc-credentials.txt
  // (chmod 600) inside the deploy dir for the persistent copy.
  if (generatedSecrets.ownerPassword) {
    io.log(`  Owner password ${chalkGreen(generatedSecrets.ownerPassword)}  ${chalkGray('(auto-generated — change after first login)')}`);
    io.log(`  Credentials    ${chalkGray('also saved to deploy/.cc-credentials.txt (chmod 600)')}`);
  } else {
    io.log(`  Owner password ${chalkGray('(as you typed — not displayed for safety)')}`);
  }
  io.log(`  Inbound number ${state.telnyx?.phoneNumber || '(not yet — run ./deploy/cc telnyx)'}`);
  io.log('');
  if (state.tunnel?.mode === 'cloudflare-quick') {
    io.log('  🌐 Public access: Cloudflare quick tunnel (auto-started, no domain given)');
    io.log(`     ${state.tunnel.url}`);
    io.log(`     Keeps running after this wizard exits (pid ${state.tunnel.pid}). Stop it with:`);
    io.log(`       kill ${state.tunnel.pid}`);
    io.log('     Note: quick tunnels get a NEW random URL every time they restart — if you');
    io.log('     stop it (or reboot), re-run ./deploy/cc up to start a fresh one and re-point');
    io.log('     the Telnyx webhook automatically. Only port 3000 (HTTP) is tunneled; if you');
    io.log('     build a flow that uses streaming/AI (port 3001), you need a real domain or a');
    io.log('     named (authenticated) Cloudflare tunnel instead.');
    io.log('');
  }
  io.log('  Telnyx resources:');
  io.log(`    Voice app        ${state.telnyx?.voiceAppId || '—'}`);
  io.log(`    OVP              ${state.telnyx?.outboundVoiceProfileId || '—'}`);
  io.log(`    WebRTC SIP conn  ${state.telnyx?.sipConnectionId || '—'}`);
  io.log('');
  io.log('  Useful commands:');
  io.log('    ./deploy/cc status | logs -f | update | telnyx | destroy');
  io.log('');
  io.log(`  Details saved to deploy/.cc-state.json (contains resource IDs, no secrets).`);
}

/**
 * GCP HTTPS Load Balancer opt-in (Phase 3) — the GCP equivalent of AWS's
 * runAwsDnsStep's ALB-opt-in half. This step only decides ONE thing: does
 * this deployment get an HTTPS Load Balancer + Google-managed cert, or does
 * it stay on plain HTTP (Phase 1/2 default)? Cloud DNS automation (finding
 * a matching managed zone and offering to create/overwrite a record there)
 * is a SEPARATE step (runGcpDnsStep, right below) that only runs when this
 * one returns lbEnabled=true — mirrors how AWS's own DNS step branches
 * internally on wantsAlb.
 *
 * Requires state.domain to be set (runParamsStep already made this
 * mandatory for the gcp target) — a managed certificate needs a real
 * hostname to be issued for.
 *
 * Skipped entirely on resume once already decided (state.infra.lbEnabled
 * is a real boolean, not the initial null) so re-running `cc up` doesn't
 * re-ask a question that was already answered and acted on — same resume
 * convention as runAwsDnsStep's albEnabled check.
 */
export async function runGcpLbStep({ state, io }) {
  if (state.target !== 'gcp') return { state };
  const enabled = await io.confirm(
    `Front this deployment with a global HTTPS Load Balancer + Google-managed SSL certificate for ${state.domain}? (Recommended for production — otherwise the app stays on plain HTTP directly on the instance's public IP, same as Phase 1/2.)`,
    false,
  );
  return {
    state: {
      ...state,
      infra: { ...state.infra, lbEnabled: enabled },
    },
  };
}

/**
 * GCP Cloud DNS automation — the GCP equivalent of the Route53 half of
 * AWS's runAwsDnsStep. Only reached when the operator opted into the HTTPS
 * Load Balancer (runGcpLbStep returned lbEnabled=true); a plain-HTTP GCP
 * deployment has no stable Terraform-managed IP worth automating DNS
 * against (the bare instance's public IP is ephemeral across `cc destroy`+
 * `cc up` cycles), same reasoning as why AWS's DNS automation is gated on
 * wantsAlb rather than running unconditionally.
 *
 * Flow (mirrors route53.mjs's usage inside runAwsDnsStep exactly):
 *   1. List the project's Cloud DNS public managed zones.
 *   2. Longest-suffix-match the operator's domain against those zones'
 *      dnsName. No match -> Cloud DNS is not managing this domain; the
 *      operator is told (here + in the final summary) to point the domain
 *      at the Load Balancer's IP by hand.
 *   3. If a zone matches, check whether a record already exists for the
 *      exact hostname — if so, ask whether to overwrite it (declining
 *      leaves DNS unmanaged, same "don't clobber" contract as AWS).
 *   4. Record the resolved zone name + consent in
 *      state.infra.gcpDnsZoneName/gcpDnsManaged, which
 *      gcp-cloud.mjs's writeGcpTfvars threads into the dns_managed_zone
 *      tfvar — Terraform then creates/updates the actual A records in the
 *      SAME apply as the Load Balancer, and tears them down on
 *      `terraform destroy` (see cc-compute-single-gcp's google_dns_record_set
 *      resources), exactly the same reasoning as why AWS's Route53 record
 *      moved from an out-of-band CLI call into a real Terraform resource.
 *
 * Skipped entirely when lbEnabled is false, and skipped on resume once
 * already resolved (state.infra.gcpDnsManaged is a real boolean, not the
 * initial undefined).
 */
export async function runGcpDnsStep({
  state, io, execImpl = execFileAsync,
  listManagedZonesImpl = listManagedZones,
  findZoneForHostnameImpl = findGcpZoneForHostname,
  findRecordForHostImpl = findGcpRecordForHost,
}) {
  if (state.target !== 'gcp' || !state.infra?.lbEnabled) return { state };
  const domain = state.domain;
  const projectId = state.infra?.gcpProjectId;

  const wantsDns = await io.confirm(
    `Manage ${domain}'s DNS automatically in Google Cloud DNS? (No — you'll point ${domain} and ws.${domain} at the Load Balancer's IP yourself once it's known.)`,
    true,
  );
  if (!wantsDns) {
    io.log(`  ℹ No Cloud DNS automation — ${domain} will need to point at this deployment's Load Balancer IP once it's known (see the final summary for the exact instruction).`);
    return {
      state: { ...state, infra: { ...state.infra, gcpDnsManaged: false, gcpDnsZoneName: null } },
    };
  }

  let zones = [];
  try {
    zones = await listManagedZonesImpl({ project: projectId, execImpl });
  } catch (err) {
    io.log(`  ⚠ Could not list Cloud DNS managed zones (${err.message}) — continuing without DNS automation.`);
  }
  const zone = findZoneForHostnameImpl(zones, domain);

  if (!zone) {
    io.log(`  ⚠ ${domain} is not managed by a Cloud DNS zone in this project.`);
    return {
      state: { ...state, infra: { ...state.infra, gcpDnsManaged: false, gcpDnsZoneName: null } },
    };
  }

  io.log(`  ✔ Found Cloud DNS zone "${zone.name}" covering ${domain}.`);
  let dnsManaged = true;
  try {
    const existing = await findRecordForHostImpl({ zoneName: zone.name, fqdn: domain, project: projectId, execImpl });
    if (existing) {
      io.log(`  ⚠ A DNS record already exists for ${domain} in this zone (type ${existing.type}).`);
      const overwrite = await io.confirm('Overwrite it to point at this deployment?', false);
      if (!overwrite) {
        io.log(`  ℹ Leaving the existing record untouched — you'll need to point ${domain} at this deployment's Load Balancer yourself (see the final summary for the exact instruction).`);
        dnsManaged = false;
      }
    }
  } catch (err) {
    io.log(`  ⚠ Could not check for an existing record (${err.message}) — will attempt to create/update it anyway.`);
  }

  return {
    state: {
      ...state,
      infra: { ...state.infra, gcpDnsManaged: dnsManaged, gcpDnsZoneName: zone.name },
    },
  };
}

/**
 * Polls the Google-managed certificate's status after `terraform apply` has
 * created the Load Balancer + certificate resource (runGcpProvisionStep
 * calls this right after provisionGcpInfra succeeds, only when
 * state.infra.lbEnabled is true). Prints the Load Balancer's IP and the
 * exact DNS A record(s) to create BEFORE polling, since the certificate
 * cannot validate until that record exists and has propagated — mirrors
 * ensureCertificate's onValidationRecordsReady callback pattern from the
 * AWS/ACM path, just without an automated-DNS branch (see this module's
 * own header for why).
 *
 * Never aborts the wizard on a timeout — a not-yet-issued certificate is
 * expected and normal (DNS propagation + Google's own polling interval can
 * take up to an hour); the deployment itself already succeeded (the
 * instance is up, serving over the LB's plain-HTTP :80->:443 redirect with
 * a temporary self-signed fallback cert for HTTPS in the meantime). The
 * operator is told to re-check with `cc status` later instead.
 */
export async function runGcpLbWaitStep({
  state, io, execImpl = execFileAsync, waitForManagedCertificateImpl = waitForManagedCertificate,
}) {
  if (!state.infra?.lbEnabled || !state.infra?.lbCertName) return { state };

  io.log('');
  if (state.infra?.gcpDnsManaged) {
    // Terraform already created the A records (google_dns_record_set.app /
    // app_ws, gated on dns_managed_zone) in the SAME apply that created the
    // certificate — nothing for the operator to do by hand, unlike the
    // unmanaged branch below.
    io.log(`  🌐 HTTPS Load Balancer — DNS is managed automatically (Cloud DNS zone "${state.infra.gcpDnsZoneName}").`);
    io.log(`     ${state.domain} and ws.${state.domain} already point at ${state.infra.lbIp}.`);
  } else {
    io.log('  🌐 HTTPS Load Balancer — point your domain\'s DNS at this deployment:');
    io.log(`     Create an A record:`);
    io.log(`       ${state.domain}  ->  ${state.infra.lbIp}`);
    io.log(`       ws.${state.domain}  ->  ${state.infra.lbIp}`);
  }
  io.log(`     The Google-managed certificate cannot validate until this record exists and has propagated.`);
  io.log('');

  const certStep = (io.longStep || io.step)('Waiting for the managed certificate to become ACTIVE (this can take several minutes to an hour)...', { timeoutMs: 30 * 60_000 });
  const result = await waitForManagedCertificateImpl({
    certName: state.infra.lbCertName, project: state.infra?.gcpProjectId, execImpl,
  });
  if (result.issued) {
    certStep.succeed('Certificate ACTIVE — HTTPS is live');
  } else {
    certStep.warn(`Certificate not yet ACTIVE (status: ${result.status || 'unknown'}) — this is normal right after DNS is created. Re-run \`./deploy/cc status\` later to check progress, or \`./deploy/cc up\` again once you've confirmed the DNS record is live.`);
  }
  return { state };
}

/**
 * Azure Application Gateway opt-in (Phase 3) — the Azure equivalent of
 * runGcpLbStep/the ALB half of runAwsDnsStep. Unlike AWS's ACM or GCP's
 * managed certificate (both fully automated issuance), Application Gateway
 * reads its TLS certificate FROM the shared Key Vault — this step only
 * decides the opt-in; getting a real certificate into Key Vault under the
 * exact secret name Terraform expects is runAzureCertificateStep's job
 * (runs later, after DNS, see that function's docstring for why).
 *
 * Skipped entirely on resume once already decided (state.infra.lbEnabled
 * is a real boolean, not the initial null) — same resume convention as
 * runAwsDnsStep's albEnabled check / runGcpLbStep's lbEnabled check. Note:
 * reuses the SAME state.infra.lbEnabled field GCP uses (see state.mjs's
 * comment on that field for why one shared field, not a third
 * provider-specific boolean).
 */
export async function runAzureLbStep({ state, io }) {
  if (state.target !== 'azure') return { state };
  const enabled = await io.confirm(
    `Front this deployment with an Application Gateway v2 + TLS certificate for ${state.domain}? (Recommended for production — otherwise the app stays on plain HTTP directly on the instance's public IP, same as Phase 1/2.)`,
    false,
  );
  return {
    state: {
      ...state,
      infra: { ...state.infra, lbEnabled: enabled },
    },
  };
}

/**
 * Azure DNS automation — the Azure equivalent of the Route53 half of AWS's
 * runAwsDnsStep / runGcpDnsStep. Only reached when the operator opted into
 * the Application Gateway (runAzureLbStep returned lbEnabled=true); a
 * plain-HTTP Azure deployment has no stable Terraform-managed IP worth
 * automating DNS against, same reasoning AWS/GCP's DNS automation is gated
 * on their own load-balancer opt-in.
 *
 * Flow mirrors runGcpDnsStep exactly, adapted to Azure DNS zones being
 * addressed by NAME + RESOURCE GROUP (not a single globally-unique
 * id/name) — both fields are recorded in state.infra so writeAzureTfvars
 * can pass them straight through to the dns_zone_name/
 * dns_zone_resource_group tfvars.
 *
 * Skipped entirely when lbEnabled is false, and skipped on resume once
 * already resolved (state.infra.azureDnsManaged is a real boolean, not the
 * initial undefined). Runs BEFORE runAzureCertificateStep (see that
 * function's docstring) because the Let's Encrypt DNS-01 option it offers
 * is only possible when this step already established Azure DNS zone
 * control (azureDnsManaged=true).
 */
export async function runAzureDnsStep({
  state, io, execImpl = execFileAsync,
  listDnsZonesImpl = listDnsZones,
  findZoneForHostnameImpl = findAzureZoneForHostname,
  findRecordForHostImpl = findAzureRecordForHost,
}) {
  if (state.target !== 'azure' || !state.infra?.lbEnabled) return { state };
  const domain = state.domain;
  const subscriptionId = state.infra?.azureSubscriptionId;

  const wantsDns = await io.confirm(
    `Manage ${domain}'s DNS automatically in Azure DNS? (No — you'll point ${domain} and ws.${domain} at the Application Gateway's IP yourself once it's known.)`,
    true,
  );
  if (!wantsDns) {
    io.log(`  ℹ No Azure DNS automation — ${domain} will need to point at this deployment's Application Gateway IP once it's known (see the final summary for the exact instruction).`);
    return {
      state: { ...state, infra: { ...state.infra, azureDnsManaged: false, azureDnsZoneName: null, azureDnsZoneResourceGroup: null } },
    };
  }

  let zones = [];
  try {
    zones = await listDnsZonesImpl({ subscriptionId, execImpl });
  } catch (err) {
    io.log(`  ⚠ Could not list Azure DNS zones (${err.message}) — continuing without DNS automation.`);
  }
  const zone = findZoneForHostnameImpl(zones, domain);

  if (!zone) {
    io.log(`  ⚠ ${domain} is not managed by an Azure DNS zone in this subscription.`);
    return {
      state: { ...state, infra: { ...state.infra, azureDnsManaged: false, azureDnsZoneName: null, azureDnsZoneResourceGroup: null } },
    };
  }

  io.log(`  ✔ Found Azure DNS zone "${zone.name}" (resource group "${zone.resourceGroup}") covering ${domain}.`);
  let dnsManaged = true;
  try {
    const existing = await findRecordForHostImpl({
      zoneName: zone.name, resourceGroup: zone.resourceGroup, fqdn: domain, subscriptionId, execImpl,
    });
    if (existing) {
      io.log(`  ⚠ A DNS A record already exists for ${domain} in this zone.`);
      const overwrite = await io.confirm('Overwrite it to point at this deployment?', false);
      if (!overwrite) {
        io.log(`  ℹ Leaving the existing record untouched — you'll need to point ${domain} at this deployment's Application Gateway yourself (see the final summary for the exact instruction).`);
        dnsManaged = false;
      }
    }
    // Also check ws.<domain> — Terraform manages BOTH records in the same
    // apply once dnsManaged is true (see cc-compute-single-azure's
    // azurerm_dns_a_record.app_ws), and this step's own prompt above
    // explicitly promises the operator "${domain} and ws.${domain}" will
    // be managed automatically. Without this check a pre-existing
    // ws.<domain> record (e.g. from a prior manual setup, or a different
    // service already using that hostname) would be silently
    // overwritten by `terraform apply` with no chance to decline — same
    // "don't clobber without asking" contract the primary-domain check
    // above already gives the operator.
    if (dnsManaged) {
      const wsHost = `ws.${domain}`;
      const existingWs = await findRecordForHostImpl({
        zoneName: zone.name, resourceGroup: zone.resourceGroup, fqdn: wsHost, subscriptionId, execImpl,
      });
      if (existingWs) {
        io.log(`  ⚠ A DNS A record already exists for ${wsHost} in this zone.`);
        const overwriteWs = await io.confirm(`Overwrite it too, to point at this deployment?`, false);
        if (!overwriteWs) {
          io.log(`  ℹ Leaving the existing ${wsHost} record untouched — you'll need to point BOTH ${domain} and ${wsHost} at this deployment's Application Gateway yourself (see the final summary for the exact instructions), since Terraform manages them as a pair.`);
          dnsManaged = false;
        }
      }
    }
  } catch (err) {
    io.log(`  ⚠ Could not check for an existing record (${err.message}) — will attempt to create/update it anyway.`);
  }

  return {
    state: {
      ...state,
      infra: {
        ...state.infra, azureDnsManaged: dnsManaged, azureDnsZoneName: zone.name, azureDnsZoneResourceGroup: zone.resourceGroup,
      },
    },
  };
}

/**
 * Azure Application Gateway TLS certificate provisioning (Phase 3.5) —
 * runs AFTER runAzureDnsStep (needs to know whether Azure DNS is managing
 * the zone, since that gates the Let's Encrypt option) and AFTER the Key
 * Vault bootstrap pass (runAzureWizardTail calls provisionAzureKeyVaultOnly
 * first on a fresh deployment specifically so keyVaultName is already known
 * by the time this step runs — no more "come back and re-run cc up" gap).
 * Only reached when the operator opted into the Application Gateway
 * (lbEnabled=true); a plain-HTTP deployment has no certificate requirement
 * at all.
 *
 * Decision order — NOT a free-form menu. The operator only ever gets a
 * yes/no confirm, never an open choice between reuse/Let's Encrypt/manual:
 *   1. Look for an existing usable certificate already in THIS
 *      deployment's Key Vault (covers both `domain` and `ws.<domain>` —
 *      found via azure-keyvault-cert.mjs's findCertificatesForDomain).
 *      If found, ask a single yes/no "reuse this one?" — decline falls
 *      through to step 2/3 exactly as if none had been found.
 *   2. No usable existing certificate, and Azure DNS already controls the
 *      zone (state.infra.azureDnsManaged=true, i.e. DNS-01 challenge
 *      records can be created programmatically): AUTOMATICALLY issue a
 *      Let's Encrypt certificate via ACME DNS-01 (azure-acme.mjs) — no
 *      prompt, no opt-out. The operator already told us they want HTTPS
 *      by opting into the Application Gateway; once we know we CAN get a
 *      real certificate for them, we always do, rather than asking them
 *      to choose between "secure" and "not secure yet" on every run.
 *   3. No usable existing certificate, and Azure DNS does NOT control the
 *      zone: DNS-01 is impossible (no way to create the challenge TXT
 *      record), so this is the one remaining case that still requires a
 *      manual PFX import — a real ACME/DNS constraint, not a UX choice.
 *
 * Skipped entirely when lbEnabled is false, and skipped on resume once
 * already resolved (state.infra.azureTlsCertSource is a real string).
 */
export async function runAzureCertificateStep({
  state, io, execImpl = execFileAsync,
  findCertificatesForDomainImpl = findCertificatesForDomain,
  copyCertificateToNameImpl = copyCertificateToName,
  issueCertificateViaDns01Impl = issueCertificateViaDns01,
  importPfxToKeyVaultImpl = importPfxToKeyVault,
  deployDir,
}) {
  if (state.target !== 'azure' || !state.infra?.lbEnabled) return { state };

  const domain = state.domain;
  const targetSecretName = `${state.deploymentName}-tls-cert`;
  const vaultName = state.infra?.keyVaultName;

  if (!vaultName) {
    // Should not normally happen — runAzureWizardTail bootstraps the Key
    // Vault via provisionAzureKeyVaultOnly BEFORE calling this step. This
    // is a defensive fallback only (e.g. the bootstrap pass itself was
    // aborted/declined) so the wizard still degrades gracefully to the
    // old two-pass behavior instead of crashing on a null vault name.
    io.log('  ⚠ No Key Vault known yet for this deployment — skipping automatic certificate provisioning for now. Re-run `./deploy/cc up` once the Key Vault exists.');
    return {
      state: { ...state, infra: { ...state.infra, azureTlsCertSource: null } },
    };
  }

  let existingCandidates = [];
  try {
    existingCandidates = await findCertificatesForDomainImpl({
      vaultName, domain, altNames: [`ws.${domain}`], execImpl,
    });
  } catch (err) {
    io.log(`  ⚠ Could not list Key Vault "${vaultName}"'s certificates (${err.message}) — continuing without the reuse option.`);
  }

  if (existingCandidates.length > 0) {
    const cert = existingCandidates[0];
    const reuse = await io.confirm(
      `Found an existing certificate "${cert.name}" in Key Vault "${vaultName}" covering ${domain} + ws.${domain} (valid until ${new Date(cert.validTo).toISOString().slice(0, 10)}). Reuse it?`,
      true,
    );
    if (reuse) {
      const copyStep = io.step(`Copying certificate "${cert.name}" to "${targetSecretName}"...`);
      try {
        await copyCertificateToNameImpl({
          vaultName, sourceName: cert.name, targetName: targetSecretName, execImpl,
        });
        copyStep.succeed(`Certificate ready as "${targetSecretName}"`);
        return {
          state: { ...state, infra: { ...state.infra, azureTlsCertSource: 'existing', azureTlsCertSourceName: cert.name } },
        };
      } catch (err) {
        copyStep.fail(`Could not copy certificate: ${err.message}`);
        io.log('  ℹ Falling through to automatic issuance/manual import below.');
        // Falls through to the Let's Encrypt / manual branch below —
        // deliberately NOT returning here, same "don't dead-end the
        // operator on one failed path" principle as the rest of this step.
      }
    }
  }

  if (state.infra?.azureDnsManaged) {
    // Azure DNS already controls the zone => DNS-01 is possible => we
    // ALWAYS get the operator a real certificate automatically. This is
    // not offered as a choice: the operator already opted into HTTPS by
    // enabling the Application Gateway, so once we know we can deliver on
    // that, we do — no "issue via Let's Encrypt?" prompt to decline.
    io.log(`  ℹ No existing certificate to reuse — issuing a free certificate via Let's Encrypt automatically (Azure DNS manages ${domain}, so the DNS-01 challenge can be completed without operator involvement).`);
    const issueStep = (io.longStep || io.step)("Requesting a certificate from Let's Encrypt (DNS-01 — this can take a minute for DNS propagation)...", { timeoutMs: 5 * 60_000 });
    try {
      const result = await issueCertificateViaDns01Impl({
        domain,
        altNames: [`ws.${domain}`],
        deployDir,
        zoneName: state.infra?.azureDnsZoneName,
        resourceGroup: state.infra?.azureDnsZoneResourceGroup,
        subscriptionId: state.infra?.azureSubscriptionId,
      });
      await importPfxToKeyVaultImpl({
        vaultName, targetName: targetSecretName, pfxBuffer: result.pfxBuffer, pfxPassword: result.pfxPassword, execImpl,
      });
      issueStep.succeed(`Certificate issued and imported as "${targetSecretName}"`);
      // Surface (not swallow) any leftover ACME challenge TXT records —
      // discovered via live testing: Azure DNS zones created by
      // PURCHASING a domain through Azure (as opposed to just hosting an
      // externally-registered one) get an automatic CanNotDelete resource
      // lock, which silently blocks the DNS-01 cleanup step above. The
      // issuance itself still succeeds (the lock only blocks deletes, not
      // creates), so this is cosmetic — but the operator should know
      // those records exist rather than being surprised by mystery
      // _acme-challenge entries in their zone later.
      if (result.cleanupFailures?.length > 0) {
        io.log(`  ⚠ Could not remove ${result.cleanupFailures.length} leftover ACME challenge TXT record(s) after issuance (harmless, but worth knowing about):`);
        for (const f of result.cleanupFailures) {
          io.log(`      ${f.relativeName === '@' ? '_acme-challenge' : f.relativeName} — ${f.error.split('\n')[0]}`);
        }
        io.log(`     If this is a "ScopeLocked"/"CanNotDelete" error, it's likely because this DNS zone was created by purchasing the domain through Azure (Azure auto-locks those zones against deletion, including individual record deletes) — the leftover TXT records are inert and won't affect the deployment, but you can remove the zone-level lock in the Azure Portal first if you want automatic cleanup on future renewals.`);
      }
      return {
        state: { ...state, infra: { ...state.infra, azureTlsCertSource: 'letsencrypt', azureTlsCertSourceName: targetSecretName } },
      };
    } catch (err) {
      issueStep.fail(`Let's Encrypt issuance failed: ${err.message}`);
      io.log('  ℹ Falling back to manual import — see the summary at the end of this run for the exact command.');
      // Falls through to the manual-import instructions below.
    }
  }

  // Only reached when: no existing certificate was reused, AND either
  // Azure DNS doesn't manage the zone (DNS-01 impossible) or automatic
  // issuance itself failed. This is the one case that genuinely requires
  // operator action — not a UX choice, a real constraint (no zone control
  // means no way to complete a DNS-01 challenge programmatically).
  io.log(`  ℹ Before this run's \`terraform apply\` can succeed, import a valid TLS certificate (PFX, with private key, covering both ${domain} and ws.${domain}) into Key Vault "${vaultName}" under secret name "${targetSecretName}":`);
  io.log(`      az keyvault certificate import --vault-name ${vaultName} --name ${targetSecretName} --file /path/to/cert.pfx`);
  return {
    state: { ...state, infra: { ...state.infra, azureTlsCertSource: 'manual', azureTlsCertSourceName: null } },
  };
}


/**
 * Step 7 (Azure cloud target) — Terraform provisioning + image build/ship/
 * deploy over `az vm run-command invoke`. Runs AFTER Telnyx bootstrap, same
 * ordering rationale as AWS/GCP/Local (every TELNYX_* id/secret must be
 * known before the app/env Key Vault secret is populated), and AFTER the
 * certificate step (runAzureCertificateStep) has already ensured a real
 * certificate sits in Key Vault under the exact secret name this apply's
 * Application Gateway expects — see that function's docstring for the
 * single-pass bootstrap sequencing. Mirrors runAwsProvisionStep's/
 * runGcpProvisionStep's contract but is backed by azure-cloud.mjs's
 * provisionAzureInfra. No cert-status wait step here (unlike GCP's
 * runGcpLbWaitStep) — Application Gateway has no async issuance to poll;
 * by the time this step runs the certificate already exists (or the
 * operator was told exactly what manual step remains), so a missing/
 * invalid certificate simply fails `terraform apply` outright rather than
 * lingering in a pending-validation state worth polling.
 */
export async function runAzureProvisionStep({
  state, io, answers, deployDir, extraEnvUpdates = {}, execImpl, fetchImpl, spawnImpl, sleep,
}) {
  await writeAzureTfvars({ deployDir, state });

  // Same rationale as runAwsProvisionStep/runGcpProvisionStep: build the
  // full env-values map so provisionAzureInfra's Key Vault write carries
  // every value the app needs, not just the ~4 interactively collected
  // fields. `postgresMode` is always 'bundled' — the Azure path provisions
  // its own Postgres Flexible Server (cc-database-azure module), there's
  // no "existing Postgres" concept for cloud targets. POSTGRES_HOST/PORT
  // get overwritten below from the Terraform-created Flexible Server FQDN
  // once known.
  const sampleEnvText = await readFile(join(deployDir, '..', 'docker', 'production', 'sample.env'), 'utf8');
  const { content: envValuesMap, generatedSecrets } = (() => {
    const { content, generatedSecrets: gs } = generateEnvFile({
      sampleEnvText, answers, target: 'azure', postgresMode: 'bundled', existingPostgres: null,
    });
    return { content: parseEnvValues(content), generatedSecrets: gs };
  })();

  const provisionRes = await provisionAzureInfra({
    state, io, answers: { ...answers, envValues: envValuesMap }, deployDir, extraEnvUpdates,
    execImpl, fetchImpl, spawnImpl, ...(sleep ? { sleep } : {}),
  });
  state = provisionRes.state;
  if (provisionRes.aborted) {
    return { state, aborted: true };
  }

  // Persist/print any auto-generated credentials (e.g. the owner password)
  // — same ordering rationale as runGcpProvisionStep (persist before any
  // later best-effort step, though Azure has none here since there's no
  // cert-status wait to run).
  if (generatedSecrets && Object.keys(generatedSecrets).length > 0) {
    await persistGeneratedSecrets({ deployDir, generatedSecrets });
    for (const [name, value] of Object.entries(generatedSecrets)) {
      io.log('');
      io.log(`  🔑 Auto-generated ${name}: ${chalkGreen(value)}`);
      io.log(`      Saved to deploy/.cc-credentials.txt (chmod 600)`);
    }
  }

  let next = markStep(state, 'provision', 'done');
  return { state: next, aborted: false, generatedSecrets, answers };
}

/**
 * Azure cloud-target tail of the wizard (Phase 2/3): Application Gateway
 * opt-in (runAzureLbStep) -> Azure DNS automation (runAzureDnsStep) ->
 * Telnyx bootstrap -> Terraform provisioning + image build/ship/deploy
 * (runAzureProvisionStep) -> summary. Default Call Flow seeding happens
 * inside the app container at boot (lib/seed-default-call-flow.mjs),
 * exactly like Local/AWS/GCP — no separate step needed here. Mirrors
 * runGcpWizardTail's structure exactly (see that function's docstring for
 * the full step-ordering rationale).
 */
export async function runAzureWizardTail({
  state, io, answers, deployDir, execImpl, fetchImpl, spawnImpl, sleep,
  buyNumber = true, pickedNumber = null, countryCode = 'US',
}) {
  // Step 5.5 (Phase 3) — Application Gateway opt-in. Must run before
  // Telnyx bootstrap/provisioning since its outcome (state.infra.lbEnabled)
  // feeds directly into writeAzureTfvars. Skipped entirely on resume once
  // already resolved — same resume convention as AWS's albEnabled check /
  // GCP's lbEnabled check.
  if (state.infra?.lbEnabled === undefined || state.infra?.lbEnabled === null) {
    const lbRes = await runAzureLbStep({ state, io });
    state = lbRes.state;
    await saveState(deployDir, state);
  } else {
    io.log(`  ✔ Application Gateway — ${state.infra.lbEnabled ? 'enabled (import your own TLS cert into Key Vault)' : 'disabled (plain HTTP on the instance)'} (resumed)`);
  }

  // Step 5.6 (Azure DNS automation) — only reached when the Gateway is
  // enabled (runAzureDnsStep itself no-ops for target!=azure /
  // lbEnabled=false). Same resume convention: skip once
  // state.infra.azureDnsManaged is already a real boolean.
  if (state.infra?.lbEnabled && (state.infra?.azureDnsManaged === undefined || state.infra?.azureDnsManaged === null)) {
    const dnsRes = await runAzureDnsStep({ state, io, execImpl });
    state = dnsRes.state;
    await saveState(deployDir, state);
  } else if (state.infra?.lbEnabled) {
    io.log(`  ✔ Azure DNS — ${state.infra.azureDnsManaged ? `managed automatically (zone "${state.infra.azureDnsZoneName}")` : 'not managed by Terraform (point DNS manually)'} (resumed)`);
  }

  // Step 5.6.5 (Azure Key Vault bootstrap) — runs AFTER DNS, BEFORE the
  // certificate step, ONLY when the Gateway is enabled and no Key Vault is
  // known yet (a totally fresh deployment). This is what makes the whole
  // Azure flow single-pass: instead of letting the full-stack
  // terraform apply fail on the Application Gateway's missing certificate
  // and forcing a second `cc up`, we create JUST the resource group + Key
  // Vault now (provisionAzureKeyVaultOnly, a small `-target`-scoped
  // apply), so runAzureCertificateStep immediately below has a real
  // keyVaultName to reuse/issue-into/import-into in THIS SAME run. Skipped
  // entirely once keyVaultName is already known (resumed deployment, or a
  // deployment that already went through this step).
  if (state.infra?.lbEnabled && !state.infra?.keyVaultName) {
    const kvRes = await provisionAzureKeyVaultOnly({ state, io, deployDir, execImpl, spawnImpl });
    state = kvRes.state;
    await saveState(deployDir, state);
    if (kvRes.aborted) {
      return { state, aborted: true };
    }
  }

  // Step 5.7 (Azure TLS certificate) — runs AFTER DNS (needs
  // azureDnsManaged to decide whether Let's Encrypt is offered) and only
  // when the Gateway is enabled (runAzureCertificateStep itself no-ops for
  // target!=azure / lbEnabled=false). Same resume convention: skip once
  // state.infra.azureTlsCertSource is already a real string.
  if (state.infra?.lbEnabled && !state.infra?.azureTlsCertSource) {
    const certRes = await runAzureCertificateStep({ state, io, execImpl, deployDir });
    state = certRes.state;
    await saveState(deployDir, state);
  } else if (state.infra?.lbEnabled) {
    io.log(`  ✔ TLS certificate — ${state.infra.azureTlsCertSource} (resumed)`);
  }

  let picked = pickedNumber;
  if (state.telnyx?.phoneNumber) {
    picked = { id: state.telnyx.phoneNumberId, phone_number: state.telnyx.phoneNumber };
    io.log(`  ✔ Phone number — reusing ${state.telnyx.phoneNumber} from a previous run.`);
  } else if (buyNumber && !picked) {
    let pickResult;
    try {
      pickResult = await pickPhoneNumber({
        fetchImpl,
        apiKey: answers?.telnyxApiKey,
        countryCode,
        log: (...args) => io.log(args.join(' ')),
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        io.log('');
        io.log(`  ✖ ${err.message}`);
        io.log('');
        state = markStep(state, 'telnyx', 'pending');
        await saveState(deployDir, state);
        return { state, aborted: true, reason: 'INSUFFICIENT_BALANCE' };
      }
      throw err;
    }
    const { candidates } = pickResult;
    if (candidates.length === 0) {
      io.log('  ⚠ No phone numbers available for the requested country — continuing without a number (you can run ./deploy/cc telnyx later).');
    } else {
      const options = candidates.map((n) => {
        const cost = n?.cost_information?.monthly_cost || '?';
        return {
          label: `${n.phone_number}  $${cost}/mo`,
          value: { phone_number: n.phone_number, monthly_cost: cost },
          description: n.region_information?.region_name || n.locality || '',
        };
      });
      const choice = await io.select(
        `Pick a ${countryCode} phone number to assign to this deployment`,
        options,
      );
      picked = { phone_number: choice.phone_number };
    }
  } else if (!buyNumber) {
    io.log('  ℹ Skipping number purchase (buyNumber=false) — you can assign one later via ./deploy/cc telnyx.');
  }

  const telnyxRes = await runTelnyxBootstrapStep({
    state, io, answers, deployDir, fetchImpl, pickedNumber: picked,
  });
  state = telnyxRes.state;
  await saveState(deployDir, state);

  const provisionRes = await runAzureProvisionStep({
    state, io, answers, deployDir,
    extraEnvUpdates: telnyxRes.result?.envUpdates || {},
    execImpl, fetchImpl, spawnImpl, sleep,
  });
  state = provisionRes.state;
  if (provisionRes.aborted) {
    await saveState(deployDir, state);
    return { state, aborted: true };
  }
  await saveState(deployDir, state);

  state = markStep(state, 'summary', 'done');
  await saveState(deployDir, state);

  printAzureSummary({ state, answers, io, generatedSecrets: provisionRes.generatedSecrets });
  return { state, aborted: false };
}

/**
 * Azure cloud-target summary — analogous to printAwsSummary/printGcpSummary
 * but surfaces Azure's terraform-created infra (public IP, VM name,
 * resource group, storage account) and always tells the operator to point
 * their own domain at the deployment by hand when Azure DNS automation
 * isn't managing it (or when there's no Application Gateway at all).
 */
export function printAzureSummary({ state, answers, io, generatedSecrets = {} }) {
  io.header('Telnyx Contact Center is live 🎉');
  io.log('');
  io.log(`  App URL        ${state.infra?.appUrl || answers.baseUrl}`);
  io.log(`  Owner login    ${answers.ownerEmail}`);
  if (generatedSecrets.ownerPassword) {
    io.log(`  Owner password ${chalkGreen(generatedSecrets.ownerPassword)}  ${chalkGray('(auto-generated — change after first login)')}`);
    io.log(`  Credentials    ${chalkGray('also saved to deploy/.cc-credentials.txt (chmod 600)')}`);
  } else {
    io.log(`  Owner password ${chalkGray('(as you typed — not displayed for safety)')}`);
  }
  io.log(`  Inbound number ${state.telnyx?.phoneNumber || '(not yet — run ./deploy/cc telnyx)'}`);
  io.log('');
  io.log(`  Azure subscription  ${state.infra?.azureSubscriptionId || '—'}`);
  io.log(`  Resource group      ${state.infra?.azureResourceGroup || '—'}`);
  io.log(`  Public IP           ${state.infra?.publicIp || '—'}`);
  io.log(`  VM name             ${state.infra?.vmName || '—'}`);
  io.log(`  Storage account     ${state.infra?.storageAccount || '—'}`);
  io.log('');
  if (state.infra?.lbEnabled) {
    if (state.infra?.azureDnsManaged) {
      io.log(`  🌐 Application Gateway — DNS managed automatically (Azure DNS zone "${state.infra.azureDnsZoneName}").`);
      io.log(`     ${state.domain} and ws.${state.domain} already point at ${state.infra?.appgwPublicIp || '(pending)'}.`);
    } else {
      io.log('  🌐 Application Gateway — point your domain at this deployment:');
      if (state.infra?.appgwPublicIp) {
        io.log(`     Create A records:`);
        io.log(`       ${state.domain}  ->  ${state.infra.appgwPublicIp}`);
        io.log(`       ws.${state.domain}  ->  ${state.infra.appgwPublicIp}`);
      } else {
        io.log(`     (Application Gateway IP not yet known — re-run \`./deploy/cc status\` once provisioning finishes, then create the DNS records.)`);
      }
    }
    if (state.infra?.azureTlsCertSource === 'existing') {
      io.log(`     ✔ TLS certificate: reused existing Key Vault certificate "${state.infra?.azureTlsCertSourceName}".`);
    } else if (state.infra?.azureTlsCertSource === 'letsencrypt') {
      io.log(`     ✔ TLS certificate: issued automatically via Let's Encrypt.`);
    } else {
      // 'manual' or null (Key Vault bootstrap itself never completed) —
      // the one remaining case that requires operator action, either
      // because Azure DNS doesn't manage the zone (DNS-01 impossible) or
      // automatic issuance failed.
      io.log(`     ⚠ TLS certificate: import one yourself — \`terraform apply\` will fail on the Application Gateway step until you do:`);
      io.log(`         az keyvault certificate import --vault-name ${state.infra?.keyVaultName || '<key-vault-name>'} --name ${state.deploymentName}-tls-cert --file /path/to/cert.pfx`);
      io.log(`     Then re-run \`./deploy/cc up\` to finish provisioning.`);
    }
    io.log('');
  } else if (state.domain) {
    io.log('  🌐 DNS — point your domain at this deployment yourself:');
    if (state.infra?.publicIp) {
      io.log(`     Create an A record:`);
      io.log(`       ${state.domain}  ->  ${state.infra.publicIp}`);
    } else {
      io.log(`     (Public address not yet known — re-run \`./deploy/cc status\` once provisioning finishes, then create the DNS record.)`);
    }
    io.log(`     Note: the app serves plain HTTP directly on the instance (no Application`);
    io.log(`     Gateway yet) — put your own reverse proxy/CDN in front of it for TLS.`);
    io.log('');
  }
  if (state.portainer?.agentEnabled) {
    io.log(`  🐳 Portainer agent enabled on port ${state.portainer.agentPort} — pair it from your own Portainer server.`);
    io.log('');
  }
  io.log('  Telnyx resources:');
  io.log(`    Voice app        ${state.telnyx?.voiceAppId || '—'}`);
  io.log(`    OVP              ${state.telnyx?.outboundVoiceProfileId || '—'}`);
  io.log(`    WebRTC SIP conn  ${state.telnyx?.sipConnectionId || '—'}`);
  io.log('');
  io.log('  Useful commands:');
  io.log('    ./deploy/cc status | logs -f | update | telnyx | destroy');
  io.log('');
  io.log(`  Details saved to deploy/.cc-state.json (contains resource IDs, no secrets).`);
}

/**
 * Step 7 (GCP cloud target) — Terraform provisioning + image build/ship/
 * deploy over an IAP-tunneled SSH command. Runs AFTER Telnyx bootstrap, same
 * ordering rationale as AWS/Local (every TELNYX_* id/secret must be known
 * before the app/env Secret Manager secret is populated). Mirrors
 * runAwsProvisionStep's contract but is backed by gcp-cloud.mjs's
 * provisionGcpInfra instead of provisionAwsInfra. Phase 3: also runs the
 * HTTPS Load Balancer cert-status wait (runGcpLbWaitStep) right after a
 * successful provision, when state.infra.lbEnabled is true.
 */
export async function runGcpProvisionStep({
  state, io, answers, deployDir, extraEnvUpdates = {}, execImpl, fetchImpl, spawnImpl, sleep,
}) {
  await writeGcpTfvars({ deployDir, state });

  // Same rationale as runAwsProvisionStep: build the full env-values map so
  // provisionGcpInfra's Secret Manager write carries every value the app
  // needs, not just the ~4 interactively collected fields. `postgresMode` is
  // always 'bundled' — the GCP path provisions its own Cloud SQL instance
  // (cc-database-gcp module), there's no "existing Postgres" concept for
  // cloud targets. POSTGRES_HOST/PORT get overwritten below from the
  // Terraform-created Cloud SQL private IP once known.
  const sampleEnvText = await readFile(join(deployDir, '..', 'docker', 'production', 'sample.env'), 'utf8');
  const { content: envValuesMap, generatedSecrets } = (() => {
    const { content, generatedSecrets: gs } = generateEnvFile({
      sampleEnvText, answers, target: 'gcp', postgresMode: 'bundled', existingPostgres: null,
    });
    return { content: parseEnvValues(content), generatedSecrets: gs };
  })();

  const provisionRes = await provisionGcpInfra({
    state, io, answers: { ...answers, envValues: envValuesMap }, deployDir, extraEnvUpdates,
    execImpl, fetchImpl, spawnImpl, ...(sleep ? { sleep } : {}),
  });
  state = provisionRes.state;
  if (provisionRes.aborted) {
    return { state, aborted: true };
  }

  // Persist/print any auto-generated credentials (e.g. the owner password)
  // BEFORE the best-effort certificate wait below. That wait can run for
  // up to 30 minutes (DNS propagation + Google's own CA polling interval),
  // and until this repo's own PR #1191 review this credential-saving step
  // ran AFTER it — so a Ctrl-C or terminal disconnect during a long
  // cert-provisioning wait meant an auto-generated owner password that
  // only ever existed in Secret Manager, never written to
  // deploy/.cc-credentials.txt nor shown to the operator. The deployment
  // itself has already succeeded by this point (provisionGcpInfra
  // returned aborted: false) — there is no reason credential persistence
  // should be gated behind an unrelated, best-effort, long-running poll.
  if (generatedSecrets && Object.keys(generatedSecrets).length > 0) {
    await persistGeneratedSecrets({ deployDir, generatedSecrets });
    for (const [name, value] of Object.entries(generatedSecrets)) {
      io.log('');
      io.log(`  🔑 Auto-generated ${name}: ${chalkGreen(value)}`);
      io.log(`      Saved to deploy/.cc-credentials.txt (chmod 600)`);
    }
  }

  // Phase 3: when the operator opted into the HTTPS Load Balancer
  // (runGcpLbStep), the certificate resource now exists (terraform apply
  // just created it) but Google's CA hasn't necessarily validated it yet —
  // print the DNS instructions and poll for ACTIVE status. Best-effort:
  // never aborts the wizard (see runGcpLbWaitStep's own docstring). Runs
  // AFTER credential persistence above (see that comment for why the
  // ordering matters).
  if (state.infra?.lbEnabled) {
    await runGcpLbWaitStep({ state, io, execImpl });
  }

  let next = markStep(state, 'provision', 'done');
  return { state: next, aborted: false, generatedSecrets, answers };
}

/**
 * GCP cloud-target tail of the wizard (Phase 2/3): HTTPS Load Balancer
 * opt-in (runGcpLbStep) -> Telnyx bootstrap -> Terraform provisioning +
 * image build/ship/deploy (runGcpProvisionStep, which also runs the
 * cert-status wait when lbEnabled) -> summary. Default Call Flow seeding
 * happens inside the app container at boot (lib/seed-default-call-flow.mjs),
 * exactly like Local and AWS — no separate step needed here.
 *
 * Still no Cloud DNS automation (unlike AWS's runAwsDnsStep, which can
 * auto-manage a Route53 record) — the operator always points their own
 * domain's A record at the Load Balancer's IP (or, with lbEnabled=false,
 * the instance's public IP) by hand, printed in the final summary.
 */
export async function runGcpWizardTail({
  state, io, answers, deployDir, execImpl, fetchImpl, spawnImpl, sleep,
  buyNumber = true, pickedNumber = null, countryCode = 'US',
}) {
  // Step 5.5 (Phase 3) — HTTPS Load Balancer opt-in. Must run before
  // Telnyx bootstrap/provisioning since its outcome (state.infra.lbEnabled)
  // feeds directly into writeGcpTfvars. Skipped entirely on resume once
  // already resolved (state.infra.lbEnabled is a real boolean, not the
  // initial null) — same resume convention as AWS's albEnabled check.
  if (state.infra?.lbEnabled === undefined || state.infra?.lbEnabled === null) {
    const lbRes = await runGcpLbStep({ state, io });
    state = lbRes.state;
    await saveState(deployDir, state);
  } else {
    io.log(`  ✔ HTTPS Load Balancer — ${state.infra.lbEnabled ? 'enabled (Google-managed cert)' : 'disabled (plain HTTP on the instance)'} (resumed)`);
  }

  // Step 5.6 (Cloud DNS automation) — only reached when the LB is enabled
  // (runGcpDnsStep itself no-ops for target!=gcp / lbEnabled=false). Same
  // resume convention: skip once state.infra.gcpDnsManaged is already a
  // real boolean rather than the initial undefined.
  if (state.infra?.lbEnabled && state.infra?.gcpDnsManaged === undefined) {
    const dnsRes = await runGcpDnsStep({ state, io, execImpl });
    state = dnsRes.state;
    await saveState(deployDir, state);
  } else if (state.infra?.lbEnabled) {
    io.log(`  ✔ Cloud DNS — ${state.infra.gcpDnsManaged ? `managed automatically (zone "${state.infra.gcpDnsZoneName}")` : 'not managed by Terraform (point DNS manually)'} (resumed)`);
  }

  let picked = pickedNumber;
  if (state.telnyx?.phoneNumber) {
    picked = { id: state.telnyx.phoneNumberId, phone_number: state.telnyx.phoneNumber };
    io.log(`  ✔ Phone number — reusing ${state.telnyx.phoneNumber} from a previous run.`);
  } else if (buyNumber && !picked) {
    let pickResult;
    try {
      pickResult = await pickPhoneNumber({
        fetchImpl,
        apiKey: answers.telnyxApiKey,
        countryCode,
        log: (...args) => io.log(args.join(' ')),
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        io.log('');
        io.log(`  ✖ ${err.message}`);
        io.log('');
        state = markStep(state, 'telnyx', 'pending');
        await saveState(deployDir, state);
        return { state, aborted: true, reason: 'INSUFFICIENT_BALANCE' };
      }
      throw err;
    }
    const { candidates } = pickResult;
    if (candidates.length === 0) {
      io.log('  ⚠ No phone numbers available for the requested country — continuing without a number (you can run ./deploy/cc telnyx later).');
    } else {
      const options = candidates.map((n) => {
        const cost = n?.cost_information?.monthly_cost || '?';
        return {
          label: `${n.phone_number}  $${cost}/mo`,
          value: { phone_number: n.phone_number, monthly_cost: cost },
          description: n.region_information?.region_name || n.locality || '',
        };
      });
      const choice = await io.select(
        `Pick a ${countryCode} phone number to assign to this deployment`,
        options,
      );
      picked = { phone_number: choice.phone_number };
    }
  } else if (!buyNumber) {
    io.log('  ℹ Skipping number purchase (buyNumber=false) — you can assign one later via ./deploy/cc telnyx.');
  }

  const telnyxRes = await runTelnyxBootstrapStep({
    state, io, answers, deployDir, fetchImpl, pickedNumber: picked,
  });
  state = telnyxRes.state;
  await saveState(deployDir, state);

  const provisionRes = await runGcpProvisionStep({
    state, io, answers, deployDir,
    extraEnvUpdates: telnyxRes.result?.envUpdates || {},
    execImpl, fetchImpl, spawnImpl, sleep,
  });
  state = provisionRes.state;
  if (provisionRes.aborted) {
    await saveState(deployDir, state);
    return { state, aborted: true };
  }
  await saveState(deployDir, state);

  state = markStep(state, 'summary', 'done');
  await saveState(deployDir, state);

  printGcpSummary({ state, answers, io, generatedSecrets: provisionRes.generatedSecrets });
  return { state, aborted: false };
}

/**
 * GCP cloud-target summary — analogous to printAwsSummary but surfaces
 * GCP's terraform-created infra (public IP, instance name, storage bucket)
 * and always tells the operator to point their own domain at the instance
 * public IP by hand (no DNS automation / no ALB equivalent in Phase 1/2).
 */
export function printGcpSummary({ state, answers, io, generatedSecrets = {} }) {
  io.header('Telnyx Contact Center is live 🎉');
  io.log('');
  io.log(`  App URL        ${state.infra?.appUrl || answers.baseUrl}`);
  io.log(`  Owner login    ${answers.ownerEmail}`);
  if (generatedSecrets.ownerPassword) {
    io.log(`  Owner password ${chalkGreen(generatedSecrets.ownerPassword)}  ${chalkGray('(auto-generated — change after first login)')}`);
    io.log(`  Credentials    ${chalkGray('also saved to deploy/.cc-credentials.txt (chmod 600)')}`);
  } else {
    io.log(`  Owner password ${chalkGray('(as you typed — not displayed for safety)')}`);
  }
  io.log(`  Inbound number ${state.telnyx?.phoneNumber || '(not yet — run ./deploy/cc telnyx)'}`);
  io.log('');
  io.log(`  GCP project    ${state.infra?.gcpProjectId || '—'}`);
  io.log(`  Public IP      ${state.infra?.publicIp || '—'}`);
  io.log(`  Instance name  ${state.infra?.instanceName || '—'}`);
  io.log(`  Storage bucket ${state.infra?.storageBucket || '—'}`);
  io.log('');
  if (state.infra?.lbEnabled) {
    // Phase 3: HTTPS Load Balancer + Google-managed cert. When Cloud DNS
    // automation resolved a zone and the operator consented
    // (state.infra.gcpDnsManaged), Terraform already created the A records
    // in the same apply — nothing for the operator to do. Otherwise, same
    // manual-DNS-pointing shape as the no-LB branch below, just pointed at
    // the Load Balancer's global IP instead of the instance's own, and
    // with an explicit cert-status note (validation can lag DNS creation
    // by minutes to an hour — see runGcpLbWaitStep, which already polled
    // once during this same `cc up` run).
    if (state.infra?.gcpDnsManaged) {
      io.log(`  🌐 HTTPS Load Balancer — DNS managed automatically (Cloud DNS zone "${state.infra.gcpDnsZoneName}").`);
      io.log(`     ${state.domain} and ws.${state.domain} already point at ${state.infra?.lbIp || '(pending)'}.`);
    } else {
      io.log('  🌐 HTTPS Load Balancer — point your domain at this deployment:');
      if (state.infra?.lbIp) {
        io.log(`     Create A records:`);
        io.log(`       ${state.domain}  ->  ${state.infra.lbIp}`);
        io.log(`       ws.${state.domain}  ->  ${state.infra.lbIp}`);
      } else {
        io.log(`     (Load Balancer IP not yet known — re-run \`./deploy/cc status\` once provisioning finishes, then create the DNS records.)`);
      }
    }
    io.log(`     Note: the Google-managed certificate validates once the DNS record above`);
    io.log(`     exists and has propagated (minutes to about an hour) — check progress any`);
    io.log(`     time with \`./deploy/cc status\`.`);
    io.log('');
  } else if (state.domain) {
    // No HTTPS Load Balancer (Phase 1/2 default, or the operator declined
    // the Phase 3 opt-in) — always print the manual-pointing instruction
    // when a domain was given. Cloud DNS automation is only wired up for
    // the HTTPS Load Balancer path (no lb_enabled means no stable
    // Terraform-managed IP worth automating DNS against — see
    // runGcpDnsStep's own docstring for the full rationale).
    io.log('  🌐 DNS — point your domain at this deployment yourself:');
    if (state.infra?.publicIp) {
      io.log(`     Create an A record:`);
      io.log(`       ${state.domain}  ->  ${state.infra.publicIp}`);
    } else {
      io.log(`     (Public address not yet known — re-run \`./deploy/cc status\` once provisioning finishes, then create the DNS record.)`);
    }
    io.log(`     Note: the app serves plain HTTP directly on the instance (no HTTPS Load`);
    io.log(`     Balancer yet) — put your own reverse proxy/CDN in front of it for TLS.`);
    io.log('');
  }
  if (state.portainer?.agentEnabled) {
    io.log(`  🐳 Portainer agent enabled on port ${state.portainer.agentPort} — pair it from your own Portainer server.`);
    io.log('');
  }
  io.log('  Telnyx resources:');
  io.log(`    Voice app        ${state.telnyx?.voiceAppId || '—'}`);
  io.log(`    OVP              ${state.telnyx?.outboundVoiceProfileId || '—'}`);
  io.log(`    WebRTC SIP conn  ${state.telnyx?.sipConnectionId || '—'}`);
  io.log('');
  io.log('  Useful commands:');
  io.log('    ./deploy/cc status | logs -f | update | telnyx | destroy');
  io.log('');
  io.log(`  Details saved to deploy/.cc-state.json (contains resource IDs, no secrets).`);
}

/**
 * Runs the full Local-target wizard end to end (Phase 2 scope: includes
 * Telnyx bootstrap with phone number purchase, plus Default Call Flow
 * seeding). Cloud targets currently stop after preflight (provisioning ships
 * in Phase 3/4); for cloud, the wizard still records `state.deploymentName`
 * so `./deploy/cc telnyx` can be invoked later to do the bootstrap on the
 * running VM.
 *
 * Resume behavior: if `deploy/.cc-state.json` shows a deployment that started
 * (consent given) but never finished (summary step not done), the wizard asks
 * the user up front whether to continue from where it left off or start a
 * fresh deployment. Answering "continue" causes already-`done`/`skipped`
 * steps (target/size/region/params) to be skipped entirely — their values are
 * read back from `.cc-state.json` instead of being asked again. Secrets are
 * never persisted to state, so `ownerPassword` (only needed if the provision
 * step hasn't run yet) and `telnyxApiKey` (needed by preflight/telnyx/callFlow
 * regardless of resume point) are always re-collected — same UX as before.
 * The Telnyx bootstrap step itself doesn't need step-level skip logic: every
 * resource upsert in telnyx-bootstrap.mjs is find-by-name-first, so re-running
 * it on a resume finds already-created resources instead of duplicating them
 * (that idempotency is what actually satisfies "don't re-create the voice app,
 * only create what's missing" — the resume prompt is the UX layer on top).
 */
export async function runWizard({
  deployDir,
  sampleEnvPath,
  io = defaultIo(),
  execImpl,
  fetchImpl = fetch,
  ports,
  // Telnyx bootstrap options:
  //   buyNumber (default true) — when false, skip the search/buy flow entirely
  //     (useful for repeat installs where a number is already provisioned).
  //   pickedNumber — pre-selected candidate for unattended mode
  //     ({ id, phone_number }); when set, the wizard skips the search/confirm UI
  //     and purchases+assigns in one call.
  //   countryCode — defaults to 'US'.
  buyNumber = true,
  pickedNumber = null,
  countryCode = 'US',
  // Injectable for tests — avoids spawning a real `cloudflared` process /
  // touching the network when no domain is given. Defaults to the real
  // implementation for actual `cc up` runs.
  startTunnelImpl,
  // Injectable for tests — real `terraform apply` streams via child_process.spawn
  // (see terraform.mjs), not execFile, so it needs its own override slot.
  spawnImpl,
  // Injectable for tests — the AWS path's SSM/ALB polling loops (waitForSsmOnline,
  // runSsmDeployCommand, target-group health waits) default to a real setTimeout-based
  // sleep; tests override this to make otherwise multi-second polling loops instant.
  sleep,
} = {}) {
  let state = await loadState(deployDir);

  // --- Resume detection --------------------------------------------------
  // Ask BEFORE the intro step so the user isn't shown the "here's what we'll
  // do" banner twice on a resume — if they pick "start fresh" we fall through
  // to the normal from-scratch flow (defaultState()); if they pick "continue"
  // we keep the loaded state and let the per-step skip logic below reuse it.
  let resuming = false;
  if (hasIncompleteDeployment(state)) {
    const info = describeIncompleteDeployment(state, ORDERED_STEPS);
    io.log('');
    io.log(`⚠ Found an incomplete deployment: "${info.deploymentName}" (target: ${info.target || 'unknown'}), last updated ${info.when}.`);
    io.log(`  Next step would be: ${info.nextStep}`);
    if (info.detail) io.log(`  Already done: ${info.detail}`);
    io.log('');
    const choice = await io.select('How do you want to proceed?', [
      { value: 'continue', label: `Continue from where it left off (skip completed steps: ${ORDERED_STEPS.filter((s) => isStepDone(state, s)).join(', ') || 'none yet'})` },
      { value: 'fresh', label: 'Start a fresh deployment (re-ask everything; existing Telnyx resources are still reused by name, not duplicated)' },
    ]);
    if (choice === 'fresh') {
      state = defaultState();
    } else {
      resuming = true;
    }
  }

  const skip = (stepName) => resuming && isStepDone(state, stepName);

  if (skip('consent')) {
    io.log(`✔ Consent — already given, resuming.`);
  } else {
    const intro = await runIntroStep({ state, io });
    state = intro.state;
    if (intro.aborted) return { state, aborted: true };
    await saveState(deployDir, state);
  }

  if (skip('target')) {
    io.log(`✔ Target — ${state.target} (resumed)`);
  } else {
    const targetRes = await runTargetStep({ state, io });
    state = targetRes.state;
    await saveState(deployDir, state);
  }

  if (skip('size')) {
    io.log(`✔ Size — ${state.size} / ${state.nodes} node(s) (resumed)`);
  } else {
    const sizeRes = await runSizeStep({ state, io });
    state = sizeRes.state;
    await saveState(deployDir, state);
  }

  if (skip('region')) {
    io.log(`✔ Region — ${state.region || 'n/a'} (resumed)`);
  } else {
    const regionRes = await runRegionStep({
      state, io, fetchImpl, execImpl,
    });
    state = regionRes.state;
    await saveState(deployDir, state);
  }

  // AWS/GCP/Azure only, opt-in. Tied to the same resume point as `params`
  // (not its own ORDERED_STEPS entry — it's just a state field, safe to
  // always redo on a fresh run and safe to skip re-asking on resume since
  // it has no network/billing side effect of its own).
  if ((state.target === 'aws' || state.target === 'gcp' || state.target === 'azure') && !skip('params')) {
    const portainerRes = await runAwsPortainerStep({ state, io });
    state = portainerRes.state;
    await saveState(deployDir, state);
  }

  let answers;
  if (skip('params')) {
    io.log(`✔ Deployment params — "${state.deploymentName}" (resumed; re-collecting secrets below)`);
    // Non-secret fields come back from state; secrets are never persisted so
    // they're re-collected here regardless of resume point. ownerPassword is
    // only actually consumed by the provision step (writing .env) — skip
    // asking for it if that step already completed (the .env already has a
    // password, generated or user-supplied, and rewriting it would orphan the
    // owner's real login).
    const ownerPassword = isStepDone(state, 'provision')
      ? ''
      : await io.askSecret('Owner admin password (leave blank to auto-generate)');
    const telnyxApiKey = await io.askSecret('Telnyx API key');
    const baseUrl = resolveBaseUrl(state.domain, state.target);
    answers = {
      deploymentName: state.deploymentName,
      domain: state.domain,
      ownerEmail: state.ownerEmail,
      ownerPassword,
      telnyxApiKey,
      baseUrl,
    };
  } else {
    const paramsRes = await runParamsStep({ state, io });
    state = paramsRes.state;
    answers = paramsRes.answers;
    await saveState(deployDir, state);
  }

  const preflightRes = await runPreflightStep({ state, io, answers, execImpl, fetchImpl, ports });
  state = preflightRes.state;
  // Merge in any answers the preflight step enriched via port-conflict (postgresMode,
  // existingPostgres). Without this, downstream steps (envgen, composeUp) wouldn't
  // know about the user's existing-Postgres wiring.
  if (preflightRes.answers) answers = preflightRes.answers;
  if (preflightRes.aborted) {
    await saveState(deployDir, state);
    return { state, aborted: true };
  }
  await saveState(deployDir, state);

  if (state.target !== 'local' && state.target !== 'aws' && state.target !== 'gcp' && state.target !== 'azure') {
    io.log('');
    io.log(`Cloud provisioning + Telnyx bootstrap for "${state.target}" ship in a later phase (AWS, GCP, and Azure are supported now — see plan). Stopping here for now.`);
    return { state, aborted: false, partial: true };
  }

  if (state.target === 'aws') {
    return runAwsWizardTail({
      state, io, answers, deployDir, execImpl, fetchImpl, spawnImpl, sleep,
      buyNumber, pickedNumber, countryCode,
    });
  }

  if (state.target === 'gcp') {
    return runGcpWizardTail({
      state, io, answers, deployDir, execImpl, fetchImpl, spawnImpl, sleep,
      buyNumber, pickedNumber, countryCode,
    });
  }

  if (state.target === 'azure') {
    return runAzureWizardTail({
      state, io, answers, deployDir, execImpl, fetchImpl, spawnImpl, sleep,
      buyNumber, pickedNumber, countryCode,
    });
  }

  // Step 6a — auto tunnel (Local target, no domain given). Runs before Telnyx
  // bootstrap so the tunnel URL is already answers.baseUrl by the time any
  // Telnyx webhook gets registered — see runLocalTunnelStep's docstring for
  // why this ordering (tunnel -> Telnyx bootstrap -> provision) replaced the
  // old (provision -> Telnyx bootstrap -> patch .env -> restart) order.
  const tunnelRes = await runLocalTunnelStep({
    state, io, answers, deployDir,
    ...(startTunnelImpl ? { startTunnelImpl } : {}),
  });
  state = tunnelRes.state;
  if (tunnelRes.aborted) {
    await saveState(deployDir, state);
    return { state, aborted: true };
  }
  if (tunnelRes.answers) answers = tunnelRes.answers;
  await saveState(deployDir, state);

  // Step 6b — Telnyx bootstrap. Always runs (creates voice app + SIP conn +
  // owner credential + outbound profile) even if buyNumber is false. The
  // purchase is gated behind an explicit user pick from the candidate list.
  // Buying a number is MANDATORY for the wizard to succeed — the user needs
  // an inbound number to receive the first call and verify the deploy. The
  // only escape hatches are:
  //   - `pickedNumber` supplied from the answers file (unattended mode)
  //   - `buyNumber=false` for power users who already have a number assigned
  //     out-of-band (skip the search/pick flow entirely)
  // On resume, a number that was already purchased+assigned in a prior run is
  // detected by purchaseAndAssignNumber's own idempotency check (owned +
  // assigned to this voice app => outcome 'found', no new purchase) — so it's
  // safe to re-offer the picker here even after a partial success; picking
  // the same number again is a no-op, not a double charge.
  let picked = pickedNumber;
  if (state.telnyx?.phoneNumber) {
    // Already have a number from a previous run (resume) — reuse it instead
    // of prompting again. This is the concrete fix for "don't re-buy a number
    // I already have"; the wizard just re-confirms/re-assigns idempotently.
    picked = { id: state.telnyx.phoneNumberId, phone_number: state.telnyx.phoneNumber };
    io.log(`  ✔ Phone number — reusing ${state.telnyx.phoneNumber} from a previous run.`);
  } else if (buyNumber && !picked) {
    let pickResult;
    try {
      pickResult = await pickPhoneNumber({
        fetchImpl,
        apiKey: answers.telnyxApiKey,
        countryCode,
        log: (...args) => io.log(args.join(' ')),
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        // Hard-fail with a targeted message — the user needs to fund their
        // Telnyx account before continuing. The wizard aborts cleanly so they
        // can resume (state.consent is preserved).
        io.log('');
        io.log(`  ✖ ${err.message}`);
        io.log('');
        state = markStep(state, 'telnyx', 'pending');
        await saveState(deployDir, state);
        return { state, aborted: true, reason: 'INSUFFICIENT_BALANCE' };
      }
      throw err;
    }
    const { candidates } = pickResult;
    if (candidates.length === 0) {
      io.log('  ⚠ No phone numbers available for the requested country — continuing without a number (you can run ./deploy/cc telnyx later).');
    } else {
      // Render the full candidate list as an io.select so the user MUST pick
      // one (no auto-buy of top-1). Options are formatted as
      // `+E.164  $X.XX/mo` — /v2/available_phone_numbers results have no `id`
      // field (only phone_number, cost_information, region_information,
      // etc.), so the E.164 string itself is the only stable identifier we
      // can carry through to the purchase call.
      const options = candidates.map((n) => {
        const cost = n?.cost_information?.monthly_cost || '?';
        return {
          label: `${n.phone_number}  $${cost}/mo`,
          value: { phone_number: n.phone_number, monthly_cost: cost },
          description: n.region_information?.region_name || n.locality || '',
        };
      });
      const choice = await io.select(
        `Pick a ${countryCode} phone number to assign to this deployment`,
        options,
      );
      picked = { phone_number: choice.phone_number };
    }
  } else if (!buyNumber) {
    io.log('  ℠ Skipping number purchase (buyNumber=false) — you can assign one later via ./deploy/cc telnyx.');
  }

  const telnyxRes = await runTelnyxBootstrapStep({
    state,
    io,
    answers,
    deployDir,
    fetchImpl,
    pickedNumber: picked,
  });
  state = telnyxRes.state;
  await saveState(deployDir, state);

  // Step 7 — Provision infra: writes the .env (base answers + telnyxRes'
  // envUpdates merged in) and does the ONE AND ONLY `docker compose up
  // --build`. Every TELNYX_* id/secret is already known at this point, so
  // there's no second write-and-restart afterward.
  const provisionRes = await runLocalProvisionStep({
    state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl,
    extraEnvUpdates: telnyxRes.result?.envUpdates || {},
  });
  state = provisionRes.state;
  if (provisionRes.aborted) {
    await saveState(deployDir, state);
    return { state, aborted: true };
  }
  await saveState(deployDir, state);

  // Default Call Flow seeding now happens INSIDE the app container at boot
  // (lib/seed-default-call-flow.mjs, called from ensurePostgresSchema()) —
  // no separate wizard step needed here anymore. By the time
  // runLocalProvisionStep's `docker compose up` returns healthy above, the
  // container has already booted once with TELNYX_DEFAULT_FLOW_VOICE_APP_ID
  // set (from telnyxRes.result.envUpdates) and seeded the flow.

  state = markStep(state, 'summary', 'done');
  await saveState(deployDir, state);

  printSummary({ state, answers, io, generatedSecrets: provisionRes.generatedSecrets });
  return { state, aborted: false };
}

/**
 * AWS cloud-target tail of the wizard (Phase 4): Telnyx bootstrap ->
 * Terraform provisioning + image build/ship/deploy (runAwsProvisionStep) ->
 * summary. Default Call Flow seeding happens inside the app container at
 * boot (lib/seed-default-call-flow.mjs) exactly like the Local target — no
 * separate step needed here, and no more AWS-specific gap: RDS is
 * unreachable from the wizard's own machine, but the app itself always sits
 * right next to its database wherever it's deployed.
 * Mirrors the Local-target tail's step order and ordering rationale (Telnyx
 * bootstrap before provisioning, so every TELNYX_* id/secret the app needs is
 * already known when the app/env Secrets Manager secret gets populated —
 * same "no restart-after-the-fact" property as PR #1153 gave the Local path).
 *
 * Split into its own function (rather than inlined in runWizard) because the
 * Local and AWS tails diverge completely after preflight — no tunnel step,
 * different provision mechanism, different summary needs — and mashing both
 * into one function via `if (state.target === 'aws')` branches throughout
 * would make the already-long runWizard harder to follow than two shorter,
 * single-purpose tails.
 */
export async function runAwsWizardTail({
  state, io, answers, deployDir, execImpl, fetchImpl, spawnImpl, sleep,
  buyNumber = true, pickedNumber = null, countryCode = 'US',
}) {
  // Step 5.5 — DNS/TLS decision (Route53 + ACM). Must run before Telnyx
  // bootstrap/provisioning since its outcome (state.infra.albEnabled +
  // any reused ACM certificate) feeds directly into writeAwsTfvars. Skipped
  // entirely on resume once already resolved (state.infra.albEnabled is a
  // real boolean, not the initial `null`/undefined) so re-running `cc up`
  // doesn't re-ask a question that was already answered and acted on.
  if (state.infra?.albEnabled === undefined || state.infra?.albEnabled === null) {
    const dnsRes = await runAwsDnsStep({ state, io, execImpl });
    state = dnsRes.state;
    await saveState(deployDir, state);
  } else {
    io.log(`  ✔ DNS/TLS — ${state.infra.albEnabled ? 'ALB + ACM' : 'no ALB (plain HTTP on the instance)'} (resumed)`);
  }

  // Step 6 — Telnyx bootstrap. Same idempotent upsert-by-name semantics as
  // the Local path (see runTelnyxBootstrapStep's docstring) — safe to re-run
  // on resume. AWS has no tunnel step: answers.baseUrl is already the real
  // public domain (required — see plan §4c/§4d, cloud targets always need a
  // real domain for Telnyx webhooks; there's no cloudflared-quick-tunnel
  // fallback for cloud like there is for Local).
  let picked = pickedNumber;
  if (state.telnyx?.phoneNumber) {
    picked = { id: state.telnyx.phoneNumberId, phone_number: state.telnyx.phoneNumber };
    io.log(`  ✔ Phone number — reusing ${state.telnyx.phoneNumber} from a previous run.`);
  } else if (buyNumber && !picked) {
    let pickResult;
    try {
      pickResult = await pickPhoneNumber({
        fetchImpl,
        apiKey: answers?.telnyxApiKey,
        countryCode,
        log: (...args) => io.log(args.join(' ')),
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        io.log('');
        io.log(`  ✖ ${err.message}`);
        io.log('');
        state = markStep(state, 'telnyx', 'pending');
        await saveState(deployDir, state);
        return { state, aborted: true, reason: 'INSUFFICIENT_BALANCE' };
      }
      throw err;
    }
    const { candidates } = pickResult;
    if (candidates.length === 0) {
      io.log('  ⚠ No phone numbers available for the requested country — continuing without a number (you can run ./deploy/cc telnyx later).');
    } else {
      const options = candidates.map((n) => {
        const cost = n?.cost_information?.monthly_cost || '?';
        return {
          label: `${n.phone_number}  $${cost}/mo`,
          value: { phone_number: n.phone_number, monthly_cost: cost },
          description: n.region_information?.region_name || n.locality || '',
        };
      });
      const choice = await io.select(
        `Pick a ${countryCode} phone number to assign to this deployment`,
        options,
      );
      picked = { phone_number: choice.phone_number };
    }
  } else if (!buyNumber) {
    io.log('  ℠ Skipping number purchase (buyNumber=false) — you can assign one later via ./deploy/cc telnyx.');
  }

  const telnyxRes = await runTelnyxBootstrapStep({
    state, io, answers, deployDir, fetchImpl, pickedNumber: picked,
  });
  state = telnyxRes.state;
  await saveState(deployDir, state);

  // Step 7 — Terraform provisioning + image build/ship/deploy over SSM. See
  // runAwsProvisionStep's docstring for the ACM-before-tfvars ordering
  // (multi-node/HA only) and the Secrets Manager population step.
  const provisionRes = await runAwsProvisionStep({
    state, io, answers, deployDir,
    extraEnvUpdates: telnyxRes.result?.envUpdates || {},
    execImpl, fetchImpl, spawnImpl, sleep,
  });
  state = provisionRes.state;
  if (provisionRes.aborted) {
    await saveState(deployDir, state);
    return { state, aborted: true };
  }
  await saveState(deployDir, state);

  // Step 7.5 — Route53 record. REMOVED (2026-07-06): the domain's A/alias
  // record is now created/updated by Terraform itself, as a real
  // aws_route53_record resource in the same apply as the ALB/EIP it points
  // at (see cc-compute-single/cc-compute-ha's main.tf, gated on the
  // dns_zone_id tfvar that runAwsProvisionStep's writeAwsTfvars call already
  // set from state.infra.dnsZoneId whenever state.infra.dnsManaged is true).
  //
  // The old version of this step called route53.mjs's upsertAliasRecord/
  // upsertARecord directly via the AWS CLI, entirely OUTSIDE tfstate — which
  // meant `terraform destroy` had no way to know the record existed and
  // never cleaned it up. Confirmed via a real cc-test3 teardown where the
  // record was still live, pointing at now-destroyed infrastructure, after a
  // full `cc destroy` run. Modeling it as a real Terraform resource (with
  // allow_overwrite = true so it can take over a record an older wizard
  // version created out-of-band, or one the operator hand-created) closes
  // that gap: create/update AND delete are both handled by the same
  // `terraform apply`/`terraform destroy` this step used to run alongside.

  // Default Call Flow seeding runs inside the app container at boot (see
  // lib/seed-default-call-flow.mjs) — no wizard step needed here anymore.
  // By the time runAwsProvisionStep's SSM deploy reports healthy above, the
  // container has already booted once with TELNYX_DEFAULT_FLOW_VOICE_APP_ID
  // set (from telnyxRes.result.envUpdates, folded into the app/env Secrets
  // Manager secret) and seeded the flow — this is what closes the gap that
  // used to leave every AWS deployment without one.

  state = markStep(state, 'summary', 'done');
  await saveState(deployDir, state);

  printAwsSummary({ state, answers, io, generatedSecrets: provisionRes.generatedSecrets });
  return { state, aborted: false };
}

/**
 * AWS cloud-target summary — analogous to printSummary but surfaces
 * Terraform-created infra (public IP or ALB DNS name, instance ids, S3
 * artifact bucket) instead of the Local target's tunnel/docker details.
 */
export function printAwsSummary({ state, answers, io, generatedSecrets = {} }) {
  io.header('Telnyx Contact Center is live 🎉');
  io.log('');
  io.log(`  App URL        ${state.infra?.appUrl || answers.baseUrl}`);
  io.log(`  Owner login    ${answers.ownerEmail}`);
  if (generatedSecrets.ownerPassword) {
    io.log(`  Owner password ${chalkGreen(generatedSecrets.ownerPassword)}  ${chalkGray('(auto-generated — change after first login)')}`);
    io.log(`  Credentials    ${chalkGray('also saved to deploy/.cc-credentials.txt (chmod 600)')}`);
  } else {
    io.log(`  Owner password ${chalkGray('(as you typed — not displayed for safety)')}`);
  }
  io.log(`  Inbound number ${state.telnyx?.phoneNumber || '(not yet — run ./deploy/cc telnyx)'}`);
  io.log('');
  io.log(`  AWS topology   ${state.infra?.awsTopology === 'ha' ? `multi-node / HA (${state.infra.instanceIds?.length || 0} nodes)` : 'single-node'}`);
  if (state.infra?.awsTopology === 'ha' || state.infra?.albEnabled) {
    io.log(`    ALB DNS name   ${state.infra.albDnsName || '—'}`);
    io.log(`    Instance ids   ${(state.infra.instanceIds || []).join(', ') || '—'}`);
  } else {
    io.log(`    Public IP      ${state.infra?.publicIp || '—'}`);
    io.log(`    Instance id    ${state.infra?.instanceIds?.[0] || '—'}`);
  }
  io.log(`    Storage bucket ${state.infra?.storageBucket || '—'}`);
  io.log('');
  // DNS instructions — only needed when the wizard does NOT manage the
  // record itself (either no Route53 zone was found for this domain, or the
  // user declined to let Terraform manage/overwrite an existing record).
  // When dnsManaged is true, Terraform's aws_route53_record.app already
  // pointed the domain at the deployment as part of the same apply that
  // created the ALB/EIP (see cc-compute-single/cc-compute-ha's main.tf) —
  // nothing more to do here.
  if (state.domain && !state.infra?.dnsManaged) {
    io.log('  🌐 DNS — point your domain at this deployment yourself:');
    if (state.infra?.albEnabled && state.infra?.albDnsName) {
      io.log(`     Create a CNAME (or ALIAS, if your DNS provider supports it) record:`);
      io.log(`       ${state.domain}  ->  ${state.infra.albDnsName}`);
    } else if (state.infra?.publicIp) {
      io.log(`     Create an A record:`);
      io.log(`       ${state.domain}  ->  ${state.infra.publicIp}`);
    } else {
      io.log(`     (Public address not yet known — re-run \`./deploy/cc status\` once provisioning finishes, then create the DNS record.)`);
    }
    io.log('');
  }
  if (state.portainer?.agentEnabled) {
    io.log(`  🐳 Portainer agent enabled on port ${state.portainer.agentPort} — pair it from your own Portainer server.`);
    io.log('');
  }
  io.log('  Telnyx resources:');
  io.log(`    Voice app        ${state.telnyx?.voiceAppId || '—'}`);
  io.log(`    OVP              ${state.telnyx?.outboundVoiceProfileId || '—'}`);
  io.log(`    WebRTC SIP conn  ${state.telnyx?.sipConnectionId || '—'}`);
  io.log('');
  io.log('  Useful commands:');
  io.log('    ./deploy/cc status | logs -f | update | telnyx | destroy');
  io.log('');
  io.log(`  Details saved to deploy/.cc-state.json (contains resource IDs, no secrets).`);
}

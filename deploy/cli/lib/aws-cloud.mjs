import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  writeTfvars, terraformInit, terraformPlan, terraformApply, terraformDestroy, terraformOutputs, terraformVersion,
  createTerraformLineFilter,
} from './terraform.mjs';
import { checkAwsIamPermissions } from './aws-iam-check.mjs';
import { checkAwsEipQuota } from './aws-eip-check.mjs';
import { ensureCertificate } from './acm.mjs';
import {
  buildAndPackageImage, uploadArtifact, deploySingleNode, deployHaRolling,
} from './cloud-deploy.mjs';
import { parseEnvValues } from './envgen.mjs';

const execFileAsync = promisify(execFileCb);

// Orchestrates the AWS cloud path (single-node and multi-node/HA) for the
// wizard: Terraform apply, ACM certificate resolution (HA only), image
// build+ship+deploy over SSM. This is the cloud-target counterpart to
// wizard.mjs's runLocalProvisionStep — same job (make .env/app.env known,
// build/ship the image once, wait healthy) but driven by Terraform +
// Secrets Manager + SSM instead of docker compose.
//
// Per plan §4d, the wizard step order for cloud targets is:
//   preflight (incl. AWS IAM precheck) -> Telnyx bootstrap -> provision
//   (terraform apply + image build/ship/deploy, ONE deploy per node) ->
//   callFlow -> summary
// so by the time this module's `provisionAwsInfra` runs, every TELNYX_*
// id/secret is already known and gets written into the app/env Secrets
// Manager secret as part of the same provisioning pass — no restart-after-
// the-fact, mirroring the Local-target fix from PR #1153.

const REPO_ROOT_FROM_DEPLOY_DIR = (deployDir) => join(deployDir, '..');

function terraformRootFor(deployDir, topology) {
  return join(deployDir, 'terraform', 'aws', topology === 'ha' ? 'multi-node' : 'single-node');
}

// Exported alias — `cc destroy` needs to resolve the same terraform root a
// prior `cc up` used (from state.infra.terraformDir when present, falling
// back to re-deriving it from topology) without duplicating this join logic.
export { terraformRootFor };

/**
 * AWS preflight additions beyond preflight.mjs's existing checks (Docker,
 * Terraform version, Telnyx key/balance): AWS CLI credentials + the IAM
 * permission precheck from plan §4g. Called from runPreflightStep when
 * state.target === 'aws'.
 */
export async function checkAwsCloudPreflight({
  topology = 'single', deploymentName, region, nodeCount = 1, execImpl = execFileAsync,
} = {}) {
  const results = [];

  const tfVersion = await terraformVersion({ execImpl });
  if (!tfVersion) {
    results.push({
      key: 'terraform', status: 'fail', label: 'Terraform',
      detail: 'not found',
      hint: 'Install Terraform >= 1.7: brew install hashicorp/tap/terraform (macOS — plain "brew install terraform" 404s, it is only published under the hashicorp/tap) or https://developer.hashicorp.com/terraform/install',
    });
  } else {
    const [major, minor] = tfVersion.split('.').map(Number);
    const ok = major > 1 || (major === 1 && minor >= 7);
    results.push(ok
      ? { key: 'terraform', status: 'ok', label: 'Terraform', detail: `${tfVersion} (>= 1.7 required)` }
      : { key: 'terraform', status: 'fail', label: 'Terraform', detail: `${tfVersion} — too old`, hint: 'Upgrade to Terraform >= 1.7.' });
  }

  try {
    const { stdout } = await execImpl('aws', ['sts', 'get-caller-identity', '--output', 'json']);
    const identity = JSON.parse(stdout);
    results.push({
      key: 'aws-cli', status: 'ok', label: 'AWS CLI',
      detail: `credentials OK (account ${identity.Account})`,
    });
  } catch (err) {
    results.push({
      key: 'aws-cli', status: 'fail', label: 'AWS CLI',
      detail: 'no valid credentials found',
      hint: 'Configure credentials: aws configure, or export AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or use an SSO profile.',
    });
    // No point probing IAM permissions without valid credentials.
    return results;
  }

  const iamResult = await checkAwsIamPermissions({
    topology, deploymentName, region, execImpl,
  });
  results.push(iamResult);

  const eipResult = await checkAwsEipQuota({
    region, topology, nodeCount, execImpl,
  });
  results.push(eipResult);

  return results;
}

/**
 * Writes the tfvars file for the chosen AWS topology from the wizard's
 * collected answers. Key mapping is intentionally explicit here (not a
 * generic pass-through) so drift between wizard field names and Terraform
 * variable names is visible and testable at this one call site.
 */
export async function writeAwsTfvars({
  deployDir, topology, state, acmCertificateArn, streamingWsDomainName,
} = {}) {
  const root = terraformRootFor(deployDir, topology);
  // Only pass the Route53 zone id through to Terraform when the wizard's DNS
  // step (runAwsDnsStep) actually got explicit consent to manage/overwrite
  // the record at this name (state.infra.dnsManaged === true) — dnsZoneId
  // alone is populated even in the "found the zone but the operator declined
  // to overwrite an existing record" case, so gating on dnsManaged here is
  // what makes that decision stick instead of Terraform silently taking over
  // (and, on destroy, deleting) a record the operator explicitly said not to
  // touch. See cc-compute-single/cc-compute-ha's aws_route53_record.app for
  // where this actually gets used.
  const dnsZoneId = state.infra?.dnsManaged ? (state.infra?.dnsZoneId || '') : '';
  const commonVars = {
    region: state.region,
    deployment_name: state.deploymentName,
    domain: state.domain || '',
    admin_ssh_cidrs: state.awsAdminSshCidrs || [],
    portainer_agent_enabled: Boolean(state.portainer?.agentEnabled),
    portainer_agent_port: state.portainer?.agentPort || 9001,
    portainer_server_cidrs: state.portainer?.serverCidrs || [],
  };
  const vars = topology === 'ha'
    ? {
        ...commonVars,
        streaming_ws_domain_name: streamingWsDomainName,
        acm_certificate_arn: acmCertificateArn,
        node_count: state.nodes || 2,
        instance_type: state.awsInstanceType || 'm6a.large',
        db_instance_class: state.awsDbInstanceClass || 'db.t3.medium',
        dns_zone_id: dnsZoneId,
      }
    : {
        ...commonVars,
        instance_type: state.awsInstanceType || 't3a.medium',
        db_instance_class: state.awsDbInstanceClass || 'db.t4g.micro',
        // Single-node ALB path (Route53-managed domain + ACM cert — see
        // plan's HTTPS-handling rewrite). alb_enabled is set by the wizard's
        // DNS step (runAwsDnsStep) based on how the user answered the
        // Route53 questions — false (default) means no ALB, no ACM, no TLS
        // on the instance at all.
        alb_enabled: Boolean(state.infra?.albEnabled),
        acm_certificate_arn: state.infra?.albEnabled ? acmCertificateArn : '',
        streaming_ws_domain_name: state.infra?.albEnabled ? streamingWsDomainName : '',
        dns_zone_id: dnsZoneId,
      };
  await writeTfvars(root, vars);
  return { root, vars };
}

/**
 * Resolves the ACM certificate for an ALB-fronted deployment — always for
 * multi-node/HA (mandatory there), and for single-node only when the
 * wizard's DNS step (runAwsDnsStep) set state.infra.albEnabled=true (the
 * user picked a Route53-managed domain). Callers should check
 * `topology === 'ha' || state.infra?.albEnabled` before invoking this.
 */
export async function resolveAlbCertificate({ state, region, execImpl = execFileAsync, onValidationRecordsReady, io } = {}) {
  const domain = state.domain;
  const streamingWsDomainName = `ws.${domain}`;
  const result = await ensureCertificate({
    domain,
    alternativeNames: [streamingWsDomainName],
    region,
    existingCertificateArn: state.infra?.acm?.certificateArn || null,
    execImpl,
    onValidationRecordsReady: (info) => {
      if (io) {
        if (info.automated) {
          io.log(`  ✔ ACM validation record created automatically in Route53 zone ${info.zone?.zoneName}`);
        } else {
          io.log('  ⚠ Could not find this domain\'s Route53 zone in your AWS account — add this CNAME at your DNS provider:');
          for (const r of info.records) {
            io.log(`      ${r.name}  CNAME  ${r.value}`);
          }
        }
      }
      if (onValidationRecordsReady) onValidationRecordsReady(info);
    },
  });
  return { ...result, streamingWsDomainName };
}

/**
 * Full AWS provisioning pass: terraform init/plan/apply, then build+ship+
 * deploy the app image over SSM. Mirrors runLocalProvisionStep's contract
 * (accepts `extraEnvUpdates` — the Telnyx bootstrap step's resource ids —
 * and folds them into the SAME app/env Secrets Manager write that happens
 * before the ONE deploy, so there's no restart-after-the-fact here either).
 */
export async function provisionAwsInfra({
  state, io, answers, deployDir, extraEnvUpdates = {},
  execImpl = execFileAsync, fetchImpl = fetch, spawnImpl = spawn,
  sleep,
  onLine,
} = {}) {
  const topology = state.infra?.awsTopology || (state.nodes >= 2 ? 'ha' : 'single');
  const root = terraformRootFor(deployDir, topology);

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

  const applyStep = (io.longStep || io.step)('Applying Terraform (this can take several minutes for RDS)...', { timeoutMs: 15 * 60_000 });
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
      awsTopology: topology,
      terraformDir: root,
      publicIp: outputs.public_ip || null,
      appUrl: outputs.app_url || answers.baseUrl,
      instanceIds: topology === 'ha' ? (outputs.instance_ids || []) : [outputs.instance_id].filter(Boolean),
      albDnsName: outputs.alb_dns_name || null,
      albZoneId: outputs.alb_zone_id || null,
      appTargetGroupArn: outputs.app_target_group_arn || null,
      streamingWsTargetGroupArn: outputs.streaming_ws_target_group_arn || null,
      storageBucket: outputs.storage_bucket || null,
      dbSecretName: outputs.db_secret_name || null,
      appEnvSecretName: outputs.app_env_secret_name || null,
    },
  };

  // Populate the app/env Secrets Manager secret with the full runtime .env —
  // this is the cloud-target equivalent of runLocalProvisionStep's .env
  // write. envUpdates (Telnyx ids) are already known at this point (Telnyx
  // bootstrap runs before this step per plan §4d), so this is written once.
  const envUpdateStep = io.step('Populating runtime secret in Secrets Manager...');
  try {
    // answers.envValues was built pre-apply with placeholder DB wiring
    // (POSTGRES_HOST=postgres, i.e. the local compose service name — see
    // runAwsWizardTail's comment on why). Now that Terraform has actually
    // created the RDS instance, pull the REAL connection details out of the
    // cc-database module's Secrets Manager secret and overwrite the
    // placeholders — otherwise the app never learns the RDS endpoint and
    // instead tries (forever) to resolve a Docker-compose-only hostname
    // that doesn't exist on a cloud target (confirmed via real E2E: this
    // previously produced an endless "postgres:5432 - no response" loop).
    let dbOverrides = {};
    if (nextState.infra.dbSecretName) {
      const { stdout: dbSecretRaw } = await execImpl('aws', [
        'secretsmanager', 'get-secret-value',
        '--region', state.region,
        '--secret-id', nextState.infra.dbSecretName,
        '--query', 'SecretString',
        '--output', 'text',
      ]);
      const dbSecret = JSON.parse(dbSecretRaw);
      dbOverrides = {
        POSTGRES_HOST: dbSecret.host,
        POSTGRES_PORT: String(dbSecret.port || 5432),
        POSTGRES_DB: dbSecret.dbname,
        POSTGRES_USER: dbSecret.username,
        POSTGRES_PASSWORD: dbSecret.password,
        // RDS Postgres enforces `rds.force_ssl=1` by default (confirmed via
        // `aws rds describe-db-parameters` — Source: system, i.e. an AWS
        // engine default, not something this repo's parameter group opts
        // into). Without this, lib/postgres-ssl.mjs's readPostgresSslConfig()
        // defaults to `ssl: false` and every connection is rejected with
        // "no pg_hba.conf entry for host ... no encryption" — confirmed via a
        // real E2E run (2026-07-06, cc-test3) where the app container looped
        // on this FATAL error and the SSM deploy failed health checks after
        // ~7 minutes. 'true' -> readPostgresSslConfig() returns
        // { rejectUnauthorized: false } (encrypt, don't verify the RDS CA
        // chain) — satisfies force_ssl without bundling Amazon's RDS CA
        // bundle into the image. Local target is unaffected (its bundled
        // compose Postgres container has no SSL enforcement).
        POSTGRES_SSL: 'true',
        // The bundled `with-pg` compose profile only ever applies when the
        // wizard is invoked WITHOUT `--profile cloud` (e.g. local target) —
        // `--profile cloud` on its own already excludes the postgres
        // service regardless of COMPOSE_PROFILES. Still set explicitly so
        // .env accurately documents that this deployment uses RDS, not a
        // bundled container, if anyone inspects it by hand.
        COMPOSE_PROFILES: 'no-with-pg',
      };
    }
    // NOTE: CC_DOMAIN / Caddy is no longer part of the AWS path at all —
    // Caddy-on-instance TLS termination was removed entirely (see
    // cc-compute-single's user_data.sh.tpl header comment). HTTPS is either
    // handled by an ALB + ACM certificate (Route53-managed domain path) or
    // is the operator's own responsibility (externally-hosted domain path).
    // CC_DOMAIN remains relevant only for the Local target's docker-compose
    // `cloud` profile... which Local never actually uses (see compose.yaml —
    // that profile now exists purely for anyone running the container stack
    // by hand outside the wizard).

    // S3 storage wiring (Bug #14): the storage bucket + IAM permissions to
    // read/write it have existed since the cc-storage Terraform module
    // shipped, but nothing ever wrote STORAGE_PROVIDER/STORAGE_BUCKET/
    // STORAGE_REGION/STORAGE_ENDPOINT into the env the app container
    // actually reads. HA nodes happened to get these for free (their
    // user_data.sh.tpl writes /opt/cc/node.env and cloud-deploy.mjs's
    // REMOTE_DEPLOY_SCRIPT_HA passes it to `docker run --env-file`), but
    // single-node's app container is started by `docker compose --profile
    // cloud up` with `env_file: .env` only — compose.yaml never references
    // node.env, so on single-node lib/storage/s3-driver.mjs never saw
    // STORAGE_BUCKET and the app silently fell back to the local-disk
    // driver (uploads land in the container's ephemeral /app/public/media
    // instead of S3, and are lost on every redeploy). Setting these here
    // means both topologies get them the same way, through the one env
    // write this function already owns — no need to keep node.env's copy
    // in sync with two different code paths.
    const storageOverride = nextState.infra.storageBucket
      ? {
          STORAGE_PROVIDER: 's3',
          STORAGE_BUCKET: nextState.infra.storageBucket,
          STORAGE_REGION: state.region,
          STORAGE_ENDPOINT: `https://s3.${state.region}.amazonaws.com`,
          STORAGE_FORCE_PATH_STYLE: 'false',
        }
      : {};

    const envMap = { ...answers.envValues, ...extraEnvUpdates, ...dbOverrides, ...storageOverride };
    const envText = Object.entries(envMap).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
    await execImpl('aws', [
      'secretsmanager', 'put-secret-value',
      '--region', state.region,
      '--secret-id', nextState.infra.appEnvSecretName,
      '--secret-string', envText,
    ]);
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
        NEXT_PUBLIC_BASE_URL: nextState.infra.appUrl,
        NEXT_PUBLIC_TELNYX_WEBRTC_REGION: answers.envValues?.NEXT_PUBLIC_TELNYX_WEBRTC_REGION || '',
      },
    });
    buildStep.succeed('Image built and packaged');
  } catch (err) {
    buildStep.fail(`Docker build failed: ${err.message}`);
    return { state: nextState, aborted: true };
  }

  const uploadStep = io.step('Uploading image artifact to S3...');
  const shortId = imageTag.split(':')[1];
  let uploadResult;
  try {
    uploadResult = await uploadArtifact({
      bucket: nextState.infra.storageBucket,
      shortId,
      archivePath: artifact.archivePath,
      archiveName: artifact.archiveName,
      checksumPath: artifact.checksumPath,
      manifestPath: artifact.manifestPath,
      execImpl,
    });
    uploadStep.succeed(`Uploaded to ${uploadResult.s3Prefix}`);
  } catch (err) {
    uploadStep.fail(`Upload failed: ${err.message}`);
    return { state: nextState, aborted: true };
  }

  const deployStep = (io.longStep || io.step)('Deploying to node(s) via SSM...', { timeoutMs: 10 * 60_000 });
  try {
    if (topology === 'single') {
      await deploySingleNode({
        instanceId: nextState.infra.instanceIds[0],
        region: state.region,
        s3Prefix: uploadResult.s3Prefix,
        appEnvSecretName: nextState.infra.appEnvSecretName,
        appPort: 3000,
        streamingWsPort: 3001,
        execImpl,
        ...(sleep ? { sleep } : {}),
      });
    } else {
      await deployHaRolling({
        instanceIds: nextState.infra.instanceIds,
        region: state.region,
        s3Prefix: uploadResult.s3Prefix,
        appEnvSecretName: nextState.infra.appEnvSecretName,
        appPort: 3000,
        streamingWsPort: 3001,
        appTargetGroupArn: nextState.infra.appTargetGroupArn,
        wsTargetGroupArn: nextState.infra.streamingWsTargetGroupArn,
        execImpl,
        ...(sleep ? { sleep } : {}),
      });
    }
    deployStep.succeed('Deployed and healthy');
  } catch (err) {
    deployStep.fail(`Deploy failed: ${err.message}`);
    return { state: nextState, aborted: true };
  }

  return { state: nextState, aborted: false, outputs };
}

/**
 * `cc update` for AWS: rebuilds the app image from the CURRENT working tree
 * and reships it to the already-provisioned node(s), reusing every
 * identifier `provisionAwsInfra` already recorded in `state.infra`
 * (instanceIds, storageBucket, appEnvSecretName, awsTopology, ALB target
 * group ARNs). Deliberately does NOT touch Terraform at all — no init, no
 * plan, no apply — because a redeploy should never risk reprovisioning or
 * recreating any resource; it's purely "build a new image, ship it to the
 * node(s) that already exist". If the operator actually needs an infra
 * change (instance size, region, etc.), that's a `cc destroy` + `cc up`
 * job, not this one.
 *
 * Does NOT rewrite the app/env Secrets Manager secret either — that secret
 * already holds the correct runtime config from the last `cc up`/`cc
 * update` run (Telnyx ids, DB credentials, storage HMAC), and this command
 * has no new information to add to it (no new Telnyx bootstrap, no new
 * Terraform outputs). Rewriting it here would risk clobbering a value the
 * operator or a different tool intentionally changed by hand since the
 * last deploy (e.g. rotated TELNYX_AI_API_KEY) with a stale in-memory copy.
 *
 * Requires `state.infra.instanceIds`/`storageBucket`/`appEnvSecretName` to
 * already be populated (i.e. a prior successful `cc up`) — throws a clear
 * error rather than silently no-op'ing if `cc update` is run before any
 * infra exists.
 */
/**
 * Merges fresh Telnyx resource ids/secrets into this deployment's app/env
 * Secrets Manager secret WITHOUT touching anything else already in it — the
 * cloud-target equivalent of envgen.mjs's applyEnvUpdates (Local target's
 * in-place .env patch). Used by `cc telnyx` (standalone Telnyx bootstrap
 * re-run): unlike `cc update`'s redeployAwsApp, which deliberately never
 * rewrites this secret (see its own docstring — a plain redeploy has no new
 * information to add), `cc telnyx` runs the Telnyx bootstrap orchestrator
 * again and DOES have new information (a just-created/repaired voice app,
 * SIP connection, or phone number) that has to land in the secret before the
 * next rebuild bakes it into the image / the running container picks it up.
 *
 * Read-merge-write instead of a blind overwrite so any value an operator (or
 * a different tool) changed by hand since the last `cc up`/`cc update` — a
 * rotated TELNYX_AI_API_KEY, a hand-tuned feature flag — survives this call
 * untouched; only the keys actually present in `envUpdates` change.
 */
export async function updateAwsEnvSecret({ state, envUpdates = {}, execImpl = execFileAsync } = {}) {
  if (!state.infra?.appEnvSecretName) {
    throw new Error('No AWS app/env secret recorded for this deployment yet — run `cc up` first.');
  }
  const { stdout: envRaw } = await execImpl('aws', [
    'secretsmanager', 'get-secret-value',
    '--region', state.region,
    '--secret-id', state.infra.appEnvSecretName,
    '--query', 'SecretString',
    '--output', 'text',
  ]);
  const currentEnv = parseEnvValues(envRaw);
  const merged = { ...currentEnv, ...envUpdates };
  const envText = Object.entries(merged).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
  await execImpl('aws', [
    'secretsmanager', 'put-secret-value',
    '--region', state.region,
    '--secret-id', state.infra.appEnvSecretName,
    '--secret-string', envText,
  ]);
  return merged;
}

export async function redeployAwsApp({
  state, io, deployDir, execImpl = execFileAsync, sleep,
} = {}) {
  const topology = state.infra?.awsTopology || (state.nodes >= 2 ? 'ha' : 'single');
  if (!state.infra?.instanceIds?.length || !state.infra?.storageBucket || !state.infra?.appEnvSecretName) {
    throw new Error('No AWS infrastructure recorded for this deployment yet — run `cc up` first (cc update only reships a new build to already-provisioned infra).');
  }

  // NEXT_PUBLIC_* vars are baked into the JS bundle at BUILD time (not
  // read from the runtime env at container start), so a redeploy has to
  // source the current value from wherever it was last durably written —
  // the app/env Secrets Manager secret this deployment already has,
  // populated by the last `cc up`/`cc update` run. There is no copy of it
  // in state.mjs (by design: state.mjs deliberately excludes app config,
  // only resource ids — see state.mjs's own header comment), so this reads
  // it back rather than guessing/defaulting, keeping the rebuilt bundle
  // consistent with whatever the operator (or the last wizard run) set.
  const readEnvStep = io.step('Reading current runtime config from Secrets Manager...');
  let currentEnv = {};
  try {
    const { stdout: envRaw } = await execImpl('aws', [
      'secretsmanager', 'get-secret-value',
      '--region', state.region,
      '--secret-id', state.infra.appEnvSecretName,
      '--query', 'SecretString',
      '--output', 'text',
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
      // Every NEXT_PUBLIC_* var the Dockerfile declares as a build ARG
      // (docker/production/Dockerfile: BASE_URL, RECAPTCHA_SITE_KEY,
      // STREAMING_PORT, TELNYX_WEBRTC_REGION,
      // TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES, and any future additions)
      // gets baked into next build and is UNRECOVERABLE from the running
      // container's runtime env afterwards — the client bundle only has
      // whatever value it was built with. `cc update` must therefore
      // forward the FULL current set from the app/env secret, not just
      // the two vars this function happens to touch directly; otherwise a
      // redeploy silently blanks every other public build-time feature
      // (e.g. reCAPTCHA, ICE-candidate prefetch) even though the secret
      // still has the correct values. Pull every already-set NEXT_PUBLIC_*
      // key out of currentEnv first, then apply this function's own
      // resolution/fallback logic only for the two keys it actually needs
      // to reconcile against state.infra (BASE_URL, WEBRTC_REGION).
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

  const uploadStep = io.step('Uploading image artifact to S3...');
  const shortId = imageTag.split(':')[1];
  let uploadResult;
  try {
    uploadResult = await uploadArtifact({
      bucket: state.infra.storageBucket,
      shortId,
      archivePath: artifact.archivePath,
      archiveName: artifact.archiveName,
      checksumPath: artifact.checksumPath,
      manifestPath: artifact.manifestPath,
      execImpl,
    });
    uploadStep.succeed(`Uploaded to ${uploadResult.s3Prefix}`);
  } catch (err) {
    uploadStep.fail(`Upload failed: ${err.message}`);
    return { aborted: true };
  }

  const deployStep = (io.longStep || io.step)('Deploying to node(s) via SSM...', { timeoutMs: 10 * 60_000 });
  try {
    if (topology === 'single') {
      await deploySingleNode({
        instanceId: state.infra.instanceIds[0],
        region: state.region,
        s3Prefix: uploadResult.s3Prefix,
        appEnvSecretName: state.infra.appEnvSecretName,
        appPort: 3000,
        streamingWsPort: 3001,
        execImpl,
        ...(sleep ? { sleep } : {}),
      });
    } else {
      await deployHaRolling({
        instanceIds: state.infra.instanceIds,
        region: state.region,
        s3Prefix: uploadResult.s3Prefix,
        appEnvSecretName: state.infra.appEnvSecretName,
        appPort: 3000,
        streamingWsPort: 3001,
        appTargetGroupArn: state.infra.appTargetGroupArn,
        wsTargetGroupArn: state.infra.streamingWsTargetGroupArn,
        execImpl,
        ...(sleep ? { sleep } : {}),
      });
    }
    deployStep.succeed('Deployed and healthy');
  } catch (err) {
    deployStep.fail(`Deploy failed: ${err.message}`);
    return { aborted: true };
  }

  return { aborted: false, imageTag, s3Prefix: uploadResult.s3Prefix };
}

/**
 * Tears down an AWS deployment's Terraform-managed infrastructure. Mirrors
 * provisionAwsInfra's plan-then-confirm-then-apply shape but for destroy —
 * added after a real 2026-07-06 incident where a failed `terraform apply`
 * (AllocateAddress: AddressLimitExceeded) left a partially-provisioned
 * deployment (VPC/RDS/ALB already created) with NO built-in way to unwind it
 * other than manually running `terraform destroy` by hand outside the CLI.
 *
 * Deliberately does NOT touch Telnyx resources — those are a separate,
 * distinct decision (see telnyx-bootstrap.mjs's deleteTelnyxResources) since
 * a phone number in particular may be worth keeping across a destroy+re-up
 * cycle of the same deployment name. Callers (cc.mjs's cmdDestroy) own the
 * decision of whether/how to also clean up Telnyx and prompt separately.
 *
 * `onLine` receives raw terraform destroy output lines for the caller's
 * spinner/log (see wizard.mjs's usage of the same pattern in
 * provisionAwsInfra), so a `terraform destroy` that runs for several minutes
 * (RDS deletion, final snapshot) doesn't look frozen.
 */
export async function destroyAwsInfra({
  state, io, deployDir, execImpl = execFileAsync, spawnImpl = spawn, onLine,
} = {}) {
  const topology = state.infra?.awsTopology || (state.nodes >= 2 ? 'ha' : 'single');
  const root = state.infra?.terraformDir || terraformRootFor(deployDir, topology);

  const initStep = (io.longStep || io.step)('Running terraform init...');
  try {
    await terraformInit({ cwd: root, execImpl });
    initStep.succeed('terraform init complete');
  } catch (err) {
    initStep.fail(`terraform init failed: ${err.message}`);
    return { aborted: true };
  }

  const planStep = (io.longStep || io.step)('Running terraform plan -destroy...');
  let plan;
  try {
    plan = await terraformPlan({
      cwd: root, destroy: true, execImpl,
    });
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
    `This will PERMANENTLY destroy ${plan.summary ? plan.summary.toDestroy : 'the'} AWS resource(s) for "${state.deploymentName}" (EC2, RDS, VPC, S3, Secrets Manager, ALB — see the plan above). This cannot be undone. Continue?`,
    false,
  );
  if (!confirmed) {
    io.log('Aborted — nothing was destroyed.');
    return { aborted: true };
  }

  const destroyStep = (io.longStep || io.step)('Applying terraform destroy (this can take several minutes for RDS)...', { timeoutMs: 15 * 60_000 });
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

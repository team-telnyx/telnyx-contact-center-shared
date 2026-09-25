import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  writeTfvars, terraformInit, terraformPlan, terraformApply, terraformDestroy, terraformOutputs, terraformVersion,
  createTerraformLineFilter,
} from './terraform.mjs';
import {
  buildAndPackageImage,
} from './cloud-deploy.mjs';
import {
  deploySingleNodeAzure,
} from './azure-deploy.mjs';
import { parseEnvValues } from './envgen.mjs';

const execFileAsync = promisify(execFileCb);

// Azure cloud-target counterpart to aws-cloud.mjs/gcp-cloud.mjs — Terraform
// apply + build/ship/deploy orchestration for the `azure` target. Phase
// 1/2/3 scope: single-node only (no HA/multi-node terraform root exists
// yet, same current scope as GCP), Application Gateway v2 is opt-in
// (Phase 3, mirrors GCP's HTTPS Load Balancer opt-in) — Phase 1/2 default
// is plain HTTP directly on the instance's public IP, exactly like the
// AWS no-ALB / GCP no-LB fallback path.
//
// Structural differences from the AWS/GCP paths that shape this module:
//   1. Auth is a Service Principal (ARM_SUBSCRIPTION_ID/ARM_TENANT_ID/
//      ARM_CLIENT_ID/ARM_CLIENT_SECRET env vars for Terraform's azurerm
//      provider), not an AWS profile or gcloud ADC — see the
//      azure-infra-provisioning skill for the full auth model. This module
//      does NOT set those env vars itself; the wizard/cc.mjs caller is
//      responsible for having them exported before calling anything here
//      (same "caller owns the ambient credential" contract execImpl
//      already has for aws-cloud.mjs's `aws` CLI calls).
//   2. Remote exec is `az vm run-command invoke` (synchronous, single
//      call) instead of SSM RunCommand's async send/poll or IAP-tunneled
//      SSH — see azure-deploy.mjs for the actual remote-script mechanics.
//   3. Image artifact ships to Blob Storage instead of S3/GCS (`az storage
//      blob upload` instead of `aws s3 cp` / `gcloud storage cp`).
//   4. Secrets live in Key Vault (ONE shared vault per deployment, see
//      cc-secrets-azure's module header) instead of a flat Secrets
//      Manager/Secret Manager namespace — `az keyvault secret set`/`show`
//      instead of `aws secretsmanager put-secret-value` / `gcloud secrets
//      versions add`.

const REPO_ROOT_FROM_DEPLOY_DIR = (deployDir) => join(deployDir, '..');

function terraformRootFor(deployDir) {
  // Single-node only for now — mirrors gcp-cloud.mjs's terraformRootFor
  // (also single-root, no topology parameter yet).
  return join(deployDir, 'terraform', 'azure', 'single-node');
}

export { terraformRootFor };

/**
 * Azure preflight additions beyond preflight.mjs's existing checks (Docker,
 * Terraform version, Telnyx key/balance): az CLI presence, active
 * authentication (Service Principal or user session), and that the
 * configured subscription is reachable. Called from runPreflightStep when
 * state.target === 'azure'.
 */
export async function checkAzureCloudPreflight({
  subscriptionId, execImpl = execFileAsync,
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

  let azVersion = null;
  try {
    const { stdout } = await execImpl('az', ['version', '--output', 'json']);
    const parsed = JSON.parse(stdout || '{}');
    azVersion = parsed['azure-cli'] || 'installed';
    results.push({ key: 'az-cli', status: 'ok', label: 'Azure CLI', detail: azVersion });
  } catch {
    results.push({
      key: 'az-cli', status: 'fail', label: 'Azure CLI',
      detail: 'not found',
      hint: 'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli, then `az login`.',
    });
    // No point probing auth/subscription without the CLI itself.
    return results;
  }

  try {
    const { stdout } = await execImpl('az', ['account', 'show', '--output', 'json']);
    const account = JSON.parse(stdout);
    results.push({
      key: 'az-auth', status: 'ok', label: 'az auth',
      detail: `authenticated as ${account.user?.name || 'unknown'} (subscription ${account.id})`,
    });
  } catch {
    results.push({
      key: 'az-auth', status: 'fail', label: 'az auth',
      detail: 'no active session',
      hint: 'Run `az login` (interactive) or export ARM_SUBSCRIPTION_ID/ARM_TENANT_ID/ARM_CLIENT_ID/ARM_CLIENT_SECRET (Service Principal — see the azure-infra-provisioning skill).',
    });
    return results;
  }

  if (subscriptionId) {
    try {
      const { stdout } = await execImpl('az', ['account', 'show', '--subscription', subscriptionId, '--output', 'json']);
      const parsed = JSON.parse(stdout);
      results.push({
        key: 'azure-subscription', status: 'ok', label: 'Azure subscription',
        detail: `${parsed.name || subscriptionId} (${parsed.state || 'Enabled'})`,
      });
    } catch {
      results.push({
        key: 'azure-subscription', status: 'fail', label: 'Azure subscription',
        detail: `could not access subscription "${subscriptionId}" — does it exist, and does the active identity have access?`,
        hint: 'Double-check the subscription id and RBAC role assignments (`az role assignment list --all`).',
      });
    }
  }

  return results;
}

/**
 * Resolves the Azure AD object id of whatever identity `az` is CURRENTLY
 * authenticated as — i.e. the identity that will actually run `az storage
 * blob upload --auth-mode login` (azure-deploy.mjs's uploadArtifactToBlob),
 * which always uses the CLI's own active session, never Terraform's ARM_*
 * credentials. Used to populate cc-storage-azure's uploader_object_id so
 * that identity gets the same Storage Blob Data Contributor grant
 * Terraform's own identity already gets — see that variable's docstring
 * for the full rationale (Codex review finding on PR #1197).
 *
 * `az account show` reports the active session's `user.name` + `user.type`
 * but that "name" is NOT a usable Azure AD object id for either identity
 * shape:
 *   - `user.type === "user"`: `user.name` is a UPN (email-shaped), not an
 *     object id — resolve the real object id via `az ad signed-in-user
 *     show`, a Microsoft Graph "me" call valid only for a real delegated
 *     user session.
 *   - `user.type === "servicePrincipal"`: `user.name` is actually the
 *     Service Principal's `appId` (client id), not its object id either —
 *     resolve via `az ad sp show --id <appId>`, which accepts an appId and
 *     returns the SP's real object id (`id` field). `az ad signed-in-user
 *     show` does NOT work here at all ("/me request is only valid with
 *     delegated authentication flow" — confirmed live against the wizard's
 *     own `cc-deploy-wizard` SP session).
 * Returns '' (not null/undefined) on any failure at any step — callers
 * treat '' as "skip the extra grant, assume same identity as Terraform",
 * which is always a safe, non-destructive default (this is a nice-to-have
 * closing an edge case, never a hard requirement for `cc up` to succeed).
 */
export async function resolveActiveAzureIdentity({ execImpl = execFileAsync } = {}) {
  let account;
  try {
    const { stdout } = await execImpl('az', ['account', 'show', '--output', 'json']);
    account = JSON.parse(stdout || '{}');
  } catch {
    return '';
  }
  const userType = account.user?.type;
  const userName = account.user?.name;
  if (!userName) return '';
  try {
    if (userType === 'servicePrincipal') {
      const { stdout } = await execImpl('az', ['ad', 'sp', 'show', '--id', userName, '--query', 'id', '--output', 'tsv']);
      return (stdout || '').trim();
    }
    // Default/fallback: treat as a real user session (userType === 'user'
    // or unset — az's own schema doesn't guarantee `type` is always
    // present on older CLI versions).
    const { stdout } = await execImpl('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '--output', 'tsv']);
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

/**
 * Resolves the Azure AD object id of whatever identity TERRAFORM itself
 * will authenticate as for this `apply` — the other half of the
 * uploader-vs-Terraform identity comparison described on
 * resolveActiveAzureIdentity above. Mirrors azurerm provider's own auth
 * resolution order (see versions.tf's provider block comment): if
 * ARM_CLIENT_ID is set in the environment, Terraform authenticates as
 * that Service Principal regardless of whatever `az` is separately logged
 * in as; otherwise it falls back to `az`'s own current CLI session,
 * identical to resolveActiveAzureIdentity. Returns '' on any failure,
 * same safe-default contract as its counterpart.
 */
export async function resolveTerraformAzureIdentity({ execImpl = execFileAsync, env = process.env } = {}) {
  const armClientId = env.ARM_CLIENT_ID;
  if (!armClientId) return resolveActiveAzureIdentity({ execImpl });
  try {
    const { stdout } = await execImpl('az', ['ad', 'sp', 'show', '--id', armClientId, '--query', 'id', '--output', 'tsv']);
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

/**
 * Writes the tfvars file for the Azure single-node root from the wizard's
 * collected answers. Explicit key mapping (like writeAwsTfvars/
 * writeGcpTfvars), not a generic pass-through, so drift between wizard
 * field names and Terraform variable names is visible/testable at this one
 * call site.
 */
export async function writeAzureTfvars({ deployDir, state, execImpl = execFileAsync } = {}) {
  const root = terraformRootFor(deployDir);
  // Resolve BOTH identities and compare here (plain JS), not inside
  // Terraform via a `count` expression comparing against
  // data.azurerm_client_config.current.object_id — cc-storage-azure's
  // module block carries depends_on = [module.secrets] at the root level,
  // which defers EVERY resource/data source inside that module (including
  // its own client_config data source) to apply-time, and `count` cannot
  // depend on a value Terraform can't resolve during `plan` ("Invalid
  // count argument"). Doing the comparison here and passing '' when they
  // already match keeps cc-storage-azure's count expression a simple,
  // always-plan-time-resolvable check against the literal empty string.
  const [activeIdentity, terraformIdentity] = await Promise.all([
    resolveActiveAzureIdentity({ execImpl }),
    resolveTerraformAzureIdentity({ execImpl }),
  ]);
  const uploaderObjectId = (activeIdentity && activeIdentity !== terraformIdentity) ? activeIdentity : '';
  const vars = {
    subscription_id: state.infra?.azureSubscriptionId,
    location: state.region,
    deployment_name: state.deploymentName,
    domain: state.domain || '',
    admin_ssh_source_ranges: [],
    vm_size: state.azureVmSize || 'Standard_D2s_v3',
    db_sku_name: state.azureDbSkuName || 'GP_Standard_D2s_v3',
    portainer_agent_enabled: Boolean(state.portainer?.agentEnabled),
    portainer_agent_port: state.portainer?.agentPort || 9001,
    portainer_server_cidrs: state.portainer?.serverCidrs || [],
    // Terraform authenticates via ARM_* env vars (the wizard's own SP —
    // see this module's header), which can be a DIFFERENT identity than
    // whatever `az` is interactively logged in as when it later runs `az
    // storage blob upload --auth-mode login`. Passing this through lets
    // cc-storage-azure grant the blob-upload role to BOTH identities when
    // they differ, instead of only the Terraform SP. See
    // resolveActiveAzureIdentity's docstring above for how it's resolved.
    uploader_object_id: uploaderObjectId,
    // Phase 3: Application Gateway v2 + Key Vault-backed cert. Set by the
    // wizard's runAzureLbStep based on whether the operator opted in —
    // false (default) keeps the Phase 1/2 behavior (plain HTTP on the
    // instance's public IP). Mirrors writeAwsTfvars's alb_enabled /
    // writeGcpTfvars's lb_enabled gates. Reuses state.infra.lbEnabled (the
    // same field GCP already set) — see state.mjs's comment on that field.
    lb_enabled: Boolean(state.infra?.lbEnabled),
    // Azure DNS automation (parity with AWS's dns_zone_id / GCP's
    // dns_managed_zone gate) — only takes effect when BOTH lbEnabled and
    // azureDnsManaged are true, mirroring runGcpDnsStep's own gating.
    dns_zone_name: (state.infra?.lbEnabled && state.infra?.azureDnsManaged) ? (state.infra?.azureDnsZoneName || '') : '',
    dns_zone_resource_group: (state.infra?.lbEnabled && state.infra?.azureDnsManaged) ? (state.infra?.azureDnsZoneResourceGroup || '') : '',
  };
  await writeTfvars(root, vars);
  return { root, vars };
}

/**
 * Targeted bootstrap pass: creates ONLY the Resource Group + Key Vault
 * (`-target=module.secrets`, which Terraform's own dependency graph
 * automatically expands to include `azurerm_resource_group.main` since
 * cc-secrets-azure depends on it) — a small, fast (~10-30s) apply that
 * exists so the wizard's certificate step (runAzureCertificateStep) can
 * know the real Key Vault NAME (globally-unique, hash-suffixed, only
 * known after Terraform actually creates it — see cc-secrets-azure's
 * local.kv_name) and therefore offer certificate reuse / auto-issue
 * Let's Encrypt / import BEFORE the full stack apply runs, instead of
 * requiring a separate `cc up` re-run after a first pass that fails on
 * the Application Gateway's missing certificate.
 *
 * This is intentionally its own small init/plan/apply cycle rather than
 * folding into provisionAzureInfra's main plan/apply — Terraform plan
 * files are tied to the resources they were planned against, so a
 * `-target`-scoped plan can't later be "widened" into a full-stack apply;
 * the caller (runAzureProvisionStep) re-plans/re-applies the FULL stack
 * afterwards, which is a normal, idempotent Terraform operation once the
 * targeted resources already exist in state (Terraform sees them as
 * "already applied, no changes needed" and only creates what's left).
 *
 * Only called when lb_enabled=true and no keyVaultName is known yet
 * (fresh deployment) — see runAzureWizardTail's gating. No-ops safely if
 * called again on a deployment that already has a Key Vault (targeted
 * apply against existing state is a no-change no-op, not an error).
 */
export async function provisionAzureKeyVaultOnly({
  state, io, deployDir, execImpl = execFileAsync, spawnImpl = spawn,
} = {}) {
  const root = terraformRootFor(deployDir);
  await writeAzureTfvars({ deployDir, state, execImpl });

  const initStep = (io.longStep || io.step)('Running terraform init...');
  try {
    await terraformInit({ cwd: root, execImpl });
    initStep.succeed('terraform init complete');
  } catch (err) {
    initStep.fail(`terraform init failed: ${err.message}`);
    return { state, aborted: true };
  }

  const planStep = (io.longStep || io.step)('Planning Key Vault bootstrap (resource group + Key Vault only)...');
  let plan;
  try {
    plan = await terraformPlan({ cwd: root, targets: ['module.secrets'], execImpl });
    planStep.succeed(`Plan ready: ${plan.summary ? `${plan.summary.toAdd} to add, ${plan.summary.toChange} to change, ${plan.summary.toDestroy} to destroy` : 'see output'}`);
  } catch (err) {
    planStep.fail(`terraform plan failed: ${err.message}`);
    return { state, aborted: true };
  }

  io.log('  ℹ About to create: the resource group and Key Vault only (not the full stack yet) — this lets the wizard offer certificate reuse / Let\'s Encrypt in this same run instead of requiring a second `cc up`.');
  const confirmed = await io.confirm('Create the resource group + Key Vault now?', true);
  if (!confirmed) {
    io.log('Aborted — nothing was created.');
    return { state, aborted: true };
  }

  const applyStep = (io.longStep || io.step)('Creating resource group + Key Vault...', { timeoutMs: 3 * 60_000 });
  try {
    const filterLine = createTerraformLineFilter();
    await terraformApply({
      cwd: root,
      planFile: plan.planFile,
      spawnImpl,
      onLine: (line) => {
        const filtered = filterLine(line);
        if (filtered !== null) applyStep.info?.(filtered);
      },
    });
    applyStep.succeed('Resource group + Key Vault created');
  } catch (err) {
    applyStep.fail(`terraform apply failed: ${err.message}`);
    return { state, aborted: true };
  }

  const outputs = await terraformOutputs({ cwd: root, execImpl });
  return {
    state: {
      ...state,
      infra: {
        ...state.infra,
        terraformDir: root,
        keyVaultName: outputs.key_vault_name || null,
        azureResourceGroup: outputs.resource_group_name || null,
      },
    },
    aborted: false,
  };
}

/**
 * Full Azure provisioning pass: terraform init/plan/apply, populate the
 * app/env Key Vault secret (mirroring provisionAwsInfra's Secrets Manager
 * write / provisionGcpInfra's Secret Manager write — every TELNYX_*
 * id/secret is already known because Telnyx bootstrap runs before this
 * step, per the same ordering rule as AWS/GCP), then build+ship+deploy the
 * app image over `az vm run-command invoke`.
 */
export async function provisionAzureInfra({
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

  const applyStep = (io.longStep || io.step)('Applying Terraform (this can take several minutes for Postgres Flexible Server)...', { timeoutMs: 15 * 60_000 });
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
    // Common real-world case (see runAzureLbStep/runAzureCertificateStep):
    // apply fails specifically on the Application Gateway step because its
    // TLS certificate doesn't exist in Key Vault yet — but everything
    // BEFORE that resource (resource group, network, secrets/Key Vault,
    // database, storage, compute) already applied successfully and is
    // real, live infrastructure Terraform's own state file now tracks.
    // Terraform itself allows `terraform output` to run against a
    // partially-applied state (it just returns whichever outputs'
    // dependencies happen to be satisfied), so fetch what's available now
    // rather than leaving state.infra entirely null — without this, a
    // resumed `cc up` has no keyVaultName to offer the "reuse an existing
    // certificate" / "issue via Let's Encrypt" choices against, forcing
    // the operator through the fully-manual import path even though the
    // vault they'd import into already exists.
    let partialOutputs = {};
    try {
      partialOutputs = await terraformOutputs({ cwd: root, execImpl });
    } catch {
      // terraform output itself can fail on a sufficiently early/broken
      // apply (e.g. state file corrupt, or literally nothing applied yet)
      // — that's fine, partialOutputs stays {} and state.infra keeps
      // whatever it already had from a previous run.
    }
    return {
      state: {
        ...state,
        infra: {
          ...state.infra,
          terraformDir: root,
          keyVaultName: partialOutputs.key_vault_name || state.infra?.keyVaultName || null,
          azureResourceGroup: partialOutputs.resource_group_name || state.infra?.azureResourceGroup || null,
        },
      },
      aborted: true,
    };
  }

  const outputs = await terraformOutputs({ cwd: root, execImpl });

  let nextState = {
    ...state,
    infra: {
      ...state.infra,
      terraformDir: root,
      publicIp: outputs.public_ip || null,
      appUrl: outputs.app_url || answers.baseUrl,
      azureResourceGroup: outputs.resource_group_name || null,
      vmName: outputs.vm_name || null,
      instanceIds: [outputs.vm_id].filter(Boolean),
      keyVaultName: outputs.key_vault_name || null,
      appEnvSecretName: outputs.app_env_secret_name || null,
      storageAccount: outputs.storage_account_name || null,
      storageContainer: outputs.storage_container_name || null,
      dbSecretName: outputs.db_secret_name || null,
      // Phase 3: only present when lb_enabled=true (Terraform outputs are
      // null otherwise — see azure/single-node's outputs.tf).
      appgwPublicIp: outputs.appgw_public_ip || null,
    },
  };

  // Populate the app/env Key Vault secret — the Azure equivalent of
  // provisionAwsInfra's `aws secretsmanager put-secret-value` write /
  // provisionGcpInfra's `gcloud secrets versions add`. Same "one write, no
  // restart-after-the-fact" property: extraEnvUpdates (Telnyx ids) are
  // already known by this point.
  const envUpdateStep = io.step('Populating runtime secret in Key Vault...');
  try {
    let dbOverrides = {};
    if (nextState.infra.dbSecretName) {
      const { stdout: dbSecretRaw } = await execImpl('az', [
        'keyvault', 'secret', 'show',
        '--vault-name', nextState.infra.keyVaultName,
        '--name', nextState.infra.dbSecretName,
        '--query', 'value', '-o', 'tsv',
      ]);
      const dbSecret = JSON.parse(dbSecretRaw);
      dbOverrides = {
        POSTGRES_HOST: dbSecret.host,
        POSTGRES_PORT: String(dbSecret.port || 5432),
        POSTGRES_DB: dbSecret.dbname,
        POSTGRES_USER: dbSecret.username,
        POSTGRES_PASSWORD: dbSecret.password,
        // Azure Postgres Flexible Server requires SSL/TLS for connections
        // by default (same posture as RDS's post-2024-default-encryption
        // rollout and Cloud SQL's private-IP-still-encrypted requirement —
        // see aws-cloud.mjs/gcp-cloud.mjs for those incidents). Set
        // proactively here rather than waiting to hit a "no encryption"
        // connection failure against Flexible Server.
        POSTGRES_SSL: 'true',
        COMPOSE_PROFILES: 'no-with-pg',
      };
    }

    let storageOverride = {};
    if (nextState.infra.storageAccount) {
      // The app's Azure Blob driver (lib/storage/azure-blob-driver.mjs)
      // authenticates via the VM's Managed Identity by default (no keys —
      // see cc-compute-single-azure's Storage Blob Data Contributor role
      // assignment) when STORAGE_ACCOUNT is set without a connection
      // string. Only STORAGE_PROVIDER/STORAGE_ACCOUNT/STORAGE_CONTAINER
      // need to land in the app/env secret — node.env (written by
      // cloud-init.sh.tpl, NOT this secret) already carries
      // AZURE_STORAGE_CONNECTION_STRING as the local-tooling fallback, so
      // this secret intentionally does NOT duplicate that credential.
      storageOverride = {
        STORAGE_PROVIDER: 'azure',
        STORAGE_ACCOUNT: nextState.infra.storageAccount,
        STORAGE_CONTAINER: nextState.infra.storageContainer,
      };
    }

    // Same WS_BASE_URL override rationale as provisionAwsInfra/
    // provisionGcpInfra: when the Application Gateway is enabled, only the
    // ws.<domain> host is routed for streaming traffic and direct instance
    // access is removed, so the runtime fallback
    // (`wss://<host>:3001`) would otherwise be unreachable.
    let wsUrlOverride = {};
    if (nextState.infra.lbEnabled && state.domain) {
      wsUrlOverride = { WS_BASE_URL: `wss://ws.${state.domain}` };
    }

    const envMap = { ...answers.envValues, ...extraEnvUpdates, ...dbOverrides, ...storageOverride, ...wsUrlOverride };
    const envText = Object.entries(envMap).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
    await execImpl('az', [
      'keyvault', 'secret', 'set',
      '--vault-name', nextState.infra.keyVaultName,
      '--name', nextState.infra.appEnvSecretName,
      '--value', envText,
    ], { maxBuffer: 1024 * 1024 * 4 });
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
        // Same baseUrl-over-terraform-output preference as
        // provisionAwsInfra/provisionGcpInfra — see those docstrings for
        // the full rationale (avoids shipping a client bundle pointed at
        // http:// when the real public entrypoint is always https://).
        NEXT_PUBLIC_BASE_URL: answers.baseUrl || nextState.infra.appUrl,
        NEXT_PUBLIC_TELNYX_WEBRTC_REGION: answers.envValues?.NEXT_PUBLIC_TELNYX_WEBRTC_REGION || '',
      },
    });
    buildStep.succeed('Image built and packaged');
  } catch (err) {
    buildStep.fail(`Docker build failed: ${err.message}`);
    return { state: nextState, aborted: true };
  }

  const deployStep = (io.longStep || io.step)('Deploying to VM via az vm run-command (this can take a few minutes)...', { timeoutMs: 10 * 60_000 });
  try {
    await deploySingleNodeAzure({
      vmName: nextState.infra.vmName,
      resourceGroup: nextState.infra.azureResourceGroup,
      storageAccount: nextState.infra.storageAccount,
      storageContainer: nextState.infra.storageContainer,
      artifact,
      keyVaultName: nextState.infra.keyVaultName,
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
 * `cc update` for Azure: rebuilds the app image from the CURRENT working
 * tree and reships it to the already-provisioned VM, reusing every
 * identifier `provisionAzureInfra` already recorded in `state.infra`
 * (vmName, azureResourceGroup, storageAccount, storageContainer,
 * keyVaultName, appEnvSecretName). Mirrors redeployAwsApp's/
 * redeployGcpApp's counterparts exactly in shape and the same "never touch
 * Terraform, never touch the Key Vault write" rules — see those
 * docstrings for the full rationale.
 */
export async function updateAzureEnvSecret({ state, envUpdates = {}, execImpl = execFileAsync } = {}) {
  if (!state.infra?.appEnvSecretName || !state.infra?.keyVaultName) {
    throw new Error('No Azure app/env secret recorded for this deployment yet — run `cc up` first.');
  }
  const { stdout: envRaw } = await execImpl('az', [
    'keyvault', 'secret', 'show',
    '--vault-name', state.infra.keyVaultName,
    '--name', state.infra.appEnvSecretName,
    '--query', 'value', '-o', 'tsv',
  ]);
  const currentEnv = parseEnvValues(envRaw);
  const merged = { ...currentEnv, ...envUpdates };
  const envText = Object.entries(merged).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
  await execImpl('az', [
    'keyvault', 'secret', 'set',
    '--vault-name', state.infra.keyVaultName,
    '--name', state.infra.appEnvSecretName,
    '--value', envText,
  ], { maxBuffer: 1024 * 1024 * 4 });
  return merged;
}

export async function redeployAzureApp({
  state, io, deployDir, execImpl = execFileAsync, sleep,
} = {}) {
  if (!state.infra?.vmName || !state.infra?.storageAccount || !state.infra?.appEnvSecretName) {
    throw new Error('No Azure infrastructure recorded for this deployment yet — run `cc up` first (cc update only reships a new build to already-provisioned infra).');
  }

  const readEnvStep = io.step('Reading current runtime config from Key Vault...');
  let currentEnv = {};
  try {
    const { stdout: envRaw } = await execImpl('az', [
      'keyvault', 'secret', 'show',
      '--vault-name', state.infra.keyVaultName,
      '--name', state.infra.appEnvSecretName,
      '--query', 'value', '-o', 'tsv',
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

  const deployStep = (io.longStep || io.step)('Deploying to VM via az vm run-command (this can take a few minutes)...', { timeoutMs: 10 * 60_000 });
  try {
    await deploySingleNodeAzure({
      vmName: state.infra.vmName,
      resourceGroup: state.infra.azureResourceGroup,
      storageAccount: state.infra.storageAccount,
      storageContainer: state.infra.storageContainer,
      artifact,
      keyVaultName: state.infra.keyVaultName,
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
 * Tears down an Azure deployment's Terraform-managed infrastructure.
 * Mirrors destroyAwsInfra's/destroyGcpInfra's plan-then-confirm-then-apply
 * shape.
 *
 * Deliberately does NOT touch Telnyx resources — same separation of
 * concerns as the AWS/GCP paths (cc.mjs's cleanupTelnyxResourcesInteractive
 * handles that, shared across every target).
 */
export async function destroyAzureInfra({
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
    `This will PERMANENTLY destroy ${plan.summary ? plan.summary.toDestroy : 'the'} Azure resource(s) for "${state.deploymentName}" (VM, Postgres Flexible Server, VNet, Storage Account, Key Vault — see the plan above). This cannot be undone. Continue?`,
    false,
  );
  if (!confirmed) {
    io.log('Aborted — nothing was destroyed.');
    return { aborted: true };
  }

  const destroyStep = (io.longStep || io.step)('Applying terraform destroy (this can take several minutes for Postgres Flexible Server)...', { timeoutMs: 15 * 60_000 });
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
    // Specific hint for a case discovered via live testing: Azure DNS
    // zones created by PURCHASING a domain through Azure (see
    // runAzureDnsStep/azure-acme.mjs's cleanupFailures handling for the
    // Let's Encrypt TXT-record equivalent of this) get an automatic
    // CanNotDelete resource lock — this also blocks Terraform from
    // deleting the A records it created (azurerm_dns_a_record.app/app_ws
    // in cc-compute-single-azure), so `terraform destroy` fails on those
    // specific resources even though everything else tears down fine.
    // Re-running after simply removing the zone-level lock in the Azure
    // Portal (Locks blade) resolves it — no code-side workaround exists
    // since Azure locks intentionally cannot be bypassed by any caller.
    if (/ScopeLocked|CanNotDelete/i.test(err.message)) {
      io.log('  ℹ This looks like an Azure resource lock (ScopeLocked/CanNotDelete) — common on DNS zones created by purchasing a domain through Azure. Remove the lock on the DNS zone in the Azure Portal (Locks blade) and re-run `cc destroy`.');
    }
    return { aborted: true };
  }

  // Note: NOT calling `az keyvault purge` here. The azurerm provider's
  // key_vault.purge_soft_delete_on_destroy defaults to true (see
  // https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/features-block
  // - our versions.tf's `features {}` block takes every default as-is),
  // so `terraform destroy` already fully purges azurerm_key_vault.main as
  // part of destroying that resource — that's why it took ~10 minutes in
  // practice rather than a quick delete. A previous version of this
  // function ran a second, redundant `az keyvault purge` afterward on the
  // assumption the provider only soft-deletes; that always failed with
  // `DeletedVaultNotFound` (the vault is already gone, not sitting in
  // recoverable soft-delete state waiting to be purged) — harmless since
  // it was caught as non-fatal, but confusing noise on every destroy.

  return { aborted: false, destroyed: plan.summary ? plan.summary.toDestroy : null };
}

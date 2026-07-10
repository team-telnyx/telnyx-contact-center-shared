import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// Azure-specific deploy mechanics: ship the image tarball to Blob Storage,
// then run the deploy over `az vm run-command invoke`. This is the Azure
// counterpart to cloud-deploy.mjs's uploadArtifact/deploySingleNode (AWS S3
// + SSM RunCommand) and gcp-deploy.mjs's uploadArtifactToGcs/
// deploySingleNodeGcp (GCS + IAP-tunneled SSH) — split into its own module
// for the same reason gcp-deploy.mjs is separate from cloud-deploy.mjs: the
// transport mechanism is entirely different per provider even though the
// remote shell script that actually runs ON the instance is nearly
// identical (buildAndPackageImage is reused as-is from cloud-deploy.mjs —
// building/packaging the image locally has nothing provider-specific about
// it).
//
// Transport shape, unlike AWS SSM (async SendCommand + poll
// GetCommandInvocation) and GCP IAP-SSH (a real interactive-shell-capable
// SSH session): `az vm run-command invoke` is a single synchronous CLI call
// that blocks until the remote script exits and returns its stdout/stderr
// inline in the JSON response — no separate polling loop needed here,
// mirroring how gcp-deploy.mjs's runIapSshDeployCommand needed none either
// (SSH is already synchronous) but AWS's SSM path does.

const REMOTE_DEPLOY_SCRIPT_AZURE = `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_PREFIX="$1"
APP_DIR=/opt/cc
RELEASE_ID="$(basename "$ARTIFACT_PREFIX")"
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"
CURRENT_IMAGE_FILE="$APP_DIR/current-image"
CONTAINER_NAME=cc-app
mkdir -p "$RELEASE_DIR"
cd "$RELEASE_DIR"

echo "Refreshing /opt/cc/app.env from Key Vault"
az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name "$APP_ENV_SECRET" --query value -o tsv > "$APP_DIR/app.env"
chmod 0600 "$APP_DIR/app.env"

echo "Downloading artifact from $ARTIFACT_PREFIX"
az storage blob download --auth-mode login --account-name "$STORAGE_ACCOUNT" --container-name "$STORAGE_CONTAINER" --name "$ARTIFACT_PREFIX/manifest.json" --file manifest.json --no-progress
az storage blob download --auth-mode login --account-name "$STORAGE_ACCOUNT" --container-name "$STORAGE_CONTAINER" --name "$ARTIFACT_PREFIX/image.tar.zst" --file image.tar.zst --no-progress
az storage blob download --auth-mode login --account-name "$STORAGE_ACCOUNT" --container-name "$STORAGE_CONTAINER" --name "$ARTIFACT_PREFIX/image.tar.zst.sha256" --file image.tar.zst.sha256 --no-progress

echo "Verifying checksum"
sha256sum -c image.tar.zst.sha256

# jq instead of python3 — same choice as the GCP remote script (python3
# isn't installed by cc-compute-single-azure's cloud-init.sh.tpl; jq
# already is, apt-installed alongside zstd right at the top of that script).
IMAGE_NAME="$(jq -r '.image' manifest.json)"
previous_image=""
[ -f "$CURRENT_IMAGE_FILE" ] && previous_image="$(tr -d '\\n' < "$CURRENT_IMAGE_FILE")"

echo "Loading image $IMAGE_NAME"
zstd -dc image.tar.zst | docker load

run_container() {
  local image="$1"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d \\
    --name "$CONTAINER_NAME" \\
    --restart unless-stopped \\
    --env-file "$APP_DIR/app.env" \\
    --env-file "$APP_DIR/node.env" \\
    -p "$APP_PORT:$APP_PORT" \\
    -p "$STREAMING_WS_PORT:$STREAMING_WS_PORT" \\
    "$image"
}

wait_health() {
  for i in $(seq 1 60); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}

run_container "$IMAGE_NAME"
if wait_health; then
  echo "$IMAGE_NAME" > "$CURRENT_IMAGE_FILE"
  echo "DEPLOY_OK image=$IMAGE_NAME"
  exit 0
fi

echo "New image failed health checks: $IMAGE_NAME" >&2
if [ -n "$previous_image" ]; then
  echo "Rolling back to previous image: $previous_image" >&2
  run_container "$previous_image"
  wait_health || true
fi
exit 5
`;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Uploads the built artifact (image tarball + checksum + manifest) to
 * <container>/deploy-artifacts/<shortId>/ in the deployment's Storage
 * Account. Mirrors cloud-deploy.mjs's uploadArtifact (S3) and
 * gcp-deploy.mjs's uploadArtifactToGcs (GCS) but via `az storage blob
 * upload`. `--auth-mode login` reuses the operator's own `az login`
 * session (the wizard runs on the operator's machine, which already has
 * Owner/Contributor on the subscription — no separate storage key needed
 * here, matching the "no keys, RBAC everywhere" posture the rest of the
 * Azure root uses).
 */
export async function uploadArtifactToBlob({
  accountName, containerName, shortId, archivePath, archiveName, checksumPath, manifestPath, execImpl = execFileAsync,
} = {}) {
  if (!accountName) throw new Error('uploadArtifactToBlob requires { accountName }');
  if (!containerName) throw new Error('uploadArtifactToBlob requires { containerName }');
  if (!shortId) throw new Error('uploadArtifactToBlob requires { shortId }');
  const prefix = `deploy-artifacts/${shortId}`;

  const uploadOne = (localPath, blobName) => execImpl('az', [
    'storage', 'blob', 'upload',
    '--auth-mode', 'login',
    '--account-name', accountName,
    '--container-name', containerName,
    '--name', blobName,
    '--file', localPath,
    '--overwrite',
    '--no-progress',
  ], { maxBuffer: 1024 * 1024 * 8 });

  await uploadOne(archivePath, `${prefix}/${archiveName}`);
  await uploadOne(checksumPath, `${prefix}/${archiveName}.sha256`);
  await uploadOne(manifestPath, `${prefix}/manifest.json`);
  return { blobPrefix: prefix };
}

/**
 * Waits for the VM's cloud-init bootstrap to have finished (Docker + az CLI
 * installed, Managed Identity login done — see cloud-init.sh.tpl's final
 * `echo ... > /var/log/cc-bootstrap.done` line) before attempting the real
 * deploy command. Terraform reporting the VM as created only means the
 * Azure Compute API accepted the request — cloud-init can still be mid-run
 * (apt installs, Docker daemon startup) for a minute or more after that,
 * during which `az vm run-command invoke` would either hang or return a
 * confusing "docker: command not found" failure. Mirrors
 * waitForSsmOnline's (AWS) and waitForIapSshReady's (GCP) same-purpose
 * pre-deploy readiness probes, adapted to run-command's own polling shape
 * (no separate "agent registered" signal to check — the run-command itself
 * IS the probe here, since a VM that isn't ready to accept a command will
 * simply fail or time out on `az vm run-command invoke`).
 */
export async function waitForCloudInitReady({
  vmName, resourceGroup, timeoutMs = 240_000, intervalMs = 10_000,
  execImpl = execFileAsync, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt,
} = {}) {
  if (!vmName) throw new Error('waitForCloudInitReady requires { vmName }');
  if (!resourceGroup) throw new Error('waitForCloudInitReady requires { resourceGroup }');
  const start = now();
  let attempts = 0;
  while (now() - start < timeoutMs) {
    attempts += 1;
    let ok = false;
    try {
      const { stdout } = await execImpl('az', [
        'vm', 'run-command', 'invoke',
        '--name', vmName,
        '--resource-group', resourceGroup,
        '--command-id', 'RunShellScript',
        '--scripts', 'test -f /var/log/cc-bootstrap.done && echo READY || echo NOTREADY',
      ], { timeout: 60_000, maxBuffer: 1024 * 1024 * 4 });
      ok = String(stdout || '').includes('READY') && !String(stdout || '').includes('NOTREADY');
    } catch {
      ok = false;
    }
    const elapsedMs = now() - start;
    if (onAttempt) onAttempt({ attempt: attempts, ok, elapsedMs });
    if (ok) return { ready: true, attempts, elapsedMs };
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    await sleep(intervalMs);
  }
  return { ready: false, attempts, elapsedMs: now() - start };
}

/**
 * Runs the deploy script on the instance over `az vm run-command invoke`.
 * This is the Azure counterpart to runSsmDeployCommand (AWS) and
 * runIapSshDeployCommand (GCP) — same "heredoc the script, run it with env
 * vars, capture output" shape. `az vm run-command invoke` is itself
 * synchronous (no separate poll-for-completion step, unlike SSM), and its
 * `--parameters` mechanism doesn't cleanly support arbitrary env var
 * injection into the remote script's shell environment the way SSM
 * RunCommand's Parameters map or a plain SSH command's env-export prelude
 * do — so env vars are exported as shell statements prepended to the
 * script body instead, same technique runIapSshDeployCommand already uses
 * for its own sudo-env-reset workaround.
 */
export async function runVmDeployCommand({
  vmName, resourceGroup, script, blobPrefix, env = {},
  execImpl = execFileAsync, timeout = 480_000,
} = {}) {
  if (!vmName) throw new Error('runVmDeployCommand requires { vmName }');
  if (!resourceGroup) throw new Error('runVmDeployCommand requires { resourceGroup }');
  if (!blobPrefix) throw new Error('runVmDeployCommand requires { blobPrefix }');

  const envExports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n');
  const fullScript = `${envExports}\ncat > /tmp/cc-deploy.sh <<'CC_DEPLOY_SCRIPT_EOF'\n${script}\nCC_DEPLOY_SCRIPT_EOF\nchmod +x /tmp/cc-deploy.sh\n/tmp/cc-deploy.sh ${shellQuote(blobPrefix)}`;

  try {
    const { stdout } = await execImpl('az', [
      'vm', 'run-command', 'invoke',
      '--name', vmName,
      '--resource-group', resourceGroup,
      '--command-id', 'RunShellScript',
      '--scripts', fullScript,
    ], { timeout, maxBuffer: 1024 * 1024 * 16 });
    // `az vm run-command invoke` always exits 0 from the CLI's own
    // perspective as long as the API call itself succeeded — the REMOTE
    // script's actual exit code and stdout/stderr are nested inside the
    // JSON response's value[].message field, not surfaced as the CLI
    // process's own exit code. Parse it out rather than trusting execImpl's
    // resolve/reject alone, mirroring runIapSshDeployCommand's equivalent
    // "the transport succeeded, but did the SCRIPT succeed" distinction
    // (there SSH's own exit code already carries that signal; here it
    // does not, so we parse explicitly).
    const parsed = JSON.parse(stdout || '{}');
    const message = parsed?.value?.map((v) => v.message).join('\n') || stdout || '';
    const failed = /DEPLOY_OK/.test(message) === false || /\[stderr\][\s\S]*exit(ed)? (with )?(status |code )?[1-9]/i.test(message);
    if (failed && !/DEPLOY_OK/.test(message)) {
      return { success: false, output: message, error: 'remote deploy script did not report DEPLOY_OK' };
    }
    return { success: true, output: message };
  } catch (err) {
    return {
      success: false,
      output: err?.stdout || '',
      error: err?.stderr || err?.message || 'az vm run-command invoke failed',
    };
  }
}

/**
 * Single-node Azure deploy: upload the artifact to Blob Storage, wait for
 * cloud-init to be finished, then run the deploy script over `az vm
 * run-command invoke`. Mirrors cloud-deploy.mjs's deploySingleNode (AWS)
 * and gcp-deploy.mjs's deploySingleNodeGcp (GCP) end to end, minus any
 * Application Gateway registration step (Phase 3's Application Gateway
 * targets the VM's private IP directly via a static backend pool — see
 * cc-compute-single-azure's azurerm_application_gateway.app — so there is
 * no dynamic register/deregister dance to do here, unlike AWS ALB target
 * groups).
 */
export async function deploySingleNodeAzure({
  vmName, resourceGroup, storageAccount, storageContainer, artifact, keyVaultName, appEnvSecretName,
  appPort, streamingWsPort,
  execImpl = execFileAsync, sleep,
  waitForCloudInitReadyImpl = waitForCloudInitReady, runVmDeployCommandImpl = runVmDeployCommand,
  uploadArtifactToBlobImpl = uploadArtifactToBlob,
} = {}) {
  const shortId = Date.now().toString(36);
  const uploadResult = await uploadArtifactToBlobImpl({
    accountName: storageAccount,
    containerName: storageContainer,
    shortId,
    archivePath: artifact.archivePath,
    archiveName: artifact.archiveName,
    checksumPath: artifact.checksumPath,
    manifestPath: artifact.manifestPath,
    execImpl,
  });

  const cloudInitReady = await waitForCloudInitReadyImpl({
    vmName, resourceGroup, execImpl, ...(sleep ? { sleep } : {}),
  });
  if (!cloudInitReady.ready) {
    throw new Error(`VM ${vmName} never finished cloud-init bootstrap after ${cloudInitReady.attempts} attempts — check that the custom-data script completed (Docker/az CLI install) via the Azure Portal's "Boot diagnostics" or "Run command" history.`);
  }

  const result = await runVmDeployCommandImpl({
    vmName, resourceGroup, blobPrefix: uploadResult.blobPrefix,
    script: REMOTE_DEPLOY_SCRIPT_AZURE,
    env: {
      KEY_VAULT_NAME: keyVaultName, APP_ENV_SECRET: appEnvSecretName,
      STORAGE_ACCOUNT: storageAccount, STORAGE_CONTAINER: storageContainer,
      APP_PORT: appPort, STREAMING_WS_PORT: streamingWsPort,
    },
    execImpl,
  });
  if (!result.success) {
    throw new Error(`Single-node Azure deploy failed on ${vmName}: ${result.error || result.output}`.slice(0, 4000));
  }
  return { ...result, blobPrefix: uploadResult.blobPrefix };
}

export const REMOTE_SCRIPTS = { single: REMOTE_DEPLOY_SCRIPT_AZURE };

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// GCP-specific deploy mechanics: ship the image tarball to GCS, then run the
// deploy over `gcloud compute ssh --tunnel-through-iap`. This is the GCP
// counterpart to cloud-deploy.mjs's uploadArtifact/deploySingleNode/
// deployHaRolling (AWS S3 + SSM RunCommand) — split into its own module
// (not folded into cloud-deploy.mjs) because the transport mechanism is
// entirely different even though the shell script that runs ON the
// instance is nearly identical, and this keeps cloud-deploy.mjs provider-
// agnostic where the shapes really do overlap (buildAndPackageImage is
// reused as-is from there — building/packaging the image locally has
// nothing provider-specific about it).

const REMOTE_DEPLOY_SCRIPT_GCP = `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_PREFIX="$1"
APP_DIR=/opt/cc
RELEASE_ID="$(basename "$ARTIFACT_PREFIX")"
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"
CURRENT_IMAGE_FILE="$APP_DIR/current-image"
CONTAINER_NAME=cc-app
mkdir -p "$RELEASE_DIR"
cd "$RELEASE_DIR"

echo "Refreshing /opt/cc/app.env from Secret Manager"
gcloud secrets versions access latest --secret="$APP_ENV_SECRET" --project="$GCP_PROJECT" > "$APP_DIR/app.env"
chmod 0600 "$APP_DIR/app.env"

echo "Downloading artifact from $ARTIFACT_PREFIX"
gcloud storage cp "$ARTIFACT_PREFIX/manifest.json" manifest.json
gcloud storage cp "$ARTIFACT_PREFIX/image.tar.zst" image.tar.zst
gcloud storage cp "$ARTIFACT_PREFIX/image.tar.zst.sha256" image.tar.zst.sha256

echo "Verifying checksum"
sha256sum -c image.tar.zst.sha256

# jq instead of python3 (the AWS remote script's choice) — python3 isn't
# installed by cc-compute-single-gcp's startup-script.sh.tpl (jq already is,
# for the storage-HMAC-secret parsing that script itself does).
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
 * gs://<bucket>/deploy-artifacts/<shortId>/. Mirrors cloud-deploy.mjs's
 * uploadArtifact (S3) but via `gcloud storage cp`.
 */
export async function uploadArtifactToGcs({
  bucket, shortId, archivePath, archiveName, checksumPath, manifestPath, execImpl = execFileAsync,
} = {}) {
  if (!bucket) throw new Error('uploadArtifactToGcs requires { bucket }');
  if (!shortId) throw new Error('uploadArtifactToGcs requires { shortId }');
  const prefix = `gs://${bucket}/deploy-artifacts/${shortId}`;

  await execImpl('gcloud', ['storage', 'cp', archivePath, `${prefix}/${archiveName}`]);
  await execImpl('gcloud', ['storage', 'cp', checksumPath, `${prefix}/${archiveName}.sha256`]);
  await execImpl('gcloud', ['storage', 'cp', manifestPath, `${prefix}/manifest.json`]);
  return { gcsPrefix: prefix };
}

/**
 * Waits for the instance to be reachable via IAP SSH (analogous to
 * waitForSsmOnline's SSM-registration wait) — a freshly-created instance's
 * startup-script may still be mid-run (installing Docker etc.) even once
 * Terraform reports it RUNNING, and `gcloud compute ssh` will otherwise
 * either hang or fail with a confusing connection-refused error during that
 * window. Probes with a trivial remote command instead of polling instance
 * metadata, since IAP tunnel readiness itself (not just instance state) is
 * what we actually need to know.
 */
export async function waitForIapSshReady({
  instanceName, zone, project, timeoutMs = 180_000, intervalMs = 5000,
  execImpl = execFileAsync, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt,
} = {}) {
  if (!instanceName) throw new Error('waitForIapSshReady requires { instanceName }');
  const start = now();
  let attempts = 0;
  while (now() - start < timeoutMs) {
    attempts += 1;
    let ok = false;
    try {
      await execImpl('gcloud', [
        'compute', 'ssh', instanceName,
        '--zone', zone,
        '--project', project,
        '--tunnel-through-iap',
        // --quiet suppresses gcloud's interactive prompts — most importantly
        // the "We are going to generate a new SSH keypair..." confirmation
        // gcloud asks on a workstation that has never run `gcloud compute
        // ssh` before. Without it, this readiness probe (and the deploy
        // command below) can hang waiting on stdin, or fail outright under
        // execFile (which supplies no tty/stdin for an interactive prompt),
        // breaking the "wizard stays unattended after the Terraform
        // confirmation" contract on a first-time GCP deploy.
        '--quiet',
        '--command', 'true',
      ], { timeout: 30_000 });
      ok = true;
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
 * Runs the deploy script on the instance over `gcloud compute ssh
 * --tunnel-through-iap`. This is the GCP counterpart to
 * runSsmDeployCommand — same "heredoc the script, chmod +x, run it with
 * env vars, capture output" shape, just over an SSH command instead of SSM
 * RunCommand's send-command/get-command-invocation poll loop (SSH is
 * already synchronous, so no separate polling step is needed here).
 */
export async function runIapSshDeployCommand({
  instanceName, zone, project, script, gcsPrefix, env = {},
  execImpl = execFileAsync, timeout = 480_000,
} = {}) {
  if (!instanceName) throw new Error('runIapSshDeployCommand requires { instanceName }');
  if (!gcsPrefix) throw new Error('runIapSshDeployCommand requires { gcsPrefix }');

  // `sudo` on this (and every stock) Ubuntu image resets the environment to
  // a default set of variables (see `sudo -V` -> "Reset the environment to
  // a default set of variables"), so plain `export FOO=bar` in the SSH
  // user's shell followed by `sudo /tmp/cc-deploy.sh` does NOT propagate
  // those exports to the root process the deploy script actually runs as.
  // With the deploy script's `set -u`, that means it aborts on the very
  // first `$APP_ENV_SECRET`/`$GCP_PROJECT` reference instead of loading the
  // image. `sudo env VAR=val ... cmd` explicitly forwards the named
  // variables into the command's environment regardless of sudo's env-reset
  // policy — pass them there instead of relying on shell-level export +
  // inherited environment.
  const envExports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n');
  const sudoEnvArgs = Object.keys(env).map((k) => `${k}=${shellQuote(env[k] ?? '')}`).join(' ');
  const fullScript = `${envExports}\ncat > /tmp/cc-deploy.sh <<'CC_DEPLOY_SCRIPT_EOF'\n${script}\nCC_DEPLOY_SCRIPT_EOF\nchmod +x /tmp/cc-deploy.sh\nsudo env ${sudoEnvArgs} /tmp/cc-deploy.sh ${shellQuote(gcsPrefix)}`;

  try {
    const { stdout } = await execImpl('gcloud', [
      'compute', 'ssh', instanceName,
      '--zone', zone,
      '--project', project,
      '--tunnel-through-iap',
      '--quiet',
      '--command', fullScript,
    ], { timeout, maxBuffer: 1024 * 1024 * 16 });
    return { success: true, output: stdout || '' };
  } catch (err) {
    return {
      success: false,
      output: err?.stdout || '',
      error: err?.stderr || err?.message || 'gcloud compute ssh failed',
    };
  }
}

/**
 * Single-node GCP deploy: upload the artifact to GCS, wait for the
 * instance's IAP SSH tunnel to be ready, then run the deploy script.
 * Mirrors cloud-deploy.mjs's deploySingleNode (AWS) end to end, minus the
 * ALB registration step (no load balancer in Phase 1/2 — see gcp-cloud.mjs
 * header).
 */
export async function deploySingleNodeGcp({
  instanceName, zone, project, bucket, artifact, appEnvSecretName, appPort, streamingWsPort,
  execImpl = execFileAsync, sleep,
  waitForIapSshReadyImpl = waitForIapSshReady, runIapSshDeployCommandImpl = runIapSshDeployCommand,
  uploadArtifactToGcsImpl = uploadArtifactToGcs,
} = {}) {
  const shortId = Date.now().toString(36);
  const uploadResult = await uploadArtifactToGcsImpl({
    bucket,
    shortId,
    archivePath: artifact.archivePath,
    archiveName: artifact.archiveName,
    checksumPath: artifact.checksumPath,
    manifestPath: artifact.manifestPath,
    execImpl,
  });

  const sshReady = await waitForIapSshReadyImpl({
    instanceName, zone, project, execImpl, ...(sleep ? { sleep } : {}),
  });
  if (!sshReady.ready) {
    throw new Error(`Instance ${instanceName} never became reachable over IAP SSH after ${sshReady.attempts} attempts — check that the startup-script has finished (Docker/gcloud install) and the IAP firewall rule is in place.`);
  }

  const result = await runIapSshDeployCommandImpl({
    instanceName, zone, project, gcsPrefix: uploadResult.gcsPrefix,
    script: REMOTE_DEPLOY_SCRIPT_GCP,
    env: {
      // appEnvSecretName arrives here as the FULLY-QUALIFIED Secret Manager
      // resource name ("projects/<num>/secrets/<id>" — same shape as every
      // other *_secret_name terraform output, see gcp-cloud.mjs's
      // toSecretId doc comment for the full story / the 404 this caused).
      // The remote script's `gcloud secrets versions access --secret=` also
      // wants the bare id, so strip it down the same way here.
      GCP_PROJECT: project, APP_ENV_SECRET: appEnvSecretName?.split('/').pop() ?? appEnvSecretName, APP_PORT: appPort, STREAMING_WS_PORT: streamingWsPort,
    },
    execImpl,
  });
  if (!result.success) {
    throw new Error(`Single-node GCP deploy failed on ${instanceName}: ${result.error || result.output}`.slice(0, 4000));
  }
  return { ...result, gcsPrefix: uploadResult.gcsPrefix };
}

export const REMOTE_SCRIPTS = { single: REMOTE_DEPLOY_SCRIPT_GCP };

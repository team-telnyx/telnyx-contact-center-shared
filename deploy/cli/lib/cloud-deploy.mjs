import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';

const execFileAsync = promisify(execFileCb);

// Implements the unified S3-tarball build+ship+deploy mechanism from plan
// §4a, used identically by single-node and multi-node (HA) AWS targets, and
// reused verbatim by `cc update` for every subsequent deploy. No container
// registry (no ECR, no GHCR) anywhere in this path — see the plan for the
// full rationale (an EC2 instance small enough to be affordable chokes
// trying to build the Next.js production image itself, so the image is
// always built on the OPERATOR's own machine and shipped as a tarball).
//
// Ported from the internal FDE pattern (fde-internals/S3_IMAGE_ARTIFACT_DEPLOYMENT.md,
// build-s3-image-artifact.yml, scripts/deploy-from-s3.sh, deploy-artifact-ssm.sh),
// stripped of every GitHub-Actions/FDE-specific piece and driven directly by
// this CLI instead of a workflow_dispatch.

const REMOTE_DEPLOY_SCRIPT_SINGLE = `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_PREFIX="$1"
APP_DIR=/opt/cc
RELEASE_ID="$(basename "$ARTIFACT_PREFIX")"
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"
CURRENT_IMAGE_FILE="$APP_DIR/current-image"
CONTAINER_NAME=cc-app
mkdir -p "$RELEASE_DIR"
cd "$RELEASE_DIR"

echo "Refreshing /opt/cc/app.env from Secrets Manager"
aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_ENV_SECRET" --query SecretString --output text > "$APP_DIR/app.env"
chmod 0600 "$APP_DIR/app.env"

echo "Downloading artifact from $ARTIFACT_PREFIX"
aws s3 cp "$ARTIFACT_PREFIX/manifest.json" manifest.json --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst" image.tar.zst --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst.sha256" image.tar.zst.sha256 --only-show-errors

echo "Verifying checksum"
sha256sum -c image.tar.zst.sha256

IMAGE_NAME="$(python3 -c "import json;print(json.load(open('manifest.json'))['image'])")"
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

const REMOTE_DEPLOY_SCRIPT_HA = `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_PREFIX="$1"
APP_DIR=/opt/cc
RELEASE_ID="$(basename "$ARTIFACT_PREFIX")"
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"
CURRENT_IMAGE_FILE="$APP_DIR/current-image"
CONTAINER_NAME=cc-app
mkdir -p "$RELEASE_DIR"
cd "$RELEASE_DIR"

echo "Refreshing /opt/cc/app.env from Secrets Manager"
aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_ENV_SECRET" --query SecretString --output text > "$APP_DIR/app.env"
chmod 0600 "$APP_DIR/app.env"

echo "Downloading artifact from $ARTIFACT_PREFIX"
aws s3 cp "$ARTIFACT_PREFIX/manifest.json" manifest.json --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst" image.tar.zst --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst.sha256" image.tar.zst.sha256 --only-show-errors

echo "Verifying checksum"
sha256sum -c image.tar.zst.sha256

IMAGE_NAME="$(python3 -c "import json;print(json.load(open('manifest.json'))['image'])")"
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

/**
 * Builds the production Docker image locally (operator's own machine — see
 * plan §4a rationale) and packages it as a compressed, checksummed,
 * manifest-described tarball ready for S3 upload. Falls back from zstd to
 * gzip when zstd isn't installed locally (preflight recommends zstd but
 * doesn't hard-require it — see plan §4a).
 */
export async function buildAndPackageImage({
  repoRoot,
  imageTag,
  dockerfilePath = 'docker/production/Dockerfile',
  buildArgs = {},
  outDir,
  useZstd = true,
  execImpl = execFileAsync,
  // Docker Desktop's buildx state occasionally throws a transient
  // "permission denied" / similar filesystem error reading its own
  // ~/.docker/buildx/refs/<builder>/<builder> metadata right after the
  // daemon has been busy for a long time (e.g. a 5+ minute `terraform
  // apply` running concurrently) — confirmed in the wild on 2026-07-06:
  // the exact same `docker build` command succeeded immediately when
  // re-run by hand seconds later, with no config/permission change. Retry
  // a small, fixed number of times with a short backoff before giving up,
  // so a one-off Docker Desktop hiccup doesn't abort an otherwise-successful
  // multi-minute cloud deployment.
  buildRetries = 2,
  retryDelayMs = 5000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!repoRoot) throw new Error('buildAndPackageImage requires { repoRoot }');
  if (!imageTag) throw new Error('buildAndPackageImage requires { imageTag }');
  if (!outDir) throw new Error('buildAndPackageImage requires { outDir }');

  const buildArgArgs = Object.entries(buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v ?? ''}`]);
  const dockerBuildArgs = [
    'build', '--platform', 'linux/amd64',
    '--file', dockerfilePath,
    ...buildArgArgs,
    '--tag', imageTag,
    '.',
  ];
  let lastErr;
  for (let attempt = 0; attempt <= buildRetries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential retry.
      await execImpl('docker', dockerBuildArgs, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 64 });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < buildRetries) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential retry.
        await sleep(retryDelayMs);
      }
    }
  }
  if (lastErr) throw lastErr;

  const archiveName = useZstd ? 'image.tar.zst' : 'image.tar.gz';
  const archivePath = `${outDir}/${archiveName}`;
  // `docker save | zstd` piped via shell — kept as a single shell -c
  // invocation (like the internal build-s3-image-artifact.yml does) rather
  // than wiring up two child processes + a Node stream pipe ourselves.
  // `-f` (force) is required on zstd: outDir/archiveName is a FIXED path per
  // run (not unique per imageTag), so a second `cc update`/retry from the
  // same operator machine hits an existing file from the previous run and
  // zstd refuses to overwrite it by default ("already exists; stdin is an
  // input - not proceeding"), aborting the whole deploy on a trivial retry.
  //
  // `set -o pipefail;` is mandatory here — without it, bash's default
  // pipeline exit status is just the LAST command's (zstd/gzip), so a
  // `docker save` that fails (confirmed in the wild 2026-07-09: a `docker
  // save <tag>` right after a `--platform linux/amd64` build occasionally
  // can't find the image it just built — a Docker Desktop containerd-store
  // hiccup, the exact same class of transient issue buildRetries above
  // already works around for `docker build` itself) still lets `zstd`/
  // `gzip` compress its EMPTY stdin into a tiny-but-valid archive (13
  // bytes for zstd). That silently "succeeds" all the way through
  // checksum computation (the checksum matches — it's checksumming the
  // same garbage), upload, and remote download — the failure only
  // surfaces 5-10 minutes later on the VM as an opaque "did not report
  // DEPLOY_OK", with no indication the actual root cause was a build-time
  // failure. `set -o pipefail` makes the whole `bash -c` invocation exit
  // non-zero (and therefore throw here, with the real docker/zstd error
  // message) the moment `docker save` fails.
  const compressCmd = useZstd
    ? `set -o pipefail; docker save ${shellQuote(imageTag)} | zstd -f -T0 -3 -o ${shellQuote(archivePath)}`
    : `set -o pipefail; docker save ${shellQuote(imageTag)} | gzip > ${shellQuote(archivePath)}`;
  await execImpl('bash', ['-c', compressCmd], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 64 });

  // Defense in depth beyond pipefail: even a genuinely zero-byte-input
  // archive is technically a "successful" zstd/gzip run (empty input is
  // valid input), and pipefail only catches a non-zero EXIT CODE from
  // docker save, not every conceivable way to end up with a too-small
  // archive (e.g. a future refactor that drops pipefail again, or a
  // provider script change). A real production Next.js image is always at
  // minimum tens of MB compressed — 1MB is a wildly generous floor that
  // only ever trips on a genuinely empty/near-empty archive, never a real
  // build. Fail loudly HERE, on the operator's own machine with a clear
  // message, instead of a confusing failure on the remote VM many minutes
  // later.
  const archiveStat = await stat(archivePath);
  const MIN_ARCHIVE_BYTES = 1024 * 1024;
  if (archiveStat.size < MIN_ARCHIVE_BYTES) {
    throw new Error(
      `Packaged image archive is suspiciously small (${archiveStat.size} bytes at ${archivePath}) — `
      + `\`docker save ${imageTag}\` likely failed silently (see pipefail note in cloud-deploy.mjs). `
      + 'Re-run the deploy; if it persists, run `docker save '
      + `${imageTag} | wc -c\` by hand to see the real error.`,
    );
  }

  const checksum = await sha256File(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  const checksumLine = `${checksum}  ${archiveName}\n`;
  // Actually write the checksum + manifest to disk — uploadArtifact (and the
  // real `cc up`/`cc update` flow) reads these paths back via `aws s3 cp`,
  // so computing the values without persisting them left the upload step
  // failing on "path does not exist" the first time this ran against a real
  // S3 bucket (unit tests only asserted the in-memory values, never that the
  // files landed on disk, so this went unnoticed until an actual E2E run).
  const manifestPath = `${outDir}/manifest.json`;
  const manifest = {
    app: 'telnyx-contact-center',
    image: imageTag,
    archive: archiveName,
    built_at: new Date().toISOString(),
  };
  await writeFile(checksumPath, checksumLine, 'utf8');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    archivePath,
    archiveName,
    checksumPath,
    checksumLine,
    manifest,
    manifestPath,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function sha256File(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Uploads the built artifact (image tarball + checksum + manifest) to
 * s3://<bucket>/deploy-artifacts/<shortId>/. Both topologies use the exact
 * same plain-`docker run` deploy mechanism now (no compose.yaml/Caddyfile
 * to ship alongside — see cc-compute-single's user_data.sh.tpl for why
 * Caddy-on-instance was removed), so `extraFiles` only exists for forward
 * compatibility / future callers that need to ship something else.
 */
export async function uploadArtifact({
  bucket,
  shortId,
  archivePath,
  archiveName,
  checksumPath,
  manifestPath,
  extraFiles = {},
  writeFileImpl,
  execImpl = execFileAsync,
} = {}) {
  if (!bucket) throw new Error('uploadArtifact requires { bucket }');
  if (!shortId) throw new Error('uploadArtifact requires { shortId }');
  const prefix = `s3://${bucket}/deploy-artifacts/${shortId}`;

  await execImpl('aws', ['s3', 'cp', archivePath, `${prefix}/${archiveName}`, '--only-show-errors']);
  await execImpl('aws', ['s3', 'cp', checksumPath, `${prefix}/${archiveName}.sha256`, '--only-show-errors']);
  await execImpl('aws', ['s3', 'cp', manifestPath, `${prefix}/manifest.json`, '--content-type', 'application/json', '--only-show-errors']);
  for (const [name, path] of Object.entries(extraFiles)) {
    // eslint-disable-next-line no-await-in-loop -- small, fixed set (compose.yaml/Caddyfile), sequential upload is fine and keeps error attribution simple.
    await execImpl('aws', ['s3', 'cp', path, `${prefix}/${name}`, '--only-show-errors']);
  }
  return { s3Prefix: prefix };
}

/**
 * Polls `aws ssm describe-instance-information` until the given instance ID
 * reports PingStatus=Online, or times out. Closes the real gap identified in
 * plan §4h: an EC2 instance can be `running` (Terraform's job is done) 30-90s
 * before the SSM agent has actually registered with the SSM service — the
 * first SendCommand issued before that window closes fails with an opaque
 * "instance not connected" error that looks like a bug rather than a normal
 * boot race.
 */
export async function waitForSsmOnline({
  instanceId,
  region,
  timeoutMs = 180_000,
  intervalMs = 5000,
  execImpl = execFileAsync,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt,
} = {}) {
  if (!instanceId) throw new Error('waitForSsmOnline requires { instanceId }');
  const start = now();
  let attempts = 0;
  while (now() - start < timeoutMs) {
    attempts += 1;
    let status = null;
    try {
      const { stdout } = await execImpl('aws', [
        'ssm', 'describe-instance-information',
        // `region` was previously omitted here, so this always queried the
        // AWS CLI's DEFAULT region (~/.aws/config or AWS_REGION), not the
        // region the deployment actually targets. On any profile whose
        // default region differs from the deployment region (e.g. an
        // internal ops profile pinned to one region, deploying to another),
        // this always returned an empty InstanceInformationList and the
        // whole deploy failed with a false "instance never registered with
        // SSM" error even though the instance was Online the entire time.
        ...(region ? ['--region', region] : []),
        '--filters', `Key=InstanceIds,Values=${instanceId}`,
        '--output', 'json',
      ]);
      const parsed = JSON.parse(stdout);
      status = parsed?.InstanceInformationList?.[0]?.PingStatus || null;
    } catch {
      status = null;
    }
    const elapsedMs = now() - start;
    if (onAttempt) onAttempt({ attempt: attempts, status, elapsedMs });
    if (status === 'Online') return { online: true, attempts, elapsedMs };
    await sleep(intervalMs);
  }
  return { online: false, attempts, elapsedMs: now() - start };
}

/**
 * Sends the deploy command to one instance via SSM RunCommand and polls for
 * completion. Returns { success, output, status }. The remote script itself
 * (REMOTE_DEPLOY_SCRIPT_SINGLE/_HA above) handles checksum verification,
 * image load, container (re)start, local health-wait, and rollback on
 * failure — this function's job is purely "run it over SSM and tell me what
 * happened", mirroring deploy-artifact-ssm.sh's SendCommand/GetCommandInvocation
 * loop.
 */
export async function runSsmDeployCommand({
  instanceId,
  region,
  script,
  s3Prefix,
  env = {},
  timeoutMs = 480_000,
  pollIntervalMs = 5000,
  execImpl = execFileAsync,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!instanceId) throw new Error('runSsmDeployCommand requires { instanceId }');
  if (!s3Prefix) throw new Error('runSsmDeployCommand requires { s3Prefix }');

  const envExports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n');
  const fullScript = `${envExports}\ncat > /tmp/cc-deploy.sh <<'CC_DEPLOY_SCRIPT_EOF'\n${script}\nCC_DEPLOY_SCRIPT_EOF\nchmod +x /tmp/cc-deploy.sh\n/tmp/cc-deploy.sh ${shellQuote(s3Prefix)}`;

  const sendResult = await execImpl('aws', [
    'ssm', 'send-command',
    '--region', region,
    '--instance-ids', instanceId,
    '--document-name', 'AWS-RunShellScript',
    // Full JSON (not the `commands=[...]` shorthand syntax) — the AWS CLI's
    // shorthand parser splits on commas and gets confused by quotes/brackets
    // inside a large multi-line shell script, silently truncating it (this
    // previously produced a mangled remote script: "export -euo: bad
    // variable name" and a missing manifest.json, because the script body
    // got cut off mid-heredoc). Passing a `--parameters` value that starts
    // with `{` makes the CLI treat it as full JSON instead, which handles
    // arbitrary script content safely.
    '--parameters', JSON.stringify({ commands: [fullScript] }),
    '--output', 'json',
  ], { maxBuffer: 1024 * 1024 * 8 });
  const sendParsed = JSON.parse(sendResult.stdout);
  const commandId = sendParsed?.Command?.CommandId;
  if (!commandId) throw new Error('ssm send-command did not return a CommandId');

  const start = now();
  while (now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    await sleep(pollIntervalMs);
    let invocation;
    try {
      // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
      const { stdout } = await execImpl('aws', [
        'ssm', 'get-command-invocation',
        '--region', region,
        '--command-id', commandId,
        '--instance-id', instanceId,
        '--output', 'json',
      ]);
      invocation = JSON.parse(stdout);
    } catch {
      continue; // eslint-disable-line no-continue -- invocation record may not exist yet immediately after send-command.
    }
    const status = invocation.Status;
    if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(status)) {
      return {
        success: status === 'Success',
        status,
        output: invocation.StandardOutputContent || '',
        error: invocation.StandardErrorContent || '',
        commandId,
      };
    }
  }
  return { success: false, status: 'ClientTimeout', output: '', error: `Timed out after ${timeoutMs}ms waiting for SSM command ${commandId}`, commandId };
}

/** ALB helpers for the HA rolling-deploy drain/re-register loop (plan §4a). */
async function targetHealthState({ targetGroupArn, instanceId, port, region, execImpl = execFileAsync }) {
  try {
    const { stdout } = await execImpl('aws', [
      'elbv2', 'describe-target-health',
      '--region', region,
      '--target-group-arn', targetGroupArn,
      '--targets', `Id=${instanceId},Port=${port}`,
      '--output', 'json',
    ]);
    const parsed = JSON.parse(stdout);
    return parsed?.TargetHealthDescriptions?.[0]?.TargetHealth?.State || null;
  } catch {
    return null;
  }
}

async function waitTargetState({
  targetGroupArn, instanceId, port, region, wanted, maxAttempts = 24, intervalMs = 5000,
  execImpl = execFileAsync, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (let i = 0; i < maxAttempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    const state = await targetHealthState({ targetGroupArn, instanceId, port, region, execImpl });
    if (wanted === 'unused' && (!state || state === 'unused')) return true;
    if (state === wanted) return true;
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    await sleep(intervalMs);
  }
  return false;
}

export async function deregisterFromAlb({ appTargetGroupArn, wsTargetGroupArn, instanceId, appPort, wsPort, region, execImpl = execFileAsync, sleep } = {}) {
  await execImpl('aws', ['elbv2', 'deregister-targets', '--region', region, '--target-group-arn', appTargetGroupArn, '--targets', `Id=${instanceId},Port=${appPort}`]);
  await execImpl('aws', ['elbv2', 'deregister-targets', '--region', region, '--target-group-arn', wsTargetGroupArn, '--targets', `Id=${instanceId},Port=${wsPort}`]);
  await waitTargetState({ targetGroupArn: appTargetGroupArn, instanceId, port: appPort, region, wanted: 'unused', execImpl, sleep });
  await waitTargetState({ targetGroupArn: wsTargetGroupArn, instanceId, port: wsPort, region, wanted: 'unused', execImpl, sleep });
}

export async function registerWithAlb({ appTargetGroupArn, wsTargetGroupArn, instanceId, appPort, wsPort, region, execImpl = execFileAsync, sleep } = {}) {
  await execImpl('aws', ['elbv2', 'register-targets', '--region', region, '--target-group-arn', appTargetGroupArn, '--targets', `Id=${instanceId},Port=${appPort}`]);
  await execImpl('aws', ['elbv2', 'register-targets', '--region', region, '--target-group-arn', wsTargetGroupArn, '--targets', `Id=${instanceId},Port=${wsPort}`]);
  const appOk = await waitTargetState({ targetGroupArn: appTargetGroupArn, instanceId, port: appPort, region, wanted: 'healthy', maxAttempts: 40, execImpl, sleep });
  const wsOk = await waitTargetState({ targetGroupArn: wsTargetGroupArn, instanceId, port: wsPort, region, wanted: 'healthy', maxAttempts: 40, execImpl, sleep });
  if (!appOk || !wsOk) throw new Error(`Instance ${instanceId} did not become healthy in ALB target groups after redeploy (app healthy=${appOk}, ws healthy=${wsOk})`);
}

/**
 * Single-node deploy: one SSM RunCommand, no ALB drain (unless alb_enabled,
 * in which case the ALB's health check alone gates traffic — there's only
 * one instance, so there's no drain/re-register dance to do). Waits for SSM
 * registration first (§4h), then runs the deploy script — a plain
 * `docker run` with `--env-file app.env --env-file node.env`, same mechanism
 * as the HA path (see REMOTE_DEPLOY_SCRIPT_HA). No compose.yaml, no Caddy.
 */
export async function deploySingleNode({
  instanceId, region, s3Prefix, appEnvSecretName, appPort, streamingWsPort,
  execImpl = execFileAsync, sleep, waitForSsmOnlineImpl = waitForSsmOnline, runSsmDeployCommandImpl = runSsmDeployCommand,
} = {}) {
  const ssmReady = await waitForSsmOnlineImpl({ instanceId, region, execImpl, sleep });
  if (!ssmReady.online) {
    throw new Error(`Instance ${instanceId} never registered with SSM (PingStatus=Online) after ${ssmReady.attempts} attempts — check that the SSM agent started and the instance role has AmazonSSMManagedInstanceCore attached.`);
  }
  const result = await runSsmDeployCommandImpl({
    instanceId, region, s3Prefix, execImpl,
    script: REMOTE_DEPLOY_SCRIPT_SINGLE,
    env: { AWS_REGION: region, APP_ENV_SECRET: appEnvSecretName, APP_PORT: appPort, STREAMING_WS_PORT: streamingWsPort },
    ...(sleep ? { sleep } : {}),
  });
  if (!result.success) {
    throw new Error(`Single-node deploy failed on ${instanceId} (status ${result.status}): ${result.error || result.output}`.slice(0, 4000));
  }
  return result;
}

/**
 * HA rolling deploy: one node at a time — deregister from both target
 * groups, deploy, wait for local + ALB health, re-register, move to the
 * next node. Ported from fde-internals/scripts/deploy-artifact-ssm.sh's HA
 * path. A failure on any node stops the rollout (does not proceed to the
 * next node) so a bad image can't be rolled out fleet-wide unattended.
 */
export async function deployHaRolling({
  instanceIds, region, s3Prefix, appEnvSecretName, appPort, streamingWsPort,
  appTargetGroupArn, wsTargetGroupArn,
  execImpl = execFileAsync, sleep,
  waitForSsmOnlineImpl = waitForSsmOnline, runSsmDeployCommandImpl = runSsmDeployCommand,
  deregisterFromAlbImpl = deregisterFromAlb, registerWithAlbImpl = registerWithAlb,
} = {}) {
  const results = [];
  for (const instanceId of instanceIds) {
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential: one node at a time, per the plan's rolling-deploy requirement.
    const ssmReady = await waitForSsmOnlineImpl({ instanceId, region, execImpl, sleep });
    if (!ssmReady.online) {
      throw new Error(`Instance ${instanceId} never registered with SSM (PingStatus=Online) after ${ssmReady.attempts} attempts.`);
    }
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential.
    await deregisterFromAlbImpl({ appTargetGroupArn, wsTargetGroupArn, instanceId, appPort, wsPort: streamingWsPort, region, execImpl, sleep });
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential.
    const result = await runSsmDeployCommandImpl({
      instanceId, region, s3Prefix, execImpl,
      script: REMOTE_DEPLOY_SCRIPT_HA,
      env: { AWS_REGION: region, APP_ENV_SECRET: appEnvSecretName, APP_PORT: appPort, STREAMING_WS_PORT: streamingWsPort },
      ...(sleep ? { sleep } : {}),
    });
    if (!result.success) {
      throw new Error(`HA rolling deploy failed on ${instanceId} (status ${result.status}): ${result.error || result.output}`.slice(0, 4000));
    }
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential.
    await registerWithAlbImpl({ appTargetGroupArn, wsTargetGroupArn, instanceId, appPort, wsPort: streamingWsPort, region, execImpl, sleep });
    results.push({ instanceId, ...result });
  }
  return results;
}

export const REMOTE_SCRIPTS = { single: REMOTE_DEPLOY_SCRIPT_SINGLE, ha: REMOTE_DEPLOY_SCRIPT_HA };

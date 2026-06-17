import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/build-s3-image-artifact.yml', 'utf8');
const deployHost = readFileSync('scripts/deploy-from-s3.sh', 'utf8');
const deploySsm = readFileSync('scripts/deploy-artifact-ssm.sh', 'utf8');
const docs = readFileSync('docs/S3_IMAGE_ARTIFACT_DEPLOYMENT.md', 'utf8');
const targetsExample = readFileSync('deploy/targets.example.json', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');

test('S3 artifact workflow builds the production Dockerfile and uploads immutable files', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /docker\/production\/Dockerfile/);
  assert.match(workflow, /docker save/);
  assert.match(workflow, /zstd/);
  assert.match(workflow, /sha256sum image\.tar\.zst/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /aws s3 cp artifact\/image\.tar\.zst/);
  assert.match(workflow, /AWS_ROLE_TO_ASSUME/);
});

test('host deploy script verifies checksums, loads image, health checks, and can rollback', () => {
  assert.match(deployHost, /sha256sum -c image\.tar\.zst\.sha256/);
  assert.match(deployHost, /zstd -dc image\.tar\.zst \| docker load/);
  assert.match(deployHost, /docker rm -f "\$CONTAINER_NAME"/);
  assert.match(deployHost, /curl -fsS --max-time 5 "\$HEALTH_URL"/);
  assert.match(deployHost, /Rolling back to previous image/);
  assert.match(deployHost, /CURRENT_IMAGE_FILE/);
});

test('SSM deploy script supports single-node and HA rolling target groups', () => {
  assert.match(deploySsm, /AWS-RunShellScript/);
  assert.match(deploySsm, /deregister-targets/);
  assert.match(deploySsm, /register-targets/);
  assert.match(deploySsm, /describe-target-health/);
  assert.match(deploySsm, /instance_tag/);
  assert.match(deploySsm, /instance_ids/);
});

test('deploy docs cover build, legacy PROD, HA, direct deploy, and rollback', () => {
  assert.match(docs, /gh workflow run build-s3-image-artifact\.yml/);
  assert.match(docs, /legacy CC PROD/);
  assert.match(docs, /HA deploys one node at a time/);
  assert.match(docs, /Direct host deploy/);
  assert.match(docs, /Rollback/);
  assert.match(docs, /NEXT_PUBLIC_\*/);
});

test('example target config contains HA and legacy target shapes without live IDs', () => {
  const parsed = JSON.parse(targetsExample);
  assert.equal(parsed['cc-ha'].type, 'ha');
  assert.equal(parsed['legacy-cc-prod'].type, 'single-node');
  assert.match(parsed['legacy-cc-prod'].instance_ids[0], /CHANGE_ME/);
  assert.match(parsed['cc-ha'].app_target_group_arn, /CHANGE_ME/);
});

test('docker build context excludes local state and secrets', () => {
  assert.match(dockerignore, /^\.git$/m);
  assert.match(dockerignore, /^\.next$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
});

test('shell scripts are executable after chmod in git worktree', () => {
  assert.ok(statSync('scripts/deploy-from-s3.sh').mode & 0o111);
  assert.ok(statSync('scripts/deploy-artifact-ssm.sh').mode & 0o111);
});

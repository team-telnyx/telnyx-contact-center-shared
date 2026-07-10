import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultState,
  loadState,
  saveState,
  markStep,
  isStepDone,
  nextPendingStep,
  STATE_VERSION,
} from '../lib/state.mjs';

describe('state.mjs', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-state-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaultState has all wizard steps pending and no secrets fields', () => {
    const state = defaultState();
    assert.strictEqual(state.version, STATE_VERSION);
    assert.deepStrictEqual(Object.keys(state.steps), [
      'consent', 'target', 'size', 'region', 'params', 'port-conflict', 'preflight', 'telnyx', 'provision', 'summary',
    ]);
    for (const status of Object.values(state.steps)) {
      assert.strictEqual(status, 'pending');
    }
    // No password/apiKey/secret-VALUE fields anywhere in default shape.
    // Secret *identifiers* (Secrets Manager ARNs/names like dbSecretName,
    // appEnvSecretName — added for the AWS cloud path, Phase 4) are fine to
    // store; they're non-sensitive pointers, not the secret value itself
    // (see cc-database/cc-secrets Terraform modules — the actual values
    // never leave Secrets Manager). Strip known-safe "*SecretName"/
    // "*SecretArn" key names before checking, so this assertion still catches
    // a real regression (someone adding a `dbPassword`/`apiKey` field) without
    // false-positiving on those identifiers.
    const sanitized = JSON.stringify(state).replace(/"[a-zA-Z]*Secret(Name|Arn)":/g, '"__redacted__":');
    assert.strictEqual(sanitized.match(/password|apiKey|secret/i), null);
  });

  it('loadState returns defaultState when no file exists yet', async () => {
    const state = await loadState(dir);
    assert.strictEqual(state.target, null);
    assert.strictEqual(state.steps.consent, 'pending');
  });

  it('saveState then loadState round-trips values', async () => {
    let state = defaultState();
    state.target = 'aws';
    state.region = 'eu-central-1';
    state.deploymentName = 'cc-main';
    await saveState(dir, state);

    const reloaded = await loadState(dir);
    assert.strictEqual(reloaded.target, 'aws');
    assert.strictEqual(reloaded.region, 'eu-central-1');
    assert.strictEqual(reloaded.deploymentName, 'cc-main');
    assert.ok(reloaded.createdAt);
    assert.ok(reloaded.updatedAt);
  });

  it('markStep updates step status and rejects unknown steps', () => {
    let state = defaultState();
    state = markStep(state, 'consent', 'done');
    assert.strictEqual(state.steps.consent, 'done');
    assert.strictEqual(isStepDone(state, 'consent'), true);
    assert.strictEqual(isStepDone(state, 'target'), false);

    assert.throws(() => markStep(state, 'not-a-real-step'), /Unknown wizard step/);
  });

  it('nextPendingStep finds the first incomplete step in order, or null when all done', () => {
    const order = ['consent', 'target', 'size', 'region'];
    let state = defaultState();
    assert.strictEqual(nextPendingStep(state, order), 'consent');

    state = markStep(state, 'consent', 'done');
    assert.strictEqual(nextPendingStep(state, order), 'target');

    state = markStep(state, 'target', 'done');
    state = markStep(state, 'size', 'skipped');
    state = markStep(state, 'region', 'done');
    assert.strictEqual(nextPendingStep(state, order), null);
  });

  it('resume: saved partial progress is picked up on next loadState (simulating interrupted run)', async () => {
    let state = defaultState();
    state.target = 'local';
    state = markStep(state, 'consent', 'done');
    state = markStep(state, 'target', 'done');
    await saveState(dir, state);

    // Simulate a fresh process re-invoking `cc up`
    const resumed = await loadState(dir);
    const order = ['consent', 'target', 'size', 'region', 'params', 'preflight', 'provision', 'telnyx', 'summary'];
    assert.strictEqual(nextPendingStep(resumed, order), 'size');
  });

  it('loadState falls back to defaultState on unknown version instead of crashing', async () => {
    let state = defaultState();
    state.version = 999;
    await saveState(dir, state);
    const reloaded = await loadState(dir);
    assert.strictEqual(reloaded.version, STATE_VERSION);
  });

  it('loadState falls back to defaultState on corrupt JSON', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { statePath } = await import('../lib/state.mjs');
    await writeFile(statePath(dir), '{ not valid json', 'utf8');
    const reloaded = await loadState(dir);
    assert.strictEqual(reloaded.version, STATE_VERSION);
    assert.strictEqual(reloaded.target, null);
  });

  it('deep-merges saved state onto new defaults so newly-added fields survive an old file', async () => {
    let state = defaultState();
    delete state.infra; // simulate an older state file missing a field we added later
    // Target value itself is irrelevant to this test (it only exercises
    // state.mjs's deep-merge/backfill logic) — a fictitious provider name
    // makes that "any string, don't read meaning into it" intent explicit
    // rather than tying the test to whichever real provider strings
    // currently happen to exist.
    state.target = 'some-legacy-target';
    await saveState(dir, state);

    const reloaded = await loadState(dir);
    assert.strictEqual(reloaded.target, 'some-legacy-target');
    assert.ok(reloaded.infra, 'missing nested object should be backfilled from defaults');
    assert.strictEqual(reloaded.infra.terraformDir, null);
  });

  it('defaultState includes AWS cloud infra fields (Phase 4) with safe defaults', () => {
    const state = defaultState();
    assert.strictEqual(state.infra.awsTopology, null);
    assert.deepStrictEqual(state.infra.instanceIds, []);
    assert.strictEqual(state.infra.albDnsName, null);
    assert.deepStrictEqual(state.infra.acm, { certificateArn: null, issued: false, createdByWizard: false });
  });

  it('defaultState includes Portainer agent fields (opt-in, off by default)', () => {
    const state = defaultState();
    assert.strictEqual(state.portainer.agentEnabled, false);
    assert.strictEqual(state.portainer.agentPort, 9001);
    assert.deepStrictEqual(state.portainer.serverCidrs, []);
  });

  it('round-trips AWS infra + portainer fields through save/load', async () => {
    let state = defaultState();
    state.target = 'aws';
    state.infra.awsTopology = 'ha';
    state.infra.instanceIds = ['i-abc', 'i-def'];
    state.infra.albDnsName = 'cc-main-alb-123.us-east-2.elb.amazonaws.com';
    state.infra.acm.certificateArn = 'arn:aws:acm:us-east-2:123:certificate/abc';
    state.infra.acm.issued = true;
    state.portainer.agentEnabled = true;
    state.portainer.serverCidrs = ['203.0.113.5/32'];
    await saveState(dir, state);

    const reloaded = await loadState(dir);
    assert.strictEqual(reloaded.infra.awsTopology, 'ha');
    assert.deepStrictEqual(reloaded.infra.instanceIds, ['i-abc', 'i-def']);
    assert.strictEqual(reloaded.infra.acm.issued, true);
    assert.strictEqual(reloaded.portainer.agentEnabled, true);
    assert.deepStrictEqual(reloaded.portainer.serverCidrs, ['203.0.113.5/32']);
  });
});

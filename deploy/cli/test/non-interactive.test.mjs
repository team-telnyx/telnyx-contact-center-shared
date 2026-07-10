import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nonInteractiveIo, runWizard } from '../lib/wizard.mjs';

describe('nonInteractiveIo', () => {
  it('answers target/size selects from the answers object', async () => {
    const io = nonInteractiveIo({ target: 'local', size: 'small' }, { log: () => {} });
    assert.strictEqual(await io.select('Where do you want to deploy Contact Center?', []), 'local');
    assert.strictEqual(await io.select('Expected scale (concurrent agents using the app)?', []), 'small');
  });

  it('throws when target is missing (unattended run must not guess)', async () => {
    const io = nonInteractiveIo({}, { log: () => {} });
    await assert.rejects(() => io.select('Where do you want to deploy Contact Center?', []), /requires "target"/);
  });

  it('throws on an unmapped select prompt rather than silently picking an option', async () => {
    const io = nonInteractiveIo({ target: 'local' }, { log: () => {} });
    await assert.rejects(() => io.select('Some future prompt?', []), /no answer mapped/);
  });

  it('ask() falls back to the provided default when answers has no match', async () => {
    const io = nonInteractiveIo({}, { log: () => {} });
    const value = await io.ask('Owner admin email', 'default@example.com');
    assert.strictEqual(value, 'default@example.com');
  });

  it('askSecret() throws for telnyx api key when missing (never silently blank a required secret)', async () => {
    const io = nonInteractiveIo({}, { log: () => {} });
    await assert.rejects(() => io.askSecret('Telnyx API key'), /no answer mapped/);
  });

  it('askSecret() allows an explicitly blank owner password (auto-generate path)', async () => {
    const io = nonInteractiveIo({}, { log: () => {} });
    const value = await io.askSecret('Owner admin password (leave blank to auto-generate)');
    assert.strictEqual(value, '');
  });

  it('confirm() defaults to true (accept consent / continue past warnings) unless explicitly overridden', async () => {
    const io = nonInteractiveIo({}, { log: () => {} });
    assert.strictEqual(await io.confirm('Continue?'), true);
    const declineIo = nonInteractiveIo({ consent: false }, { log: () => {} });
    assert.strictEqual(await declineIo.confirm('Continue?'), false);
  });

  it('maps the GCP region select prompt (regression: Codex review on PR #1188 — GCP target was unusable non-interactively)', async () => {
    const io = nonInteractiveIo({ target: 'gcp', region: 'europe-west3' }, { log: () => {} });
    assert.strictEqual(await io.select('GCP region for this deployment?', []), 'europe-west3');
    // Falls back to a sane default when the answers file omits region.
    const defaultIo2 = nonInteractiveIo({ target: 'gcp' }, { log: () => {} });
    assert.strictEqual(await defaultIo2.select('GCP region for this deployment?', []), 'us-central1');
  });

  it('maps the Azure region select prompt (Azure gained a region menu alongside AWS/GCP; non-interactive mode trusts the answers file directly, no menu/validation)', async () => {
    const io = nonInteractiveIo({ target: 'azure', region: 'eastus2' }, { log: () => {} });
    assert.strictEqual(await io.select('Azure region for this deployment?', []), 'eastus2');
    // Falls back to a sane default when the answers file omits region.
    const defaultIo2 = nonInteractiveIo({ target: 'azure' }, { log: () => {} });
    assert.strictEqual(await defaultIo2.select('Azure region for this deployment?', []), 'westeurope');
  });

  it('maps the GCP project id and zone ask prompts (regression: Codex review on PR #1188)', async () => {
    const io = nonInteractiveIo({ gcpProjectId: 'my-gcp-project', gcpZone: 'us-central1-b' }, { log: () => {} });
    assert.strictEqual(
      await io.ask('GCP project id (must already exist — the wizard does not create projects)', ''),
      'my-gcp-project',
    );
    // The zone prompt's question text itself contains "region" ("GCP zone
    // within <region> for the Compute Engine instance") — matchAsk must
    // check the more specific 'gcp zone' pattern first so this doesn't
    // fall through to the generic 'region' match instead.
    assert.strictEqual(
      await io.ask('GCP zone within europe-west3 for the Compute Engine instance', ''),
      'us-central1-b',
    );
  });
});

describe('runWizard with --non-interactive answers (Task 1.4)', () => {
  let repoRoot;
  let deployDir;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'cc-noninteractive-'));
    deployDir = join(repoRoot, 'deploy');
    await mkdir(deployDir, { recursive: true });
    await mkdir(join(repoRoot, 'docker', 'production'), { recursive: true });
    await writeFile(
      join(repoRoot, 'docker', 'production', 'sample.env'),
      ['TELNYX_API_KEY=', 'DEFAULT_OWNER_EMAIL=', 'DEFAULT_OWNER_PASSWORD=', 'NEXT_PUBLIC_BASE_URL='].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('runs the full Local flow end to end with zero prompts', async () => {
    const answers = {
      target: 'local',
      deploymentName: 'cc-ci',
      domain: '',
      ownerEmail: 'ci@example.com',
      ownerPassword: '',
      telnyxApiKey: 'KEY_CI_VALID',
    };
    const io = nonInteractiveIo(answers, { log: () => {} });
    const execImpl = async (cmd, args) => {
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      return { stdout: '' };
    };
    // Minimal Telnyx mock returning ok-only responses. We intentionally skip
    // the number purchase here (buyNumber=false) so unattended CI never tries
    // to charge a real card; a separate unattended flow with pickedNumber set
    // is covered by the orchestrator's dedicated test suite.
    let counter = 0;
    const nextId = (p) => `${p}-${++counter}`;
    function json(s, p) { return { ok: true, status: s, json: async () => p, text: async () => JSON.stringify(p) }; }
    const telnyxState = { voiceApps: [], outboundProfiles: [], credentialConnections: [], telephonyCredentials: [], phoneNumbers: [] };
    const telnyxFetch = async (url, init = {}) => {
      const m = init.method || 'GET';
      const u = new URL(url);
      if (m === 'GET' && u.pathname === '/v2/call_control_applications') return json(200, { data: telnyxState.voiceApps });
      if (m === 'POST' && u.pathname === '/v2/call_control_applications') {
        const body = JSON.parse(init.body);
        const c = { id: nextId('app'), application_name: body.application_name };
        telnyxState.voiceApps.push(c); return json(200, { data: c });
      }
      if (m === 'PATCH' && u.pathname.startsWith('/v2/call_control_applications/')) return json(200, { data: telnyxState.voiceApps[0] });
      if (m === 'GET' && u.pathname === '/v2/outbound_voice_profiles') return json(200, { data: telnyxState.outboundProfiles });
      if (m === 'POST' && u.pathname === '/v2/outbound_voice_profiles') {
        const body = JSON.parse(init.body);
        const c = { id: nextId('ovp'), name: body.name };
        telnyxState.outboundProfiles.push(c); return json(200, { data: c });
      }
      if (m === 'GET' && u.pathname === '/v2/credential_connections') return json(200, { data: telnyxState.credentialConnections });
      if (m === 'POST' && u.pathname === '/v2/credential_connections') {
        const body = JSON.parse(init.body);
        const c = { id: nextId('conn'), connection_name: body.connection_name };
        telnyxState.credentialConnections.push(c); return json(200, { data: c });
      }
      if (m === 'PATCH' && u.pathname.startsWith('/v2/credential_connections/')) return json(200, { data: telnyxState.credentialConnections[0] });
      if (m === 'GET' && u.pathname === '/v2/telephony_credentials') return json(200, { data: telnyxState.telephonyCredentials });
      if (m === 'POST' && u.pathname === '/v2/telephony_credentials') {
        const body = JSON.parse(init.body);
        const c = { id: nextId('cred'), ...body, user_id: nextId('user'), sip_username: `sip${nextId('user')}` };
        telnyxState.telephonyCredentials.push(c); return json(200, { data: c });
      }
      if (m === 'GET' && u.pathname === '/v2/balance') {
        // Preflight's mandatory balance gate (checkTelnyxBalance) needs a
        // funded-looking account, otherwise it fails before the wizard even
        // reaches the provision/telnyx steps this test actually exercises.
        return json(200, { data: { balance: '100.00', credit_limit: '0.00', available_credit: '100.00', pending: '0.00' } });
      }
      return json(200, { data: [] });
    };
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyxFetch(url, init);
      // Preflight ping / health probe — never used by Telnyx code path.
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };

    const result = await runWizard({
      deployDir,
      sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
      io,
      execImpl,
      fetchImpl,
      ports: [59911, 59912],
      buyNumber: false,
    });

    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.state.deploymentName, 'cc-ci');
    assert.strictEqual(result.state.steps.summary, 'done');
    assert.strictEqual(result.state.steps.telnyx, 'done');
    assert.ok(result.state.telnyx.voiceAppId, 'voice app id should be populated even in non-interactive mode');
  });
});

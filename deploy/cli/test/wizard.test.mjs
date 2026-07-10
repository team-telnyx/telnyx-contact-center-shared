import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import forge from 'node-forge';
import {
  runIntroStep,
  runTargetStep,
  runSizeStep,
  runRegionStep,
  runParamsStep,
  runPreflightStep,
  runPortConflictStep,
  runLocalProvisionStep,
  runLocalTunnelStep,
  runAwsDnsStep,
  runWizard,
  ORDERED_STEPS,
} from '../lib/wizard.mjs';
import { defaultState, loadState, saveState } from '../lib/state.mjs';

// Bind-and-close helper used by the runLocalProvisionStep + runPreflightStep
// tests below to grab a port that's guaranteed free at test time. Module-scoped
// so it's shared across both describe blocks (they're adjacent).
async function findFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Shared Telnyx mock used by all runWizard tests — needed because Step 7 now
// hits the Telnyx API even on the "no number purchased" path (Voice App + OVP
// + WebRTC SIP conn + owner credential). Kept minimal: every endpoint just
// returns canned data; no persistence across calls.
function makeTelnyxMock({ numberCost = '1.00' } = {}) {
  const state = {
    voiceApps: [],
    outboundProfiles: [],
    credentialConnections: [],
    telephonyCredentials: [],
    phoneNumbers: [],
  };
  // Per-resource counters so the test can assert exact ids like "app-1"
  // without coupling to the order in which the bootstrap module creates
  // resources.
  const counters = { app: 0, ovp: 0, conn: 0, cred: 0, user: 0, num: 0, pn: 0, order: 0 };
  const nextId = (prefix) => `${prefix}-${++counters[prefix]}`;
  function json(status, payload) {
    return { ok: true, status, json: async () => payload, text: async () => JSON.stringify(payload) };
  }
  return {
    state,
    counters,
    fetchImpl: async (url, init = {}) => {
      const method = init.method || 'GET';
      const u = new URL(url);
      if (method === 'GET' && u.pathname === '/v2/call_control_applications') return json(200, { data: state.voiceApps });
      if (method === 'POST' && u.pathname === '/v2/call_control_applications') {
        const body = JSON.parse(init.body);
        const created = { id: nextId('app'), application_name: body.application_name, webhook_event_url: body.webhook_event_url };
        state.voiceApps.push(created);
        return json(200, { data: created });
      }
      if (method === 'PATCH' && u.pathname.startsWith('/v2/call_control_applications/')) {
        const id = u.pathname.split('/').pop();
        const idx = state.voiceApps.findIndex((a) => a.id === id);
        if (idx >= 0) Object.assign(state.voiceApps[idx], JSON.parse(init.body));
        return json(200, { data: state.voiceApps[idx] });
      }
      if (method === 'GET' && u.pathname === '/v2/outbound_voice_profiles') return json(200, { data: state.outboundProfiles });
      if (method === 'POST' && u.pathname === '/v2/outbound_voice_profiles') {
        const body = JSON.parse(init.body);
        const created = { id: nextId('ovp'), name: body.name, traffic_type: body.traffic_type };
        state.outboundProfiles.push(created);
        return json(200, { data: created });
      }
      if (method === 'GET' && u.pathname === '/v2/credential_connections') return json(200, { data: state.credentialConnections });
      if (method === 'POST' && u.pathname === '/v2/credential_connections') {
        const body = JSON.parse(init.body);
        const created = { id: nextId('conn'), connection_name: body.connection_name, webrtc: body.webrtc };
        state.credentialConnections.push(created);
        return json(200, { data: created });
      }
      if (method === 'PATCH' && u.pathname.startsWith('/v2/credential_connections/')) {
        const id = u.pathname.split('/').pop();
        const idx = state.credentialConnections.findIndex((c) => c.id === id);
        if (idx >= 0) Object.assign(state.credentialConnections[idx], JSON.parse(init.body));
        return json(200, { data: state.credentialConnections[idx] });
      }
      if (method === 'GET' && u.pathname === '/v2/telephony_credentials') return json(200, { data: state.telephonyCredentials });
      if (method === 'POST' && u.pathname === '/v2/telephony_credentials') {
        const body = JSON.parse(init.body);
        const created = { id: nextId('cred'), ...body, user_id: nextId('user'), sip_username: `sip${nextId('user')}` };
        state.telephonyCredentials.push(created);
        return json(200, { data: created });
      }
      if (method === 'GET' && u.pathname === '/v2/available_phone_numbers') {
        return json(200, { data: [{ id: nextId('num'), phone_number: '+14155550134', cost_information: { monthly_cost: numberCost } }] });
      }
      if (method === 'GET' && u.pathname === '/v2/balance') {
        return json(200, { data: { balance: '100.00', credit_limit: '0.00', available_credit: '100.00', pending: '0.00' } });
      }
      if (method === 'GET' && u.pathname === '/v2/phone_numbers') return json(200, { data: state.phoneNumbers });
      if (method === 'POST' && u.pathname === '/v2/number_orders') {
          const orderId = `order-${state.phoneNumbers.length + 1}`;
          const phoneNumberId = `pn-${state.phoneNumbers.length + 1}`;
          state.phoneNumbers.push({ id: phoneNumberId, phone_number: '+14155550134', connection_id: null });
          return json(200, { data: { id: orderId, phone_numbers: [{ id: phoneNumberId, phone_number: '+14155550134' }] } });
        }
      if (method === 'PATCH' && u.pathname.startsWith('/v2/phone_numbers/')) {
        const id = u.pathname.split('/').pop();
        const idx = state.phoneNumbers.findIndex((p) => p.id === id);
        if (idx >= 0) state.phoneNumbers[idx].connection_id = JSON.parse(init.body).connection_id;
        return json(200, { data: state.phoneNumbers[idx] });
      }
      return json(404, { errors: [{ detail: `wizard-test mock: no default for ${method} ${u.pathname}` }] });
    },
  };
}

// Fake `io`: scripted answers instead of a real TTY, plus a log sink so
// assertions can check what was printed without needing a terminal.
function fakeIo({ confirms = [], selects = [], asks = [], secrets = [] } = {}) {
  const logs = [];
  let ci = 0; let si = 0; let ai = 0; let sei = 0;
  return {
    io: {
      header: (title) => logs.push(`HEADER: ${title}`),
      log: (msg = '') => logs.push(String(msg)),
      confirm: async () => confirms[ci++],
      select: async () => selects[si++],
      ask: async (_q, def) => (asks[ai] !== undefined ? asks[ai++] : def),
      askSecret: async () => secrets[sei++] ?? '',
      checkLine: (status, label, detail) => logs.push(`${status}: ${label} ${detail || ''}`.trim()),
      step: (label) => {
        logs.push(`STEP: ${label}`);
        return {
          succeed: (m) => logs.push(`OK: ${m}`),
          fail: (m) => logs.push(`FAIL: ${m}`),
          warn: (m) => logs.push(`WARN: ${m}`),
          info: (m) => logs.push(`INFO: ${m}`),
        };
      },
    },
    logs,
  };
}

describe('wizard.mjs — step units', () => {
  it('runIntroStep: declining consent aborts and marks the step skipped', async () => {
    const { io } = fakeIo({ confirms: [false] });
    const result = await runIntroStep({ state: defaultState(), io });
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.state.steps.consent, 'skipped');
  });

  it('runIntroStep: accepting consent records acceptedAt and marks done', async () => {
    const { io } = fakeIo({ confirms: [true] });
    const result = await runIntroStep({ state: defaultState(), io });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.state.steps.consent, 'done');
    assert.ok(result.state.consent.acceptedAt);
  });

  it('runTargetStep: records the selected target', async () => {
    const { io } = fakeIo({ selects: ['aws'] });
    const result = await runTargetStep({ state: defaultState(), io });
    assert.strictEqual(result.state.target, 'aws');
    assert.strictEqual(result.state.steps.target, 'done');
  });

  it('runSizeStep: Local target skips the sizing menu entirely (always small/1 node)', async () => {
    const { io } = fakeIo({ selects: ['medium'] }); // should not be consulted
    const state = { ...defaultState(), target: 'local' };
    const result = await runSizeStep({ state, io });
    assert.strictEqual(result.state.size, 'small');
    assert.strictEqual(result.state.nodes, 1);
    assert.strictEqual(result.state.steps.size, 'skipped');
  });

  it('runSizeStep: cloud target large + non-AWS provider falls back to single node with a warning', async () => {
    const { io, logs } = fakeIo({ selects: ['large'] });
    const state = { ...defaultState(), target: 'gcp' };
    const result = await runSizeStep({ state, io });
    assert.strictEqual(result.state.nodes, 1);
    assert.ok(logs.some((l) => l.includes('HA multi-node is currently available for AWS only')));
  });

  it('runSizeStep: cloud target large on AWS keeps 3 nodes', async () => {
    const { io } = fakeIo({ selects: ['large'] });
    const state = { ...defaultState(), target: 'aws' };
    const result = await runSizeStep({ state, io });
    assert.strictEqual(result.state.nodes, 3);
  });

  it('runRegionStep: Local target skips region entirely', async () => {
    const { io } = fakeIo({ asks: ['should-not-be-used'] });
    const state = { ...defaultState(), target: 'local' };
    const result = await runRegionStep({ state, io });
    assert.strictEqual(result.state.region, null);
    assert.strictEqual(result.state.steps.region, 'skipped');
  });

  it('runRegionStep: AWS target lets the user pick from a region menu and auto-resolves the SSH CIDR (no prompt)', async () => {
    const { io } = fakeIo({ selects: ['eu-central-1'] });
    const state = { ...defaultState(), target: 'aws' };
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        prefixes: [
          { service: 'EC2_INSTANCE_CONNECT', region: 'eu-central-1', ip_prefix: '3.120.181.40/29' },
          { service: 'EC2_INSTANCE_CONNECT', region: 'us-east-1', ip_prefix: '18.206.107.24/29' },
        ],
      }),
    });
    const result = await runRegionStep({ state, io, fetchImpl });
    assert.strictEqual(result.state.region, 'eu-central-1');
    assert.strictEqual(result.state.steps.region, 'done');
    assert.deepStrictEqual(result.state.awsAdminSshCidrs, ['3.120.181.40/29']);
  });

  it('runRegionStep: AWS target "Other" choice prompts for a free-typed region code', async () => {
    const { io } = fakeIo({ selects: ['__other__'], asks: ['ap-southeast-1'] });
    const state = { ...defaultState(), target: 'aws' };
    const fetchImpl = async () => ({ ok: false, status: 500 });
    const result = await runRegionStep({ state, io, fetchImpl });
    assert.strictEqual(result.state.region, 'ap-southeast-1');
  });

  it('runRegionStep: falls back to the built-in CIDR snapshot when the live fetch fails', async () => {
    const { io } = fakeIo({ selects: ['us-west-2'] });
    const state = { ...defaultState(), target: 'aws' };
    const fetchImpl = async () => { throw new Error('network down'); };
    const result = await runRegionStep({ state, io, fetchImpl });
    assert.strictEqual(result.state.region, 'us-west-2');
    assert.deepStrictEqual(result.state.awsAdminSshCidrs, ['18.237.140.160/29']);
  });

  it('runRegionStep: Azure target loops on a blank subscription id, then lets the user pick from the popular-region menu', async () => {
    const { io } = fakeIo({ asks: ['', 'sub-123'], selects: ['westeurope'] });
    const state = { ...defaultState(), target: 'azure' };
    const result = await runRegionStep({ state, io });
    assert.strictEqual(result.state.region, 'westeurope');
    assert.strictEqual(result.state.infra.azureSubscriptionId, 'sub-123');
    assert.strictEqual(result.state.steps.region, 'done');
  });

  it('runRegionStep: Azure target "Other" choice prompts for a free-typed region, validated against the live/fallback region set (regression: user request — Azure had no region menu unlike AWS/GCP)', async () => {
    const { io } = fakeIo({ asks: ['sub-123', 'eastus2'], selects: ['__other__'] });
    const state = { ...defaultState(), target: 'azure' };
    const execImpl = async () => { throw new Error('az not installed in this test'); };
    const result = await runRegionStep({ state, io, execImpl });
    assert.strictEqual(result.state.region, 'eastus2');
    assert.strictEqual(result.state.infra.azureSubscriptionId, 'sub-123');
  });

  it('runRegionStep: Azure "Other" region re-prompts on a typo/invalid region name instead of silently accepting it', async () => {
    const { io, logs } = fakeIo({ asks: ['sub-123', 'not-a-real-region', 'eastus'], selects: ['__other__'] });
    const state = { ...defaultState(), target: 'azure' };
    const execImpl = async () => { throw new Error('az not installed in this test'); };
    const result = await runRegionStep({ state, io, execImpl });
    assert.strictEqual(result.state.region, 'eastus');
    assert.ok(logs.some((l) => l.includes('not a recognized Azure region')));
  });

  it('runRegionStep: Azure "Other" region validates against the LIVE az account list-locations set when available', async () => {
    const { io } = fakeIo({ asks: ['sub-123', 'brandnewregion'], selects: ['__other__'] });
    const state = { ...defaultState(), target: 'azure' };
    const execImpl = async (cmd, args) => {
      assert.strictEqual(cmd, 'az');
      assert.deepStrictEqual(args.slice(0, 2), ['account', 'list-locations']);
      return { stdout: JSON.stringify(['eastus', 'westeurope', 'brandnewregion']) };
    };
    const result = await runRegionStep({ state, io, execImpl });
    assert.strictEqual(result.state.region, 'brandnewregion');
  });

  it('runRegionStep: GCP target loops on a blank project id instead of accepting it (regression: Codex review on PR #1188)', async () => {
    // The wizard must not silently record an empty project id — that
    // would sail through checkGcpCloudPreflight (its project probe is
    // gated on `if (projectId)`) and only surface as a Terraform
    // "project_id is required" failure AFTER Telnyx bootstrap has already
    // created live resources. First ask() answer is blank (Enter), second
    // is the real project id — the step must re-prompt instead of moving on.
    const { io, logs } = fakeIo({ asks: ['', 'my-real-project', 'us-central1-a'], selects: ['us-central1'] });
    const state = { ...defaultState(), target: 'gcp' };
    const result = await runRegionStep({ state, io });
    assert.strictEqual(result.state.infra.gcpProjectId, 'my-real-project');
    assert.ok(logs.some((l) => l.includes('GCP project id is required')), 'expected a warning about the blank project id');
  });

  it('runParamsStep: slugifies deployment name and derives baseUrl from domain', async () => {
    const { io } = fakeIo({
      asks: ['My CC Deployment!', 'cc.example.com'],
      secrets: ['leszek@example.com'.length ? '' : '', 'KEY123'], // ownerPassword blank, telnyxApiKey set
    });
    // fix ask order: name, domain ; then plain ask for email is separate call via ask? -> email uses ask too
    const state = defaultState();
    const result = await runParamsStep({ state, io: {
      ...io,
      ask: (() => {
        const values = ['My CC Deployment!', 'cc.example.com', 'owner@example.com'];
        let i = 0;
        return async () => values[i++];
      })(),
      askSecret: (() => {
        const values = ['', 'KEY123'];
        let i = 0;
        return async () => values[i++];
      })(),
    } });
    assert.strictEqual(result.state.deploymentName, 'my-cc-deployment');
    assert.strictEqual(result.answers.baseUrl, 'https://cc.example.com');
    assert.strictEqual(result.answers.telnyxApiKey, 'KEY123');
    assert.strictEqual(result.state.steps.params, 'done');
  });

  it('runParamsStep: local target with no domain falls back to http://localhost:3000', async () => {
    const values = ['cc-main', '', 'owner@example.com'];
    let i = 0;
    const state = { ...defaultState(), target: 'local' };
    const result = await runParamsStep({
      state,
      io: {
        ask: async () => values[i++],
        askSecret: async () => '',
        log: () => {},
      },
    });
    assert.strictEqual(result.answers.baseUrl, 'http://localhost:3000');
  });

  it('runParamsStep: domain pasted with a full https:// URL is not double-prefixed (regression)', async () => {
    // Real-world bug: user pasted the full URL "https://api.demo.example.com"
    // at the "Public domain" prompt. Naively prepending https:// on top used
    // to produce "https://https://api.demo.example.com", which then made the
    // health-check step hang forever waiting on an unreachable URL.
    const values = ['cc-main', 'https://api.demo.example.com', 'owner@example.com'];
    let i = 0;
    const state = defaultState();
    const result = await runParamsStep({
      state,
      io: {
        ask: async () => values[i++],
        askSecret: async () => '',
        log: () => {},
      },
    });
    assert.strictEqual(result.answers.baseUrl, 'https://api.demo.example.com');
  });

  it('runParamsStep: domain pasted with trailing slash and http:// scheme is preserved, not re-prefixed (regression)', async () => {
    const values = ['cc-main', 'http://api.demo.example.com/', 'owner@example.com'];
    let i = 0;
    const state = defaultState();
    const result = await runParamsStep({
      state,
      io: {
        ask: async () => values[i++],
        askSecret: async () => '',
        log: () => {},
      },
    });
    assert.strictEqual(result.answers.baseUrl, 'http://api.demo.example.com');
  });

  it('never persists secrets (ownerPassword/telnyxApiKey) into wizard state', async () => {
    const values = ['cc-main', 'cc.example.com', 'owner@example.com'];
    let i = 0;
    const state = defaultState();
    const result = await runParamsStep({
      state,
      io: {
        ask: async () => values[i++],
        askSecret: async () => 'super-secret-value',
        log: () => {},
      },
    });
    const stateJson = JSON.stringify(result.state);
    assert.ok(!stateJson.includes('super-secret-value'), 'secret leaked into persisted state');
  });

  it('runParamsStep: AWS target has no Cloudflare-tunnel fallback — loops until a non-empty domain is given', async () => {
    // First domain answer is blank (user hit Enter out of habit from the
    // Local-target flow) — the AWS branch must re-prompt instead of silently
    // falling through to a tunnel that doesn't exist for cloud targets.
    const askValues = ['cc-main', '', 'cc.example.com', 'owner@example.com'];
    let ai = 0;
    const logs = [];
    const state = { ...defaultState(), target: 'aws' };
    const result = await runParamsStep({
      state,
      io: {
        ask: async () => askValues[ai++],
        askSecret: async () => '',
        log: (m) => logs.push(m),
      },
    });
    assert.strictEqual(result.answers.domain, 'cc.example.com');
    assert.strictEqual(result.answers.baseUrl, 'https://cc.example.com');
    assert.ok(logs.some((l) => /require a public domain/i.test(l)), 'expected a warning about the missing domain on the blank attempt');
  });

  it('runParamsStep: AWS target never mentions a Cloudflare tunnel in its prompt', async () => {
    const askValues = ['cc-main', 'cc.example.com', 'owner@example.com'];
    let ai = 0;
    let promptText = '';
    const state = { ...defaultState(), target: 'aws' };
    await runParamsStep({
      state,
      io: {
        ask: async (question) => { if (question.toLowerCase().includes('domain')) promptText = question; return askValues[ai++]; },
        askSecret: async () => '',
        log: () => {},
      },
    });
    assert.doesNotMatch(promptText, /cloudflare/i);
    assert.doesNotMatch(promptText, /tunnel/i);
  });
});

describe('wizard.mjs — runAwsDnsStep', () => {
  function makeIo({ confirms = {}, selects = {} } = {}) {
    const logs = [];
    return {
      io: {
        log: (m = '') => logs.push(String(m)),
        confirm: async (question) => {
          for (const [pattern, value] of Object.entries(confirms)) {
            if (new RegExp(pattern, 'i').test(question)) return value;
          }
          return true;
        },
        select: async (title, options) => {
          for (const [pattern, value] of Object.entries(selects)) {
            if (new RegExp(pattern, 'i').test(title)) return value;
          }
          return options[0]?.value;
        },
      },
      logs,
    };
  }

  it('multi-node/HA: ALB is mandatory — never asks, always proceeds to Route53/ACM lookup', async () => {
    const { io } = makeIo();
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', infra: { awsTopology: 'ha' } };
    let askedAboutAlb = false;
    io.confirm = async (question) => {
      if (/set up https/i.test(question)) askedAboutAlb = true;
      return true;
    };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => null;
    const listCertificatesForDomainImpl = async () => [];
    const findCertificateInOtherRegionsImpl = async () => null;
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl, findCertificateInOtherRegionsImpl,
    });
    assert.strictEqual(askedAboutAlb, false, 'HA must not ask the opt-in ALB question — it is mandatory');
    assert.strictEqual(result.state.infra.albEnabled, true);
  });

  it('single-node: declining the ALB offer disables it and marks dnsManaged=false (operator handles their own DNS/TLS)', async () => {
    const { io } = makeIo({ confirms: { 'set up https': false } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', infra: { awsTopology: 'single' } };
    const result = await runAwsDnsStep({ state, io });
    assert.strictEqual(result.state.infra.albEnabled, false);
    assert.strictEqual(result.state.infra.dnsManaged, false);
    assert.strictEqual(result.state.infra.dnsZoneId, null);
  });

  it('single-node: ALB accepted + Route53 zone found + no existing record -> albEnabled/dnsManaged both true, zone id recorded', async () => {
    const { io } = makeIo({ confirms: { 'set up https': true } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', region: 'us-east-2', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => null;
    const listCertificatesForDomainImpl = async () => [];
    const findCertificateInOtherRegionsImpl = async () => null;
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl, findCertificateInOtherRegionsImpl,
    });
    assert.strictEqual(result.state.infra.albEnabled, true);
    assert.strictEqual(result.state.infra.dnsManaged, true);
    assert.strictEqual(result.state.infra.dnsZoneId, 'Z1');
  });

  it('single-node: ALB accepted, zone found, existing record present, user declines overwrite -> dnsManaged=false but ALB stays enabled', async () => {
    const { io } = makeIo({ confirms: { 'set up https': true, 'overwrite it': false } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => ({ type: 'A', values: ['9.9.9.9'] });
    const listCertificatesForDomainImpl = async () => [];
    const findCertificateInOtherRegionsImpl = async () => null;
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl, findCertificateInOtherRegionsImpl,
    });
    assert.strictEqual(result.state.infra.albEnabled, true);
    assert.strictEqual(result.state.infra.dnsManaged, false);
  });

  it('single-node: ALB accepted, zone found, existing record present, user confirms overwrite -> dnsManaged stays true', async () => {
    const { io } = makeIo({ confirms: { 'set up https': true, 'overwrite it': true } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => ({ type: 'A', values: ['9.9.9.9'] });
    const listCertificatesForDomainImpl = async () => [];
    const findCertificateInOtherRegionsImpl = async () => null;
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl, findCertificateInOtherRegionsImpl,
    });
    assert.strictEqual(result.state.infra.dnsManaged, true);
  });

  it('single-node: ALB accepted but no Route53 zone found -> offers manual-DNS ALB path when the user proceeds anyway', async () => {
    const { io } = makeIo({ confirms: { 'set up https': true, 'continue with the alb anyway': true } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [];
    const result = await runAwsDnsStep({ state, io, listHostedZonesImpl });
    assert.strictEqual(result.state.infra.albEnabled, true);
    assert.strictEqual(result.state.infra.dnsManaged, false);
    assert.strictEqual(result.state.infra.dnsZoneId, null);
  });

  it('single-node: ALB accepted, no Route53 zone found, user declines to proceed -> falls back to no-ALB', async () => {
    const { io } = makeIo({ confirms: { 'set up https': true, 'continue with the alb anyway': false } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [];
    const result = await runAwsDnsStep({ state, io, listHostedZonesImpl });
    assert.strictEqual(result.state.infra.albEnabled, false);
  });

  it('single-node: offers an existing ACM certificate covering the domain instead of always requesting a new one', async () => {
    const { io } = makeIo({
      confirms: { 'set up https': true },
      selects: { 'found existing acm certificate': 'arn:existing-cert' },
    });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', region: 'us-east-2', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => null;
    const listCertificatesForDomainImpl = async () => [{ certificateArn: 'arn:existing-cert', domainName: 'cc.example.com' }];
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl,
    });
    assert.strictEqual(result.state.infra.acm.certificateArn, 'arn:existing-cert');
    assert.strictEqual(result.state.infra.acm.issued, true);
    // Critical: reusing an existing certificate must NEVER be flagged as
    // wizard-created — `cc destroy` uses this to decide whether it's safe to
    // delete the certificate, and this one may be a shared wildcard backing
    // other, unrelated deployments.
    assert.strictEqual(result.state.infra.acm.createdByWizard, false);
  });

  it('single-node: requests a new certificate when the user picks "Request a new certificate" from the existing-cert menu', async () => {
    const { io } = makeIo({
      confirms: { 'set up https': true },
      selects: { 'found existing acm certificate': '__new__' },
    });
    const state = { ...defaultState(), target: 'aws', domain: 'cc.example.com', region: 'us-east-2', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => null;
    const listCertificatesForDomainImpl = async () => [{ certificateArn: 'arn:existing-cert', domainName: 'cc.example.com' }];
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl,
    });
    assert.strictEqual(result.state.infra.acm.certificateArn, null);
    assert.strictEqual(result.state.infra.acm.issued, false);
    // Explicitly asked for a new one — this IS ours to delete on destroy.
    assert.strictEqual(result.state.infra.acm.createdByWizard, true);
  });

  it('single-node: no existing certificate anywhere -> the one about to be requested is marked wizard-created', async () => {
    const { io } = makeIo({ confirms: { 'set up https': true } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc-brand-new.example.com', region: 'us-west-2', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => null;
    const listCertificatesForDomainImpl = async () => [];
    const findCertificateInOtherRegionsImpl = async () => null;
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl, findCertificateInOtherRegionsImpl,
    });
    assert.strictEqual(result.state.infra.acm.certificateArn, null);
    assert.strictEqual(result.state.infra.acm.createdByWizard, true);
  });

  it('single-node: no cert in the deployment region but a wildcard exists in another region -> logs why it can\'t be reused (2026-07-06 regression: silent new-cert request with no explanation)', async () => {
    const { io, logs } = makeIo({ confirms: { 'set up https': true } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc-test3.demotelnyx.com', region: 'us-west-2', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'demotelnyx.com' }];
    const findRecordForHostImpl = async () => null;
    const listCertificatesForDomainImpl = async () => []; // nothing in us-west-2 itself
    const findCertificateInOtherRegionsImpl = async () => ({
      region: 'us-east-2',
      certificates: [{ certificateArn: 'arn:wild-east', domainName: '*.demotelnyx.com' }],
    });
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl, findCertificateInOtherRegionsImpl,
    });
    // Still proceeds to request a fresh cert for the actual deployment region.
    assert.strictEqual(result.state.infra.acm.certificateArn, null);
    assert.strictEqual(result.state.infra.acm.issued, false);
    // But now explains WHY, instead of silently doing so.
    assert.ok(logs.some((l) => l.includes('*.demotelnyx.com') && l.includes('us-east-2') && l.includes('us-west-2')),
      `expected a log line explaining the cross-region certificate, got: ${JSON.stringify(logs)}`);
  });

  it('single-node: no cert anywhere -> does not log a spurious cross-region explanation', async () => {
    const { io, logs } = makeIo({ confirms: { 'set up https': true } });
    const state = { ...defaultState(), target: 'aws', domain: 'cc-brand-new.example.com', region: 'us-west-2', infra: { awsTopology: 'single' } };
    const listHostedZonesImpl = async () => [{ id: 'Z1', name: 'example.com' }];
    const findRecordForHostImpl = async () => null;
    const listCertificatesForDomainImpl = async () => [];
    const findCertificateInOtherRegionsImpl = async () => null;
    const result = await runAwsDnsStep({
      state, io, listHostedZonesImpl, findRecordForHostImpl, listCertificatesForDomainImpl, findCertificateInOtherRegionsImpl,
    });
    assert.strictEqual(result.state.infra.acm.certificateArn, null);
    assert.ok(!logs.some((l) => l.includes('can\'t be reused here')));
  });

  it('non-AWS target is a no-op passthrough', async () => {
    const { io } = makeIo();
    const state = { ...defaultState(), target: 'local' };
    const result = await runAwsDnsStep({ state, io });
    assert.strictEqual(result.state, state);
  });
});

describe('wizard.mjs — runPreflightStep', () => {
  it('aborts when preflight has a hard failure (e.g. missing Telnyx key)', async () => {
    const { io, logs } = fakeIo({ confirms: [] });
    const state = { ...defaultState(), target: 'local' };
    const result = await runPreflightStep({ state, io, answers: { telnyxApiKey: '' } });
    assert.strictEqual(result.aborted, true);
    assert.ok(logs.some((l) => l.toLowerCase().includes('fail')));
  });
});

describe('wizard.mjs — runPortConflictStep', () => {
  it('abort path: returns aborted=true and marks the step skipped', async () => {
    const io = {
      log: () => {}, select: async () => 'abort', confirm: async () => false, ask: async () => '', askSecret: async () => '',
    };
    const state = { ...defaultState(), target: 'local' };
    const result = await runPortConflictStep({ state, io, busyPorts: [5432], execImpl: async () => ({ stdout: '' }) });
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.state.steps['port-conflict'], 'skipped');
  });

  it('different-host-port path: sets state.postgresHostPort and marks the step done', async () => {
    // auto-suggest a free port in 5433-5440 and accept it.
    const io = {
      log: () => {}, select: async () => 'different-host-port', confirm: async () => true, ask: async () => '', askSecret: async () => '',
    };
    const state = { ...defaultState(), target: 'local' };
    const result = await runPortConflictStep({ state, io, busyPorts: [5432], execImpl: async () => ({ stdout: '' }) });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.state.steps['port-conflict'], 'done');
    assert.ok(result.state.postgresHostPort >= 5433 && result.state.postgresHostPort <= 5440,
      `expected auto-picked port in 5433-5440, got ${result.state.postgresHostPort}`);
  });

  it('use-existing path: collects credentials, probes psql, sets state.postgres.mode=existing', async () => {
    const io = {
      log: () => {},
      select: async (title) => {
        if (title.toLowerCase().includes('how do you want to resolve')) return 'existing';
        throw new Error(`unexpected select: ${title}`);
      },
      confirm: async (q) => {
        // Don't overwrite an existing database — pick the rename path so we can verify it
        // shows up only when the existing db check reports exists=true.
        return false;
      },
      ask: async (question, defaultValue) => {
        const q = question.toLowerCase();
        // Order matters: 'use a different database name' includes 'database name',
        // so the more specific question must be matched first.
        if (q.includes('use a different database name')) return 'contact_center_v2';
        if (q.includes('postgres host')) return 'localhost';
        if (q.includes('postgres port')) return '5433';
        if (q.includes('postgres user')) return 'leszek';
        if (q.includes('database name')) return 'contact_center';
        return defaultValue;
      },
      askSecret: async () => 'pg-secret',
    };
    // execImpl: psql "select version()" returns ok; pg_database check returns "1" (exists),
    // then the rename re-check returns "" (not exists). Order matters: check the v2
    // exact-match FIRST so 'contact_center' substring doesn't swallow 'contact_center_v2'.
    const execImpl = async (cmd, args) => {
      const joined = (args || []).join(' ');
      if (joined.includes('select version()')) return { stdout: 'PostgreSQL 17.7 on aarch64-apple-darwin\n' };
      if (joined.includes("datname='contact_center_v2'")) return { stdout: '\n' };
      if (joined.includes("datname='contact_center'")) return { stdout: '1\n' };
      return { stdout: '' };
    };
    const state = { ...defaultState(), target: 'local' };
    const result = await runPortConflictStep({ state, io, busyPorts: [5432], execImpl });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.state.postgres.mode, 'existing');
    assert.strictEqual(result.state.postgres.host, 'localhost');
    assert.strictEqual(result.state.postgres.port, 5433);
    assert.strictEqual(result.state.postgres.user, 'leszek');
    assert.strictEqual(result.state.postgres.database, 'contact_center_v2');
    assert.deepStrictEqual(result.answers.existingPostgres, {
      host: 'localhost', port: 5433, user: 'leszek', password: 'pg-secret', database: 'contact_center_v2',
    });
    assert.strictEqual(result.answers.postgresMode, 'existing');
  });

  it('use-existing path: aborted when psql connection fails (no version returned)', async () => {
    const io = {
      log: () => {}, select: async () => 'existing', confirm: async () => false, ask: async () => '', askSecret: async () => '',
    };
    const execImpl = async () => { throw new Error('Connection refused'); };
    const state = { ...defaultState(), target: 'local' };
    const result = await runPortConflictStep({ state, io, busyPorts: [5432], execImpl });
    assert.strictEqual(result.aborted, true);
  });
});

describe('wizard.mjs — runWizard (full local flow, mocked exec/fetch)', () => {
  let deployDir;
  let repoRoot;

  // No domain is set in any of these fixtures, so runLocalProvisionStep's
  // auto-tunnel branch fires on every run here — inject a fake so tests never
  // spawn a real `cloudflared` process or hit the network.
  const fakeStartTunnel = async () => ({ url: 'https://fake-tunnel.trycloudflare.com', pid: 999999 });

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'cc-wizard-repo-'));
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

  it('declining consent stops immediately without touching docker or the network', async () => {
    const { io } = fakeIo({ confirms: [false] });
    let execCalled = false;
    const execImpl = async () => { execCalled = true; return { stdout: '' }; };
    const result = await runWizard({
      deployDir,
      sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
      io,
      execImpl,
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'healthy' }) }),
    });
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(execCalled, false);
  });

  it('full happy path for Local target: consent -> target -> size(skip) -> region(skip) -> params -> preflight -> provision -> telnyx(no number) -> summary', async () => {
    const execCalls = [];
    const execImpl = async (cmd, args) => {
      execCalls.push(args);
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      return { stdout: '' };
    };
    const telnyx = makeTelnyxMock();
    const fetchImpl = async (url, init) => {
      // Route Telnyx calls to the mock; everything else (health probes) is a
      // healthy localhost.
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };

    const values = ['cc-main', '', 'owner@example.com']; // params: name, domain(skip->localhost), email
    let ai = 0;
    // Step 7's number-purchase select is forced to return the first candidate
    // (the cheapest) so the test exercises the full buy path. The dedicated
    // bootstrap-orchestrator tests cover the "user picks non-first candidate"
    // path with full mocked state. The `confirm` mock routes by question text
    // so preflight's optional "continue past warnings?" prompt is also accepted
    // without needing to count confirm calls.
    const io = {
      header: () => {},
      log: () => {},
      confirm: async (question) => {
        if (/continue past warnings/i.test(question)) return true;
        if (/Continue\?/i.test(question)) return true;
        return true;
      },
      select: async (title, options) => {
        if (/target/i.test(title)) return 'local';
        if (/Pick a US phone number/i.test(title)) return options[0].value;
        return options[0].value;
      },
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID']; // ownerPassword blank, telnyxApiKey
        let si = 0;
        return async () => secrets[si++];
      })(),
      checkLine: () => {},
      step: (label) => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: (label) => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    // Two voice apps are created during Telnyx bootstrap now: the main
    // WebRTC-agent app, plus the Default Call Flow's own dedicated voice
    // app (created by ensureCoreTelnyxObjects — see
    // telnyx-bootstrap-orchestrator.mjs). The Default Call Flow's DB row
    // itself is seeded by the app container at boot
    // (lib/seed-default-call-flow.mjs), not by this wizard step.

    const result = await runWizard({
      deployDir,
      sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
      io,
      execImpl,
      fetchImpl,
      ports: [59901, 59902],
      buyNumber: true, // io.select returns the first candidate — exercises the full buy path
      countryCode: 'US',
      startTunnelImpl: fakeStartTunnel,
    });

    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.state.target, 'local');
    assert.strictEqual(result.state.steps.provision, 'done');
    assert.strictEqual(result.state.steps.telnyx, 'done');
    assert.strictEqual(result.state.steps.summary, 'done');
    assert.ok(result.state.telnyx.voiceAppId, 'voice app id should be populated');
    assert.ok(result.state.telnyx.sipConnectionId, 'webrtc SIP conn id should be populated');
    assert.strictEqual(result.state.telnyx.phoneNumber, '+14155550134', 'number was picked via io.select');
    // Telnyx bootstrap now runs BEFORE provision (see runWizard's step
    // order), so every TELNYX_* id/secret is already known when the .env is
    // generated and the container is built — there is no second .env write
    // or restart afterward. Exactly ONE `compose up -d` invocation is
    // expected now (the old two-phase build-then-restart dance is gone).
    const upCalls = execCalls.filter((c) => c.includes('up') && c.includes('-d'));
    assert.strictEqual(upCalls.length, 1, 'compose up -d should be invoked exactly once — no post-Telnyx-bootstrap restart is needed anymore');
    assert.ok(
      !execCalls.some((c) => c.includes('restart')),
      'app container should never be `restart`ed (restart does not reload env_file, and reordering Telnyx bootstrap before provision removes the need for a second up entirely)',
    );

    // .env should have been written with the generated secret/telnyx key + the
    // Telnyx IDs from the bootstrap step.
    const { readFile } = await import('node:fs/promises');
    const envContent = await readFile(join(repoRoot, 'docker', 'production', '.env'), 'utf8');
    assert.match(envContent, /TELNYX_API_KEY=KEY_TEST_VALID/);
    assert.match(envContent, /TELNYX_CALL_CONTROL_ID=app-1/);
    assert.match(envContent, /TELNYX_SIP_CONNECTION_ID=conn-1/);
    assert.match(envContent, /TELNYX_OUTBOUND_VOICE_PROFILE=ovp-1/);
    assert.match(envContent, /TELNYX_MAIN_FROM_NUMBER=\+14155550134/);

    // State should be resumable / persisted
    const reloaded = await loadState(deployDir);
    assert.strictEqual(reloaded.deploymentName, 'cc-main');
  });

  it('resume: continuing an interrupted deployment skips already-done steps (target/size/region/params) and reuses the persisted phone number', async () => {
    // Simulate a prior run that got as far as the Telnyx bootstrap (with a
    // number already purchased+assigned) but crashed before summary/callFlow
    // — the exact scenario from the bug report ("re-running goes through all
    // steps again instead of resuming").
    const priorState = {
      ...defaultState(),
      target: 'local',
      deploymentName: 'cc-main',
      domain: null,
      ownerEmail: 'owner@example.com',
      telnyx: {
        voiceAppId: 'app-1',
        outboundVoiceProfileId: 'ovp-1',
        sipConnectionId: 'conn-1',
        phoneNumber: '+14155550134',
        phoneNumberId: 'pn-1',
        messagingProfileId: null,
      },
      steps: {
        consent: 'done', target: 'done', size: 'skipped', region: 'skipped',
        params: 'done', 'port-conflict': 'skipped', preflight: 'done',
        provision: 'done', telnyx: 'done', summary: 'pending',
      },
    };
    await saveState(deployDir, priorState);
    // Provision already ran in the "prior run", so the .env this resume reads
    // back from (via preflight/provision reuse) needs to exist too.
    const composeDir = join(repoRoot, 'docker', 'production');
    await writeFile(join(composeDir, '.env'), 'TELNYX_API_KEY=\nDEFAULT_OWNER_EMAIL=owner@example.com\nDEFAULT_OWNER_PASSWORD=\nNEXT_PUBLIC_BASE_URL=http://localhost:3000\n', 'utf8');

    const execCalls = [];
    const execImpl = async (cmd, args) => {
      execCalls.push(args);
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      return { stdout: '' };
    };
    const telnyx = makeTelnyxMock();
    // Pre-seed the mock so the idempotent find-by-name / already-owned checks
    // report "found" instead of creating duplicates — proves resume doesn't
    // re-create resources. Bump the mock's internal id counters past the
    // seeded values so the Default Call Flow's fresh voice-app creation
    // (ensureCoreTelnyxObjects runs again on every Telnyx bootstrap
    // invocation) doesn't collide with a manually-seeded id like "app-1".
    telnyx.state.voiceApps.push({ id: 'app-1', application_name: 'cc-main-voice-app', webhook_event_url: 'http://localhost:3000/api/voice/webhook' });
    telnyx.state.outboundProfiles.push({ id: 'ovp-1', name: 'cc-main-outbound' });
    telnyx.state.credentialConnections.push({ id: 'conn-1', connection_name: 'cc-main-webrtc' });
    telnyx.state.telephonyCredentials.push({ id: 'cred-1', name: 'cc-main-owner', connection_id: 'conn-1' });
    telnyx.state.phoneNumbers.push({ id: 'pn-1', phone_number: '+14155550134', connection_id: 'app-1' });
    telnyx.counters.app = 1;
    telnyx.counters.ovp = 1;
    telnyx.counters.conn = 1;
    telnyx.counters.cred = 1;
    telnyx.counters.pn = 1;
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };

    let selectCalls = 0;
    const askCalls = [];
    const io = {
      header: () => {},
      log: () => {},
      confirm: async () => true,
      select: async (title, options) => {
        selectCalls += 1;
        if (/how do you want to proceed/i.test(title)) return 'continue';
        // Any other select firing means a step we expected to be skipped
        // (target/size/region/number-pick — number is reused, not re-picked)
        // asked the user again.
        return options[0]?.value;
      },
      ask: async (q, def) => { askCalls.push(q); return def; },
      askSecret: (() => {
        const secrets = ['KEY_TEST_VALID']; // only telnyxApiKey — ownerPassword skipped (provision already done)
        let si = 0;
        return async () => secrets[si++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const mockPool = {
      rows: [],
      async query(text, params) {
        if (text.includes('SELECT id FROM voice_flows')) return { rows: this.rows.filter((r) => r.id === params[0]) };
        if (text.includes('INSERT INTO voice_flows')) { this.rows.push({ id: params[0] }); return { rows: [{ id: params[0] }] }; }
        if (text.includes('INSERT INTO voice_flow_phone_numbers')) return { rows: [{ id: params[0] }] };
        return { rows: [] };
      },
      async end() {},
    };

    const result = await runWizard({
      deployDir,
      sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
      io,
      execImpl,
      fetchImpl,
      ports: [59921, 59922],
      buyNumber: true,
      poolFactory: async () => mockPool,
      startTunnelImpl: fakeStartTunnel,
    });

    assert.strictEqual(result.aborted, false, 'resume should complete successfully');
    // Only ONE select should have fired for "how do you want to proceed" —
    // target/size/region were skipped (size/region were already 'skipped' in
    // priorState so they never prompt anyway; target being resumed as 'done'
    // is the actual regression check) and the number picker never re-asked
    // because state.telnyx.phoneNumber was already populated.
    assert.strictEqual(result.state.target, 'local', 'resumed target should come from persisted state, not be re-asked');
    assert.strictEqual(result.state.deploymentName, 'cc-main', 'resumed deploymentName should come from persisted state');
    assert.strictEqual(result.state.telnyx.phoneNumber, '+14155550134', 'resumed phone number should be reused, not re-purchased');
    assert.strictEqual(
      telnyx.state.phoneNumbers.length, 1,
      'resume must NOT purchase a second phone number — exactly the bug this fix addresses',
    );
    // Two voice apps are expected: the main WebRTC-agent app (id app-1, reused
    // from priorState — resume must NOT duplicate it) plus the Default Call
    // Flow's own dedicated voice app (created fresh by the callFlow step,
    // which runs for the first time on this resume since it was 'pending').
    // The real regression check is that app-1 itself isn't duplicated.
    assert.strictEqual(
      telnyx.state.voiceApps.filter((a) => a.id === 'app-1').length, 1,
      'resume must NOT create a duplicate of the already-completed main voice app',
    );
    assert.strictEqual(
      telnyx.state.voiceApps.length, 2,
      'expected exactly 2 voice apps: the reused main app + the newly-created Default Call Flow app',
    );
    assert.strictEqual(result.state.steps.summary, 'done');
  });

  it('AWS target: preflight stops the wizard cleanly when AWS credentials are missing (no provisioning attempted)', async () => {
    const values = ['cc-main', 'cc.example.com', 'owner@example.com'];
    let ai = 0;
    const selects = ['aws', 'small', 'eu-central-1']; // target, size, region
    let si = 0;
    const io = {
      header: () => {},
      log: () => {},
      confirm: async () => true,
      select: async () => selects[si++],
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID'];
        let sei = 0;
        return async () => secrets[sei++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };
    let execCalls = [];
    const execImpl = async (cmd, args) => {
      execCalls.push(args);
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      // No valid AWS credentials — checkAwsCloudPreflight's aws-cli check fails,
      // which must stop the wizard before any Terraform/SSM/S3 command runs.
      if (cmd === 'aws' && args[0] === 'sts') throw new Error('Unable to locate credentials');
      return { stdout: '' };
    };
    const fetchImpl = async () => ({ ok: true, status: 200 });

    const result = await runWizard({
      deployDir,
      sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
      io,
      execImpl,
      fetchImpl,
    });

    assert.strictEqual(result.aborted, true);
    // No provisioning command (terraform apply, aws s3/ssm/secretsmanager, docker
    // build) should ever run once the AWS credentials check has failed.
    assert.ok(
      !execCalls.some((args) => args[0] === 'apply' || args.includes('secretsmanager') || args.includes('ssm')),
      'no provisioning exec calls should happen once the AWS preflight check has failed',
    );
    assert.strictEqual(result.state.target, 'aws');
    assert.strictEqual(result.state.region, 'eu-central-1');
  });

  it('AWS target: full single-node happy path (Telnyx bootstrap -> terraform apply -> SSM deploy -> summary)', async () => {
    const values = ['cc-main', 'cc.example.com', 'owner@example.com']; // params: name, domain, email
    let ai = 0;
    const selects = ['aws', 'small', 'eu-central-1']; // target, size, region
    let si = 0;
    const telnyx = makeTelnyxMock();
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };
    const io = {
      header: () => {},
      log: () => {},
      confirm: async (question) => {
        if (/enable a portainer agent/i.test(question)) return false;
        // This test exercises the plain single-node path (no ALB/ACM/Route53
        // automation) — decline the DNS step's ALB offer so it stays that way.
        if (/set up https for .* via an aws application load balancer/i.test(question)) return false;
        return true; // includes "Apply this Terraform plan?"
      },
      select: async (title, options) => {
        if (/where do you want to deploy/i.test(title)) return selects[si++];
        if (/expected scale/i.test(title)) return selects[si++];
        if (/aws region/i.test(title)) return selects[si++];
        if (/pick a us phone number/i.test(title)) return options[0].value;
        return options[0].value;
      },
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID']; // ownerPassword blank, telnyxApiKey
        let sei = 0;
        return async () => secrets[sei++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const repoRootForBuild = join(deployDir, '..');
    const execCalls = [];
    const execImpl = async (cmd, args) => {
      execCalls.push([cmd, ...args]);
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'aws' && args[0] === 'sts') return { stdout: JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/test' }) };
      if (cmd === 'aws' && args[0] === 'iam') return { stdout: JSON.stringify({ EvaluationResults: [] }) };
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 12 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '1.2.3.4' },
            app_url: { value: 'https://cc.example.com' },
            instance_id: { value: 'i-abc123' },
            storage_bucket: { value: 'cc-main-abcd1234' },
            db_secret_name: { value: 'cc-main/db/credentials' },
            app_env_secret_name: { value: 'cc-main/app/env' },
          }),
        };
      }
      if (cmd === 'aws' && args[0] === 'secretsmanager') {
        if (args.includes('get-secret-value')) {
          return { stdout: JSON.stringify({ username: 'contact_center', password: 'test-pw', engine: 'postgres', host: 'cc-main-pg.example-rds.amazonaws.com', port: 5432, dbname: 'contact_center' }) };
        }
        return { stdout: '' };
      }
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        // Must clear buildAndPackageImage's MIN_ARCHIVE_BYTES (1MB) floor
        // (2026-07-09 fix: silent-empty-archive-on-docker-save-failure
        // regression) — a too-small fixture trips that guard and fails
        // the test with the guard's own error instead of exercising the
        // full-flow success path this test is actually for.
        await writeFile(join(repoRootForBuild, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'aws' && args[0] === 's3') return { stdout: '' };
      if (cmd === 'aws' && args[0] === 'ssm') {
        if (args[1] === 'describe-instance-information') return { stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'Online' }] }) };
        if (args[1] === 'send-command') return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-1' } }) };
        if (args[1] === 'get-command-invocation') return { stdout: JSON.stringify({ Status: 'Success', StandardOutputContent: 'DEPLOY_OK' }) };
      }
      return { stdout: '' };
    };
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('Apply complete!\n'));
        child.emit('close', 0);
      });
      return child;
    };

    let result;
    try {
      result = await runWizard({
        deployDir,
        sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
        io,
        execImpl,
        fetchImpl,
        spawnImpl,
        sleep: async () => {},
      });
    } finally {
      await rm(join(repoRootForBuild, 'image.tar.zst'), { force: true });
    }

    assert.strictEqual(result.aborted, false, `expected success, got: ${JSON.stringify(result.state?.steps)}`);
    assert.strictEqual(result.state.target, 'aws');
    assert.strictEqual(result.state.infra.awsTopology, 'single');
    assert.strictEqual(result.state.infra.publicIp, '1.2.3.4');
    assert.strictEqual(result.state.infra.instanceIds.length, 1);
    assert.strictEqual(result.state.steps.provision, 'done');
    assert.strictEqual(result.state.steps.summary, 'done');
    assert.ok(telnyx.state.voiceApps.length >= 1, 'Telnyx bootstrap should have created at least the main voice app');
    assert.ok(execCalls.some(([cmd, ...args]) => cmd === 'aws' && args[0] === 'secretsmanager'), 'app/env secret should have been populated');
  });

  it('GCP target: full single-node happy path (Telnyx bootstrap -> terraform apply -> IAP SSH deploy -> summary)', async () => {
    const values = ['my-project', 'us-central1-a', 'cc-main', 'cc.example.com', 'owner@example.com']; // region step asks: projectId, zone; then params: name, domain, email
    let ai = 0;
    const selects = ['gcp', 'small', 'us-central1']; // target, size, region
    let si = 0;
    const telnyx = makeTelnyxMock();
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };
    const io = {
      header: () => {},
      log: () => {},
      confirm: async (question) => {
        if (/enable a portainer agent/i.test(question)) return false;
        if (/https load balancer/i.test(question)) return false; // stay on Phase 1/2 plain HTTP for this happy-path test
        return true; // includes "Apply this Terraform plan?"
      },
      select: async (title, options) => {
        if (/where do you want to deploy/i.test(title)) return selects[si++];
        if (/expected scale/i.test(title)) return selects[si++];
        if (/gcp region/i.test(title)) return selects[si++];
        if (/pick a us phone number/i.test(title)) return options[0].value;
        return options[0].value;
      },
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID']; // ownerPassword blank, telnyxApiKey
        let sei = 0;
        return async () => secrets[sei++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const repoRootForBuild = join(deployDir, '..');
    const execCalls = [];
    const execImpl = async (cmd, args) => {
      execCalls.push([cmd, ...args]);
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'gcloud' && args[0] === '--version') return { stdout: 'Google Cloud SDK 500.0.0\n' };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([{ account: 'me@example.com', status: 'ACTIVE' }]) };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'application-default') return { stdout: 'token\n' };
      if (cmd === 'gcloud' && args[0] === 'projects') return { stdout: JSON.stringify({ lifecycleState: 'ACTIVE' }) };
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 12 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '1.2.3.4' },
            app_url: { value: 'http://1.2.3.4.nip.io' },
            instance_name: { value: 'cc-main-app' },
            instance_id: { value: '123456789' },
            storage_bucket: { value: 'cc-main-abcd1234' },
            db_secret_name: { value: 'projects/1/secrets/cc-main-db-credentials' },
            app_env_secret_name: { value: 'projects/1/secrets/cc-main-app-env' },
            storage_hmac_secret_name: { value: 'projects/1/secrets/cc-main-storage-hmac' },
          }),
        };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') {
        const secretIdx = args.indexOf('--secret');
        const secretName = args[secretIdx + 1];
        if (secretName.includes('db-credentials')) {
          return { stdout: JSON.stringify({ username: 'contact_center', password: 'test-pw', engine: 'postgres', host: '10.1.2.3', port: 5432, dbname: 'contact_center' }) };
        }
        if (secretName.includes('storage-hmac')) {
          return { stdout: JSON.stringify({ access_id: 'GOOG1EXAMPLE', secret: 'hmac-secret-value' }) };
        }
        return { stdout: '{}' };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') return { stdout: '' };
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        // Must clear buildAndPackageImage's MIN_ARCHIVE_BYTES (1MB) floor
        // (2026-07-09 fix: silent-empty-archive-on-docker-save-failure
        // regression) — a too-small fixture trips that guard and fails
        // the test with the guard's own error instead of exercising the
        // full-flow success path this test is actually for.
        await writeFile(join(repoRootForBuild, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'gcloud' && args[0] === 'storage') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh') {
        if (args.includes('true')) return { stdout: '' }; // waitForIapSshReady probe
        return { stdout: 'DEPLOY_OK image=telnyx-contact-center:cc-main-abc' };
      }
      return { stdout: '' };
    };
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('Apply complete!\n'));
        child.emit('close', 0);
      });
      return child;
    };

    let result;
    try {
      result = await runWizard({
        deployDir,
        sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
        io,
        execImpl,
        fetchImpl,
        spawnImpl,
        sleep: async () => {},
      });
    } finally {
      await rm(join(repoRootForBuild, 'image.tar.zst'), { force: true });
    }

    assert.strictEqual(result.aborted, false, `expected success, got: ${JSON.stringify(result.state?.steps)}`);
    assert.strictEqual(result.state.target, 'gcp');
    assert.strictEqual(result.state.infra.gcpProjectId, 'my-project');
    assert.strictEqual(result.state.infra.publicIp, '1.2.3.4');
    assert.strictEqual(result.state.infra.instanceName, 'cc-main-app');
    assert.strictEqual(result.state.steps.provision, 'done');
    assert.strictEqual(result.state.steps.summary, 'done');
    assert.ok(telnyx.state.voiceApps.length >= 1, 'Telnyx bootstrap should have created at least the main voice app');
    assert.ok(execCalls.some(([cmd, ...args]) => cmd === 'gcloud' && args[0] === 'secrets'), 'app/env secret should have been populated');
  });

  it('GCP target: HTTPS Load Balancer opt-in (Phase 3) — writes lb_enabled tfvar, records lbIp/lbCertName from outputs, and polls certificate status', async () => {
    const values = ['my-project', 'us-central1-a', 'cc-main', 'cc.example.com', 'owner@example.com'];
    let ai = 0;
    const selects = ['gcp', 'small', 'us-central1'];
    let si = 0;
    const telnyx = makeTelnyxMock();
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };
    const io = {
      header: () => {},
      log: () => {},
      confirm: async (question) => {
        if (/enable a portainer agent/i.test(question)) return false;
        if (/https load balancer/i.test(question)) return true; // opt IN this time
        return true; // includes "Apply this Terraform plan?"
      },
      select: async (title, options) => {
        if (/where do you want to deploy/i.test(title)) return selects[si++];
        if (/expected scale/i.test(title)) return selects[si++];
        if (/gcp region/i.test(title)) return selects[si++];
        if (/pick a us phone number/i.test(title)) return options[0].value;
        return options[0].value;
      },
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID'];
        let sei = 0;
        return async () => secrets[sei++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const repoRootForBuild = join(deployDir, '..');
    let certDescribeCalled = false;
    const execImpl = async (cmd, args) => {
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'gcloud' && args[0] === '--version') return { stdout: 'Google Cloud SDK 500.0.0\n' };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([{ account: 'me@example.com', status: 'ACTIVE' }]) };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'application-default') return { stdout: 'token\n' };
      if (cmd === 'gcloud' && args[0] === 'projects') return { stdout: JSON.stringify({ lifecycleState: 'ACTIVE' }) };
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 20 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '1.2.3.4' },
            app_url: { value: 'https://cc.example.com' },
            instance_name: { value: 'cc-main-app' },
            instance_id: { value: '123456789' },
            storage_bucket: { value: 'cc-main-abcd1234' },
            db_secret_name: { value: 'projects/1/secrets/cc-main-db-credentials' },
            app_env_secret_name: { value: 'projects/1/secrets/cc-main-app-env' },
            storage_hmac_secret_name: { value: 'projects/1/secrets/cc-main-storage-hmac' },
            lb_ip: { value: '34.8.8.8' },
            cert_name: { value: 'cc-main-cert' },
          }),
        };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') {
        const secretIdx = args.indexOf('--secret');
        const secretName = args[secretIdx + 1];
        if (secretName.includes('db-credentials')) {
          return { stdout: JSON.stringify({ username: 'contact_center', password: 'test-pw', engine: 'postgres', host: '10.1.2.3', port: 5432, dbname: 'contact_center' }) };
        }
        if (secretName.includes('storage-hmac')) {
          return { stdout: JSON.stringify({ access_id: 'GOOG1EXAMPLE', secret: 'hmac-secret-value' }) };
        }
        return { stdout: '{}' };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssl-certificates') {
        certDescribeCalled = true;
        return { stdout: JSON.stringify({ managed: { status: 'ACTIVE' } }) };
      }
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        // Must clear buildAndPackageImage's MIN_ARCHIVE_BYTES (1MB) floor
        // (2026-07-09 fix: silent-empty-archive-on-docker-save-failure
        // regression) — a too-small fixture trips that guard and fails
        // the test with the guard's own error instead of exercising the
        // full-flow success path this test is actually for.
        await writeFile(join(repoRootForBuild, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'gcloud' && args[0] === 'storage') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh') {
        if (args.includes('true')) return { stdout: '' };
        return { stdout: 'DEPLOY_OK image=telnyx-contact-center:cc-main-abc' };
      }
      return { stdout: '' };
    };
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('Apply complete!\n'));
        child.emit('close', 0);
      });
      return child;
    };

    let result;
    try {
      result = await runWizard({
        deployDir,
        sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
        io,
        execImpl,
        fetchImpl,
        spawnImpl,
        sleep: async () => {},
      });
    } finally {
      await rm(join(repoRootForBuild, 'image.tar.zst'), { force: true });
    }

    assert.strictEqual(result.aborted, false, `expected success, got: ${JSON.stringify(result.state?.steps)}`);
    assert.strictEqual(result.state.infra.lbEnabled, true);
    assert.strictEqual(result.state.infra.lbIp, '34.8.8.8');
    assert.strictEqual(result.state.infra.lbCertName, 'cc-main-cert');
    assert.strictEqual(certDescribeCalled, true, 'expected the wizard to poll the managed certificate status after apply');
  });

  it('GCP target: Cloud DNS automation (LB enabled) — finds a matching managed zone, no existing record, writes dns_managed_zone tfvar and records gcpDnsZoneName/gcpDnsManaged', async () => {
    const values = ['my-project', 'us-central1-a', 'cc-main', 'cc.example.com', 'owner@example.com'];
    let ai = 0;
    const selects = ['gcp', 'small', 'us-central1'];
    let si = 0;
    const telnyx = makeTelnyxMock();
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };
    const io = {
      header: () => {},
      log: () => {},
      confirm: async (question) => {
        if (/enable a portainer agent/i.test(question)) return false;
        if (/https load balancer/i.test(question)) return true; // opt into the LB
        if (/manage.*dns automatically in google cloud dns/i.test(question)) return true; // opt into Cloud DNS
        return true; // includes "Apply this Terraform plan?"
      },
      select: async (title, options) => {
        if (/where do you want to deploy/i.test(title)) return selects[si++];
        if (/expected scale/i.test(title)) return selects[si++];
        if (/gcp region/i.test(title)) return selects[si++];
        if (/pick a us phone number/i.test(title)) return options[0].value;
        return options[0].value;
      },
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID'];
        let sei = 0;
        return async () => secrets[sei++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const repoRootForBuild = join(deployDir, '..');
    let capturedTfvarsText = null;
    const execImpl = async (cmd, args) => {
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'gcloud' && args[0] === '--version') return { stdout: 'Google Cloud SDK 500.0.0\n' };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([{ account: 'me@example.com', status: 'ACTIVE' }]) };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'application-default') return { stdout: 'token\n' };
      if (cmd === 'gcloud' && args[0] === 'projects') return { stdout: JSON.stringify({ lifecycleState: 'ACTIVE' }) };
      if (cmd === 'gcloud' && args[0] === 'dns' && args[1] === 'managed-zones') {
        return { stdout: JSON.stringify([{ name: 'cc-example-zone', dnsName: 'example.com.', visibility: 'public' }]) };
      }
      if (cmd === 'gcloud' && args[0] === 'dns' && args[1] === 'record-sets') {
        return { stdout: '[]' }; // no existing record for cc.example.com
      }
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 22 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '1.2.3.4' },
            app_url: { value: 'https://cc.example.com' },
            instance_name: { value: 'cc-main-app' },
            instance_id: { value: '123456789' },
            storage_bucket: { value: 'cc-main-abcd1234' },
            db_secret_name: { value: 'projects/1/secrets/cc-main-db-credentials' },
            app_env_secret_name: { value: 'projects/1/secrets/cc-main-app-env' },
            storage_hmac_secret_name: { value: 'projects/1/secrets/cc-main-storage-hmac' },
            lb_ip: { value: '34.8.8.8' },
            cert_name: { value: 'cc-main-cert' },
          }),
        };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') {
        const secretIdx = args.indexOf('--secret');
        const secretName = args[secretIdx + 1];
        if (secretName.includes('db-credentials')) {
          return { stdout: JSON.stringify({ username: 'contact_center', password: 'test-pw', engine: 'postgres', host: '10.1.2.3', port: 5432, dbname: 'contact_center' }) };
        }
        if (secretName.includes('storage-hmac')) {
          return { stdout: JSON.stringify({ access_id: 'GOOG1EXAMPLE', secret: 'hmac-secret-value' }) };
        }
        return { stdout: '{}' };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssl-certificates') {
        return { stdout: JSON.stringify({ managed: { status: 'ACTIVE' } }) };
      }
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        // Must clear buildAndPackageImage's MIN_ARCHIVE_BYTES (1MB) floor
        // (2026-07-09 fix: silent-empty-archive-on-docker-save-failure
        // regression) — a too-small fixture trips that guard and fails
        // the test with the guard's own error instead of exercising the
        // full-flow success path this test is actually for.
        await writeFile(join(repoRootForBuild, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'gcloud' && args[0] === 'storage') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh') {
        if (args.includes('true')) return { stdout: '' };
        return { stdout: 'DEPLOY_OK image=telnyx-contact-center:cc-main-abc' };
      }
      return { stdout: '' };
    };
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('Apply complete!\n'));
        child.emit('close', 0);
      });
      return child;
    };

    let result;
    try {
      result = await runWizard({
        deployDir,
        sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
        io,
        execImpl,
        fetchImpl,
        spawnImpl,
        sleep: async () => {},
      });
    } finally {
      await rm(join(repoRootForBuild, 'image.tar.zst'), { force: true });
      const tfvarsPath = join(deployDir, 'terraform', 'gcp', 'single-node', 'terraform.tfvars.json');
      try { capturedTfvarsText = await readFile(tfvarsPath, 'utf8'); } catch { /* best-effort */ }
    }

    assert.strictEqual(result.aborted, false, `expected success, got: ${JSON.stringify(result.state?.steps)}`);
    assert.strictEqual(result.state.infra.gcpDnsManaged, true);
    assert.strictEqual(result.state.infra.gcpDnsZoneName, 'cc-example-zone');
    if (capturedTfvarsText) {
      assert.match(capturedTfvarsText, /"dns_managed_zone":\s*"cc-example-zone"/);
    }
  });

  it('Azure target: full single-node happy path (Telnyx bootstrap -> terraform apply -> az vm run-command deploy -> summary)', async () => {
    // Region step: subscription id via ask(), then region via select() —
    // the fallback `select: return options[0].value` below picks the
    // first AZURE_POPULAR_REGIONS entry (westeurope), same as it already
    // does for every other unmatched select prompt in this mock. Then
    // params: name, domain, email via ask().
    const values = ['00000000-0000-0000-0000-000000000000', 'cc-main', 'cc.example.com', 'owner@example.com'];
    let ai = 0;
    const selects = ['azure', 'small']; // target, size (region select falls through to options[0] below)
    let si = 0;
    const telnyx = makeTelnyxMock();
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };
    const io = {
      header: () => {},
      log: () => {},
      confirm: async (question) => {
        if (/enable a portainer agent/i.test(question)) return false;
        if (/application gateway/i.test(question)) return false; // stay on Phase 1/2 plain HTTP for this happy-path test
        return true; // includes "Apply this Terraform plan?"
      },
      select: async (title, options) => {
        if (/where do you want to deploy/i.test(title)) return selects[si++];
        if (/expected scale/i.test(title)) return selects[si++];
        if (/pick a us phone number/i.test(title)) return options[0].value;
        return options[0].value;
      },
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID']; // ownerPassword blank, telnyxApiKey
        let sei = 0;
        return async () => secrets[sei++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const repoRootForBuild = join(deployDir, '..');
    const execCalls = [];
    const execImpl = async (cmd, args) => {
      execCalls.push([cmd, ...args]);
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'az' && args[0] === 'version') return { stdout: JSON.stringify({ 'azure-cli': '2.65.0' }) };
      if (cmd === 'az' && args[0] === 'account' && args[1] === 'show') {
        return { stdout: JSON.stringify({ id: '00000000-0000-0000-0000-000000000000', user: { name: 'owner@example.com' } }) };
      }
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 27 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '4.5.6.7' },
            app_url: { value: 'http://4.5.6.7.nip.io' },
            resource_group_name: { value: 'cc-main-rg' },
            vm_name: { value: 'cc-main-app' },
            vm_id: { value: '/subscriptions/x/resourceGroups/cc-main-rg/providers/Microsoft.Compute/virtualMachines/cc-main-app' },
            key_vault_name: { value: 'cc-main-kv' },
            app_env_secret_name: { value: 'cc-main-app-env' },
            storage_account_name: { value: 'ccmainaa5f' },
            storage_container_name: { value: 'cc-media' },
            db_secret_name: { value: 'cc-main-db-credentials' },
          }),
        };
      }
      if (cmd === 'az' && args[0] === 'keyvault' && args[1] === 'secret' && args[2] === 'show') {
        const nameIdx = args.indexOf('--name');
        const secretName = args[nameIdx + 1];
        if (secretName.includes('db-credentials')) {
          return { stdout: JSON.stringify({ username: 'contact_center', password: 'test-pw', engine: 'postgres', host: 'cc-main-pg.postgres.database.azure.com', port: 5432, dbname: 'contact_center' }) };
        }
        return { stdout: '{}' };
      }
      if (cmd === 'az' && args[0] === 'keyvault' && args[1] === 'secret' && args[2] === 'set') return { stdout: '' };
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        // Must clear buildAndPackageImage's MIN_ARCHIVE_BYTES (1MB) floor
        // (2026-07-09 fix: silent-empty-archive-on-docker-save-failure
        // regression) — a too-small fixture trips that guard and fails
        // the test with the guard's own error instead of exercising the
        // full-flow success path this test is actually for.
        await writeFile(join(repoRootForBuild, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'az' && args[0] === 'storage' && args[1] === 'blob') return { stdout: '' };
      if (cmd === 'az' && args[0] === 'vm' && args[1] === 'run-command') {
        const scriptsIdx = args.indexOf('--scripts');
        const script = args[scriptsIdx + 1];
        if (script.includes('cc-bootstrap.done')) {
          return { stdout: JSON.stringify({ value: [{ message: 'READY' }] }) }; // waitForCloudInitReady probe
        }
        return { stdout: JSON.stringify({ value: [{ message: 'DEPLOY_OK image=telnyx-contact-center:cc-main-abc' }] }) };
      }
      return { stdout: '' };
    };
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('Apply complete!\n'));
        child.emit('close', 0);
      });
      return child;
    };

    let result;
    try {
      result = await runWizard({
        deployDir,
        sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
        io,
        execImpl,
        fetchImpl,
        spawnImpl,
        sleep: async () => {},
      });
    } finally {
      await rm(join(repoRootForBuild, 'image.tar.zst'), { force: true });
    }

    assert.strictEqual(result.aborted, false, `expected success, got: ${JSON.stringify(result.state?.steps)}`);
    assert.strictEqual(result.state.target, 'azure');
    assert.strictEqual(result.state.infra.azureSubscriptionId, '00000000-0000-0000-0000-000000000000');
    assert.strictEqual(result.state.infra.publicIp, '4.5.6.7');
    assert.strictEqual(result.state.infra.vmName, 'cc-main-app');
    assert.strictEqual(result.state.infra.azureResourceGroup, 'cc-main-rg');
    assert.strictEqual(result.state.infra.storageAccount, 'ccmainaa5f');
    assert.strictEqual(result.state.steps.provision, 'done');
    assert.strictEqual(result.state.steps.summary, 'done');
    assert.ok(telnyx.state.voiceApps.length >= 1, 'Telnyx bootstrap should have created at least the main voice app');
    assert.ok(execCalls.some(([cmd, ...args]) => cmd === 'az' && args[0] === 'keyvault' && args[1] === 'secret' && args[2] === 'set'), 'app/env secret should have been populated');
  });

  // Regression: on a totally fresh deployment, defaultState() sets
  // infra.azureDnsManaged to `null` (see state.mjs), not `undefined`. The
  // runAzureWizardTail gate that decides whether to run runAzureDnsStep used
  // to check `state.infra?.azureDnsManaged === undefined` only — since the
  // field is always `null` (never literally `undefined`) coming out of
  // defaultState(), that check was permanently false and the DNS-automation
  // (and therefore the Let's Encrypt) prompt never ran on a first pass, even
  // when the operator opted into the Application Gateway. The wizard fell
  // straight through to the phone-number picker instead. Fixed to check for
  // both `undefined` and `null`, matching AWS's albEnabled / GCP's
  // gcpDnsManaged gating convention elsewhere in this same file.
  // REGRESSION + architecture test: single-pass Azure flow. Exercises the
  // FULL sequence end-to-end on a fresh deployment (real defaultState()):
  // Application Gateway opt-in -> DNS automation opt-in -> Key Vault
  // bootstrap (targeted terraform apply, provisionAzureKeyVaultOnly) ->
  // certificate step finds + reuses an existing Key Vault certificate (no
  // prompt beyond a single yes/no) -> full-stack terraform apply succeeds
  // because the certificate already exists in Key Vault by the time it
  // runs. Proves the wizard no longer needs a second `cc up` re-run to get
  // HTTPS working. (The "no existing cert -> automatic Let's Encrypt, no
  // prompt" branch is covered by dedicated, network-free unit tests in
  // azure-tls-wizard-steps.test.mjs, which inject issueCertificateViaDns01Impl
  // directly — doing that same scenario through this full runWizard()
  // integration path would hit the real acme-client's live network calls,
  // since runAzureCertificateStep's issue*Impl defaults aren't threaded
  // through runWizard's own options the way execImpl/fetchImpl are.)
  it("Azure target: single-pass flow with Application Gateway + Azure DNS — bootstraps Key Vault and completes the full apply in ONE run (no second cc up needed)", async () => {
    const values = ['00000000-0000-0000-0000-000000000000', 'cc-azure', 'cc-azure.demo.example.com', 'owner@example.com'];
    let ai = 0;
    const selects = ['azure', 'small'];
    let si = 0;
    let dnsStepReached = false;
    let reusePromptShown = false;
    const telnyx = makeTelnyxMock();
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.telnyx.com')) return telnyx.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', database: 'connected' }) };
    };
    const io = {
      header: () => {},
      log: () => {},
      confirm: async (question) => {
        if (/enable a portainer agent/i.test(question)) return false;
        if (/front this deployment with an application gateway/i.test(question)) return true;
        if (/manage.*dns automatically in azure dns/i.test(question)) { dnsStepReached = true; return true; }
        if (/create the resource group \+ key vault now/i.test(question)) return true;
        if (/reuse it/i.test(question)) { reusePromptShown = true; return true; }
        if (/overwrite it/i.test(question)) return true;
        return true; // includes "Apply this Terraform plan?"
      },
      select: async (title, options) => {
        if (/where do you want to deploy/i.test(title)) return selects[si++];
        if (/expected scale/i.test(title)) return selects[si++];
        if (/pick a us phone number/i.test(title)) return options[0].value;
        return options[0].value;
      },
      ask: async (_q, def) => (values[ai] !== undefined ? values[ai++] : def),
      askSecret: (() => {
        const secrets = ['', 'KEY_TEST_VALID'];
        let sei = 0;
        return async () => secrets[sei++];
      })(),
      checkLine: () => {},
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {} }),
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const repoRootForBuild = join(deployDir, '..');
    // Real self-signed cert (via node-forge) covering both the primary
    // domain and ws.<domain> — exercises findCertificatesForDomain's real
    // X509Certificate.checkHost parsing, same rigor as
    // azure-keyvault-cert.test.mjs's own makeSelfSignedCertDer helper,
    // instead of a hand-waved fake DER blob.
    const existingCertDer = (() => {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01';
      cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
      cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
      const attrs = [{ name: 'commonName', value: 'cc-azure.demo.example.com' }];
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([{
        name: 'subjectAltName',
        altNames: ['cc-azure.demo.example.com', 'ws.cc-azure.demo.example.com'].map((value) => ({ type: 2, value })),
      }]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
      return Buffer.from(der, 'binary').toString('base64');
    })();
    // Tracks whether the FULL stack has already been applied once, so the
    // execImpl mock can serve `terraform output` with only the Key Vault
    // fields on the first (targeted) pass, and every field after the
    // second (full) apply — mirroring how a real `terraform output`
    // return grows as more of the state is populated.
    let fullStackApplied = false;
    const execImpl = async (cmd, args) => {
      if (args[0] === 'compose' && args[1] === 'version') return { stdout: 'Docker Compose version v2.99.0' };
      if (args[0] === '--version') return { stdout: 'Docker version 27.0.0' };
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'az' && args[0] === 'version') return { stdout: JSON.stringify({ 'azure-cli': '2.65.0' }) };
      if (cmd === 'az' && args[0] === 'account' && args[1] === 'show') {
        return { stdout: JSON.stringify({ id: '00000000-0000-0000-0000-000000000000', user: { name: 'owner@example.com' } }) };
      }
      if (cmd === 'az' && args[0] === 'network' && args[1] === 'dns' && args[2] === 'zone') {
        return { stdout: JSON.stringify([{ name: 'demo.example.com', resourceGroup: 'demo-rg' }]) };
      }
      if (cmd === 'az' && args[0] === 'network' && args[1] === 'dns' && args[2] === 'record-set') {
        // No existing A records for cc-azure.demo.example.com / ws.cc-azure.demo.example.com.
        throw new Error('ResourceNotFound: the record set was not found');
      }
      // A pre-existing certificate already sits in the Key Vault (e.g. a
      // wildcard cert imported before this run) that covers both the
      // domain and ws.<domain> — this exercises the "found + reuse" path
      // entirely via mockable az CLI calls, no ACME/network involved.
      if (cmd === 'az' && args[0] === 'keyvault' && args[1] === 'certificate' && args[2] === 'list') {
        return { stdout: JSON.stringify([{ name: 'existing-wildcard-cert' }]) };
      }
      if (cmd === 'az' && args[0] === 'keyvault' && args[1] === 'certificate' && args[2] === 'show') {
        return { stdout: JSON.stringify({ cer: existingCertDer, attributes: { enabled: true } }) };
      }
      if (cmd === 'az' && args[0] === 'keyvault' && args[1] === 'certificate' && args[2] === 'import') return { stdout: '' };
      if (cmd === 'az' && args[0] === 'keyvault' && args[1] === 'secret' && args[2] === 'show') {
        const nameIdx = args.indexOf('--name');
        const secretName = args[nameIdx + 1];
        if (secretName.includes('db-credentials')) {
          return { stdout: JSON.stringify({ username: 'contact_center', password: 'test-pw', engine: 'postgres', host: 'cc-azure-pg.postgres.database.azure.com', port: 5432, dbname: 'contact_center' }) };
        }
        return { stdout: '{}' };
      }
      if (cmd === 'az' && args[0] === 'keyvault' && args[1] === 'secret' && args[2] === 'set') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') {
        return { stdout: 'Plan: 3 to add, 0 to change, 0 to destroy.\n' };
      }
      if (cmd === 'terraform' && args[0] === 'output') {
        if (!fullStackApplied) {
          // Targeted (Key Vault-only) pass output — only the two fields
          // provisionAzureKeyVaultOnly reads exist yet.
          return {
            stdout: JSON.stringify({
              key_vault_name: { value: 'cc-azure-kv' },
              resource_group_name: { value: 'cc-azure-rg' },
            }),
          };
        }
        return {
          stdout: JSON.stringify({
            public_ip: { value: '4.5.6.7' },
            app_url: { value: 'https://cc-azure.demo.example.com' },
            resource_group_name: { value: 'cc-azure-rg' },
            vm_name: { value: 'cc-azure-app' },
            vm_id: { value: '/subscriptions/x/resourceGroups/cc-azure-rg/providers/Microsoft.Compute/virtualMachines/cc-azure-app' },
            key_vault_name: { value: 'cc-azure-kv' },
            app_env_secret_name: { value: 'cc-azure-app-env' },
            storage_account_name: { value: 'ccazureaa5f' },
            storage_container_name: { value: 'cc-media' },
            db_secret_name: { value: 'cc-azure-db-credentials' },
            appgw_public_ip: { value: '9.9.9.9' },
          }),
        };
      }
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        // Must clear buildAndPackageImage's MIN_ARCHIVE_BYTES (1MB) floor
        // (2026-07-09 fix: silent-empty-archive-on-docker-save-failure
        // regression) — a too-small fixture trips that guard and fails
        // the test with the guard's own error instead of exercising the
        // full-flow success path this test is actually for.
        await writeFile(join(repoRootForBuild, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'az' && args[0] === 'storage' && args[1] === 'blob') return { stdout: '' };
      if (cmd === 'az' && args[0] === 'vm' && args[1] === 'run-command') {
        const scriptsIdx = args.indexOf('--scripts');
        const script = args[scriptsIdx + 1];
        if (script.includes('cc-bootstrap.done')) {
          return { stdout: JSON.stringify({ value: [{ message: 'READY' }] }) };
        }
        return { stdout: JSON.stringify({ value: [{ message: 'DEPLOY_OK image=telnyx-contact-center:cc-azure-abc' }] }) };
      }
      return { stdout: '' };
    };
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        fullStackApplied = true;
        child.stdout.emit('data', Buffer.from('Apply complete!\n'));
        child.emit('close', 0);
      });
      return child;
    };

    let result;
    try {
      result = await runWizard({
        deployDir,
        sampleEnvPath: join(repoRoot, 'docker', 'production', 'sample.env'),
        io,
        execImpl,
        fetchImpl,
        spawnImpl,
        sleep: async () => {},
      });
    } finally {
      await rm(join(repoRootForBuild, 'image.tar.zst'), { force: true }).catch(() => {});
    }

    // Core architecture assertion: Key Vault bootstrapped in THIS SAME run.
    assert.strictEqual(dnsStepReached, true);
    assert.strictEqual(result.state.infra.lbEnabled, true);
    assert.strictEqual(result.state.infra.azureDnsManaged, true);
    assert.strictEqual(result.state.infra.keyVaultName, 'cc-azure-kv', 'Key Vault should be bootstrapped via the targeted apply in THIS SAME run — no second cc up needed');
    assert.strictEqual(reusePromptShown, true, 'a real, usable, self-signed cert covering both hosts was found in the mock vault — the single yes/no reuse confirm should have fired');
    assert.strictEqual(result.state.infra.azureTlsCertSource, 'existing');
    assert.strictEqual(result.state.infra.azureTlsCertSourceName, 'existing-wildcard-cert');
    // The wizard should have reached (and completed) the full-stack apply
    // in this SAME run — no "does not exist yet, re-run cc up" abort.
    assert.strictEqual(result.aborted, false, `expected the single-pass flow to complete, got: ${JSON.stringify(result.state?.steps)}`);
    assert.strictEqual(result.state.steps.provision, 'done');
    assert.strictEqual(result.state.steps.summary, 'done');
  });
});

describe('wizard.mjs — runLocalProvisionStep (Postgres wiring threading)', () => {
  // Regression for the "second wizard run forgets 5433 mapping" bug:
  //   - Run #1 hits port-conflict on 5432, user picks "different host port: 5433".
  //     state.postgresHostPort=5433 is persisted to deploy/.cc-state.json.
  //   - Run #2 loads that state. Preflight sees port 5433 is free (no conflict
  //     to resolve) so the port-conflict step is skipped — but the in-memory
  //     `answers` map from runParamsStep is FRESH and has no postgresHostPort.
  //   - Without the state->answers fallback, envgen wrote POSTGRES_HOST_PORT=5432
  //     and docker compose died with `bind: address already in use` even though
  //     preflight had just confirmed 5433 was free.
  //
  // Tests use the REAL docker/production/sample.env so we exercise the same
  // renderEnvFile logic the production wizard uses. The generated .env lives at
  // docker/production/.env (gitignored — see .gitignore line 43).
  //
  // The wizard writes .env at `join(deployDir, '..', 'docker', 'production', '.env')`,
  // i.e. RELATIVE to deployDir. In production that's deployDir = <repo>/deploy and
  // the env lands in <repo>/docker/production/.env (correct). The tests therefore
  // use deployDir = <repo>/deploy so the relative path resolves to the real repo
  // location. The .env file is gitignored and gets overwritten on every test run.
  // runLocalProvisionStep writes the .env at the RELATIVE path
  //   `join(deployDir, '..', 'docker', 'production', '.env')`.
  // In production that's deployDir = <repo>/deploy, so the env lands in
  // <repo>/docker/production/.env (correct). The same convention is used
  // by the pre-existing happy-path test in this file, so we do the same here:
  // deployDir = <repoRoot>/deploy, then read back from <repoRoot>/docker/production/.env.
  // The .env file is gitignored (.gitignore line 43) and gets overwritten on
  // every test run anyway.
  // runLocalProvisionStep writes the .env at the RELATIVE path
  //   `join(deployDir, '..', 'docker', 'production', '.env')`.
  // We replicate that relative layout inside a tmpdir so a failing test never
  // overwrites the developer's working docker/production/.env (the real .env
  // is gitignored but might contain live Telnyx keys the developer doesn't
  // want to lose to a `node --test` run).
  //
  // Layout per test:
  //   tmpBase/
  //     deploy/                       ← deployDir
  //     docker/production/.env        ← where the wizard writes the env file
  //
  // The source sample.env is read from the real repo (it's a read-only
  // tracked file; nothing we do here can change it). Only the generated .env
  // is written inside tmpdir.
  const sampleEnvPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'docker', 'production', 'sample.env',
  );
  let deployDir;
  let tmpBase;
  let envPath;

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'cc-prov-step-'));
    deployDir = join(tmpBase, 'deploy');
    envPath = join(tmpBase, 'docker', 'production', '.env');
    await mkdir(join(tmpBase, 'docker', 'production'), { recursive: true });
    await mkdir(deployDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });
  // Mock the things runLocalProvisionStep actually executes: writeFile for the
  // .env, composeUp (execImpl), and waitForHealthy (fetchImpl returning 200).
  function makeExecs() {
    let composeUpCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'compose') {
        composeUpCalled = true;
        return { stdout: 'ok' };
      }
      return { stdout: '' };
    };
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'healthy' }),
      text: async () => '{"status":"healthy"}',
    });
    return { execImpl, fetchImpl, isComposeUpCalled: () => composeUpCalled };
  }

  function makeIo({ logSink = [] } = {}) {
    return {
      header: () => {}, log: (...a) => logSink.push(a.join(' ')),
      confirm: async () => true, select: async () => '', ask: async () => '',
      askSecret: async () => '', checkLine: () => {},
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };
  }

  // These tests exercise Postgres/.env wiring, not the tunnel feature — inject
  // a fake startTunnelImpl so runLocalProvisionStep's auto-tunnel branch (fires
  // whenever state.domain is unset, which is the default in all these fixtures)
  // never spawns a real `cloudflared` process or touches the network.
  const fakeStartTunnel = async () => ({ url: 'https://fake-tunnel.trycloudflare.com', pid: 999999 });

  it('uses state.postgresHostPort=5433 on resume when answers.postgresHostPort is undefined (regression)', async () => {
    // State from a previous run that resolved port-conflict to host port 5433.
    const state = {
      ...defaultState(),
      target: 'local',
      deploymentName: 'cc-main',
      postgresHostPort: 5433, // <-- sticky from run #1
      // Answers are fresh (run #2 just collected params) — no postgresHostPort here.
    };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };

    const { execImpl, fetchImpl, isComposeUpCalled } = makeExecs();
    const logSink = [];
    const io = makeIo({ logSink });

    const result = await runLocalProvisionStep({
      state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl, startTunnelImpl: fakeStartTunnel,
    });
    assert.strictEqual(result.aborted, false, `wizard aborted unexpectedly; logs: ${logSink.join('\n')}`);
    assert.ok(isComposeUpCalled(), 'compose up should have been called');

    // Read back the .env the wizard wrote and confirm POSTGRES_HOST_PORT=5433.
    const envText = await readFile(envPath, 'utf8');
    const match = envText.match(/^POSTGRES_HOST_PORT=(\S*)$/m);
    assert.ok(match, `expected POSTGRES_HOST_PORT line in .env:\n${envText}`);
    assert.strictEqual(match[1], '5433',
      `expected POSTGRES_HOST_PORT=5433 (state was sticky from prior run), got '${match[1]}' — docker compose would now bind 5432 and crash`);
  });

  it('prefers answers.postgresHostPort over state.postgresHostPort when both are set', async () => {
    // In-run port-conflict resolution sets BOTH (state and answers); the
    // answers value is the freshest one and should win.
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main', postgresHostPort: 5433 };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
      postgresHostPort: 5434, // user picked a different port this run
    };

    const { execImpl, fetchImpl } = makeExecs();
    const io = makeIo();

    await runLocalProvisionStep({ state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl, startTunnelImpl: fakeStartTunnel });
    const envText = await readFile(envPath, 'utf8');
    const match = envText.match(/^POSTGRES_HOST_PORT=(\S*)$/m);
    assert.strictEqual(match[1], '5434');
  });

  it('defaults POSTGRES_HOST_PORT to 5432 when neither state nor answers specify a host port', async () => {
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main' };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };

    const { execImpl, fetchImpl } = makeExecs();
    const io = makeIo();

    await runLocalProvisionStep({ state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl, startTunnelImpl: fakeStartTunnel });
    const envText = await readFile(envPath, 'utf8');
    const match = envText.match(/^POSTGRES_HOST_PORT=(\S*)$/m);
    assert.strictEqual(match[1], '5432');
  });

  it('reconstructs existingPostgres from state on resume so COMPOSE_PROFILES=no-with-pg is written even without a fresh port-conflict step', async () => {
    // The user previously picked "use the Postgres I already have running
    // locally" — that decision is sticky in state.postgres.* (no secret in
    // state, but host/port/user/database are). On a resume, answers.* is
    // fresh and has no existingPostgres block; without the state fallback
    // the wizard would write POSTGRES_MODE=bundled and docker compose would
    // bring up the bundled container (and fail because the user's existing
    // pg is on 5432 and the bundled one tries to bind 5432 too).
    const state = {
      ...defaultState(),
      target: 'local',
      deploymentName: 'cc-main',
      postgres: {
        mode: 'existing',
        host: 'localhost',
        port: 5432,
        user: 'leszek',
        database: 'cc_main_db',
      },
    };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };

    const { execImpl, fetchImpl } = makeExecs();
    const io = makeIo();

    await runLocalProvisionStep({ state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl, startTunnelImpl: fakeStartTunnel });
    const envText = await readFile(envPath, 'utf8');
    assert.match(envText, /^POSTGRES_MODE=existing$/m, '.env must record existing mode (regression: was bundled)');
    assert.match(envText, /^COMPOSE_PROFILES=no-with-pg$/m, '.env must suppress the bundled container (regression: was with-pg)');
    assert.match(envText, /^POSTGRES_HOST=localhost$/m);
    assert.match(envText, /^POSTGRES_USER=leszek$/m);
    assert.match(envText, /^POSTGRES_DB=cc_main_db$/m);
  });

  it('passes answers.existingPostgres.password to envgen when supplied, even on resume with state.postgres.*', async () => {
    // Password precedence: fresh answer (set during this run) wins. The state
    // never holds the password (it's secret) but if a future refactor adds it,
    // the same precedence logic still applies.
    const state = {
      ...defaultState(),
      target: 'local',
      deploymentName: 'cc-main',
      postgres: { mode: 'existing', host: 'localhost', port: 5432, user: 'leszek', database: 'cc_main_db' },
    };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
      existingPostgres: { password: 'fresh-pwd-from-this-run' },
    };

    const { execImpl, fetchImpl } = makeExecs();
    const io = makeIo();

    await runLocalProvisionStep({ state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl, startTunnelImpl: fakeStartTunnel });
    const envText = await readFile(envPath, 'utf8');
    assert.match(envText, /^POSTGRES_PASSWORD=fresh-pwd-from-this-run$/m);
  });

  // Regression coverage for the codex review finding on PR #1153: Telnyx
  // bootstrap now runs BEFORE provision, so the one-time TELNYX_AI_API_KEY
  // integration secret (created once, never readable back from Telnyx) is
  // only in memory until this step's .env write. Because generateEnvFile
  // always rebuilds .env from scratch, and the Telnyx bootstrap step
  // correctly omits TELNYX_AI_API_KEY from envUpdates on any run where the
  // secret already exists (Telnyx returns outcome 'found', not the token),
  // a naive implementation would blank out an already-working key on every
  // resume/re-run. These tests assert the recovery path (existing .env +
  // the durable secrets cache) instead.
  it('preserves an existing TELNYX_AI_API_KEY in .env when this run\'s extraEnvUpdates does not include it (resume after secret already existed in Telnyx)', async () => {
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main' };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };
    const { execImpl, fetchImpl } = makeExecs();
    const io = makeIo();

    // Simulate a first successful run that already wrote TELNYX_AI_API_KEY.
    await runLocalProvisionStep({
      state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl,
      extraEnvUpdates: { TELNYX_AI_API_KEY: 'first-run-secret-token', TELNYX_AI_API_KEY_REF: 'telnyx-ai-api-key' },
    });
    let envText = await readFile(envPath, 'utf8');
    assert.match(envText, /^TELNYX_AI_API_KEY=first-run-secret-token$/m);

    // Second run: Telnyx bootstrap finds the secret already exists (outcome
    // 'found'), so envUpdates does NOT include TELNYX_AI_API_KEY this time
    // (matches telnyx-bootstrap-orchestrator.mjs's real behavior).
    await runLocalProvisionStep({
      state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl,
      extraEnvUpdates: { TELNYX_AI_API_KEY_REF: 'telnyx-ai-api-key' },
    });
    envText = await readFile(envPath, 'utf8');
    assert.match(envText, /^TELNYX_AI_API_KEY=first-run-secret-token$/m,
      'TELNYX_AI_API_KEY must survive a re-run where Telnyx bootstrap correctly omits it (secret already existed, no read-back possible)');
  });

  it('recovers TELNYX_AI_API_KEY from the durable secrets cache even when no .env exists yet on disk', async () => {
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main' };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };
    const { execImpl, fetchImpl } = makeExecs();
    const io = makeIo();

    // Simulate runTelnyxBootstrapStep having already persisted the secret to
    // the cache (e.g. the process crashed right after creating it in Telnyx,
    // before this provision step ever ran once) — no .env exists at all yet.
    const { mergeSecretsCache } = await import('../lib/telnyx-secrets-cache.mjs');
    await mergeSecretsCache(deployDir, { TELNYX_AI_API_KEY: 'cached-before-any-env-write' });

    const result = await runLocalProvisionStep({
      state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl,
      extraEnvUpdates: {}, // this run's Telnyx bootstrap supplied nothing fresh
    });
    assert.strictEqual(result.aborted, false);
    const envText = await readFile(envPath, 'utf8');
    assert.match(envText, /^TELNYX_AI_API_KEY=cached-before-any-env-write$/m,
      'a value persisted to the secrets cache must be recovered even when .env never existed before');
  });

  it('a fresh TELNYX_AI_API_KEY from this run\'s extraEnvUpdates always wins over any cached/existing value', async () => {
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main' };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };
    const { execImpl, fetchImpl } = makeExecs();
    const io = makeIo();

    const { mergeSecretsCache } = await import('../lib/telnyx-secrets-cache.mjs');
    await mergeSecretsCache(deployDir, { TELNYX_AI_API_KEY: 'stale-cached-value' });

    await runLocalProvisionStep({
      state, io, answers, deployDir, sampleEnvPath, execImpl, fetchImpl,
      extraEnvUpdates: { TELNYX_AI_API_KEY: 'brand-new-value-this-run' },
    });
    const envText = await readFile(envPath, 'utf8');
    assert.match(envText, /^TELNYX_AI_API_KEY=brand-new-value-this-run$/m);
  });
});

describe('wizard.mjs — runLocalTunnelStep (auto-tunnel, no domain given)', () => {
  // Tunnel logic was extracted out of runLocalProvisionStep into its own
  // step that now runs BEFORE Telnyx bootstrap and BEFORE provision (see
  // runWizard's step order) — so the tunnel URL is baked into every Telnyx
  // webhook AND the one-and-only docker build, instead of the old order
  // where provision (with the tunnel) ran, then Telnyx bootstrap patched
  // .env and tried (unsuccessfully — `compose restart` doesn't reload
  // env_file) to restart the container.
  let deployDir;
  let tmpBase;

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'cc-tunnel-step-'));
    deployDir = join(tmpBase, 'deploy');
    await mkdir(deployDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  function makeIo() {
    return {
      header: () => {}, log: () => {},
      confirm: async () => true, select: async () => '', ask: async () => '',
      askSecret: async () => '', checkLine: () => {},
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };
  }

  it('no domain given => starts a quick tunnel and rewrites answers.baseUrl to the tunnel URL (regression: webhook must not stay on localhost)', async () => {
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main', domain: null };
    const answers = {
      baseUrl: 'http://localhost:3000', // what runParamsStep would have produced with no domain
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };
    const io = makeIo();
    const startTunnelCalls = [];
    const startTunnelImpl = async (opts) => {
      startTunnelCalls.push(opts);
      return { url: 'https://sponsored-essentials.trycloudflare.com', pid: 55501 };
    };

    const result = await runLocalTunnelStep({ state, io, answers, deployDir, startTunnelImpl });

    assert.strictEqual(result.aborted, false);
    // The tunnel must be started on port 3000 (the HTTP/webhook port).
    assert.strictEqual(startTunnelCalls.length, 1);
    assert.strictEqual(startTunnelCalls[0].port, 3000);
    // answers.baseUrl returned from the step must be the tunnel URL, not
    // localhost — this is what runWizard threads into the Telnyx bootstrap
    // step's webhook registration AND the provision step's .env write.
    assert.strictEqual(result.answers.baseUrl, 'https://sponsored-essentials.trycloudflare.com');
    // state.tunnel must be persisted so `cc up` resume / `cc destroy` can find
    // and manage the detached cloudflared process later.
    assert.strictEqual(result.state.tunnel.mode, 'cloudflare-quick');
    assert.strictEqual(result.state.tunnel.url, 'https://sponsored-essentials.trycloudflare.com');
    assert.strictEqual(result.state.tunnel.pid, 55501);
  });

  it('a domain given => never calls startTunnelImpl and records tunnel.mode=user-provided', async () => {
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main', domain: 'api.demo.example.com' };
    const answers = {
      baseUrl: 'https://api.demo.example.com',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };
    const io = makeIo();
    let startTunnelCalled = false;
    const startTunnelImpl = async () => { startTunnelCalled = true; return { url: 'unused', pid: 1 }; };

    const result = await runLocalTunnelStep({ state, io, answers, deployDir, startTunnelImpl });

    assert.strictEqual(result.aborted, false);
    assert.strictEqual(startTunnelCalled, false, 'startTunnelImpl must not be called when a domain was given');
    assert.strictEqual(result.answers.baseUrl, 'https://api.demo.example.com', 'baseUrl must be untouched');
    assert.strictEqual(result.state.tunnel.mode, 'user-provided');
  });

  it('resume reuses a still-alive tunnel process instead of starting a second one', async () => {
    const state = {
      ...defaultState(),
      target: 'local',
      deploymentName: 'cc-main',
      domain: null,
      tunnel: { mode: 'cloudflare-quick', url: 'https://old-tunnel-from-prior-run.trycloudflare.com', pid: process.pid },
    };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };
    const io = makeIo();
    let startTunnelCalled = false;
    const startTunnelImpl = async () => { startTunnelCalled = true; return { url: 'should-not-be-used', pid: 2 }; };

    const result = await runLocalTunnelStep({ state, io, answers, deployDir, startTunnelImpl });

    assert.strictEqual(result.aborted, false);
    assert.strictEqual(startTunnelCalled, false, 'a live tunnel from a prior run should be reused, not replaced');
    assert.strictEqual(result.answers.baseUrl, 'https://old-tunnel-from-prior-run.trycloudflare.com');
    assert.strictEqual(result.state.tunnel.pid, process.pid);
  });

  it('fails the wizard cleanly (aborted=true) when cloudflared cannot be started', async () => {
    const state = { ...defaultState(), target: 'local', deploymentName: 'cc-main', domain: null };
    const answers = {
      baseUrl: 'http://localhost:3000',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'Pwd12345abc',
      telnyxApiKey: 'KEY_test',
    };
    const io = makeIo();
    const startTunnelImpl = async () => { throw new Error('cloudflared: command not found'); };

    const result = await runLocalTunnelStep({ state, io, answers, deployDir, startTunnelImpl });

    assert.strictEqual(result.aborted, true);
  });
});

describe('wizard.mjs — runPreflightStep (state -> answers seeding for port-conflict resume)', () => {
  // The companion fix to the runLocalProvisionStep change: preflight should
  // also seed `answers.postgresHostPort` from sticky `state.postgresHostPort`
  // BEFORE running its port-list check. Without this, a resume that had
  // previously resolved to 5433 would re-test 5432 (which is busy) and the
  // user would be asked to resolve a conflict that they already resolved in
  // the prior run. Or — if the host's 5432 happens to be free on the second
  // run — preflight would silently drop the sticky 5433 mapping and the
  // provision step would later write POSTGRES_HOST_PORT=5432 (see the
  // runLocalProvisionStep tests above).
  it('seeds answers.postgresHostPort from state.postgresHostPort on resume so the re-tested port list is correct', async () => {
    // Use an ephemeral port that's guaranteed free at test time, then put it
    // in state.postgresHostPort. We pass `ports: [freePort]` explicitly so the
    // test doesn't have to mock port 3000 (which on the developer's host is
    // usually taken by a real Next.js dev server) — the bug we're testing is
    // purely about whether the sticky state.postgresHostPort value gets
    // propagated into `answers.postgresHostPort` before preflight runs.
    const freePort = await findFreePort();

    const state = {
      ...defaultState(),
      target: 'local',
      deploymentName: 'cc-main',
      postgresHostPort: freePort, // sticky from a previous run
      // Domain set so this test (about postgresHostPort seeding, not tunnels)
      // doesn't also need to satisfy the needsTunnel=true cloudflared
      // requirement — that's covered by its own dedicated tests.
      domain: 'irrelevant.example.com',
    };
    const answers = { telnyxApiKey: 'KEY_test' }; // fresh — no postgresHostPort

    // lsof / ss / netstat probes for checkPorts — return "no matches" so all
    // ports look free (canContinue=true).
    const execImpl = async () => ({ stdout: '' });
    // Mock the Telnyx API key check (checkTelnyxApiKey GETs a 200 endpoint)
    // and the balance preflight check (checkTelnyxBalance GETs /v2/balance) —
    // without the balance branch this test's single canned response ({data:[]})
    // gets parsed as an empty balance object (available_credit=0), which fails
    // the $5 minimum-balance gate and aborts preflight for a reason unrelated
    // to what this test actually exercises (the port-seeding regression).
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/v2/balance')) {
        return { ok: true, status: 200, json: async () => ({ data: { balance: '100.00', credit_limit: '0.00', available_credit: '100.00', pending: '0.00' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };

    const io = {
      header: () => {}, log: () => {}, confirm: async () => true, select: async () => '',
      ask: async () => '', askSecret: async () => '', checkLine: () => {},
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const result = await runPreflightStep({
      state, io, answers, execImpl, fetchImpl, ports: [freePort],
    });
    assert.strictEqual(result.aborted, false,
      `runPreflightStep aborted unexpectedly; results: ${JSON.stringify(result.results)}`);

    // Check that the returned answers carries the seeded postgresHostPort
    // — that's what runWizard then threads into the provision step.
    assert.strictEqual(result.answers.postgresHostPort, freePort,
      `runPreflightStep should seed answers.postgresHostPort from state.postgresHostPort; got ${result.answers.postgresHostPort}`);
    // And that the preflight ports check used the sticky port (not the default 5432).
    const portsDetail = result.results.find((r) => r.key === 'ports')?.detail || '';
    assert.match(portsDetail, new RegExp(String(freePort)),
      `ports detail should mention ${freePort}, got: ${portsDetail}`);
    assert.doesNotMatch(portsDetail, /\b5432\b/, `ports detail must not regress to 5432 (the bug), got: ${portsDetail}`);
  });

  // Regression for the codex-review finding on PR #1149: needsTunnel must
  // survive the port-conflict rerun, not just the initial preflight call.
  // Without carrying it forward, a no-domain Local run that ALSO hits a busy
  // port would have its missing-cloudflared check silently downgraded from
  // "fail" back to a mere warning on the rerun — preflight would report
  // canContinue=true, and runLocalProvisionStep would then still try (and
  // fail) to start the now-"optional" tunnel right after.
  it('needsTunnel survives the preflight rerun after a resolved port conflict (regression)', async () => {
    const state = {
      ...defaultState(),
      target: 'local',
      deploymentName: 'cc-main',
      domain: '', // no domain => needsTunnel=true
    };
    const answers = { telnyxApiKey: 'sk_test_fake_key' };

    // First preflight call: port 5432 reports busy (triggers port-conflict
    // handoff). cloudflared is missing on both the first AND rerun probe —
    // if needsTunnel isn't carried into the rerun, this would be downgraded
    // to a warning and canContinue would flip to true.
    let call = 0;
    const execImpl = async (cmd) => {
      call += 1;
      if (String(cmd).includes('cloudflared')) {
        const err = new Error('command not found: cloudflared');
        err.code = 127;
        throw err;
      }
      if (String(cmd).includes('lsof') || String(cmd).includes('ss ') || String(cmd).includes('netstat')) {
        // Only report 5432 busy on the very first ports probe; the
        // port-conflict step itself probes a free replacement port
        // separately and must see it as free.
        if (call <= 2) return { stdout: '5432' };
        return { stdout: '' };
      }
      return { stdout: '' };
    };
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/v2/balance')) {
        return { ok: true, status: 200, json: async () => ({ data: { balance: '100.00', credit_limit: '0.00', available_credit: '100.00', pending: '0.00' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    const io = {
      header: () => {}, log: () => {}, confirm: async () => true, select: async () => 'different-host-port',
      ask: async () => '', askSecret: async () => '', checkLine: () => {},
      longStep: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
      step: () => ({ succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {} }),
    };

    const result = await runPreflightStep({ state, io, answers, execImpl, fetchImpl });

    // The rerun's cloudflared check must still be a hard "fail" (needsTunnel
    // carried forward), so overall preflight must NOT be able to continue.
    const rerunCloudflared = result.results.find((r) => r.key === 'cloudflared');
    assert.strictEqual(rerunCloudflared?.status, 'fail',
      `cloudflared check must stay a hard failure across the port-conflict rerun when needsTunnel=true; got status=${rerunCloudflared?.status}`);
    assert.strictEqual(result.aborted, true,
      'preflight must abort (not silently continue) when the tunnel-required cloudflared check fails on the rerun');
  });
});

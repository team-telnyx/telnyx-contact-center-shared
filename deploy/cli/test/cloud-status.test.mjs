import assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  terraformManagedResourceCount, probeAppHealth, printCloudStatus,
} from '../lib/cloud-status.mjs';

describe('cloud-status.mjs — terraformManagedResourceCount', () => {
  it('returns the line count of terraform state list output', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    try {
      const execImpl = async (cmd, args) => {
        assert.strictEqual(cmd, 'terraform');
        assert.strictEqual(args[0], 'state');
        assert.strictEqual(args[1], 'list');
        // Regression (Codex review on PR #1189): `terraform state list`
        // only accepts -state/-id, NOT -no-color/-input=false (those ARE
        // accepted by plan/apply/destroy, but not this subcommand) — the
        // real CLI rejects the call outright if they're present, which
        // this function's catch then silently downgrades to a warning.
        // Assert the args list is EXACTLY ['state', 'list'] with nothing
        // else appended.
        assert.strictEqual(args.length, 2);
        return { stdout: 'aws_instance.app\naws_security_group.app\ngoogle_compute_instance.app\n' };
      };
      const count = await terraformManagedResourceCount({ terraformDir, execImpl });
      assert.strictEqual(count, 3);
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('returns 0 for an empty state file (deployment fully destroyed but state preserved)', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    try {
      const execImpl = async () => ({ stdout: '' });
      const count = await terraformManagedResourceCount({ terraformDir, execImpl });
      assert.strictEqual(count, 0);
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('returns null when the terraformDir does not exist on disk (skip silently — no infra to query)', async () => {
    const count = await terraformManagedResourceCount({ terraformDir: '/tmp/this-does-not-exist-12345' });
    assert.strictEqual(count, null);
  });

  it('returns null when terraform state list fails (e.g. provider creds gone) instead of throwing', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    try {
      const execImpl = async () => { throw new Error('No valid credentials'); };
      const logs = [];
      const count = await terraformManagedResourceCount({
        terraformDir, execImpl, log: (m) => logs.push(m),
      });
      assert.strictEqual(count, null);
      assert.ok(logs.some((l) => l.includes('No valid credentials')));
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });
});

describe('cloud-status.mjs — probeAppHealth', () => {
  it('returns ok=true with statusCode/body on a 2xx response', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'healthy', database: 'connected' }),
    });
    const result = await probeAppHealth({ url: 'https://cc.example.com', fetchImpl });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.parsed.status, 'healthy');
    assert.strictEqual(result.parsed.database, 'connected');
  });

  it('returns ok=false with the status code on a non-2xx (so the operator sees the real problem, not just "down")', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });
    const result = await probeAppHealth({ url: 'https://cc.example.com', fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.statusCode, 503);
    assert.match(result.reason, /HTTP 503/);
  });

  it('returns ok=false with "no url" when url is empty (no deploy recorded yet — not a failure mode)', async () => {
    const result = await probeAppHealth({ url: '' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no url');
  });

  it('returns ok=false with a timeout reason when the endpoint never responds (AbortSignal.timeout fires)', async () => {
    const fetchImpl = async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    };
    const result = await probeAppHealth({ url: 'https://cc.example.com', fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /timeout/);
  });

  it('returns ok=false with the network error message when the fetch rejects (DNS, refused, etc.)', async () => {
    const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND cc.example.com'); };
    const result = await probeAppHealth({ url: 'https://cc.example.com', fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /ENOTFOUND/);
  });
});

describe('cloud-status.mjs — printCloudStatus', () => {
  it('renders AWS state with terraform outputs + managed-resource count + Telnyx resources', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '1.2.3.4' },
            app_url: { value: 'https://cc.example.com' },
            instance_id: { value: 'i-abc' },
            storage_bucket: { value: 'cc-main-abcd' },
          }),
        };
      }
      if (cmd === 'terraform' && args[0] === 'state' && args[1] === 'list') {
        return { stdout: 'aws_instance.app\naws_s3_bucket.app\naws_rds_instance.app\n' };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{"status":"healthy","database":"connected"}' });
    const logs = [];
    const state = {
      target: 'aws', region: 'us-east-2', deploymentName: 'cc-main',
      infra: {
        terraformDir,
        publicIp: '1.2.3.4', instanceIds: ['i-abc'], storageBucket: 'cc-main-abcd',
      },
      telnyx: { voiceAppId: 'app-1', outboundVoiceProfileId: 'ovp-1', sipConnectionId: 'conn-1', phoneNumber: '+14155550100' },
    };
    try {
      const result = await printCloudStatus({
        state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl, log: (m) => logs.push(m),
      });
      assert.strictEqual(result.managedCount, 3);
      assert.strictEqual(result.outputs.public_ip, '1.2.3.4');
      // Visible check: every important field appears in the rendered output.
      assert.ok(logs.some((l) => l.includes('cc.example.com')), 'expected app url in output');
      assert.ok(logs.some((l) => l.includes('Managed resources 3')), 'expected managed-resource count line');
      assert.ok(logs.some((l) => l.includes('Health           ✔')), 'expected a healthy probe line');
      assert.ok(logs.some((l) => l.includes('Voice app        app-1')), 'expected Telnyx voice app id');
      assert.ok(logs.some((l) => l.includes('+14155550100')), 'expected Telnyx phone number');
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('legacy AWS state (no infra.terraformDir/awsTopology) derives HA root from nodes >= 2, not always single', async () => {
    // Regression (Codex review on PR #1189): resolveTerraformRoot's legacy
    // fallback used to hardcode 'single' regardless of state.nodes, so an
    // old HA state file (predating infra.terraformDir/infra.awsTopology)
    // would silently point cc status at the WRONG (single-node) terraform
    // root — reading empty/nonexistent state instead of the real HA
    // deployment's. destroyAwsInfra's own legacy fallback already derives
    // 'ha' from `state.nodes >= 2`; cloud-status.mjs must mirror it.
    let capturedInitCwd = null;
    const execImpl = async (cmd, args, opts) => {
      if (cmd === 'terraform' && args[0] === 'init') { capturedInitCwd = opts?.cwd; return { stdout: '' }; }
      if (cmd === 'terraform' && args[0] === 'output') return { stdout: '{}' };
      if (cmd === 'terraform' && args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const state = {
      target: 'aws', region: 'us-east-2', deploymentName: 'cc-main', nodes: 2,
      infra: {}, // no terraformDir, no awsTopology — legacy shape
      telnyx: {},
    };
    await printCloudStatus({
      state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl: async () => ({ ok: false }), log: () => {},
    });
    assert.ok(capturedInitCwd && capturedInitCwd.endsWith('terraform/aws/multi-node'), `expected multi-node root, got: ${capturedInitCwd}`);
  });

  it('does not throw when terraform init fails (e.g. providers gone) — degrades to a warning + skips output reads', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') throw new Error('Failed to install provider');
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const logs = [];
    const state = {
      target: 'aws', region: 'us-east-2', deploymentName: 'cc-main',
      infra: { terraformDir },
    };
    try {
      const result = await printCloudStatus({
        state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
        log: (m) => logs.push(m),
      });
      assert.strictEqual(result.outputs, null);
      assert.ok(logs.some((l) => l.includes('terraform init failed')), 'expected a warning line about init failure');
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('does not throw when terraform output read fails — renders the rest of the report from state.infra alone', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') throw new Error('state file corrupted');
      if (cmd === 'terraform' && args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      throw new Error('unexpected');
    };
    const logs = [];
    const state = {
      target: 'aws', region: 'us-east-2', deploymentName: 'cc-main',
      infra: { terraformDir, publicIp: '1.2.3.4', appUrl: 'https://cc.example.com' },
    };
    try {
      const result = await printCloudStatus({
        state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"status":"healthy"}' }),
        log: (m) => logs.push(m),
      });
      assert.strictEqual(result.outputs, null);
      assert.ok(logs.some((l) => l.includes('Could not read terraform outputs')));
      // The appUrl should fall back to state.infra.appUrl.
      assert.ok(logs.some((l) => l.includes('cc.example.com')));
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('skips the /api/health probe entirely when there is no app URL (no deploy recorded yet)', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') throw new Error('no terraform dir');
      throw new Error('unexpected');
    };
    let healthProbed = false;
    const fetchImpl = async () => { healthProbed = true; return { ok: true, status: 200, text: async () => '' }; };
    const logs = [];
    const state = {
      target: 'aws', region: 'us-east-2', deploymentName: 'cc-main',
      infra: { /* no terraformDir, no appUrl */ },
    };
    await printCloudStatus({
      state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl, log: (m) => logs.push(m),
    });
    assert.strictEqual(healthProbed, false, 'expected no health probe when no appUrl is known');
  });

  it('renders GCP state with terraform outputs + project id + managed-resource count', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '5.6.7.8' },
            app_url: { value: 'http://5.6.7.8' },
            instance_name: { value: 'cc-main-gcp' },
            storage_bucket: { value: 'cc-main-gcp-bucket' },
          }),
        };
      }
      if (cmd === 'terraform' && args[0] === 'state' && args[1] === 'list') {
        return { stdout: 'google_compute_instance.app\ngoogle_storage_bucket.app\n' };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{"status":"healthy"}' });
    const logs = [];
    const state = {
      target: 'gcp', region: 'us-central1', deploymentName: 'cc-main-gcp',
      infra: {
        terraformDir, gcpProjectId: 'my-gcp-project',
        publicIp: '5.6.7.8', instanceName: 'cc-main-gcp', storageBucket: 'cc-main-gcp-bucket',
      },
      telnyx: { voiceAppId: 'app-2', outboundVoiceProfileId: 'ovp-2', sipConnectionId: 'conn-2', phoneNumber: '+141****0200' },
    };
    try {
      const result = await printCloudStatus({
        state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl, log: (m) => logs.push(m),
      });
      assert.strictEqual(result.managedCount, 2);
      assert.ok(logs.some((l) => l.includes('GCP project      my-gcp-project')), 'expected GCP project id line');
      assert.ok(logs.some((l) => l.includes('Instance name    cc-main-gcp')), 'expected instance name line');
      assert.ok(logs.some((l) => l.includes('Storage bucket   cc-main-gcp-bucket')), 'expected storage bucket line');
      assert.ok(logs.some((l) => l.includes('Health           ✔')), 'expected a healthy probe line');
      assert.ok(logs.some((l) => l.includes('+141****0200')), 'expected Telnyx phone number');
      // AWS-only line should not appear for a GCP target.
      assert.ok(!logs.some((l) => l.includes('AWS topology')), 'AWS topology line must not render for gcp target');
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('renders HTTPS LB IP + Cloud DNS status lines for a GCP deployment with the Load Balancer enabled', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') return { stdout: '{}' };
      if (cmd === 'terraform' && args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const state = {
      target: 'gcp', region: 'us-central1', deploymentName: 'cc-main-gcp',
      infra: {
        terraformDir, gcpProjectId: 'my-gcp-project',
        lbEnabled: true, lbIp: '34.8.8.8', gcpDnsManaged: true, gcpDnsZoneName: 'cc-example-zone',
      },
      telnyx: {},
    };
    const logs = [];
    try {
      await printCloudStatus({
        state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl: async () => ({ ok: false }), log: (m) => logs.push(m),
      });
      assert.ok(logs.some((l) => l.includes('HTTPS LB IP      34.8.8.8')), 'expected HTTPS LB IP line');
      assert.ok(logs.some((l) => l.includes('Cloud DNS        managed (zone "cc-example-zone")')), 'expected Cloud DNS managed line');
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('omits HTTPS LB / Cloud DNS lines entirely for a GCP deployment without the Load Balancer enabled', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') return { stdout: '{}' };
      if (cmd === 'terraform' && args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const state = {
      target: 'gcp', region: 'us-central1', deploymentName: 'cc-main-gcp',
      infra: { terraformDir, gcpProjectId: 'my-gcp-project' },
      telnyx: {},
    };
    const logs = [];
    try {
      await printCloudStatus({
        state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl: async () => ({ ok: false }), log: (m) => logs.push(m),
      });
      assert.ok(!logs.some((l) => l.includes('HTTPS LB IP')), 'HTTPS LB IP line must not render when lbEnabled is falsy');
      assert.ok(!logs.some((l) => l.includes('Cloud DNS')), 'Cloud DNS line must not render when lbEnabled is falsy');
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });

  it('renders a health warning line (not an exception) when the probe fails', async () => {
    const terraformDir = await mkdtemp(join(tmpdir(), 'cc-cstatus-tf-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return { stdout: JSON.stringify({ app_url: { value: 'https://cc.example.com' } }) };
      }
      if (cmd === 'terraform' && args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      throw new Error('unexpected');
    };
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const logs = [];
    const state = {
      target: 'aws', region: 'us-east-2', deploymentName: 'cc-main',
      infra: { terraformDir },
    };
    try {
      await printCloudStatus({
        state, deployDir: '/tmp/fake-deploy', execImpl, fetchImpl, log: (m) => logs.push(m),
      });
      assert.ok(logs.some((l) => l.includes('Health') && l.includes('ECONNREFUSED')), 'expected a warning-style health line');
    } finally {
      await rm(terraformDir, { recursive: true, force: true });
    }
  });
});

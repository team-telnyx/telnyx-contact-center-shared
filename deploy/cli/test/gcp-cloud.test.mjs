import assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  checkGcpCloudPreflight, writeGcpTfvars, provisionGcpInfra, destroyGcpInfra, redeployGcpApp,
  updateGcpEnvSecret,
  describeManagedCertificate, waitForManagedCertificate,
} from '../lib/gcp-cloud.mjs';

function fakeSpawnFactory({ exitCode = 0, stdoutChunks = ['Apply complete!\n'] } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk));
      child.emit('close', exitCode);
    });
    return child;
  };
}

function makeIo(overrides = {}) {
  const logs = [];
  return {
    log: (...args) => logs.push(args.join(' ')),
    confirm: overrides.confirm || (async () => true),
    step: (label) => {
      logs.push(`STEP: ${label}`);
      return {
        succeed: (m) => logs.push(`OK: ${m}`),
        fail: (m) => logs.push(`FAIL: ${m}`),
        warn: (m) => logs.push(`WARN: ${m}`),
        info: (m) => logs.push(m),
      };
    },
    longStep: (label) => {
      logs.push(`STEP: ${label}`);
      return {
        succeed: (m) => logs.push(`OK: ${m}`),
        fail: (m) => logs.push(`FAIL: ${m}`),
        warn: (m) => logs.push(`WARN: ${m}`),
        info: (m) => logs.push(m),
        stop: () => {},
      };
    },
    _logs: logs,
  };
}

describe('gcp-cloud.mjs — checkGcpCloudPreflight', () => {
  it('reports terraform ok, gcloud ok, auth ok, ADC ok, and project ok when everything is reachable', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'gcloud' && args[0] === '--version') return { stdout: 'Google Cloud SDK 500.0.0\n' };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([{ account: 'me@example.com', status: 'ACTIVE' }]) };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'application-default') return { stdout: 'ya29.token\n' };
      if (cmd === 'gcloud' && args[0] === 'projects') return { stdout: JSON.stringify({ lifecycleState: 'ACTIVE' }) };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const results = await checkGcpCloudPreflight({ projectId: 'my-project', execImpl });
    assert.strictEqual(results.find((r) => r.key === 'terraform').status, 'ok');
    assert.strictEqual(results.find((r) => r.key === 'gcloud').status, 'ok');
    assert.strictEqual(results.find((r) => r.key === 'gcloud-auth').status, 'ok');
    assert.strictEqual(results.find((r) => r.key === 'gcloud-adc').status, 'ok');
    assert.strictEqual(results.find((r) => r.key === 'gcp-project').status, 'ok');
  });

  it('fails fast (no auth/project probes) when gcloud CLI itself is missing', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'gcloud') throw new Error('command not found');
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const results = await checkGcpCloudPreflight({ execImpl });
    assert.strictEqual(results.find((r) => r.key === 'gcloud').status, 'fail');
    assert.ok(!results.some((r) => r.key === 'gcloud-auth'), 'should not probe auth once gcloud itself is missing');
  });

  it('fails gcloud-auth when there is no active account, and stops before ADC/project checks', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'gcloud' && args[0] === '--version') return { stdout: 'Google Cloud SDK 500.0.0\n' };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([]) };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const results = await checkGcpCloudPreflight({ execImpl });
    assert.strictEqual(results.find((r) => r.key === 'gcloud-auth').status, 'fail');
    assert.ok(!results.some((r) => r.key === 'gcloud-adc'));
  });

  it('flags terraform version too old', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform') return { stdout: JSON.stringify({ terraform_version: '1.2.0' }) };
      if (cmd === 'gcloud' && args[0] === '--version') return { stdout: 'Google Cloud SDK 500.0.0\n' };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([{ account: 'me@example.com', status: 'ACTIVE' }]) };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'application-default') return { stdout: 'token\n' };
      throw new Error('unexpected');
    };
    const results = await checkGcpCloudPreflight({ execImpl });
    assert.strictEqual(results.find((r) => r.key === 'terraform').status, 'fail');
  });

  it('fails gcp-project when the project cannot be described', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'gcloud' && args[0] === '--version') return { stdout: 'Google Cloud SDK 500.0.0\n' };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([{ account: 'me@example.com', status: 'ACTIVE' }]) };
      if (cmd === 'gcloud' && args[0] === 'auth' && args[1] === 'application-default') return { stdout: 'token\n' };
      if (cmd === 'gcloud' && args[0] === 'projects') throw new Error('PERMISSION_DENIED');
      throw new Error('unexpected');
    };
    const results = await checkGcpCloudPreflight({ projectId: 'nonexistent-project', execImpl });
    assert.strictEqual(results.find((r) => r.key === 'gcp-project').status, 'fail');
  });
});

describe('gcp-cloud.mjs — writeGcpTfvars', () => {
  it('maps wizard state fields onto the exact tfvars keys the terraform root expects', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-tfvars-test-'));
    const state = {
      region: 'us-central1', deploymentName: 'cc-main', domain: 'cc.example.com',
      infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' },
      portainer: { agentEnabled: true, agentPort: 9002, serverCidrs: ['10.0.0.5/32'] },
    };
    const result = await writeGcpTfvars({ deployDir, state });
    assert.strictEqual(result.vars.project_id, 'my-project');
    assert.strictEqual(result.vars.region, 'us-central1');
    assert.strictEqual(result.vars.zone, 'us-central1-a');
    assert.strictEqual(result.vars.deployment_name, 'cc-main');
    assert.strictEqual(result.vars.domain, 'cc.example.com');
    assert.strictEqual(result.vars.portainer_agent_enabled, true);
    assert.strictEqual(result.vars.portainer_agent_port, 9002);
    assert.deepStrictEqual(result.vars.portainer_server_cidrs, ['10.0.0.5/32']);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('defaults machine_type/db_tier and blank domain/portainer when unset', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-tfvars-test-'));
    const state = {
      region: 'us-central1', deploymentName: 'cc-main',
      infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' },
    };
    const result = await writeGcpTfvars({ deployDir, state });
    assert.strictEqual(result.vars.machine_type, 'e2-standard-2');
    assert.strictEqual(result.vars.db_tier, 'db-custom-1-3840');
    assert.strictEqual(result.vars.domain, '');
    assert.strictEqual(result.vars.portainer_agent_enabled, false);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('writes lb_enabled=true when state.infra.lbEnabled is true (Phase 3 HTTPS Load Balancer opt-in)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-tfvars-test-'));
    const state = {
      deploymentName: 'cc-main', region: 'us-central1', domain: 'cc.example.com',
      infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a', lbEnabled: true },
    };
    const result = await writeGcpTfvars({ deployDir, state });
    assert.strictEqual(result.vars.lb_enabled, true);
    assert.strictEqual(result.vars.domain, 'cc.example.com');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('defaults lb_enabled to false when unset (Phase 1/2 behavior unchanged)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-tfvars-test-'));
    const state = {
      deploymentName: 'cc-main', region: 'us-central1',
      infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' },
    };
    const result = await writeGcpTfvars({ deployDir, state });
    assert.strictEqual(result.vars.lb_enabled, false);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('writes dns_managed_zone only when BOTH lbEnabled and gcpDnsManaged are true (regression: Cloud DNS automation)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-tfvars-test-'));
    const state = {
      deploymentName: 'cc-main', region: 'us-central1', domain: 'cc.example.com',
      infra: {
        gcpProjectId: 'my-project', gcpZone: 'us-central1-a',
        lbEnabled: true, gcpDnsManaged: true, gcpDnsZoneName: 'cc-example-zone',
      },
    };
    const result = await writeGcpTfvars({ deployDir, state });
    assert.strictEqual(result.vars.dns_managed_zone, 'cc-example-zone');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('leaves dns_managed_zone blank when gcpDnsManaged is false even if a zone name was resolved (operator declined to overwrite an existing record)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-tfvars-test-'));
    const state = {
      deploymentName: 'cc-main', region: 'us-central1', domain: 'cc.example.com',
      infra: {
        gcpProjectId: 'my-project', gcpZone: 'us-central1-a',
        lbEnabled: true, gcpDnsManaged: false, gcpDnsZoneName: 'cc-example-zone',
      },
    };
    const result = await writeGcpTfvars({ deployDir, state });
    assert.strictEqual(result.vars.dns_managed_zone, '');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('leaves dns_managed_zone blank when lbEnabled is false, even if gcpDnsManaged/gcpDnsZoneName are somehow set (defensive gate)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-tfvars-test-'));
    const state = {
      deploymentName: 'cc-main', region: 'us-central1', domain: 'cc.example.com',
      infra: {
        gcpProjectId: 'my-project', gcpZone: 'us-central1-a',
        lbEnabled: false, gcpDnsManaged: true, gcpDnsZoneName: 'cc-example-zone',
      },
    };
    const result = await writeGcpTfvars({ deployDir, state });
    assert.strictEqual(result.vars.dns_managed_zone, '');
    await rm(deployDir, { recursive: true, force: true });
  });
});

describe('gcp-cloud.mjs — describeManagedCertificate / waitForManagedCertificate', () => {
  it('describeManagedCertificate returns the managed.status and domainStatus from gcloud describe', async () => {
    const execImpl = async (cmd, args) => {
      assert.strictEqual(cmd, 'gcloud');
      assert.deepStrictEqual(args.slice(0, 3), ['compute', 'ssl-certificates', 'describe']);
      return {
        stdout: JSON.stringify({
          managed: { status: 'PROVISIONING', domainStatus: { 'cc.example.com': 'PROVISIONING' } },
        }),
      };
    };
    const result = await describeManagedCertificate({ certName: 'cc-main-cert', project: 'my-project', execImpl });
    assert.strictEqual(result.status, 'PROVISIONING');
    assert.deepStrictEqual(result.domainStatus, { 'cc.example.com': 'PROVISIONING' });
  });

  it('describeManagedCertificate returns status:null (never throws) when the gcloud call fails transiently', async () => {
    const execImpl = async () => { throw new Error('resource not found yet'); };
    const result = await describeManagedCertificate({ certName: 'cc-main-cert', project: 'my-project', execImpl });
    assert.strictEqual(result.status, null);
  });

  it('waitForManagedCertificate resolves issued:true as soon as status becomes ACTIVE', async () => {
    let calls = 0;
    const execImpl = async () => {
      calls += 1;
      const status = calls < 3 ? 'PROVISIONING' : 'ACTIVE';
      return { stdout: JSON.stringify({ managed: { status } }) };
    };
    const result = await waitForManagedCertificate({
      certName: 'cc-main-cert', project: 'my-project', execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.issued, true);
    assert.strictEqual(result.status, 'ACTIVE');
    assert.strictEqual(calls, 3);
  });

  it('waitForManagedCertificate stops early (terminal:true) on a FAILED_NOT_VISIBLE status instead of polling until timeout', async () => {
    const execImpl = async () => ({ stdout: JSON.stringify({ managed: { status: 'FAILED_NOT_VISIBLE' } }) });
    const result = await waitForManagedCertificate({
      certName: 'cc-main-cert', project: 'my-project', execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.issued, false);
    assert.strictEqual(result.terminal, true);
    assert.strictEqual(result.status, 'FAILED_NOT_VISIBLE');
  });

  it('waitForManagedCertificate gives up after the timeout with terminal:false when status never resolves', async () => {
    let now = 0;
    const execImpl = async () => ({ stdout: JSON.stringify({ managed: { status: 'PROVISIONING' } }) });
    const result = await waitForManagedCertificate({
      certName: 'cc-main-cert', project: 'my-project', execImpl,
      timeoutMs: 100, intervalMs: 10,
      now: () => { now += 40; return now; },
      sleep: async () => {},
    });
    assert.strictEqual(result.issued, false);
    assert.strictEqual(result.terminal, false);
    assert.strictEqual(result.status, 'PROVISIONING');
  });
});

describe('gcp-cloud.mjs — provisionGcpInfra', () => {
  function baseExecImpl({ repoRoot } = {}) {
    return async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') {
        const outputs = {
          public_ip: { value: '1.2.3.4' },
          app_url: { value: 'http://1.2.3.4.nip.io' },
          instance_name: { value: 'cc-main-app' },
          instance_id: { value: '123456789' },
          storage_bucket: { value: 'cc-main-abcd' },
          db_secret_name: { value: 'projects/1/secrets/cc-main-db-credentials' },
          app_env_secret_name: { value: 'projects/1/secrets/cc-main-app-env' },
          storage_hmac_secret_name: { value: 'projects/1/secrets/cc-main-storage-hmac' },
        };
        return { stdout: JSON.stringify(outputs) };
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
        throw new Error(`unexpected secret access: ${secretName}`);
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') return { stdout: '' };
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        await writeFile(join(repoRoot, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'gcloud' && args[0] === 'storage') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh') {
        if (args.includes('true')) return { stdout: '' }; // waitForIapSshReady probe
        return { stdout: 'DEPLOY_OK image=telnyx-contact-center:cc-main-abc' };
      }
      throw new Error(`unexpected in provisionGcpInfra test: ${cmd} ${args.join(' ')}`);
    };
  }

  it('aborts cleanly when terraform plan fails', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'plan') throw new Error('plan boom');
      throw new Error('unexpected');
    };
    const io = makeIo();
    const result = await provisionGcpInfra({
      state: { deploymentName: 'cc-main', region: 'us-central1', infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' } },
      io, answers: { baseUrl: 'http://1.2.3.4.nip.io' }, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, true);
  });

  it('aborts without applying when the user declines the plan confirmation', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'plan') return { stdout: 'Plan: 8 to add, 0 to change, 0 to destroy.\n' };
      throw new Error(`should not reach apply: ${args.join(' ')}`);
    };
    const io = makeIo({ confirm: async () => false });
    const result = await provisionGcpInfra({
      state: { deploymentName: 'cc-main', region: 'us-central1', infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' } },
      io, answers: { baseUrl: 'http://1.2.3.4.nip.io' }, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, true);
  });

  it('full happy path: init -> plan -> apply -> populate secret -> build -> deploy over IAP SSH', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 12 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionGcpInfra({
      state: { deploymentName: 'cc-main', region: 'us-central1', infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' } },
      io, answers: { baseUrl: 'http://1.2.3.4.nip.io', envValues: { TELNYX_API_KEY: 'x' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.state.infra.publicIp, '1.2.3.4');
    assert.strictEqual(result.state.infra.instanceName, 'cc-main-app');
    assert.strictEqual(result.state.infra.appEnvSecretName, 'projects/1/secrets/cc-main-app-env');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('passes only the BARE secret id (never the fully-qualified projects/.../secrets/... name) to every gcloud secrets call and to the remote IAP SSH deploy env (regression: 404 on real cc-gcp1 E2E run, 2026-07-09)', async () => {
    // terraform outputs (db_secret_name, app_env_secret_name,
    // storage_hmac_secret_name — see baseExecImpl above) all come back as
    // fully-qualified Secret Manager resource names
    // ("projects/1/secrets/<id>"). `gcloud secrets versions access/add`
    // rejects that shape for --secret / the positional SECRET arg — it
    // builds "secrets/projects/1/secrets/<id>" and 404s. Assert every
    // gcloud secrets invocation, AND the APP_ENV_SECRET env var forwarded
    // to the remote deploy script over IAP SSH, only ever carry the bare id.
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    const secretArgsSeen = [];
    let sshEnvSeen = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 12 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'gcloud' && args[0] === 'secrets') {
        secretArgsSeen.push([...args]);
      }
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh' && args.includes('--command')) {
        const script = args[args.indexOf('--command') + 1];
        const match = script.match(/export APP_ENV_SECRET=(\S+)/);
        if (match) sshEnvSeen = match[1];
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionGcpInfra({
      state: { deploymentName: 'cc-main', region: 'us-central1', infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' } },
      io, answers: { baseUrl: 'http://1.2.3.4.nip.io', envValues: { TELNYX_API_KEY: 'x' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.ok(secretArgsSeen.length > 0, 'expected at least one gcloud secrets call');
    for (const args of secretArgsSeen) {
      const flat = args.join(' ');
      assert.ok(!flat.includes('projects/1/secrets/'), `gcloud secrets call must use the bare id, not the fully-qualified name: ${flat}`);
    }
    assert.ok(sshEnvSeen, 'expected APP_ENV_SECRET to be exported in the remote deploy script');
    assert.ok(!sshEnvSeen.includes('projects/1/secrets/'), `APP_ENV_SECRET forwarded over IAP SSH must be the bare id: ${sshEnvSeen}`);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('writes STORAGE_* and POSTGRES_SSL=true into the app/env secret from the real Cloud SQL + HMAC secrets', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    let secretDataText = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 12 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') {
        // The env text is written to a temp file and passed as --data-file
        // (execFile has no stdin-piping support) — read it back here so the
        // test can assert on its contents.
        const dataFileIdx = args.indexOf('--data-file');
        const { readFile } = await import('node:fs/promises');
        secretDataText = await readFile(args[dataFileIdx + 1], 'utf8');
        return { stdout: '' };
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionGcpInfra({
      state: { deploymentName: 'cc-main', region: 'us-central1', infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' } },
      io, answers: { baseUrl: 'http://1.2.3.4.nip.io', envValues: { TELNYX_API_KEY: 'x' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.ok(secretDataText, 'expected secrets versions add to have been called with env text');
    assert.match(secretDataText, /^POSTGRES_SSL=true$/m);
    assert.match(secretDataText, /^POSTGRES_HOST=10\.1\.2\.3$/m);
    assert.match(secretDataText, /^STORAGE_PROVIDER=s3$/m);
    assert.match(secretDataText, /^STORAGE_BUCKET=cc-main-abcd$/m);
    assert.match(secretDataText, /^STORAGE_ENDPOINT=https:\/\/storage\.googleapis\.com$/m);
    assert.match(secretDataText, /^STORAGE_ACCESS_KEY=GOOG1EXAMPLE$/m);
    assert.match(secretDataText, /^STORAGE_SECRET_KEY=hmac-secret-value$/m);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('builds the client bundle against the external https:// URL (answers.baseUrl), not terraform\'s plain-http app_url (regression: Codex review on PR #1188)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    let capturedBuildArgs = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 12 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'docker' && args[0] === 'build') {
        const buildArgIdxs = args.reduce((acc, a, i) => (a === '--build-arg' ? [...acc, i] : acc), []);
        capturedBuildArgs = Object.fromEntries(buildArgIdxs.map((i) => args[i + 1].split(/=(.*)/s).slice(0, 2)));
        return { stdout: '' };
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    // Terraform's app_url output (from baseExecImpl) is plain
    // http://1.2.3.4.nip.io — a real domain deployment's answers.baseUrl
    // (resolved by the wizard's resolveBaseUrl) is always https://.
    const result = await provisionGcpInfra({
      state: { deploymentName: 'cc-main', region: 'us-central1', domain: 'cc.example.com', infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a' } },
      io, answers: { baseUrl: 'https://cc.example.com', envValues: { TELNYX_API_KEY: 'x' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.ok(capturedBuildArgs, 'expected docker build to have been called with --build-arg flags');
    assert.strictEqual(capturedBuildArgs.NEXT_PUBLIC_BASE_URL, 'https://cc.example.com');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('sets WS_BASE_URL to wss://ws.<domain> in the app/env secret when the HTTPS Load Balancer is enabled (regression: Codex review on PR #1191)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    let secretDataText = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 12 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'terraform' && args[0] === 'output') {
        return {
          stdout: JSON.stringify({
            public_ip: { value: '1.2.3.4' },
            app_url: { value: 'https://cc.example.com' },
            instance_name: { value: 'cc-main-app' },
            instance_id: { value: '123456789' },
            storage_bucket: { value: 'cc-main-abcd' },
            db_secret_name: { value: 'projects/1/secrets/cc-main-db-credentials' },
            app_env_secret_name: { value: 'projects/1/secrets/cc-main-app-env' },
            storage_hmac_secret_name: { value: 'projects/1/secrets/cc-main-storage-hmac' },
            lb_ip: { value: '35.1.2.3' },
            cert_name: { value: 'cc-main-cert' },
          }),
        };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') {
        const dataFileIdx = args.indexOf('--data-file');
        const { readFile } = await import('node:fs/promises');
        secretDataText = await readFile(args[dataFileIdx + 1], 'utf8');
        return { stdout: '' };
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionGcpInfra({
      state: {
        deploymentName: 'cc-main', region: 'us-central1', domain: 'cc.example.com',
        infra: { gcpProjectId: 'my-project', gcpZone: 'us-central1-a', lbEnabled: true },
      },
      io, answers: { baseUrl: 'https://cc.example.com', envValues: { TELNYX_API_KEY: 'x' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.ok(secretDataText, 'expected secrets versions add to have been called with env text');
    assert.match(secretDataText, /^WS_BASE_URL=wss:\/\/ws\.cc\.example\.com$/m);
    await rm(deployDir, { recursive: true, force: true });
  });
});

describe('gcp-cloud.mjs — redeployGcpApp', () => {
  function baseExecImpl({ repoRoot } = {}) {
    return async (cmd, args) => {
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') {
        return { stdout: 'NEXT_PUBLIC_BASE_URL=http://1.2.3.4.nip.io\nNEXT_PUBLIC_TELNYX_WEBRTC_REGION=auto\nTELNYX_API_KEY=abc123\n' };
      }
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        await writeFile(join(repoRoot, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'gcloud' && args[0] === 'storage') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh') {
        if (args.includes('true')) return { stdout: '' }; // waitForIapSshReady probe
        return { stdout: 'DEPLOY_OK image=telnyx-contact-center:cc-main-abc' };
      }
      throw new Error(`unexpected in redeployGcpApp test: ${cmd} ${args.join(' ')}`);
    };
  }

  it('throws a clear error instead of silently no-op-ing when no infra is recorded yet', async () => {
    const io = makeIo();
    await assert.rejects(
      () => redeployGcpApp({ state: { deploymentName: 'cc-main', region: 'us-central1', infra: {} }, io, deployDir: '/deploy' }),
      /run `cc up` first/,
    );
  });

  it('never calls terraform (init/plan/apply) — only reads the existing secret, builds, and deploys over IAP SSH', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let terraformCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform') { terraformCalled = true; return { stdout: '' }; }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await redeployGcpApp({
      state: {
        deploymentName: 'cc-main', region: 'us-central1',
        infra: {
          gcpProjectId: 'my-project', gcpZone: 'us-central1-a', instanceName: 'cc-main-app',
          storageBucket: 'cc-main-abcd', appEnvSecretName: 'projects/1/secrets/cc-main-app-env', appUrl: 'http://1.2.3.4.nip.io',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(terraformCalled, false, 'redeployGcpApp must never invoke terraform — infra is never touched');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('deploys over IAP SSH to the recorded instance name', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let sshInstanceName = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh' && !args.includes('true')) {
        sshInstanceName = args[2];
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await redeployGcpApp({
      state: {
        deploymentName: 'cc-main', region: 'us-central1',
        infra: {
          gcpProjectId: 'my-project', gcpZone: 'us-central1-a', instanceName: 'cc-main-app',
          storageBucket: 'cc-main-abcd', appEnvSecretName: 'projects/1/secrets/cc-main-app-env', appUrl: 'http://1.2.3.4.nip.io',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(sshInstanceName, 'cc-main-app');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('does not rewrite the app/env secret — only reads it (secrets versions add is never called)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let secretsAddCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') {
        secretsAddCalled = true;
        return { stdout: '' };
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await redeployGcpApp({
      state: {
        deploymentName: 'cc-main', region: 'us-central1',
        infra: {
          gcpProjectId: 'my-project', gcpZone: 'us-central1-a', instanceName: 'cc-main-app',
          storageBucket: 'cc-main-abcd', appEnvSecretName: 'projects/1/secrets/cc-main-app-env', appUrl: 'http://1.2.3.4.nip.io',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(secretsAddCalled, false, 'redeployGcpApp must never write the app/env secret — it only reships a new build');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('aborts cleanly (no build attempted) when the current app/env secret cannot be read', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') throw new Error('PERMISSION_DENIED');
      throw new Error(`should not reach: ${cmd} ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await redeployGcpApp({
      state: {
        deploymentName: 'cc-main', region: 'us-central1',
        infra: {
          gcpProjectId: 'my-project', gcpZone: 'us-central1-a', instanceName: 'cc-main-app',
          storageBucket: 'cc-main-abcd', appEnvSecretName: 'projects/1/secrets/cc-main-app-env',
        },
      },
      io, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, true);
    assert.ok(io._logs.some((l) => l.includes('PERMISSION_DENIED')));
  });

  it('preserves every NEXT_PUBLIC_* baked build arg from the current secret, not just base URL/WebRTC region (regression: Codex review on PR #1190)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-gcp-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let capturedBuildArgs = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') {
        return {
          stdout: [
            'NEXT_PUBLIC_BASE_URL=https://cc.example.com',
            'NEXT_PUBLIC_TELNYX_WEBRTC_REGION=auto',
            'NEXT_PUBLIC_RECAPTCHA_SITE_KEY=recaptcha-key-abc',
            'NEXT_PUBLIC_STREAMING_PORT=3001',
            'NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES=true',
            'TELNYX_API_KEY=abc123',
          ].join('\n'),
        };
      }
      if (cmd === 'docker' && args[0] === 'build') {
        const buildArgIdxs = args.reduce((acc, a, i) => (a === '--build-arg' ? [...acc, i] : acc), []);
        capturedBuildArgs = Object.fromEntries(buildArgIdxs.map((i) => args[i + 1].split(/=(.*)/s).slice(0, 2)));
        return { stdout: '' };
      }
      if (cmd === 'bash') {
        await writeFile(join(repoRoot, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'gcloud' && args[0] === 'storage') return { stdout: '' };
      if (cmd === 'gcloud' && args[0] === 'compute' && args[1] === 'ssh') {
        if (args.includes('true')) return { stdout: '' };
        return { stdout: 'DEPLOY_OK image=telnyx-contact-center:cc-main-abc' };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await redeployGcpApp({
      state: {
        deploymentName: 'cc-main', region: 'us-central1',
        infra: {
          gcpProjectId: 'my-project', gcpZone: 'us-central1-a', instanceName: 'cc-main-app',
          storageBucket: 'cc-main-abcd', appEnvSecretName: 'projects/1/secrets/cc-main-app-env', appUrl: 'https://cc.example.com',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.ok(capturedBuildArgs, 'expected docker build to have been called with --build-arg flags');
    // Every NEXT_PUBLIC_* the Dockerfile bakes in must survive a redeploy —
    // previously only BASE_URL/WEBRTC_REGION were forwarded, silently
    // blanking RECAPTCHA_SITE_KEY / STREAMING_PORT / PREFETCH_ICE_CANDIDATES.
    assert.strictEqual(capturedBuildArgs.NEXT_PUBLIC_BASE_URL, 'https://cc.example.com');
    assert.strictEqual(capturedBuildArgs.NEXT_PUBLIC_TELNYX_WEBRTC_REGION, 'auto');
    assert.strictEqual(capturedBuildArgs.NEXT_PUBLIC_RECAPTCHA_SITE_KEY, 'recaptcha-key-abc');
    assert.strictEqual(capturedBuildArgs.NEXT_PUBLIC_STREAMING_PORT, '3001');
    assert.strictEqual(capturedBuildArgs.NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES, 'true');
    await rm(deployDir, { recursive: true, force: true });
  });
});

describe('gcp-cloud.mjs — destroyGcpInfra', () => {
  it('reports nothing-to-destroy without prompting when the plan has zero resources', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      if (args[0] === 'plan') return { stdout: 'No changes. Your infrastructure matches the configuration.\n' };
      throw new Error('should not reach confirm/destroy');
    };
    const io = makeIo({ confirm: async () => { throw new Error('should not be called'); } });
    const result = await destroyGcpInfra({
      state: { deploymentName: 'cc-main' }, io, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.destroyed, 0);
  });

  it('aborts without destroying when the user declines the confirmation', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      if (args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 9 to destroy.\n' };
      throw new Error(`should not reach destroy: ${args.join(' ')}`);
    };
    const io = makeIo({ confirm: async () => false });
    const result = await destroyGcpInfra({
      state: { deploymentName: 'cc-main' }, io, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, true);
  });

  it('full happy path: init -> plan -destroy -> confirm -> terraform destroy', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'state' && args[1] === 'list') return { stdout: '' };
      if (args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 9 to destroy.\n' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await destroyGcpInfra({
      state: { deploymentName: 'cc-main' }, io, deployDir: '/deploy', execImpl, spawnImpl: fakeSpawnFactory(),
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.destroyed, 9);
  });

  it('removes google_sql_database/google_sql_user/google_service_networking_connection from state BEFORE planning, so a deployment whose state predates their ABANDON deletion_policy fixes does not hit the "role cannot be dropped" / "being accessed by other users" / "still using this connection" errors (regression: two real cc destroy failures on cc-gcp1, 2026-07-09)', async () => {
    const stateRmCalls = [];
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'state' && args[1] === 'list') {
        return {
          stdout: [
            'module.network.google_compute_network.main',
            'module.network.google_service_networking_connection.private_services',
            'module.database.google_sql_database_instance.main',
            'module.database.google_sql_database.main',
            'module.database.google_sql_user.app',
            'module.storage.google_storage_bucket.main',
          ].join('\n'),
        };
      }
      if (args[0] === 'state' && args[1] === 'rm') {
        stateRmCalls.push(args[2]);
        return { stdout: '' };
      }
      if (args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 10 to destroy.\n' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await destroyGcpInfra({
      state: { deploymentName: 'cc-main' }, io, deployDir: '/deploy', execImpl, spawnImpl: fakeSpawnFactory(),
    });
    assert.strictEqual(result.aborted, false);
    assert.deepEqual(
      [...stateRmCalls].sort(),
      [
        'module.database.google_sql_database.main',
        'module.database.google_sql_user.app',
        'module.network.google_service_networking_connection.private_services',
      ].sort(),
    );
  });

  it('is a no-op for the reconciliation step when neither address is present in state (does not call state rm, does not fail)', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'state' && args[1] === 'list') {
        return { stdout: 'module.network.google_compute_network.main\n' };
      }
      if (args[0] === 'state' && args[1] === 'rm') {
        throw new Error('should not be called — neither legacy address is present');
      }
      if (args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 1 to destroy.\n' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await destroyGcpInfra({
      state: { deploymentName: 'cc-main' }, io, deployDir: '/deploy', execImpl, spawnImpl: fakeSpawnFactory(),
    });
    assert.strictEqual(result.aborted, false);
  });

  it('never blocks destroy when the reconciliation step itself fails (e.g. state list errors out)', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'state' && args[1] === 'list') throw new Error('some transient terraform error');
      if (args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 1 to destroy.\n' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await destroyGcpInfra({
      state: { deploymentName: 'cc-main' }, io, deployDir: '/deploy', execImpl, spawnImpl: fakeSpawnFactory(),
    });
    assert.strictEqual(result.aborted, false);
  });
});

describe('gcp-cloud.mjs — updateGcpEnvSecret', () => {
  it('throws a clear error when no app/env secret is recorded yet', async () => {
    await assert.rejects(
      () => updateGcpEnvSecret({ state: { infra: {} }, envUpdates: { TELNYX_CALL_CONTROL_ID: 'x' } }),
      /run `cc up` first/,
    );
  });

  it('read-merge-writes: preserves every existing key not present in envUpdates, overwrites only the keys that are', async () => {
    let secretDataText = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access') {
        return { stdout: 'TELNYX_API_KEY=abc123\nTELNYX_AI_API_KEY=rotated-by-hand\nTELNYX_CALL_CONTROL_ID=old-voice-app-id\n' };
      }
      if (cmd === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'add') {
        const dataFileIdx = args.indexOf('--data-file');
        secretDataText = await readFile(args[dataFileIdx + 1], 'utf8');
        return { stdout: '' };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const merged = await updateGcpEnvSecret({
      state: { infra: { appEnvSecretName: 'projects/1/secrets/cc-main-app-env', gcpProjectId: 'my-project' } },
      envUpdates: { TELNYX_CALL_CONTROL_ID: 'new-voice-app-id', TELNYX_SIP_CONNECTION_ID: 'conn-1' },
      execImpl,
    });
    assert.strictEqual(merged.TELNYX_API_KEY, 'abc123', 'untouched key must survive');
    assert.strictEqual(merged.TELNYX_AI_API_KEY, 'rotated-by-hand', 'hand-rotated key must not be clobbered');
    assert.strictEqual(merged.TELNYX_CALL_CONTROL_ID, 'new-voice-app-id', 'key present in envUpdates must be overwritten');
    assert.strictEqual(merged.TELNYX_SIP_CONNECTION_ID, 'conn-1', 'brand-new key must be added');
    assert.ok(secretDataText.includes('TELNYX_API_KEY=abc123'));
    assert.ok(secretDataText.includes('TELNYX_CALL_CONTROL_ID=new-voice-app-id'));
    assert.ok(!secretDataText.includes('old-voice-app-id'));
  });

  it('passes the correct project id and BARE secret id (not the fully-qualified projects/.../secrets/... name) through to both the read and the write', async () => {
    // Regression test: appEnvSecretName arrives as the fully-qualified
    // Secret Manager resource name (see cc-database-gcp/outputs.tf's
    // db_secret_name = google_secret_manager_secret.db.name shape, same
    // for app_env_secret_name). Passing that full string to `gcloud secrets
    // versions access/add --secret=` makes gcloud append it onto its own
    // REST path, producing a doubled "secrets/projects/.../secrets/<id>"
    // URL and a 404 — confirmed via a real E2E run. Only the bare id must
    // reach gcloud; toSecretId() in gcp-cloud.mjs strips it down.
    const seenCalls = [];
    const execImpl = async (cmd, args) => {
      seenCalls.push([cmd, ...args]);
      if (args[2] === 'access') return { stdout: 'FOO=bar\n' };
      return { stdout: '' };
    };
    await updateGcpEnvSecret({
      state: { infra: { appEnvSecretName: 'projects/1/secrets/cc-euro-app-env', gcpProjectId: 'euro-project' } },
      envUpdates: { FOO: 'baz' },
      execImpl,
    });
    const readCall = seenCalls.find((c) => c.includes('access'));
    const writeCall = seenCalls.find((c) => c.includes('add'));
    assert.ok(readCall.includes('euro-project') && readCall.includes('cc-euro-app-env'));
    assert.ok(!readCall.includes('projects/1/secrets/cc-euro-app-env'), 'must not pass the fully-qualified resource name to gcloud');
    assert.ok(writeCall.includes('euro-project') && writeCall.includes('cc-euro-app-env'));
    assert.ok(!writeCall.includes('projects/1/secrets/cc-euro-app-env'), 'must not pass the fully-qualified resource name to gcloud');
  });
});

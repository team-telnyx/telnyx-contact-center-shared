import assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  checkAwsCloudPreflight, writeAwsTfvars, resolveAlbCertificate, provisionAwsInfra, destroyAwsInfra, redeployAwsApp,
  updateAwsEnvSecret,
} from '../lib/aws-cloud.mjs';

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

describe('aws-cloud.mjs — checkAwsCloudPreflight', () => {
  it('reports terraform ok, aws-cli ok, and delegates to the IAM check', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'aws' && args[0] === 'sts') return { stdout: JSON.stringify({ Account: '123456789012' }) };
      if (cmd === 'aws' && args[0] === 'iam') return { stdout: JSON.stringify({ EvaluationResults: [] }) };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const results = await checkAwsCloudPreflight({ topology: 'single', execImpl });
    const terraformResult = results.find((r) => r.key === 'terraform');
    const awsCliResult = results.find((r) => r.key === 'aws-cli');
    const iamResult = results.find((r) => r.key === 'aws-iam');
    assert.strictEqual(terraformResult.status, 'ok');
    assert.strictEqual(awsCliResult.status, 'ok');
    assert.ok(iamResult);
  });

  it('forwards deploymentName/region to the IAM check so resource-scoped policies simulate against the right ARNs (regression: 2026-07-06 false-negative)', async () => {
    const seenResourceArns = [];
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'version') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'aws' && args[0] === 'sts') return { stdout: JSON.stringify({ Account: '123456789012' }) };
      if (cmd === 'aws' && args[0] === 'iam') {
        const idx = args.indexOf('--resource-arns');
        if (idx !== -1) {
          const nextIdx = args.findIndex((a, i) => i > idx && a.startsWith('--'));
          seenResourceArns.push(...args.slice(idx + 1, nextIdx === -1 ? undefined : nextIdx));
        }
        return { stdout: JSON.stringify({ EvaluationResults: [] }) };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    await checkAwsCloudPreflight({
      topology: 'single', deploymentName: 'cc-main', region: 'us-west-2', execImpl,
    });
    assert.ok(seenResourceArns.some((r) => r.includes('cc-main')), `expected at least one resource-arn scoped to cc-main, got: ${JSON.stringify(seenResourceArns)}`);
  });

  it('flags terraform version too old', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform') return { stdout: JSON.stringify({ terraform_version: '1.2.0' }) };
      if (cmd === 'aws' && args[0] === 'sts') return { stdout: JSON.stringify({ Account: '1' }) };
      return { stdout: JSON.stringify({ EvaluationResults: [] }) };
    };
    const results = await checkAwsCloudPreflight({ execImpl });
    const terraformResult = results.find((r) => r.key === 'terraform');
    assert.strictEqual(terraformResult.status, 'fail');
  });

  it('includes an aws-eip-quota result and fails the whole preflight when EIP headroom is insufficient (2026-07-06 incident regression)', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'aws' && args[0] === 'sts') return { stdout: JSON.stringify({ Account: '260957529682' }) };
      if (cmd === 'aws' && args[0] === 'iam') return { stdout: JSON.stringify({ EvaluationResults: [] }) };
      if (cmd === 'aws' && args[0] === 'ec2' && args[1] === 'describe-account-attributes') {
        return { stdout: JSON.stringify({ AccountAttributes: [{ AttributeName: 'vpc-max-elastic-ips', AttributeValues: [{ AttributeValue: '5' }] }] }) };
      }
      if (cmd === 'aws' && args[0] === 'ec2' && args[1] === 'describe-addresses') {
        return { stdout: JSON.stringify({ Addresses: Array.from({ length: 28 }, () => ({})) }) };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const results = await checkAwsCloudPreflight({
      topology: 'single', deploymentName: 'cc-main-test1', region: 'us-east-2', nodeCount: 1, execImpl,
    });
    const eipResult = results.find((r) => r.key === 'aws-eip-quota');
    assert.ok(eipResult, 'expected an aws-eip-quota entry in checkAwsCloudPreflight results');
    assert.strictEqual(eipResult.status, 'fail');
    assert.match(eipResult.detail, /28\/5/);
  });

  it('stops early (no IAM probe) when AWS credentials are missing', async () => {
    let iamCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform') return { stdout: JSON.stringify({ terraform_version: '1.9.8' }) };
      if (cmd === 'aws' && args[0] === 'sts') throw new Error('Unable to locate credentials');
      if (cmd === 'aws' && args[0] === 'iam') { iamCalled = true; return { stdout: '{}' }; }
      throw new Error('unexpected');
    };
    const results = await checkAwsCloudPreflight({ execImpl });
    const awsCliResult = results.find((r) => r.key === 'aws-cli');
    assert.strictEqual(awsCliResult.status, 'fail');
    assert.strictEqual(iamCalled, false);
  });
});

describe('aws-cloud.mjs — writeAwsTfvars', () => {
  it('single-node: maps wizard state to single-node tfvars', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-tfvars-test-'));
    const state = {
      region: 'us-east-2', deploymentName: 'cc-main', domain: 'cc.example.com',
      nodes: 1, portainer: { agentEnabled: false, agentPort: 9001, serverCidrs: [] },
    };
    const result = await writeAwsTfvars({
      deployDir, topology: 'single', state,
    });
    assert.ok(result.root.endsWith('terraform/aws/single-node'));
    assert.strictEqual(result.vars.region, 'us-east-2');
    assert.strictEqual(result.vars.deployment_name, 'cc-main');
    assert.strictEqual(result.vars.domain, 'cc.example.com');
    assert.strictEqual(result.vars.instance_type, 't3a.medium');
    // No Route53+ACM domain was resolved (state.infra.albEnabled unset) — ALB
    // stays off and the ACM/streaming-ws fields are blank, not populated.
    assert.strictEqual(result.vars.alb_enabled, false);
    assert.strictEqual(result.vars.acm_certificate_arn, '');
    assert.strictEqual(result.vars.streaming_ws_domain_name, '');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('single-node: alb_enabled=true (Route53+ACM path) includes acm_certificate_arn/streaming_ws_domain_name', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-tfvars-test-'));
    const state = {
      region: 'us-east-2', deploymentName: 'cc-main', domain: 'cc.example.com',
      nodes: 1, portainer: { agentEnabled: false, agentPort: 9001, serverCidrs: [] },
      infra: { albEnabled: true },
    };
    const result = await writeAwsTfvars({
      deployDir, topology: 'single', state,
      acmCertificateArn: 'arn:aws:acm:us-east-2:123:certificate/single',
      streamingWsDomainName: 'ws.cc.example.com',
    });
    assert.strictEqual(result.vars.alb_enabled, true);
    assert.strictEqual(result.vars.acm_certificate_arn, 'arn:aws:acm:us-east-2:123:certificate/single');
    assert.strictEqual(result.vars.streaming_ws_domain_name, 'ws.cc.example.com');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('multi-node: includes acm_certificate_arn and streaming_ws_domain_name', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-tfvars-test-'));
    const state = {
      region: 'us-east-2', deploymentName: 'cc-main', domain: 'cc.example.com',
      nodes: 2, portainer: { agentEnabled: true, agentPort: 9001, serverCidrs: ['1.2.3.4/32'] },
    };
    const result = await writeAwsTfvars({
      deployDir, topology: 'ha', state,
      acmCertificateArn: 'arn:aws:acm:us-east-2:123:certificate/x',
      streamingWsDomainName: 'ws.cc.example.com',
    });
    assert.ok(result.root.endsWith('terraform/aws/multi-node'));
    assert.strictEqual(result.vars.acm_certificate_arn, 'arn:aws:acm:us-east-2:123:certificate/x');
    assert.strictEqual(result.vars.streaming_ws_domain_name, 'ws.cc.example.com');
    assert.strictEqual(result.vars.node_count, 2);
    assert.strictEqual(result.vars.portainer_agent_enabled, true);
    assert.deepStrictEqual(result.vars.portainer_server_cidrs, ['1.2.3.4/32']);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('single-node: dns_zone_id is passed through when dnsManaged is true (Terraform owns the Route53 record)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-tfvars-test-'));
    const state = {
      region: 'us-east-2', deploymentName: 'cc-main', domain: 'cc.example.com',
      nodes: 1, portainer: { agentEnabled: false, agentPort: 9001, serverCidrs: [] },
      infra: { albEnabled: true, dnsManaged: true, dnsZoneId: 'Z123' },
    };
    const result = await writeAwsTfvars({
      deployDir, topology: 'single', state,
      acmCertificateArn: 'arn:aws:acm:us-east-2:123:certificate/single',
      streamingWsDomainName: 'ws.cc.example.com',
    });
    assert.strictEqual(result.vars.dns_zone_id, 'Z123');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('single-node: dns_zone_id is blanked out when dnsManaged is false, even if dnsZoneId is set (operator declined to let Terraform manage/overwrite an existing record)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-tfvars-test-'));
    const state = {
      region: 'us-east-2', deploymentName: 'cc-main', domain: 'cc.example.com',
      nodes: 1, portainer: { agentEnabled: false, agentPort: 9001, serverCidrs: [] },
      // Found the zone (dnsZoneId set) but the operator said no to overwriting
      // an existing record there — this must NOT leak into Terraform.
      infra: { albEnabled: true, dnsManaged: false, dnsZoneId: 'Z123' },
    };
    const result = await writeAwsTfvars({
      deployDir, topology: 'single', state,
      acmCertificateArn: 'arn:aws:acm:us-east-2:123:certificate/single',
      streamingWsDomainName: 'ws.cc.example.com',
    });
    assert.strictEqual(result.vars.dns_zone_id, '');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('multi-node: dns_zone_id defaults to blank when infra is entirely unset', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-tfvars-test-'));
    const state = {
      region: 'us-east-2', deploymentName: 'cc-main', domain: 'cc.example.com',
      nodes: 2, portainer: { agentEnabled: false, agentPort: 9001, serverCidrs: [] },
    };
    const result = await writeAwsTfvars({
      deployDir, topology: 'ha', state,
      acmCertificateArn: 'arn:aws:acm:us-east-2:123:certificate/x',
      streamingWsDomainName: 'ws.cc.example.com',
    });
    assert.strictEqual(result.vars.dns_zone_id, '');
    await rm(deployDir, { recursive: true, force: true });
  });
});

describe('aws-cloud.mjs — resolveAlbCertificate', () => {
  it('requests a cert with the ws. subdomain as SAN and surfaces automated validation via io', async () => {
    const logs = [];
    const io = { log: (m) => logs.push(m) };
    const execImpl = async (cmd, args) => {
      if (args[1] === 'request-certificate') {
        assert.ok(args.includes('ws.cc.example.com'));
        return { stdout: JSON.stringify({ CertificateArn: 'arn:new' }) };
      }
      if (args[1] === 'list-hosted-zones') return { stdout: JSON.stringify({ HostedZones: [{ Id: '/hostedzone/Z1', Name: 'example.com.' }] }) };
      if (args[1] === 'describe-certificate') {
        return {
          stdout: JSON.stringify({
            Certificate: {
              Status: 'ISSUED',
              DomainValidationOptions: [{ DomainName: 'cc.example.com', ResourceRecord: { Name: 'n', Type: 'CNAME', Value: 'v' } }],
            },
          }),
        };
      }
      if (args[1] === 'change-resource-record-sets') return { stdout: JSON.stringify({ ChangeInfo: { Id: 'C1' } }) };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const result = await resolveAlbCertificate({
      state: { domain: 'cc.example.com', infra: {} }, region: 'us-east-2', execImpl, io,
    });
    assert.strictEqual(result.issued, true);
    assert.strictEqual(result.streamingWsDomainName, 'ws.cc.example.com');
    assert.ok(logs.some((l) => l.includes('automatically')));
  });

  it('reuses an existing certificateArn from state (resume) instead of requesting a new one', async () => {
    let requestCalled = false;
    const execImpl = async (cmd, args) => {
      if (args[1] === 'request-certificate') { requestCalled = true; return { stdout: JSON.stringify({ CertificateArn: 'arn:should-not-happen' }) }; }
      if (args[1] === 'describe-certificate') return { stdout: JSON.stringify({ Certificate: { Status: 'ISSUED' } }) };
      throw new Error('unexpected');
    };
    const result = await resolveAlbCertificate({
      state: { domain: 'cc.example.com', infra: { acm: { certificateArn: 'arn:existing' } } },
      region: 'us-east-2', execImpl,
    });
    assert.strictEqual(requestCalled, false);
    assert.strictEqual(result.certificateArn, 'arn:existing');
  });
});

describe('aws-cloud.mjs — provisionAwsInfra', () => {
  function baseExecImpl({ topology = 'single', repoRoot } = {}) {
    return async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'output') {
        const outputs = topology === 'single'
          ? { public_ip: { value: '1.2.3.4' }, app_url: { value: 'https://cc.example.com' }, instance_id: { value: 'i-abc' }, storage_bucket: { value: 'cc-main-abcd' }, db_secret_name: { value: 'cc-main/db/credentials' }, app_env_secret_name: { value: 'cc-main/app/env' } }
          : { instance_ids: { value: ['i-1', 'i-2'] }, alb_dns_name: { value: 'alb.example.com' }, app_target_group_arn: { value: 'arn:app' }, streaming_ws_target_group_arn: { value: 'arn:ws' }, storage_bucket: { value: 'cc-main-abcd' }, db_secret_name: { value: 'cc-main/db/credentials' }, app_env_secret_name: { value: 'cc-main/app/env' } };
        return { stdout: JSON.stringify(outputs) };
      }
      if (cmd === 'aws' && args[0] === 'secretsmanager') {
        // get-secret-value (with --secret-id ...db/credentials) is the
        // real RDS credentials lookup added for the POSTGRES_HOST override
        // fix — put-secret-value (populating app/env) has no --query flag.
        if (args.includes('get-secret-value')) {
          return { stdout: JSON.stringify({ username: 'contact_center', password: 'test-pw', engine: 'postgres', host: 'cc-main-pg.example-rds.amazonaws.com', port: 5432, dbname: 'contact_center' }) };
        }
        return { stdout: '' };
      }
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        // Simulate `docker save ... | zstd -o <archivePath>` by writing the
        // archive the buildAndPackageImage code expects to find afterward.
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(repoRoot, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'aws' && args[0] === 's3') return { stdout: '' };
      if (cmd === 'aws' && args[0] === 'ssm') {
        if (args[1] === 'describe-instance-information') return { stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'Online' }] }) };
        if (args[1] === 'send-command') return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-1' } }) };
        if (args[1] === 'get-command-invocation') return { stdout: JSON.stringify({ Status: 'Success', StandardOutputContent: 'DEPLOY_OK' }) };
      }
      if (cmd === 'aws' && args[0] === 'elbv2') {
        if (args[1] === 'describe-target-health') return { stdout: JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] }) };
        return { stdout: '' };
      }
      throw new Error(`unexpected in provisionAwsInfra test: ${cmd} ${args.join(' ')}`);
    };
  }

  it('aborts cleanly when terraform plan fails', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'plan') throw new Error('plan boom');
      throw new Error('unexpected');
    };
    const io = makeIo();
    const result = await provisionAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, answers: { baseUrl: 'https://cc.example.com' }, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, true);
  });

  it('aborts without applying when the user declines the plan confirmation', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'init') return { stdout: '' };
      if (args[0] === 'plan') return { stdout: 'Plan: 5 to add, 0 to change, 0 to destroy.\n' };
      throw new Error(`should not reach apply: ${args.join(' ')}`);
    };
    const io = makeIo({ confirm: async () => false });
    const result = await provisionAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, answers: { baseUrl: 'https://cc.example.com' }, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, true);
  });

  it('single-node: full happy path (init -> plan -> apply -> populate secret -> build -> upload -> ssm deploy)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-cloud-test-'));
    const repoRoot = join(deployDir, '..'); // provisionAwsInfra uses join(deployDir, '..') as repoRoot
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 10 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      return baseExecImpl({ topology: 'single', repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, answers: { baseUrl: 'https://cc.example.com', envValues: { TELNYX_API_KEY: 'x' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.state.infra.publicIp, '1.2.3.4');
    assert.strictEqual(result.state.infra.instanceIds.length, 1);
    assert.strictEqual(result.state.infra.appEnvSecretName, 'cc-main/app/env');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('single-node: writes STORAGE_PROVIDER/STORAGE_BUCKET/STORAGE_REGION/STORAGE_ENDPOINT into the app/env secret (Bug #14 regression — single-node has no other path to get these into the container)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    let putSecretString = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 10 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args.includes('put-secret-value')) {
        putSecretString = args[args.indexOf('--secret-string') + 1];
      }
      return baseExecImpl({ topology: 'single', repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, answers: { baseUrl: 'https://cc.example.com', envValues: { TELNYX_API_KEY: 'x' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.ok(putSecretString, 'expected put-secret-value to have been called');
    assert.match(putSecretString, /^STORAGE_PROVIDER=s3$/m);
    assert.match(putSecretString, /^STORAGE_BUCKET=cc-main-abcd$/m);
    assert.match(putSecretString, /^STORAGE_REGION=us-east-2$/m);
    assert.match(putSecretString, /^STORAGE_ENDPOINT=https:\/\/s3\.us-east-2\.amazonaws\.com$/m);
    assert.match(putSecretString, /^STORAGE_FORCE_PATH_STYLE=false$/m);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('single-node: writes POSTGRES_SSL=true into the app/env secret alongside the real RDS host (RDS force_ssl regression — 2026-07-06 cc-test3 E2E: the app looped on "no pg_hba.conf entry ... no encryption" and the SSM deploy failed health checks after ~7 minutes without this)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    let putSecretString = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 10 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args.includes('put-secret-value')) {
        putSecretString = args[args.indexOf('--secret-string') + 1];
      }
      return baseExecImpl({ topology: 'single', repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, answers: { baseUrl: 'https://cc.example.com', envValues: { TELNYX_API_KEY: 'x', POSTGRES_SSL: '' } },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.ok(putSecretString, 'expected put-secret-value to have been called');
    assert.match(putSecretString, /^POSTGRES_SSL=true$/m);
    assert.match(putSecretString, /^POSTGRES_HOST=cc-main-pg\.example-rds\.amazonaws\.com$/m);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('multi-node: full happy path uses the HA rolling-deploy loop for both instance ids', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    const deployedInstances = [];
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 20 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'aws' && args[0] === 'ssm' && args[1] === 'send-command') {
        const idIdx = args.indexOf('--instance-ids');
        deployedInstances.push(args[idIdx + 1]);
      }
      return baseExecImpl({ topology: 'ha', repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', nodes: 2, infra: { awsTopology: 'ha' } },
      io, answers: { baseUrl: 'https://cc.example.com', envValues: {} },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(), sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.deepStrictEqual(result.state.infra.instanceIds, ['i-1', 'i-2']);
    assert.deepStrictEqual(deployedInstances, ['i-1', 'i-2']);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('aborts when populating the app/env secret fails, but still surfaces terraform outputs already applied', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-cloud-test-'));
    const repoRoot = join(deployDir, '..');
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 10 to add, 0 to change, 0 to destroy.\n' };
      if (cmd === 'terraform' && args[0] === 'apply') return { stdout: 'Apply complete!' };
      if (cmd === 'aws' && args[0] === 'secretsmanager') throw new Error('AccessDenied');
      return baseExecImpl({ topology: 'single', repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await provisionAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, answers: { baseUrl: 'https://cc.example.com', envValues: {} },
      deployDir, execImpl, spawnImpl: fakeSpawnFactory(),
    });
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.state.infra.publicIp, '1.2.3.4');
    await rm(deployDir, { recursive: true, force: true });
  });
});

describe('aws-cloud.mjs — redeployAwsApp', () => {
  function baseExecImpl({ repoRoot } = {}) {
    return async (cmd, args) => {
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args[1] === 'get-secret-value') {
        return { stdout: 'NEXT_PUBLIC_BASE_URL=https://cc.example.com\nNEXT_PUBLIC_TELNYX_WEBRTC_REGION=auto\nTELNYX_API_KEY=abc123\n' };
      }
      if (cmd === 'docker' && args[0] === 'build') return { stdout: '' };
      if (cmd === 'bash') {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(repoRoot, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'aws' && args[0] === 's3') return { stdout: '' };
      if (cmd === 'aws' && args[0] === 'ssm') {
        if (args[1] === 'describe-instance-information') return { stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'Online' }] }) };
        if (args[1] === 'send-command') return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-1' } }) };
        if (args[1] === 'get-command-invocation') return { stdout: JSON.stringify({ Status: 'Success', StandardOutputContent: 'DEPLOY_OK' }) };
      }
      if (cmd === 'aws' && args[0] === 'elbv2') {
        if (args[1] === 'describe-target-health') return { stdout: JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] }) };
        return { stdout: '' };
      }
      throw new Error(`unexpected in redeployAwsApp test: ${cmd} ${args.join(' ')}`);
    };
  }

  it('throws a clear error instead of silently no-op-ing when no infra is recorded yet', async () => {
    const io = makeIo();
    await assert.rejects(
      () => redeployAwsApp({ state: { deploymentName: 'cc-main', region: 'us-east-2', infra: {} }, io, deployDir: '/deploy' }),
      /run `cc up` first/,
    );
  });

  it('never calls terraform (init/plan/apply) — only reads the existing secret, builds, uploads, and deploys', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let terraformCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform') { terraformCalled = true; return { stdout: '' }; }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await redeployAwsApp({
      state: {
        deploymentName: 'cc-main', region: 'us-east-2',
        infra: {
          awsTopology: 'single', instanceIds: ['i-abc'], storageBucket: 'cc-main-abcd', appEnvSecretName: 'cc-main/app/env', appUrl: 'https://cc.example.com',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(terraformCalled, false, 'redeployAwsApp must never invoke terraform — infra is never touched');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('single-node: deploys via deploySingleNode (SSM) using the recorded instance id', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let ssmInstanceId = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'aws' && args[0] === 'ssm' && args[1] === 'send-command') {
        const idIdx = args.indexOf('--instance-ids');
        ssmInstanceId = args[idIdx + 1];
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await redeployAwsApp({
      state: {
        deploymentName: 'cc-main', region: 'us-east-2',
        infra: {
          awsTopology: 'single', instanceIds: ['i-abc'], storageBucket: 'cc-main-abcd', appEnvSecretName: 'cc-main/app/env', appUrl: 'https://cc.example.com',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(ssmInstanceId, 'i-abc');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('HA topology: deploys via deployHaRolling using every recorded instance id + target group ARNs', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    const ssmInstanceIds = [];
    const execImpl = async (cmd, args) => {
      if (cmd === 'aws' && args[0] === 'ssm' && args[1] === 'send-command') {
        const idIdx = args.indexOf('--instance-ids');
        ssmInstanceIds.push(args[idIdx + 1]);
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await redeployAwsApp({
      state: {
        deploymentName: 'cc-main', region: 'us-east-2',
        infra: {
          awsTopology: 'ha', instanceIds: ['i-1', 'i-2'], storageBucket: 'cc-main-abcd', appEnvSecretName: 'cc-main/app/env', appUrl: 'https://cc.example.com',
          appTargetGroupArn: 'arn:app', streamingWsTargetGroupArn: 'arn:ws',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.deepStrictEqual(ssmInstanceIds, ['i-1', 'i-2']);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('does not rewrite the app/env secret — only reads it (put-secret-value is never called)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let putSecretCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args[1] === 'put-secret-value') {
        putSecretCalled = true;
        return { stdout: '' };
      }
      return baseExecImpl({ repoRoot })(cmd, args);
    };
    const io = makeIo();
    const result = await redeployAwsApp({
      state: {
        deploymentName: 'cc-main', region: 'us-east-2',
        infra: {
          awsTopology: 'single', instanceIds: ['i-abc'], storageBucket: 'cc-main-abcd', appEnvSecretName: 'cc-main/app/env', appUrl: 'https://cc.example.com',
        },
      },
      io, deployDir, execImpl, sleep: async () => {},
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(putSecretCalled, false, 'redeployAwsApp must never write the app/env secret — it only reships a new build');
    await rm(deployDir, { recursive: true, force: true });
  });

  it('aborts cleanly (no build attempted) when the current app/env secret cannot be read', async () => {
    const execImpl = async (cmd, args) => {
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args[1] === 'get-secret-value') throw new Error('AccessDeniedException');
      throw new Error(`should not reach: ${cmd} ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await redeployAwsApp({
      state: {
        deploymentName: 'cc-main', region: 'us-east-2',
        infra: {
          awsTopology: 'single', instanceIds: ['i-abc'], storageBucket: 'cc-main-abcd', appEnvSecretName: 'cc-main/app/env',
        },
      },
      io, deployDir: '/deploy', execImpl,
    });
    assert.strictEqual(result.aborted, true);
    assert.ok(io._logs.some((l) => l.includes('AccessDeniedException')));
  });

  it('preserves every NEXT_PUBLIC_* baked build arg from the current secret, not just base URL/WebRTC region (regression: Codex review on PR #1190)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-redeploy-test-'));
    const repoRoot = join(deployDir, '..');
    let capturedBuildArgs = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args[1] === 'get-secret-value') {
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
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(repoRoot, 'image.tar.zst'), Buffer.alloc(2 * 1024 * 1024, 'a'));
        return { stdout: '' };
      }
      if (cmd === 'aws' && args[0] === 's3') return { stdout: '' };
      if (cmd === 'aws' && args[0] === 'ssm') {
        if (args[1] === 'describe-instance-information') return { stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'Online' }] }) };
        if (args[1] === 'send-command') return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-1' } }) };
        if (args[1] === 'get-command-invocation') return { stdout: JSON.stringify({ Status: 'Success', StandardOutputContent: 'DEPLOY_OK' }) };
      }
      if (cmd === 'aws' && args[0] === 'elbv2') {
        if (args[1] === 'describe-target-health') return { stdout: JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] }) };
        return { stdout: '' };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const io = makeIo();
    const result = await redeployAwsApp({
      state: {
        deploymentName: 'cc-main', region: 'us-east-2',
        infra: {
          awsTopology: 'single', instanceIds: ['i-abc'], storageBucket: 'cc-main-abcd', appEnvSecretName: 'cc-main/app/env', appUrl: 'https://cc.example.com',
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

describe('aws-cloud.mjs — destroyAwsInfra', () => {
  it('plans, confirms, then applies destroy and reports the destroyed count', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-destroy-test-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') {
        assert.ok(args.includes('-destroy'), 'expected terraform plan to be called with -destroy');
        return { stdout: 'Plan: 0 to add, 0 to change, 44 to destroy.\n' };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    let confirmPrompt = null;
    const io = makeIo({
      confirm: async (msg) => { confirmPrompt = msg; return true; },
    });
    const result = await destroyAwsInfra({
      state: { deploymentName: 'cc-main-test1', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, deployDir, execImpl, spawnImpl: fakeSpawnFactory({ stdoutChunks: ['Destroy complete! Resources: 44 destroyed.\n'] }),
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.destroyed, 44);
    assert.match(confirmPrompt, /PERMANENTLY destroy 44/);
    assert.match(confirmPrompt, /cc-main-test1/);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('aborts without applying when the user declines the destroy confirmation', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-destroy-test-'));
    let applyCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 9 to destroy.\n' };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const spawnImpl = () => { applyCalled = true; return fakeSpawnFactory()(); };
    const io = makeIo({ confirm: async () => false });
    const result = await destroyAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, deployDir, execImpl, spawnImpl,
    });
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(applyCalled, false);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('short-circuits with no confirmation prompt when the plan is already empty (nothing to destroy)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-destroy-test-'));
    let confirmCalled = false;
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'No changes. Your infrastructure matches the configuration.\n' };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const io = makeIo({ confirm: async () => { confirmCalled = true; return true; } });
    const result = await destroyAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, deployDir, execImpl, spawnImpl: fakeSpawnFactory(),
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.destroyed, 0);
    assert.strictEqual(confirmCalled, false);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('prefers state.infra.terraformDir over re-derived topology root when present (resume across a renamed/moved deploy dir)', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-destroy-test-'));
    const customRoot = join(deployDir, 'custom-tf-root');
    const seenCwds = [];
    const execImpl = async (cmd, args, opts = {}) => {
      seenCwds.push(opts.cwd);
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 1 to destroy.\n' };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const io = makeIo({ confirm: async () => true });
    await destroyAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single', terraformDir: customRoot } },
      io, deployDir, execImpl, spawnImpl: fakeSpawnFactory(),
    });
    assert.ok(seenCwds.every((cwd) => cwd === customRoot), `expected all terraform calls to use ${customRoot}, got: ${JSON.stringify(seenCwds)}`);
    await rm(deployDir, { recursive: true, force: true });
  });

  it('reports failure and a retry hint when terraform destroy itself fails partway through', async () => {
    const deployDir = await mkdtemp(join(tmpdir(), 'cc-aws-destroy-test-'));
    const execImpl = async (cmd, args) => {
      if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
      if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 0 to add, 0 to change, 5 to destroy.\n' };
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const io = makeIo({ confirm: async () => true });
    const result = await destroyAwsInfra({
      state: { deploymentName: 'cc-main', region: 'us-east-2', infra: { awsTopology: 'single' } },
      io, deployDir, execImpl, spawnImpl: fakeSpawnFactory({ exitCode: 1, stdoutChunks: ['Error: dependency violation\n'] }),
    });
    assert.strictEqual(result.aborted, true);
    assert.ok(io._logs.some((l) => l.includes('re-run `cc destroy`')));
  });
});

describe('aws-cloud.mjs — updateAwsEnvSecret', () => {
  it('throws a clear error when no app/env secret is recorded yet', async () => {
    await assert.rejects(
      () => updateAwsEnvSecret({ state: { region: 'us-east-2', infra: {} }, envUpdates: { TELNYX_CALL_CONTROL_ID: 'x' } }),
      /run `cc up` first/,
    );
  });

  it('read-merge-writes: preserves every existing key not present in envUpdates, overwrites only the keys that are', async () => {
    let putSecretString = null;
    const execImpl = async (cmd, args) => {
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args[1] === 'get-secret-value') {
        return { stdout: 'TELNYX_API_KEY=abc123\nTELNYX_AI_API_KEY=rotated-by-hand\nTELNYX_CALL_CONTROL_ID=old-voice-app-id\n' };
      }
      if (cmd === 'aws' && args[0] === 'secretsmanager' && args[1] === 'put-secret-value') {
        const idx = args.indexOf('--secret-string');
        putSecretString = args[idx + 1];
        return { stdout: '' };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    };
    const merged = await updateAwsEnvSecret({
      state: { region: 'us-east-2', infra: { appEnvSecretName: 'cc-main/app/env' } },
      envUpdates: { TELNYX_CALL_CONTROL_ID: 'new-voice-app-id', TELNYX_SIP_CONNECTION_ID: 'conn-1' },
      execImpl,
    });
    assert.strictEqual(merged.TELNYX_API_KEY, 'abc123', 'untouched key must survive');
    assert.strictEqual(merged.TELNYX_AI_API_KEY, 'rotated-by-hand', 'hand-rotated key must not be clobbered');
    assert.strictEqual(merged.TELNYX_CALL_CONTROL_ID, 'new-voice-app-id', 'key present in envUpdates must be overwritten');
    assert.strictEqual(merged.TELNYX_SIP_CONNECTION_ID, 'conn-1', 'brand-new key must be added');
    assert.ok(putSecretString.includes('TELNYX_API_KEY=abc123'));
    assert.ok(putSecretString.includes('TELNYX_CALL_CONTROL_ID=new-voice-app-id'));
    assert.ok(!putSecretString.includes('old-voice-app-id'));
  });

  it('passes the correct region and secret id through to both get-secret-value and put-secret-value', async () => {
    const seenCalls = [];
    const execImpl = async (cmd, args) => {
      seenCalls.push([cmd, ...args]);
      if (args[1] === 'get-secret-value') return { stdout: 'FOO=bar\n' };
      return { stdout: '' };
    };
    await updateAwsEnvSecret({
      state: { region: 'eu-west-1', infra: { appEnvSecretName: 'cc-euro/app/env' } },
      envUpdates: { FOO: 'baz' },
      execImpl,
    });
    const getCall = seenCalls.find((c) => c[2] === 'get-secret-value');
    const putCall = seenCalls.find((c) => c[2] === 'put-secret-value');
    assert.ok(getCall.includes('eu-west-1') && getCall.includes('cc-euro/app/env'));
    assert.ok(putCall.includes('eu-west-1') && putCall.includes('cc-euro/app/env'));
  });
});

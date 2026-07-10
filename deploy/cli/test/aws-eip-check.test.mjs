import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  getEipQuota, getEipUsage, eipsNeededFor, checkAwsEipQuota,
} from '../lib/aws-eip-check.mjs';

function execImplFor({ quota = 5, addresses = [] } = {}) {
  return async (cmd, args) => {
    if (cmd !== 'aws') throw new Error(`unexpected command: ${cmd}`);
    if (args[0] === 'ec2' && args[1] === 'describe-account-attributes') {
      return {
        stdout: JSON.stringify({
          AccountAttributes: [{ AttributeName: 'vpc-max-elastic-ips', AttributeValues: [{ AttributeValue: String(quota) }] }],
        }),
      };
    }
    if (args[0] === 'ec2' && args[1] === 'describe-addresses') {
      return { stdout: JSON.stringify({ Addresses: addresses }) };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
}

describe('aws-eip-check.mjs', () => {
  it('getEipQuota: parses the legacy vpc-max-elastic-ips attribute', async () => {
    const quota = await getEipQuota({ region: 'us-east-2', execImpl: execImplFor({ quota: 5 }) });
    assert.strictEqual(quota, 5);
  });

  it('getEipUsage: counts current addresses', async () => {
    const usage = await getEipUsage({
      region: 'us-east-2',
      execImpl: execImplFor({ addresses: [{ PublicIp: '1.1.1.1' }, { PublicIp: '2.2.2.2' }] }),
    });
    assert.strictEqual(usage, 2);
  });

  it('eipsNeededFor: single-node always needs exactly 1', () => {
    assert.strictEqual(eipsNeededFor({ topology: 'single', nodeCount: 1 }), 1);
    assert.strictEqual(eipsNeededFor({ topology: 'single', nodeCount: 5 }), 1);
  });

  it('eipsNeededFor: HA needs 1 per node', () => {
    assert.strictEqual(eipsNeededFor({ topology: 'ha', nodeCount: 3 }), 3);
    assert.strictEqual(eipsNeededFor({ topology: 'ha', nodeCount: 1 }), 1);
  });

  it('eipsNeededFor: NAT gateway adds one more EIP regardless of topology', () => {
    assert.strictEqual(eipsNeededFor({ topology: 'single', nodeCount: 1, natEnabled: true }), 2);
    assert.strictEqual(eipsNeededFor({ topology: 'ha', nodeCount: 2, natEnabled: true }), 3);
  });

  it('checkAwsEipQuota: no region yet -> warn, does not call aws CLI', async () => {
    let called = false;
    const execImpl = async () => { called = true; return { stdout: '{}' }; };
    const result = await checkAwsEipQuota({ region: null, execImpl });
    assert.strictEqual(result.status, 'warn');
    assert.strictEqual(called, false);
  });

  it('checkAwsEipQuota: plenty of headroom -> ok', async () => {
    const result = await checkAwsEipQuota({
      region: 'us-east-2', topology: 'single', nodeCount: 1,
      execImpl: execImplFor({ quota: 5, addresses: [{ PublicIp: '1.1.1.1' }] }),
    });
    assert.strictEqual(result.status, 'ok');
    assert.match(result.detail, /1\/5 in use/);
  });

  it('checkAwsEipQuota: at the limit (this repo\'s real 2026-07-06 incident: 28/5, single-node needs 1) -> fail with a clear hint', async () => {
    const addresses = Array.from({ length: 28 }, (_, i) => ({ PublicIp: `10.0.0.${i}` }));
    const result = await checkAwsEipQuota({
      region: 'us-east-2', topology: 'single', nodeCount: 1,
      execImpl: execImplFor({ quota: 5, addresses }),
    });
    assert.strictEqual(result.status, 'fail');
    assert.match(result.detail, /28\/5 Elastic IPs already allocated/);
    assert.match(result.detail, /needs 1 more/);
    assert.match(result.hint, /Service Quotas/);
  });

  it('checkAwsEipQuota: exactly enough headroom (quota - inUse === needed) -> ok, not fail (boundary)', async () => {
    // quota=5, inUse=4 -> headroom=1, needed=1 -> ok (not < needed)
    const addresses = Array.from({ length: 4 }, (_, i) => ({ PublicIp: `10.0.0.${i}` }));
    const result = await checkAwsEipQuota({
      region: 'us-east-2', topology: 'single', nodeCount: 1,
      execImpl: execImplFor({ quota: 5, addresses }),
    });
    assert.strictEqual(result.status, 'ok');
  });

  it('checkAwsEipQuota: HA topology multiplies the requirement by node count', async () => {
    const addresses = Array.from({ length: 3 }, (_, i) => ({ PublicIp: `10.0.0.${i}` }));
    const result = await checkAwsEipQuota({
      region: 'us-east-2', topology: 'ha', nodeCount: 3,
      execImpl: execImplFor({ quota: 5, addresses }), // headroom=2, needed=3 -> fail
    });
    assert.strictEqual(result.status, 'fail');
    assert.match(result.detail, /needs 3 more/);
  });

  it('checkAwsEipQuota: aws CLI failure -> warn (does not block deployment on an unrelated CLI error)', async () => {
    const execImpl = async () => { throw new Error('command not found'); };
    const result = await checkAwsEipQuota({ region: 'us-east-2', execImpl });
    assert.strictEqual(result.status, 'warn');
    assert.match(result.detail, /could not check/);
  });
});

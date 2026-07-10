import assert from 'node:assert';
import { describe, it } from 'node:test';
import { resolveAdminSshCidrs, EC2_INSTANCE_CONNECT_CIDRS_FALLBACK } from '../lib/aws-instance-connect-cidrs.mjs';

describe('aws-instance-connect-cidrs.mjs — resolveAdminSshCidrs', () => {
  it('returns [] when no region is given', async () => {
    const result = await resolveAdminSshCidrs({ region: null });
    assert.deepStrictEqual(result, []);
  });

  it('returns the live EC2_INSTANCE_CONNECT prefix for the requested region', async () => {
    const fetchImpl = async (url) => {
      assert.strictEqual(url, 'https://ip-ranges.amazonaws.com/ip-ranges.json');
      return {
        ok: true,
        json: async () => ({
          prefixes: [
            { service: 'EC2_INSTANCE_CONNECT', region: 'us-east-2', ip_prefix: '3.16.146.0/29' },
            { service: 'EC2_INSTANCE_CONNECT', region: 'eu-west-1', ip_prefix: '18.202.216.48/29' },
            { service: 'AMAZON', region: 'us-east-2', ip_prefix: '52.0.0.0/16' },
          ],
        }),
      };
    };
    const result = await resolveAdminSshCidrs({ region: 'us-east-2', fetchImpl });
    assert.deepStrictEqual(result, ['3.16.146.0/29']);
  });

  it('falls back to the built-in snapshot when the fetch throws', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    const logs = [];
    const io = { log: (msg) => logs.push(msg) };
    const result = await resolveAdminSshCidrs({ region: 'eu-central-1', fetchImpl, io });
    assert.deepStrictEqual(result, EC2_INSTANCE_CONNECT_CIDRS_FALLBACK['eu-central-1']);
    assert.ok(logs.some((l) => l.includes('built-in snapshot')));
  });

  it('falls back to the built-in snapshot when the response is not ok', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 });
    const result = await resolveAdminSshCidrs({ region: 'us-west-2', fetchImpl });
    assert.deepStrictEqual(result, EC2_INSTANCE_CONNECT_CIDRS_FALLBACK['us-west-2']);
  });

  it('falls back to the built-in snapshot when the region is absent from the live document', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ prefixes: [{ service: 'EC2_INSTANCE_CONNECT', region: 'us-east-1', ip_prefix: '18.206.107.24/29' }] }),
    });
    const result = await resolveAdminSshCidrs({ region: 'eu-west-1', fetchImpl });
    assert.deepStrictEqual(result, EC2_INSTANCE_CONNECT_CIDRS_FALLBACK['eu-west-1']);
  });

  it('returns [] for a region with no live data and no fallback entry', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ prefixes: [] }) });
    const result = await resolveAdminSshCidrs({ region: 'made-up-region-1', fetchImpl });
    assert.deepStrictEqual(result, []);
  });
});

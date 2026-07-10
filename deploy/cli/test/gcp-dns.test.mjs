import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  listManagedZones, findRecordForHost, findZoneForHostname,
} from '../lib/gcp-dns.mjs';

describe('gcp-dns.mjs — listManagedZones', () => {
  it('lists public managed zones, filtering out private ones', async () => {
    const execImpl = async (cmd, args) => {
      assert.strictEqual(cmd, 'gcloud');
      assert.deepStrictEqual(args.slice(0, 3), ['dns', 'managed-zones', 'list']);
      return {
        stdout: JSON.stringify([
          { name: 'cc-example-zone', dnsName: 'example.com.', visibility: 'public' },
          { name: 'cc-internal-zone', dnsName: 'internal.example.com.', visibility: 'private' },
          { name: 'cc-legacy-zone', dnsName: 'legacy.com.' }, // no visibility field -> defaults to public
        ]),
      };
    };
    const zones = await listManagedZones({ project: 'my-project', execImpl });
    assert.deepStrictEqual(zones, [
      { name: 'cc-example-zone', dnsName: 'example.com' },
      { name: 'cc-legacy-zone', dnsName: 'legacy.com' },
    ]);
  });

  it('passes --project when provided', async () => {
    let capturedArgs = null;
    const execImpl = async (cmd, args) => { capturedArgs = args; return { stdout: '[]' }; };
    await listManagedZones({ project: 'my-project', execImpl });
    assert.ok(capturedArgs.includes('--project'));
    assert.ok(capturedArgs.includes('my-project'));
  });

  it('omits --project when not provided', async () => {
    let capturedArgs = null;
    const execImpl = async (cmd, args) => { capturedArgs = args; return { stdout: '[]' }; };
    await listManagedZones({ execImpl });
    assert.ok(!capturedArgs.includes('--project'));
  });
});

describe('gcp-dns.mjs — findZoneForHostname', () => {
  const zones = [
    { name: 'cc-example-zone', dnsName: 'example.com' },
    { name: 'cc-sub-zone', dnsName: 'sub.example.com' },
  ];

  it('picks the longest (most specific) matching zone', () => {
    const zone = findZoneForHostname(zones, 'cc-main.sub.example.com');
    assert.strictEqual(zone.name, 'cc-sub-zone');
  });

  it('falls back to a shorter suffix match when no more specific zone exists', () => {
    const zone = findZoneForHostname(zones, 'cc-main.example.com');
    assert.strictEqual(zone.name, 'cc-example-zone');
  });

  it('returns null when no zone matches', () => {
    const zone = findZoneForHostname(zones, 'cc-main.other-domain.com');
    assert.strictEqual(zone, null);
  });

  it('matches the bare zone apex itself (not just subdomains)', () => {
    const zone = findZoneForHostname(zones, 'example.com');
    assert.strictEqual(zone.name, 'cc-example-zone');
  });
});

describe('gcp-dns.mjs — findRecordForHost', () => {
  it('returns the matching record when one exists for the exact hostname', async () => {
    const execImpl = async (cmd, args) => {
      assert.strictEqual(cmd, 'gcloud');
      assert.deepStrictEqual(args.slice(0, 3), ['dns', 'record-sets', 'list']);
      return {
        stdout: JSON.stringify([
          { name: 'cc-main.example.com.', type: 'A', ttl: 300, rrdatas: ['1.2.3.4'] },
        ]),
      };
    };
    const result = await findRecordForHost({ zoneName: 'cc-example-zone', fqdn: 'cc-main.example.com', execImpl });
    assert.strictEqual(result.type, 'A');
    assert.deepStrictEqual(result.values, ['1.2.3.4']);
  });

  it('returns null when no record matches the exact hostname', async () => {
    const execImpl = async () => ({ stdout: '[]' });
    const result = await findRecordForHost({ zoneName: 'cc-example-zone', fqdn: 'cc-main.example.com', execImpl });
    assert.strictEqual(result, null);
  });

  it('throws when zoneName or fqdn is missing', async () => {
    await assert.rejects(() => findRecordForHost({ fqdn: 'x' }), /requires \{ zoneName \}/);
    await assert.rejects(() => findRecordForHost({ zoneName: 'z' }), /requires \{ fqdn \}/);
  });
});

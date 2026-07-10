import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  listHostedZones, findRecordForHost, findZoneForHostname,
} from '../lib/route53.mjs';

describe('route53.mjs — listHostedZones', () => {
  it('normalizes zone ids and filters out private zones', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({
        HostedZones: [
          { Id: '/hostedzone/Z1', Name: 'example.com.', Config: { PrivateZone: false } },
          { Id: '/hostedzone/Z2', Name: 'internal.example.com.', Config: { PrivateZone: true } },
        ],
      }),
    });
    const zones = await listHostedZones({ execImpl });
    assert.deepStrictEqual(zones, [{ id: 'Z1', name: 'example.com' }]);
  });

  it('treats zones with no Config block as public (defensive default)', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({ HostedZones: [{ Id: '/hostedzone/Z1', Name: 'example.com.' }] }),
    });
    const zones = await listHostedZones({ execImpl });
    assert.strictEqual(zones.length, 1);
  });
});

describe('route53.mjs — findZoneForHostname', () => {
  const zones = [
    { id: 'Z1', name: 'example.com' },
    { id: 'Z2', name: 'cc.example.com' },
  ];

  it('prefers the longest (most specific) matching suffix', () => {
    const zone = findZoneForHostname(zones, 'cc.example.com');
    assert.strictEqual(zone.id, 'Z2');
  });

  it('falls back to a parent zone for a hostname not exactly matching any zone name', () => {
    const zone = findZoneForHostname(zones, 'app.cc.example.com');
    assert.strictEqual(zone.id, 'Z2');
  });

  it('matches the zone apex itself', () => {
    const zone = findZoneForHostname(zones, 'example.com');
    assert.strictEqual(zone.id, 'Z1');
  });

  it('returns null when nothing matches', () => {
    const zone = findZoneForHostname(zones, 'totally-unrelated.net');
    assert.strictEqual(zone, null);
  });
});

describe('route53.mjs — findRecordForHost', () => {
  it('returns null when no record exists for the exact hostname', async () => {
    const execImpl = async () => ({ stdout: JSON.stringify({ ResourceRecordSets: [] }) });
    const result = await findRecordForHost({ zoneId: 'Z1', fqdn: 'cc.example.com', execImpl });
    assert.strictEqual(result, null);
  });

  it('finds an exact-match A record and normalizes its shape', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({
        ResourceRecordSets: [
          { Name: 'cc.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '1.2.3.4' }] },
          { Name: 'other.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '5.6.7.8' }] },
        ],
      }),
    });
    const result = await findRecordForHost({ zoneId: 'Z1', fqdn: 'cc.example.com', execImpl });
    assert.strictEqual(result.type, 'A');
    assert.deepStrictEqual(result.values, ['1.2.3.4']);
  });

  it('finds an ALIAS record (AliasTarget, no ResourceRecords) and surfaces alias info', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({
        ResourceRecordSets: [
          { Name: 'cc.example.com.', Type: 'A', AliasTarget: { DNSName: 'alb.example.com.', HostedZoneId: 'ZALB' } },
        ],
      }),
    });
    const result = await findRecordForHost({ zoneId: 'Z1', fqdn: 'cc.example.com', execImpl });
    assert.strictEqual(result.alias.dnsName, 'alb.example.com.');
  });

  it('does not false-positive on a different exact name sharing a prefix', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({
        ResourceRecordSets: [
          { Name: 'cc.example.com.evil.com.', Type: 'A', ResourceRecords: [{ Value: '1.2.3.4' }] },
        ],
      }),
    });
    const result = await findRecordForHost({ zoneId: 'Z1', fqdn: 'cc.example.com', execImpl });
    assert.strictEqual(result, null);
  });

  it('throws when zoneId or fqdn is missing', async () => {
    await assert.rejects(() => findRecordForHost({ fqdn: 'x.com' }), /zoneId/);
    await assert.rejects(() => findRecordForHost({ zoneId: 'Z1' }), /fqdn/);
  });
});

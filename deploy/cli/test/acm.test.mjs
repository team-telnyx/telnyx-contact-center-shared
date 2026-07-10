import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  findHostedZoneForDomain, requestCertificate, describeCertificate, extractValidationRecords,
  waitForValidationRecords, createValidationRecords, waitForCertificateIssued, ensureCertificate,
  listCertificatesForDomain, findCertificateInOtherRegions, deleteCertificate,
} from '../lib/acm.mjs';

const noopSleep = () => Promise.resolve();

describe('acm.mjs — findHostedZoneForDomain', () => {
  it('finds an exact match', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({ HostedZones: [{ Id: '/hostedzone/Z123', Name: 'example.com.' }] }),
    });
    const result = await findHostedZoneForDomain({ domain: 'example.com', execImpl });
    assert.deepStrictEqual(result, { zoneId: 'Z123', zoneName: 'example.com.' });
  });

  it('finds a parent-zone match for a subdomain', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({ HostedZones: [{ Id: '/hostedzone/Z456', Name: 'example.com.' }] }),
    });
    const result = await findHostedZoneForDomain({ domain: 'cc.example.com', execImpl });
    assert.strictEqual(result.zoneId, 'Z456');
  });

  it('prefers the longest matching suffix when multiple zones could match', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({
        HostedZones: [
          { Id: '/hostedzone/ZROOT', Name: 'com.' },
          { Id: '/hostedzone/ZEXACT', Name: 'example.com.' },
        ],
      }),
    });
    const result = await findHostedZoneForDomain({ domain: 'cc.example.com', execImpl });
    assert.strictEqual(result.zoneId, 'ZEXACT');
  });

  it('returns null when no zone matches', async () => {
    const execImpl = async () => ({ stdout: JSON.stringify({ HostedZones: [{ Id: '/hostedzone/Z1', Name: 'unrelated.org.' }] }) });
    const result = await findHostedZoneForDomain({ domain: 'cc.example.com', execImpl });
    assert.strictEqual(result, null);
  });

  it('throws when domain is missing', async () => {
    await assert.rejects(() => findHostedZoneForDomain({}), /domain/);
  });
});

describe('acm.mjs — requestCertificate', () => {
  it('returns the CertificateArn and includes SANs when given', async () => {
    let seenArgs;
    const execImpl = async (cmd, args) => {
      seenArgs = args;
      return { stdout: JSON.stringify({ CertificateArn: 'arn:aws:acm:us-east-2:123:certificate/abc' }) };
    };
    const arn = await requestCertificate({
      domain: 'cc.example.com', alternativeNames: ['ws.cc.example.com'], region: 'us-east-2', execImpl,
    });
    assert.strictEqual(arn, 'arn:aws:acm:us-east-2:123:certificate/abc');
    assert.ok(seenArgs.includes('--subject-alternative-names'));
    assert.ok(seenArgs.includes('ws.cc.example.com'));
  });

  it('throws when the CLI does not return a CertificateArn', async () => {
    const execImpl = async () => ({ stdout: JSON.stringify({}) });
    await assert.rejects(() => requestCertificate({ domain: 'x.com', execImpl }), /CertificateArn/);
  });
});

describe('acm.mjs — extractValidationRecords', () => {
  it('extracts name/type/value per domain', () => {
    const cert = {
      DomainValidationOptions: [
        { DomainName: 'cc.example.com', ResourceRecord: { Name: '_abc.cc.example.com.', Type: 'CNAME', Value: '_xyz.acm-validations.aws.' } },
      ],
    };
    const records = extractValidationRecords(cert);
    assert.deepStrictEqual(records, [{
      domainName: 'cc.example.com', name: '_abc.cc.example.com.', type: 'CNAME', value: '_xyz.acm-validations.aws.',
    }]);
  });

  it('returns [] when ResourceRecord is not populated yet', () => {
    const cert = { DomainValidationOptions: [{ DomainName: 'cc.example.com' }] };
    assert.deepStrictEqual(extractValidationRecords(cert), []);
  });

  it('returns [] for a missing/empty certificate', () => {
    assert.deepStrictEqual(extractValidationRecords(null), []);
    assert.deepStrictEqual(extractValidationRecords({}), []);
  });
});

describe('acm.mjs — waitForValidationRecords', () => {
  it('polls until ResourceRecord entries appear', async () => {
    let call = 0;
    const execImpl = async () => {
      call += 1;
      if (call < 3) return { stdout: JSON.stringify({ Certificate: { DomainValidationOptions: [{ DomainName: 'x' }] } }) };
      return {
        stdout: JSON.stringify({
          Certificate: { DomainValidationOptions: [{ DomainName: 'x', ResourceRecord: { Name: 'n', Type: 'CNAME', Value: 'v' } }] },
        }),
      };
    };
    const records = await waitForValidationRecords({ certificateArn: 'arn:x', execImpl, sleep: noopSleep, intervalMs: 0 });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(call, 3);
  });

  it('returns [] on timeout', async () => {
    let now = 0;
    const execImpl = async () => ({ stdout: JSON.stringify({ Certificate: { DomainValidationOptions: [] } }) });
    const records = await waitForValidationRecords({
      certificateArn: 'arn:x', execImpl, sleep: noopSleep,
      now: () => { now += 40; return now; }, timeoutMs: 100, intervalMs: 0,
    });
    assert.deepStrictEqual(records, []);
  });
});

describe('acm.mjs — createValidationRecords', () => {
  it('sends an UPSERT change batch for every record', async () => {
    let seenArgs;
    const execImpl = async (cmd, args) => { seenArgs = args; return { stdout: JSON.stringify({ ChangeInfo: { Id: 'C1', Status: 'PENDING' } }) }; };
    await createValidationRecords({
      zoneId: 'Z123',
      records: [{ name: '_abc.example.com.', type: 'CNAME', value: '_xyz.acm-validations.aws.' }],
      execImpl,
    });
    const batchIdx = seenArgs.indexOf('--change-batch');
    const batch = JSON.parse(seenArgs[batchIdx + 1]);
    assert.strictEqual(batch.Changes[0].Action, 'UPSERT');
    assert.strictEqual(batch.Changes[0].ResourceRecordSet.Name, '_abc.example.com.');
  });

  it('throws when zoneId or records missing', async () => {
    await assert.rejects(() => createValidationRecords({ records: [{ name: 'x', type: 'CNAME', value: 'y' }] }), /zoneId/);
    await assert.rejects(() => createValidationRecords({ zoneId: 'Z1', records: [] }), /records/);
  });
});

describe('acm.mjs — waitForCertificateIssued', () => {
  it('resolves issued:true once Status is ISSUED', async () => {
    let call = 0;
    const execImpl = async () => {
      call += 1;
      const Status = call < 3 ? 'PENDING_VALIDATION' : 'ISSUED';
      return { stdout: JSON.stringify({ Certificate: { Status } }) };
    };
    const result = await waitForCertificateIssued({ certificateArn: 'arn:x', execImpl, sleep: noopSleep, intervalMs: 0 });
    assert.strictEqual(result.issued, true);
  });

  it('stops early (terminal) on FAILED status instead of waiting out the full timeout', async () => {
    let calls = 0;
    const execImpl = async () => { calls += 1; return { stdout: JSON.stringify({ Certificate: { Status: 'FAILED' } }) }; };
    const result = await waitForCertificateIssued({ certificateArn: 'arn:x', execImpl, sleep: noopSleep, intervalMs: 0, timeoutMs: 60_000 });
    assert.strictEqual(result.issued, false);
    assert.strictEqual(result.terminal, true);
    assert.strictEqual(calls, 1);
  });

  it('returns issued:false, terminal:false on timeout while still PENDING_VALIDATION', async () => {
    let now = 0;
    const execImpl = async () => ({ stdout: JSON.stringify({ Certificate: { Status: 'PENDING_VALIDATION' } }) });
    const result = await waitForCertificateIssued({
      certificateArn: 'arn:x', execImpl, sleep: noopSleep,
      now: () => { now += 20_000; return now; }, timeoutMs: 50_000, intervalMs: 0,
    });
    assert.strictEqual(result.issued, false);
    assert.strictEqual(result.terminal, false);
  });
});

describe('acm.mjs — ensureCertificate (orchestrator)', () => {
  it('short-circuits when an existing certificate is already ISSUED', async () => {
    const execImpl = async (cmd, args) => {
      if (args[1] === 'describe-certificate') return { stdout: JSON.stringify({ Certificate: { Status: 'ISSUED' } }) };
      throw new Error(`should not call ${args.join(' ')} when already issued`);
    };
    const result = await ensureCertificate({
      domain: 'cc.example.com', existingCertificateArn: 'arn:existing', execImpl,
    });
    assert.strictEqual(result.issued, true);
    assert.strictEqual(result.certificateArn, 'arn:existing');
  });

  it('automated path: creates validation records when a matching Route53 zone is found', async () => {
    const calls = [];
    const execImpl = async (cmd, args) => {
      calls.push(args[0] === 'route53' || args[0] === 'acm' ? `${args[0]}:${args[1]}` : args.join(' '));
      if (args[1] === 'request-certificate') return { stdout: JSON.stringify({ CertificateArn: 'arn:new' }) };
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
    let callbackInfo = null;
    const result = await ensureCertificate({
      domain: 'cc.example.com', region: 'us-east-2', execImpl, sleep: noopSleep,
      onValidationRecordsReady: (info) => { callbackInfo = info; },
    });
    assert.strictEqual(result.issued, true);
    assert.strictEqual(result.automated, true);
    assert.strictEqual(callbackInfo.automated, true);
    assert.ok(calls.includes('route53:change-resource-record-sets'));
  });

  it('semi-automated path: no matching zone -> automated:false, does not call change-resource-record-sets', async () => {
    const calls = [];
    const execImpl = async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[1] === 'request-certificate') return { stdout: JSON.stringify({ CertificateArn: 'arn:new' }) };
      if (args[1] === 'list-hosted-zones') return { stdout: JSON.stringify({ HostedZones: [] }) };
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
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    let callbackInfo = null;
    const result = await ensureCertificate({
      domain: 'cc.example.com', execImpl, sleep: noopSleep,
      onValidationRecordsReady: (info) => { callbackInfo = info; },
    });
    assert.strictEqual(result.automated, false);
    assert.strictEqual(callbackInfo.automated, false);
    assert.ok(!calls.some((c) => c.includes('change-resource-record-sets')));
  });

  it('waitForIssued:false returns before polling for ISSUED (caller controls the wait separately)', async () => {
    const execImpl = async (cmd, args) => {
      if (args[1] === 'request-certificate') return { stdout: JSON.stringify({ CertificateArn: 'arn:new' }) };
      if (args[1] === 'list-hosted-zones') return { stdout: JSON.stringify({ HostedZones: [] }) };
      if (args[1] === 'describe-certificate') {
        return {
          stdout: JSON.stringify({
            Certificate: { DomainValidationOptions: [{ DomainName: 'x', ResourceRecord: { Name: 'n', Type: 'CNAME', Value: 'v' } }] },
          }),
        };
      }
      throw new Error('should not describe-certificate again after waitForIssued:false');
    };
    const result = await ensureCertificate({ domain: 'cc.example.com', execImpl, sleep: noopSleep, waitForIssued: false });
    assert.strictEqual(result.issued, false);
    assert.strictEqual(result.certificateArn, 'arn:new');
  });
});

describe('acm.mjs — listCertificatesForDomain', () => {
  it('matches an exact-domain ISSUED certificate', async () => {
    const execImpl = async (cmd, args) => {
      assert.ok(args.includes('--certificate-statuses'));
      assert.ok(args.includes('ISSUED'));
      return {
        stdout: JSON.stringify({
          CertificateSummaryList: [
            { CertificateArn: 'arn:exact', DomainName: 'cc.example.com' },
            { CertificateArn: 'arn:unrelated', DomainName: 'other.com' },
          ],
        }),
      };
    };
    const result = await listCertificatesForDomain({ domain: 'cc.example.com', region: 'us-east-2', execImpl });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].certificateArn, 'arn:exact');
  });

  it('matches a parent wildcard certificate (*.example.com covers cc.example.com)', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({
        CertificateSummaryList: [{ CertificateArn: 'arn:wild', DomainName: '*.example.com' }],
      }),
    });
    const result = await listCertificatesForDomain({ domain: 'cc.example.com', execImpl });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].certificateArn, 'arn:wild');
  });

  it('matches via SubjectAlternativeNameSummaries when the primary DomainName differs', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({
        CertificateSummaryList: [{
          CertificateArn: 'arn:san',
          DomainName: 'unrelated.example.com',
          SubjectAlternativeNameSummaries: ['cc.example.com'],
        }],
      }),
    });
    const result = await listCertificatesForDomain({ domain: 'cc.example.com', execImpl });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].certificateArn, 'arn:san');
  });

  it('returns [] when nothing matches', async () => {
    const execImpl = async () => ({
      stdout: JSON.stringify({ CertificateSummaryList: [{ CertificateArn: 'arn:x', DomainName: 'totally-unrelated.net' }] }),
    });
    const result = await listCertificatesForDomain({ domain: 'cc.example.com', execImpl });
    assert.deepStrictEqual(result, []);
  });

  it('throws when domain is missing', async () => {
    await assert.rejects(() => listCertificatesForDomain({}), /domain/);
  });
});

describe('acm.mjs — findCertificateInOtherRegions', () => {
  it('finds a wildcard cert in a different region and reports which one (2026-07-06 case: *.demotelnyx.com in us-east-2, deployment in us-west-2)', async () => {
    const seenRegions = [];
    const execImpl = async (cmd, args) => {
      const regionIdx = args.indexOf('--region');
      const region = regionIdx !== -1 ? args[regionIdx + 1] : null;
      seenRegions.push(region);
      if (region === 'us-east-2') {
        return { stdout: JSON.stringify({ CertificateSummaryList: [{ CertificateArn: 'arn:wild-east', DomainName: '*.demotelnyx.com' }] }) };
      }
      return { stdout: JSON.stringify({ CertificateSummaryList: [] }) };
    };
    const result = await findCertificateInOtherRegions({
      domain: 'cc-test3.demotelnyx.com',
      excludeRegion: 'us-west-2',
      regions: ['eu-central-1', 'us-east-2', 'us-west-2'],
      execImpl,
    });
    assert.ok(result);
    assert.strictEqual(result.region, 'us-east-2');
    assert.strictEqual(result.certificates[0].certificateArn, 'arn:wild-east');
    // Never probes the deployment's own excluded region.
    assert.ok(!seenRegions.includes('us-west-2'));
  });

  it('returns null when no other region has a matching certificate', async () => {
    const execImpl = async () => ({ stdout: JSON.stringify({ CertificateSummaryList: [] }) });
    const result = await findCertificateInOtherRegions({
      domain: 'cc-test3.demotelnyx.com',
      excludeRegion: 'us-west-2',
      regions: ['eu-central-1', 'us-east-2'],
      execImpl,
    });
    assert.strictEqual(result, null);
  });

  it('stops at the first region with a match (does not need to scan every region)', async () => {
    const seenRegions = [];
    const execImpl = async (cmd, args) => {
      const regionIdx = args.indexOf('--region');
      const region = regionIdx !== -1 ? args[regionIdx + 1] : null;
      seenRegions.push(region);
      if (region === 'eu-central-1') {
        return { stdout: JSON.stringify({ CertificateSummaryList: [{ CertificateArn: 'arn:eu', DomainName: '*.demotelnyx.com' }] }) };
      }
      return { stdout: JSON.stringify({ CertificateSummaryList: [] }) };
    };
    const result = await findCertificateInOtherRegions({
      domain: 'cc-test3.demotelnyx.com',
      excludeRegion: 'us-west-2',
      regions: ['eu-central-1', 'us-east-2'],
      execImpl,
    });
    assert.strictEqual(result.region, 'eu-central-1');
    assert.deepStrictEqual(seenRegions, ['eu-central-1']);
  });

  it('tolerates a region probe failing (e.g. opted-out region) and keeps checking the rest', async () => {
    const execImpl = async (cmd, args) => {
      const regionIdx = args.indexOf('--region');
      const region = regionIdx !== -1 ? args[regionIdx + 1] : null;
      if (region === 'me-south-1') throw new Error('not opted in');
      if (region === 'us-east-2') {
        return { stdout: JSON.stringify({ CertificateSummaryList: [{ CertificateArn: 'arn:east', DomainName: '*.demotelnyx.com' }] }) };
      }
      return { stdout: JSON.stringify({ CertificateSummaryList: [] }) };
    };
    const result = await findCertificateInOtherRegions({
      domain: 'cc-test3.demotelnyx.com',
      excludeRegion: 'us-west-2',
      regions: ['me-south-1', 'us-east-2'],
      execImpl,
    });
    assert.strictEqual(result.region, 'us-east-2');
  });

  it('throws when domain is missing', async () => {
    await assert.rejects(() => findCertificateInOtherRegions({ regions: ['us-east-2'] }), /domain/);
  });
});

describe('acm.mjs — deleteCertificate', () => {
  it('deletes the certificate and reports outcome=deleted', async () => {
    const calls = [];
    const execImpl = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '' };
    };
    const result = await deleteCertificate({ certificateArn: 'arn:to-delete', region: 'us-west-2', execImpl });
    assert.strictEqual(result.outcome, 'deleted');
    assert.strictEqual(calls[0].cmd, 'aws');
    assert.deepStrictEqual(calls[0].args, ['acm', 'delete-certificate', '--certificate-arn', 'arn:to-delete', '--region', 'us-west-2']);
  });

  it('treats an already-gone certificate (ResourceNotFoundException) as success, not an error', async () => {
    const execImpl = async () => {
      const err = new Error('An error occurred (ResourceNotFoundException) when calling the DeleteCertificate operation');
      err.stderr = err.message;
      throw err;
    };
    const result = await deleteCertificate({ certificateArn: 'arn:already-gone', region: 'us-west-2', execImpl });
    assert.strictEqual(result.outcome, 'not-found');
  });

  it('reports outcome=in-use (not a thrown error) when the certificate is still attached to a listener', async () => {
    const execImpl = async () => {
      const err = new Error('An error occurred (ResourceInUseException) when calling the DeleteCertificate operation: Certificate is in use');
      err.stderr = err.message;
      throw err;
    };
    const result = await deleteCertificate({ certificateArn: 'arn:in-use', region: 'us-west-2', execImpl });
    assert.strictEqual(result.outcome, 'in-use');
    assert.ok(result.error.includes('ResourceInUseException'));
  });

  it('re-throws unexpected AWS CLI errors instead of swallowing them', async () => {
    const execImpl = async () => {
      const err = new Error('An error occurred (AccessDeniedException) when calling the DeleteCertificate operation');
      err.stderr = err.message;
      throw err;
    };
    await assert.rejects(
      () => deleteCertificate({ certificateArn: 'arn:x', region: 'us-west-2', execImpl }),
      /AccessDeniedException/,
    );
  });

  it('skips with no API call when certificateArn is falsy', async () => {
    let called = false;
    const execImpl = async () => { called = true; return { stdout: '' }; };
    const result = await deleteCertificate({ certificateArn: null, region: 'us-west-2', execImpl });
    assert.strictEqual(result.outcome, 'skipped');
    assert.strictEqual(called, false);
  });
});

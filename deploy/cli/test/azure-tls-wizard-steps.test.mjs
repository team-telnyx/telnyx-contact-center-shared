import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  runAzureDnsStep,
  runAzureCertificateStep,
} from '../lib/wizard.mjs';

// Focused tests for the two Azure-specific wizard steps that were mixed
// into PR #1199's fix set / PR #1200's follow-up (see repo history) but
// never got dedicated coverage (wizard.test.mjs's Azure happy-path test
// always declines the Application Gateway, so these steps' bodies were
// exercised only manually before this file existed).

function makeIo({ confirmAnswers = {}, selectAnswers = [] } = {}) {
  const log = [];
  let si = 0;
  return {
    log: (msg) => log.push(msg),
    confirm: async (question, def) => {
      for (const [pattern, answer] of Object.entries(confirmAnswers)) {
        if (new RegExp(pattern, 'i').test(question)) return answer;
      }
      return def;
    },
    select: async (_title, options) => {
      const next = selectAnswers[si++];
      if (next !== undefined) return next;
      return options[0].value;
    },
    step: (msg) => { log.push(msg); return { succeed: (m) => log.push(m || msg), fail: (m) => log.push(m || msg), warn: (m) => log.push(m || msg), info: (m) => log.push(m) }; },
    longStep: (msg) => { log.push(msg); return { succeed: (m) => log.push(m || msg), fail: (m) => log.push(m || msg), warn: (m) => log.push(m || msg), info: (m) => log.push(m), stop: () => {} }; },
    __log: log,
  };
}

describe('runAzureDnsStep', () => {
  it('no-ops for non-azure targets', async () => {
    const io = makeIo();
    const { state } = await runAzureDnsStep({ state: { target: 'aws' }, io });
    assert.strictEqual(state.target, 'aws');
  });

  it('no-ops when Application Gateway was not opted into (lbEnabled=false)', async () => {
    const io = makeIo();
    const { state } = await runAzureDnsStep({ state: { target: 'azure', infra: { lbEnabled: false } }, io });
    assert.strictEqual(state.infra.azureDnsManaged, undefined);
  });

  it('sets azureDnsManaged=false when the operator declines DNS automation', async () => {
    const io = makeIo({ confirmAnswers: { 'manage.*dns automatically': false } });
    const { state } = await runAzureDnsStep({
      state: { target: 'azure', domain: 'demo.example.com', infra: { lbEnabled: true } },
      io,
      listDnsZonesImpl: async () => { throw new Error('should not be called'); },
    });
    assert.strictEqual(state.infra.azureDnsManaged, false);
  });

  it('sets azureDnsManaged=false when no matching zone is found', async () => {
    const io = makeIo({ confirmAnswers: { 'manage.*dns automatically': true } });
    const { state } = await runAzureDnsStep({
      state: { target: 'azure', domain: 'demo.example.com', infra: { lbEnabled: true } },
      io,
      listDnsZonesImpl: async () => [{ name: 'unrelated.com', resourceGroup: 'rg1' }],
      findZoneForHostnameImpl: () => null,
    });
    assert.strictEqual(state.infra.azureDnsManaged, false);
  });

  it('manages DNS automatically when a zone is found and no existing records conflict', async () => {
    const io = makeIo({ confirmAnswers: { 'manage.*dns automatically': true } });
    const { state } = await runAzureDnsStep({
      state: { target: 'azure', domain: 'demo.example.com', infra: { lbEnabled: true } },
      io,
      listDnsZonesImpl: async () => [{ name: 'demo.example.com', resourceGroup: 'cc-rg' }],
      findZoneForHostnameImpl: (zones) => zones[0],
      findRecordForHostImpl: async () => null,
    });
    assert.strictEqual(state.infra.azureDnsManaged, true);
    assert.strictEqual(state.infra.azureDnsZoneName, 'demo.example.com');
    assert.strictEqual(state.infra.azureDnsZoneResourceGroup, 'cc-rg');
  });

  it('REGRESSION (Codex bot finding on PR #1199): declining to overwrite an existing ws.<domain> record disables DNS management, not just an existing primary-domain record', async () => {
    const io = makeIo({ confirmAnswers: { 'overwrite it too': false } });
    const lookedUp = [];
    const { state } = await runAzureDnsStep({
      state: { target: 'azure', domain: 'demo.example.com', infra: { lbEnabled: true } },
      io,
      listDnsZonesImpl: async () => [{ name: 'demo.example.com', resourceGroup: 'cc-rg' }],
      findZoneForHostnameImpl: (zones) => zones[0],
      findRecordForHostImpl: async ({ fqdn }) => {
        lookedUp.push(fqdn);
        // No conflict on the primary domain, but ws.<domain> already has a record.
        if (fqdn === 'ws.demo.example.com') return { name: fqdn, type: 'A', ttl: 300, values: ['9.9.9.9'] };
        return null;
      },
    });
    assert.ok(lookedUp.includes('demo.example.com'), 'expected the primary domain to be checked');
    assert.ok(lookedUp.includes('ws.demo.example.com'), 'expected ws.<domain> to ALSO be checked (this was the bug)');
    assert.strictEqual(state.infra.azureDnsManaged, false);
  });

  it('manages DNS automatically when the operator agrees to overwrite an existing ws.<domain> record', async () => {
    const io = makeIo({ confirmAnswers: { 'overwrite it too': true } });
    const { state } = await runAzureDnsStep({
      state: { target: 'azure', domain: 'demo.example.com', infra: { lbEnabled: true } },
      io,
      listDnsZonesImpl: async () => [{ name: 'demo.example.com', resourceGroup: 'cc-rg' }],
      findZoneForHostnameImpl: (zones) => zones[0],
      findRecordForHostImpl: async ({ fqdn }) => (fqdn === 'ws.demo.example.com' ? { name: fqdn, type: 'A', ttl: 300, values: ['9.9.9.9'] } : null),
    });
    assert.strictEqual(state.infra.azureDnsManaged, true);
  });

  it('does not even check ws.<domain> when the primary domain record was already declined (short-circuit)', async () => {
    const io = makeIo({ confirmAnswers: { 'overwrite it to point at this deployment': false } });
    const lookedUp = [];
    const { state } = await runAzureDnsStep({
      state: { target: 'azure', domain: 'demo.example.com', infra: { lbEnabled: true } },
      io,
      listDnsZonesImpl: async () => [{ name: 'demo.example.com', resourceGroup: 'cc-rg' }],
      findZoneForHostnameImpl: (zones) => zones[0],
      findRecordForHostImpl: async ({ fqdn }) => {
        lookedUp.push(fqdn);
        if (fqdn === 'demo.example.com') return { name: fqdn, type: 'A', ttl: 300, values: ['1.1.1.1'] };
        return null;
      },
    });
    assert.deepEqual(lookedUp, ['demo.example.com']);
    assert.strictEqual(state.infra.azureDnsManaged, false);
  });
});

describe('runAzureCertificateStep', () => {
  it('no-ops for non-azure targets', async () => {
    const io = makeIo();
    const { state } = await runAzureCertificateStep({ state: { target: 'aws' }, io });
    assert.strictEqual(state.target, 'aws');
  });

  it('no-ops when Application Gateway was not opted into', async () => {
    const io = makeIo();
    const { state } = await runAzureCertificateStep({ state: { target: 'azure', infra: { lbEnabled: false } }, io });
    assert.strictEqual(state.infra.azureTlsCertSource, undefined);
  });

  it('defensive fallback: logs a warning and returns azureTlsCertSource=null when somehow reached with no keyVaultName yet (normally runAzureWizardTail bootstraps the vault first)', async () => {
    const io = makeIo();
    const { state } = await runAzureCertificateStep({
      state: { target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main', infra: { lbEnabled: true, keyVaultName: null } },
      io,
    });
    assert.strictEqual(state.infra.azureTlsCertSource, null);
    assert.ok(io.__log.some((l) => /No Key Vault known yet/.test(l)));
  });

  it('requires manual import when Key Vault exists but no reusable cert is found and Azure DNS is not managed (DNS-01 impossible without zone control)', async () => {
    const io = makeIo();
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: { lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: false },
      },
      io,
      findCertificatesForDomainImpl: async () => [],
    });
    assert.strictEqual(state.infra.azureTlsCertSource, 'manual');
    assert.strictEqual(state.infra.azureTlsCertSourceName, null);
  });

  it('reuses an existing certificate covering both domain and ws.<domain> after a single yes/no confirm (no open-choice menu)', async () => {
    const io = makeIo({ confirmAnswers: { 'reuse it': true } });
    let copyArgs = null;
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: { lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: false },
      },
      io,
      findCertificatesForDomainImpl: async ({ altNames }) => {
        assert.deepEqual(altNames, ['ws.demo.example.com']);
        return [{ name: 'my-wildcard-cert', validTo: '2027-01-01T00:00:00Z' }];
      },
      copyCertificateToNameImpl: async (args) => { copyArgs = args; return { copied: true }; },
    });
    assert.strictEqual(state.infra.azureTlsCertSource, 'existing');
    assert.strictEqual(state.infra.azureTlsCertSourceName, 'my-wildcard-cert');
    assert.strictEqual(copyArgs.sourceName, 'my-wildcard-cert');
    assert.strictEqual(copyArgs.targetName, 'cc-main-tls-cert');
  });

  it('REGRESSION (single-pass wizard): when Azure DNS manages the zone and no existing cert is found, Let\'s Encrypt is issued AUTOMATICALLY — no confirm/select prompt to decline', async () => {
    const io = makeIo();
    let confirmCalled = false;
    let selectCalled = false;
    io.confirm = async (_q, def) => { confirmCalled = true; return def; };
    io.select = async () => { selectCalled = true; throw new Error('select should never be called — this step no longer offers an open-choice menu'); };
    let issueArgs = null;
    let importArgs = null;
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: {
          lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: true,
          azureDnsZoneName: 'demo.example.com', azureDnsZoneResourceGroup: 'cc-rg',
        },
      },
      io,
      deployDir: '/tmp/fake-deploy-dir',
      findCertificatesForDomainImpl: async () => [],
      issueCertificateViaDns01Impl: async (args) => {
        issueArgs = args;
        return { pfxBuffer: Buffer.from('fake-pfx'), pfxPassword: 'pw123' };
      },
      importPfxToKeyVaultImpl: async (args) => { importArgs = args; return { imported: true }; },
    });
    assert.strictEqual(confirmCalled, false, 'no confirm() should be asked — no existing cert to offer reuse of');
    assert.strictEqual(selectCalled, false, 'no select() should be asked — Let\'s Encrypt is automatic, not a choice');
    assert.deepEqual(issueArgs.altNames, ['ws.demo.example.com']);
    assert.strictEqual(issueArgs.zoneName, 'demo.example.com');
    assert.strictEqual(importArgs.targetName, 'cc-main-tls-cert');
    assert.strictEqual(importArgs.pfxPassword, 'pw123');
    assert.strictEqual(state.infra.azureTlsCertSource, 'letsencrypt');
    assert.strictEqual(state.infra.azureTlsCertSourceName, 'cc-main-tls-cert');
  });

  it("requires manual import (never issues Let's Encrypt) when Azure DNS does not manage the zone, even with no existing cert", async () => {
    const io = makeIo();
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: { lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: false },
      },
      io,
      findCertificatesForDomainImpl: async () => [],
    });
    assert.strictEqual(state.infra.azureTlsCertSource, 'manual');
  });

  it('declining to reuse an existing cert falls through to automatic Let\'s Encrypt when Azure DNS manages the zone', async () => {
    const io = makeIo({ confirmAnswers: { 'reuse it': false } });
    let issueCalled = false;
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: {
          lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: true,
          azureDnsZoneName: 'demo.example.com', azureDnsZoneResourceGroup: 'cc-rg',
        },
      },
      io,
      deployDir: '/tmp/fake-deploy-dir',
      findCertificatesForDomainImpl: async () => [{ name: 'stale-cert', validTo: '2027-01-01T00:00:00Z' }],
      issueCertificateViaDns01Impl: async () => {
        issueCalled = true;
        return { pfxBuffer: Buffer.from('fake-pfx'), pfxPassword: 'pw123' };
      },
      importPfxToKeyVaultImpl: async () => ({ imported: true }),
    });
    assert.strictEqual(issueCalled, true);
    assert.strictEqual(state.infra.azureTlsCertSource, 'letsencrypt');
  });

  it("falls back to manual when automatic Let's Encrypt issuance fails", async () => {
    const io = makeIo();
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: {
          lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: true,
          azureDnsZoneName: 'demo.example.com', azureDnsZoneResourceGroup: 'cc-rg',
        },
      },
      io,
      deployDir: '/tmp/fake-deploy-dir',
      findCertificatesForDomainImpl: async () => [],
      issueCertificateViaDns01Impl: async () => { throw new Error('ACME server unreachable'); },
    });
    assert.strictEqual(state.infra.azureTlsCertSource, 'manual');
    assert.ok(io.__log.some((l) => /Falling back to manual import/.test(l)));
  });

  it('falls through to automatic Let\'s Encrypt when copying a reused certificate fails (Azure DNS managed)', async () => {
    const io = makeIo({ confirmAnswers: { 'reuse it': true } });
    let issueCalled = false;
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: {
          lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: true,
          azureDnsZoneName: 'demo.example.com', azureDnsZoneResourceGroup: 'cc-rg',
        },
      },
      io,
      deployDir: '/tmp/fake-deploy-dir',
      findCertificatesForDomainImpl: async () => [{ name: 'broken-cert', validTo: '2027-01-01T00:00:00Z' }],
      copyCertificateToNameImpl: async () => { throw new Error('secret download failed'); },
      issueCertificateViaDns01Impl: async () => {
        issueCalled = true;
        return { pfxBuffer: Buffer.from('fake-pfx'), pfxPassword: 'pw123' };
      },
      importPfxToKeyVaultImpl: async () => ({ imported: true }),
    });
    assert.strictEqual(issueCalled, true);
    assert.strictEqual(state.infra.azureTlsCertSource, 'letsencrypt');
  });

  it('falls back to manual when copying a reused certificate fails and Azure DNS is not managed', async () => {
    const io = makeIo({ confirmAnswers: { 'reuse it': true } });
    const { state } = await runAzureCertificateStep({
      state: {
        target: 'azure', domain: 'demo.example.com', deploymentName: 'cc-main',
        infra: { lbEnabled: true, keyVaultName: 'cc-main-kv', azureDnsManaged: false },
      },
      io,
      findCertificatesForDomainImpl: async () => [{ name: 'broken-cert', validTo: '2027-01-01T00:00:00Z' }],
      copyCertificateToNameImpl: async () => { throw new Error('secret download failed'); },
    });
    assert.strictEqual(state.infra.azureTlsCertSource, 'manual');
  });
});

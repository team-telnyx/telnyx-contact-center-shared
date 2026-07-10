import assert from 'node:assert';
import { describe, it } from 'node:test';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';
import {
  listCertificates, describeCertificate, findCertificatesForDomain, copyCertificateToName,
} from '../lib/azure-keyvault-cert.mjs';

// Generates a real self-signed X.509 cert (via node-forge) covering the
// given hostnames, so describeCertificate/findCertificatesForDomain can be
// exercised against real DER bytes + Node's own X509Certificate.checkHost
// instead of a hand-rolled fake — same rigor as the live manual
// verification already done for buildPfx() (see azure-acme.mjs's tests).
function makeSelfSignedCertDer({ commonName, altNames = [] }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [commonName, ...altNames].map((value) => ({ type: 2, value })),
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

function makeExpiredCertDer({ commonName }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() - 24 * 3600 * 1000); // expired yesterday
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

function makeExecMock(handlers) {
  return async (cmd, args) => {
    for (const [matcher, fn] of handlers) {
      if (matcher(args)) return fn(args);
    }
    throw new Error(`Unmocked az call: ${cmd} ${args.join(' ')}`);
  };
}

describe('azure-keyvault-cert.mjs', () => {
  describe('listCertificates', () => {
    it('lists certificate names from `az keyvault certificate list`', async () => {
      const execImpl = makeExecMock([
        [(a) => a[0] === 'keyvault' && a[1] === 'certificate' && a[2] === 'list',
          () => ({ stdout: JSON.stringify([{ name: 'cert-a' }, { name: 'cert-b' }]) })],
      ]);
      const result = await listCertificates({ vaultName: 'my-kv', execImpl });
      assert.deepEqual(result.map((c) => c.name), ['cert-a', 'cert-b']);
    });

    it('falls back to parsing the name out of `id` when `name` is absent', async () => {
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'list',
          () => ({ stdout: JSON.stringify([{ id: 'https://my-kv.vault.azure.net/certificates/cert-from-id/abcdef' }]) })],
      ]);
      const result = await listCertificates({ vaultName: 'my-kv', execImpl });
      assert.deepEqual(result.map((c) => c.name), ['cert-from-id']);
    });

    it('throws when vaultName is missing', async () => {
      await assert.rejects(() => listCertificates({ execImpl: async () => ({ stdout: '[]' }) }));
    });
  });

  describe('describeCertificate', () => {
    it('decodes a real cert and exposes checkHost() for SAN matching', async () => {
      const cerB64 = makeSelfSignedCertDer({ commonName: 'demo.example.com', altNames: ['ws.demo.example.com'] });
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'show',
          () => ({ stdout: JSON.stringify({ cer: cerB64, attributes: { enabled: true } }) })],
      ]);
      const described = await describeCertificate({ vaultName: 'my-kv', name: 'my-cert', execImpl });
      assert.strictEqual(described.name, 'my-cert');
      assert.strictEqual(described.enabled, true);
      assert.strictEqual(described.checkHost('demo.example.com'), true);
      assert.strictEqual(described.checkHost('ws.demo.example.com'), true);
      assert.strictEqual(described.checkHost('other.com'), false);
    });

    it('returns null when the vault has no `cer` field for that cert', async () => {
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'show', () => ({ stdout: JSON.stringify({}) })],
      ]);
      const described = await describeCertificate({ vaultName: 'my-kv', name: 'my-cert', execImpl });
      assert.strictEqual(described, null);
    });

    it('reflects attributes.enabled=false', async () => {
      const cerB64 = makeSelfSignedCertDer({ commonName: 'demo.example.com' });
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'show',
          () => ({ stdout: JSON.stringify({ cer: cerB64, attributes: { enabled: false } }) })],
      ]);
      const described = await describeCertificate({ vaultName: 'my-kv', name: 'my-cert', execImpl });
      assert.strictEqual(described.enabled, false);
    });
  });

  describe('findCertificatesForDomain', () => {
    it('includes only certs that cover BOTH domain and every altName', async () => {
      const covering = makeSelfSignedCertDer({ commonName: 'demo.example.com', altNames: ['ws.demo.example.com'] });
      const partial = makeSelfSignedCertDer({ commonName: 'demo.example.com' }); // no ws SAN
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'list',
          () => ({ stdout: JSON.stringify([{ name: 'full-cert' }, { name: 'partial-cert' }]) })],
        [(a) => a[1] === 'certificate' && a[2] === 'show' && a.includes('full-cert'),
          () => ({ stdout: JSON.stringify({ cer: covering, attributes: { enabled: true } }) })],
        [(a) => a[1] === 'certificate' && a[2] === 'show' && a.includes('partial-cert'),
          () => ({ stdout: JSON.stringify({ cer: partial, attributes: { enabled: true } }) })],
      ]);
      const results = await findCertificatesForDomain({
        vaultName: 'my-kv', domain: 'demo.example.com', altNames: ['ws.demo.example.com'], execImpl,
      });
      assert.deepEqual(results.map((r) => r.name), ['full-cert']);
    });

    it('excludes expired certificates', async () => {
      const expired = makeExpiredCertDer({ commonName: 'demo.example.com' });
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'list', () => ({ stdout: JSON.stringify([{ name: 'old-cert' }]) })],
        [(a) => a[1] === 'certificate' && a[2] === 'show',
          () => ({ stdout: JSON.stringify({ cer: expired, attributes: { enabled: true } }) })],
      ]);
      const results = await findCertificatesForDomain({ vaultName: 'my-kv', domain: 'demo.example.com', execImpl });
      assert.deepEqual(results, []);
    });

    it('excludes disabled certificates', async () => {
      const cerB64 = makeSelfSignedCertDer({ commonName: 'demo.example.com' });
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'list', () => ({ stdout: JSON.stringify([{ name: 'disabled-cert' }]) })],
        [(a) => a[1] === 'certificate' && a[2] === 'show',
          () => ({ stdout: JSON.stringify({ cer: cerB64, attributes: { enabled: false } }) })],
      ]);
      const results = await findCertificatesForDomain({ vaultName: 'my-kv', domain: 'demo.example.com', execImpl });
      assert.deepEqual(results, []);
    });

    it('returns an empty list (not a throw) when one cert fails to describe', async () => {
      const cerB64 = makeSelfSignedCertDer({ commonName: 'demo.example.com' });
      const execImpl = makeExecMock([
        [(a) => a[1] === 'certificate' && a[2] === 'list', () => ({ stdout: JSON.stringify([{ name: 'broken-cert' }, { name: 'good-cert' }]) })],
        [(a) => a[1] === 'certificate' && a[2] === 'show' && a.includes('broken-cert'),
          () => { throw new Error('access denied'); }],
        [(a) => a[1] === 'certificate' && a[2] === 'show' && a.includes('good-cert'),
          () => ({ stdout: JSON.stringify({ cer: cerB64, attributes: { enabled: true } }) })],
      ]);
      const results = await findCertificatesForDomain({ vaultName: 'my-kv', domain: 'demo.example.com', execImpl });
      assert.deepEqual(results.map((r) => r.name), ['good-cert']);
    });
  });

  describe('copyCertificateToName', () => {
    it('downloads the source secret and re-imports it under the target name', async () => {
      const fakePfxB64 = Buffer.from('fake-pfx-bytes').toString('base64');
      const importCalls = [];
      const execImpl = makeExecMock([
        [(a) => a[1] === 'secret' && a[2] === 'show',
          () => ({ stdout: `${fakePfxB64}\n` })],
        [(a) => a[1] === 'certificate' && a[2] === 'import',
          (a) => { importCalls.push(a); return { stdout: '' }; }],
      ]);
      const result = await copyCertificateToName({
        vaultName: 'my-kv', sourceName: 'wildcard-cert', targetName: 'cc-main-tls-cert', execImpl,
      });
      assert.strictEqual(result.copied, true);
      assert.strictEqual(result.targetName, 'cc-main-tls-cert');
      assert.strictEqual(importCalls.length, 1);
      assert.ok(importCalls[0].includes('cc-main-tls-cert'));
    });

    it('is a no-op when source and target names are already identical', async () => {
      const result = await copyCertificateToName({
        vaultName: 'my-kv', sourceName: 'same-name', targetName: 'same-name', execImpl: async () => { throw new Error('should not be called'); },
      });
      assert.strictEqual(result.copied, false);
      assert.strictEqual(result.reason, 'already-named-correctly');
    });

    it('throws a clear error when the source secret comes back empty', async () => {
      const execImpl = makeExecMock([
        [(a) => a[1] === 'secret' && a[2] === 'show', () => ({ stdout: '' })],
      ]);
      await assert.rejects(
        () => copyCertificateToName({ vaultName: 'my-kv', sourceName: 'src', targetName: 'dst', execImpl }),
        /came back empty/,
      );
    });
  });
});

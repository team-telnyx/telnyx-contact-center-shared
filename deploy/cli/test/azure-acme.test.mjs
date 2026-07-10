import assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import {
  loadOrCreateAccountKey, issueCertificateViaDns01, buildPfx, importPfxToKeyVault,
} from '../lib/azure-acme.mjs';

function makeExecMock(handlers) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    for (const [matcher, handler] of handlers) {
      if (matcher(args)) return handler(args);
    }
    throw new Error(`Unmocked az call: ${cmd} ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

// Builds a real self-signed cert + key pair (PEM) via node-forge, standing
// in for what Let's Encrypt's client.auto() would normally return, so
// buildPfx() is exercised against real PEM material end-to-end (same
// approach already manually verified live — see this module's PR
// description — now captured as an automated regression test).
function makeSelfSignedPem({ commonName = 'demo.example.com' } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe('azure-acme.mjs', () => {
  describe('loadOrCreateAccountKey', () => {
    it('creates a new account key on first use and persists it to deployDir', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cc-acme-test-'));
      try {
        const fakeKey = Buffer.from('fake-pem-key-bytes');
        const acmeCryptoImpl = { createPrivateKey: async () => fakeKey };
        const result = await loadOrCreateAccountKey({ deployDir: dir, acmeCryptoImpl });
        assert.strictEqual(result.created, true);
        assert.deepEqual(result.key, fakeKey);
        const onDisk = await readFile(join(dir, 'letsencrypt-account-key.pem'));
        assert.deepEqual(onDisk, fakeKey);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reuses an existing account key on a second call instead of creating a new one', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cc-acme-test-'));
      try {
        let createCalls = 0;
        const acmeCryptoImpl = { createPrivateKey: async () => { createCalls += 1; return Buffer.from(`key-${createCalls}`); } };
        const first = await loadOrCreateAccountKey({ deployDir: dir, acmeCryptoImpl });
        const second = await loadOrCreateAccountKey({ deployDir: dir, acmeCryptoImpl });
        assert.strictEqual(first.created, true);
        assert.strictEqual(second.created, false);
        assert.deepEqual(first.key, second.key);
        assert.strictEqual(createCalls, 1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('throws when deployDir is missing', async () => {
      await assert.rejects(() => loadOrCreateAccountKey({}));
    });
  });

  describe('buildPfx', () => {
    it('assembles a PFX whose embedded cert/key match the input PEM (byte-verifiable round trip)', () => {
      const { certPem, keyPem } = makeSelfSignedPem({ commonName: 'demo.example.com' });
      const pfxBuffer = buildPfx({ certPem, keyPem, password: 'test-pw-123' });
      assert.ok(Buffer.isBuffer(pfxBuffer));
      assert.ok(pfxBuffer.length > 0);

      // Round-trip: parse the PFX back out with forge and confirm it holds
      // the same cert + a matching key (RSA moduli equal — the same check
      // this module's PR description reports doing manually via openssl).
      const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, 'test-pw-123');
      const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const certBag = bags[forge.pki.oids.certBag][0];
      const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
      const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];

      const originalCert = forge.pki.certificateFromPem(certPem);
      const originalKey = forge.pki.privateKeyFromPem(keyPem);
      assert.strictEqual(certBag.cert.subject.getField('CN').value, 'demo.example.com');
      assert.strictEqual(originalCert.subject.getField('CN').value, 'demo.example.com');
      assert.strictEqual(keyBag.key.n.toString(16), originalKey.n.toString(16), 'PFX private key modulus must match the original key');
    });

    it('produces a usable PFX even with an empty password', () => {
      const { certPem, keyPem } = makeSelfSignedPem();
      const pfxBuffer = buildPfx({ certPem, keyPem });
      assert.ok(pfxBuffer.length > 0);
    });
  });

  describe('importPfxToKeyVault', () => {
    it('writes the PFX to a temp file and invokes `az keyvault certificate import`, then cleans up', async () => {
      let importedFilePath = null;
      const execImpl = makeExecMock([
        [(a) => a[0] === 'keyvault' && a[1] === 'certificate' && a[2] === 'import',
          (a) => { importedFilePath = a[a.indexOf('--file') + 1]; return { stdout: '' }; }],
      ]);
      const result = await importPfxToKeyVault({
        vaultName: 'my-kv', targetName: 'cc-main-tls-cert', pfxBuffer: Buffer.from('fake-pfx'), pfxPassword: 'pw', execImpl,
      });
      assert.strictEqual(result.imported, true);
      assert.strictEqual(result.targetName, 'cc-main-tls-cert');
      assert.ok(importedFilePath, 'expected --file arg to be captured');
      // Temp dir must be cleaned up afterward.
      await assert.rejects(() => readFile(importedFilePath));
    });

    it('throws when required args are missing', async () => {
      await assert.rejects(() => importPfxToKeyVault({ targetName: 'x', pfxBuffer: Buffer.from('a') }));
      await assert.rejects(() => importPfxToKeyVault({ vaultName: 'x', pfxBuffer: Buffer.from('a') }));
      await assert.rejects(() => importPfxToKeyVault({ vaultName: 'x', targetName: 'y' }));
    });
  });

  describe('issueCertificateViaDns01', () => {
    it('creates a TXT challenge record via Azure DNS, waits for propagation, then cleans it up', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cc-acme-test-'));
      try {
        const dnsAddCalls = [];
        const dnsDeleteCalls = [];
        const execImpl = makeExecMock([
          [(a) => a[0] === 'network' && a[2] === 'record-set' && a[4] === 'add-record',
            (a) => { dnsAddCalls.push(a); return { stdout: '' }; }],
          [(a) => a[0] === 'network' && a[2] === 'record-set' && a[4] === 'delete',
            (a) => { dnsDeleteCalls.push(a); return { stdout: '' }; }],
        ]);
        const { certPem, keyPem } = makeSelfSignedPem();
        let sleptMs = null;
        const fakeClient = {
          auto: async ({ challengeCreateFn, challengeRemoveFn }) => {
            const authz = { identifier: { value: 'demo.example.com' } };
            const challenge = { type: 'dns-01' };
            await challengeCreateFn(authz, challenge, 'fake-key-authorization');
            await challengeRemoveFn(authz, challenge);
            return certPem;
          },
        };
        const result = await issueCertificateViaDns01({
          domain: 'demo.example.com',
          altNames: ['ws.demo.example.com'],
          deployDir: dir,
          zoneName: 'demo.example.com',
          resourceGroup: 'cc-rg',
          execImpl,
          acmeCryptoImpl: {
            createPrivateKey: async () => Buffer.from('fake-account-key'),
            createCsr: async () => [{ toString: () => keyPem }, Buffer.from('fake-csr')],
          },
          ClientImpl: function FakeClient() { return fakeClient; },
          directoryUrls: { letsencrypt: { staging: 'https://staging', production: 'https://prod' } },
          sleep: async (ms) => { sleptMs = ms; },
          propagationWaitMs: 1234,
        });
        assert.ok(result.pfxBuffer.length > 0);
        assert.ok(result.pfxPassword.length > 0);
        assert.strictEqual(dnsAddCalls.length, 1);
        assert.strictEqual(dnsDeleteCalls.length, 1);
        assert.strictEqual(sleptMs, 1234);
        assert.deepEqual(result.cleanupFailures, [], 'expected no cleanup failures on a successful delete');
        // Zone apex challenge record for the primary domain -> relative name "@".
        const addArgs = dnsAddCalls[0];
        assert.ok(addArgs.includes('--record-set-name'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('throws clearly when required args are missing', async () => {
      await assert.rejects(() => issueCertificateViaDns01({ deployDir: '/tmp/x', zoneName: 'z', resourceGroup: 'rg' }), /requires \{ domain \}/);
      await assert.rejects(() => issueCertificateViaDns01({ domain: 'x.com', zoneName: 'z', resourceGroup: 'rg' }), /requires \{ deployDir \}/);
      await assert.rejects(() => issueCertificateViaDns01({ domain: 'x.com', deployDir: '/tmp/x', resourceGroup: 'rg' }), /requires \{ zoneName \}/);
      await assert.rejects(() => issueCertificateViaDns01({ domain: 'x.com', deployDir: '/tmp/x', zoneName: 'z' }), /requires \{ resourceGroup \}/);
    });

    it('REGRESSION (live-tested against demo.example.com, an Azure-purchased domain): still returns a successful issuance when the DNS zone has a CanNotDelete lock blocking TXT cleanup, but surfaces it via cleanupFailures instead of swallowing it', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cc-acme-test-'));
      try {
        const execImpl = makeExecMock([
          [(a) => a[0] === 'network' && a[2] === 'record-set' && a[4] === 'add-record', () => ({ stdout: '' })],
          [(a) => a[0] === 'network' && a[2] === 'record-set' && a[4] === 'delete',
            () => { throw new Error("ERROR: (ScopeLocked) The scope '...' cannot perform delete operation because following scope(s) are locked: '.../dnszones/demo.example.com'. Please remove the lock and try again."); }],
        ]);
        const { certPem, keyPem } = makeSelfSignedPem();
        const fakeClient = {
          auto: async ({ challengeCreateFn, challengeRemoveFn }) => {
            const authz = { identifier: { value: 'demo.example.com' } };
            const challenge = { type: 'dns-01' };
            await challengeCreateFn(authz, challenge, 'fake-key-authorization');
            await challengeRemoveFn(authz, challenge); // fails due to the lock — must not throw out of issueCertificateViaDns01
            return certPem;
          },
        };
        const result = await issueCertificateViaDns01({
          domain: 'demo.example.com',
          deployDir: dir,
          zoneName: 'demo.example.com',
          resourceGroup: 'demo-rg',
          execImpl,
          acmeCryptoImpl: {
            createPrivateKey: async () => Buffer.from('fake-account-key'),
            createCsr: async () => [{ toString: () => keyPem }, Buffer.from('fake-csr')],
          },
          ClientImpl: function FakeClient() { return fakeClient; },
          directoryUrls: { letsencrypt: { staging: 'https://staging', production: 'https://prod' } },
          sleep: async () => {},
        });
        // Issuance itself must still succeed — the lock only blocks deletes.
        assert.ok(result.pfxBuffer.length > 0);
        assert.strictEqual(result.cleanupFailures.length, 1);
        assert.match(result.cleanupFailures[0].error, /ScopeLocked/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

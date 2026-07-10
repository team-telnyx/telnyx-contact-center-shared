import acme from 'acme-client';
import forge from 'node-forge';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFileCb);

// Let's Encrypt (ACME DNS-01) issuance for the Azure Application Gateway TLS
// step (see wizard.mjs's runAzureLbStep) — the automated alternative to
// "operator manually runs `az keyvault certificate import`". Azure has no
// AWS-ACM/GCP-managed-cert equivalent (Application Gateway reads its
// certificate FROM Key Vault, Azure itself never issues one), so unlike
// acm.mjs (thin wrapper around AWS's own issuance) this module IS the
// issuing CA client, using Let's Encrypt directly via the `acme-client`
// npm package (already a transitive dependency-free choice — pulls in only
// `node-forge`, which is what we use to assemble the final PFX Key Vault
// needs).
//
// Only reachable when Azure DNS is managing the domain (runAzureDnsStep's
// azureDnsManaged=true) — DNS-01 requires the wizard to create a TXT
// record itself, which is only possible when it already controls the
// zone. Same gating AWS's Route53-automated ACM path uses (a domain hosted
// elsewhere always falls back to the manual/semi-automated path).
//
// All az/acme calls go through injectable impls (execImpl for az CLI,
// acmeClientImpl for the ACME client itself) so this is fully
// unit-testable without hitting a live Let's Encrypt endpoint or Azure
// account.

const LETSENCRYPT_ACCOUNT_KEY_FILE = 'letsencrypt-account-key.pem';

/**
 * Loads (or creates, on first use) the Let's Encrypt ACCOUNT key — separate
 * from the per-certificate key. Persisted in deployDir so repeat issuances
 * (renewals, `cc up` re-runs) reuse the same ACME account instead of
 * registering a fresh one every time. Never committed to git (deployDir is
 * the wizard's own state directory, already gitignored — see .cc-state.json
 * / .cc-credentials.txt siblings).
 */
export async function loadOrCreateAccountKey({ deployDir, acmeCryptoImpl = acme.crypto } = {}) {
  if (!deployDir) throw new Error('loadOrCreateAccountKey requires { deployDir }');
  const keyPath = join(deployDir, LETSENCRYPT_ACCOUNT_KEY_FILE);
  try {
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(keyPath);
    return { key: existing, keyPath, created: false };
  } catch {
    const key = await acmeCryptoImpl.createPrivateKey();
    await mkdir(deployDir, { recursive: true });
    await writeFile(keyPath, key, { mode: 0o600 });
    return { key, keyPath, created: true };
  }
}

/**
 * Full DNS-01 issuance + Key Vault import, driven by `acme.crypto` (CSR
 * generation), a fresh `acme.Client` (order/authorize/finalize), Azure DNS
 * (`az network dns record-set txt`) for the challenge record, and
 * `node-forge` to assemble the final PFX (Key Vault's `certificate import`
 * requires PKCS#12 or PEM-with-key; Let's Encrypt returns a bare PEM chain
 * + we hold the PEM private key separately from createCsr — forge bundles
 * them).
 *
 * Staging vs production is caller-selected (`staging` param) so the wizard
 * can offer a dry-run against Let's Encrypt's staging CA (unlimited rate
 * limits, browser-untrusted cert) before spending production's much
 * tighter rate limit (5 certs/domain/week) on a typo'd domain.
 */
export async function issueCertificateViaDns01({
  domain, altNames = [], deployDir,
  zoneName, resourceGroup, subscriptionId,
  staging = false,
  execImpl = execFileAsync,
  acmeCryptoImpl = acme.crypto,
  ClientImpl = acme.Client,
  directoryUrls = acme.directory,
  email,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  propagationWaitMs = 20_000,
} = {}) {
  if (!domain) throw new Error('issueCertificateViaDns01 requires { domain }');
  if (!deployDir) throw new Error('issueCertificateViaDns01 requires { deployDir }');
  if (!zoneName) throw new Error('issueCertificateViaDns01 requires { zoneName }');
  if (!resourceGroup) throw new Error('issueCertificateViaDns01 requires { resourceGroup }');

  const { key: accountKey } = await loadOrCreateAccountKey({ deployDir, acmeCryptoImpl });
  const directoryUrl = staging ? directoryUrls.letsencrypt.staging : directoryUrls.letsencrypt.production;
  const client = new ClientImpl({ directoryUrl, accountKey });

  const [certKey, csr] = await acmeCryptoImpl.createCsr({
    commonName: domain,
    altNames: altNames.filter((a) => a && a !== domain),
  });

  // Track which TXT records we create so challengeRemoveFn (and a final
  // best-effort cleanup) can delete exactly those, never anything the
  // operator's zone already had for unrelated reasons.
  const createdRecords = [];

  const recordNameFor = (identifierValue) => {
    // Azure DNS record-sets are relative to the zone (see azure-dns.mjs's
    // findRecordForHost) — "_acme-challenge.sub.example.com" in zone
    // "example.com" is relative name "_acme-challenge.sub".
    const full = `_acme-challenge.${identifierValue}`;
    const zoneSuffix = zoneName.toLowerCase().replace(/\.$/, '');
    const normalized = full.toLowerCase().replace(/\.$/, '');
    return normalized === zoneSuffix ? '@' : normalized.slice(0, -(zoneSuffix.length + 1));
  };

  const challengeCreateFn = async (authz, challenge, keyAuthorization) => {
    if (challenge.type !== 'dns-01') return;
    const relativeName = recordNameFor(authz.identifier.value);
    const args = [
      'network', 'dns', 'record-set', 'txt', 'add-record',
      '--zone-name', zoneName,
      '--resource-group', resourceGroup,
      '--record-set-name', relativeName,
      '--value', keyAuthorization,
    ];
    if (subscriptionId) args.push('--subscription', subscriptionId);
    await execImpl('az', args, { maxBuffer: 1024 * 1024 * 4 });
    createdRecords.push({ relativeName });
    // Let's Encrypt's own DNS lookups (and the acme-client's local
    // pre-check before calling the ACME server) need the record to have
    // propagated — a fixed wait here is simpler and more predictable than
    // polling Azure DNS's own eventually-consistent read replicas, and
    // acme-client's verifyChallenge already backs off/retries on top of
    // this if propagation is slower than expected.
    await sleep(propagationWaitMs);
  };

  // Track cleanup failures (e.g. a ScopeLocked zone — see the CanNotDelete
  // lock Azure auto-applies to DNS zones created by purchasing a domain
  // through Azure, discovered via live testing against demo.example.com) so
  // the caller can warn the operator instead of the failure vanishing
  // silently. A leftover challenge TXT record is harmless clutter either
  // way — not worth failing an otherwise-successful issuance over — but
  // the operator should still be told cleanup didn't happen and why.
  const cleanupFailures = [];

  const challengeRemoveFn = async (authz, challenge) => {
    if (challenge.type !== 'dns-01') return;
    const relativeName = recordNameFor(authz.identifier.value);
    const args = [
      'network', 'dns', 'record-set', 'txt', 'delete',
      '--zone-name', zoneName,
      '--resource-group', resourceGroup,
      '--name', relativeName,
      '--yes',
    ];
    if (subscriptionId) args.push('--subscription', subscriptionId);
    try {
      await execImpl('az', args, { maxBuffer: 1024 * 1024 * 4 });
    } catch (err) {
      cleanupFailures.push({ relativeName, error: err.message });
    }
  };

  const certPem = await client.auto({
    csr,
    email,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    challengeCreateFn,
    challengeRemoveFn,
  });

  const pfxPassword = randomBytes(24).toString('base64url');
  const pfxBuffer = buildPfx({ certPem, keyPem: certKey.toString(), password: pfxPassword });

  return {
    certPem, keyPem: certKey.toString(), pfxBuffer, pfxPassword, createdRecords, staging, cleanupFailures,
  };
}

/**
 * Assembles a PKCS#12 (PFX) bundle from a PEM certificate chain + PEM
 * private key using node-forge — Key Vault's `certificate import` accepts
 * PFX or PEM-with-key, and PFX is the format cc-compute-single-azure's
 * ssl_certificate block / Application Gateway consumes without further
 * conversion (same format the manual `az keyvault certificate import
 * --file cert.pfx` instruction in runAzureLbStep already asks operators
 * for, so this keeps the automated and manual paths symmetric).
 */
export function buildPfx({ certPem, keyPem, password = '' }) {
  const forgeKey = forge.pki.privateKeyFromPem(keyPem);
  const chain = acme.crypto.splitPemChain
    ? acme.crypto.splitPemChain(certPem)
    : certPem.split(/(?=-----BEGIN CERTIFICATE-----)/g).filter((c) => c.trim());
  const forgeCerts = chain.map((c) => forge.pki.certificateFromPem(c));
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(forgeKey, forgeCerts, password, { algorithm: '3des' });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(p12Der, 'binary');
}

/**
 * Imports a freshly-issued PFX directly into Key Vault under `targetName`
 * — the last step of the automated Let's Encrypt path, writing straight to
 * the exact secret name Terraform's Application Gateway expects (see
 * azure-keyvault-cert.mjs's copyCertificateToName for the equivalent
 * "reuse an existing cert" path, which shares this same target-naming
 * requirement).
 */
export async function importPfxToKeyVault({
  vaultName, targetName, pfxBuffer, pfxPassword = '', execImpl = execFileAsync,
} = {}) {
  if (!vaultName) throw new Error('importPfxToKeyVault requires { vaultName }');
  if (!targetName) throw new Error('importPfxToKeyVault requires { targetName }');
  if (!pfxBuffer) throw new Error('importPfxToKeyVault requires { pfxBuffer }');

  const dir = await mkdtemp(join(tmpdir(), 'cc-le-cert-'));
  const pfxPath = join(dir, 'cert.pfx');
  try {
    await writeFile(pfxPath, pfxBuffer, { mode: 0o600 });
    const args = [
      'keyvault', 'certificate', 'import',
      '--vault-name', vaultName,
      '--name', targetName,
      '--file', pfxPath,
    ];
    if (pfxPassword) args.push('--password', pfxPassword);
    await execImpl('az', args, { maxBuffer: 1024 * 1024 * 8 });
    return { imported: true, targetName };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

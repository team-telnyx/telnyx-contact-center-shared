import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFileCb);

// Key Vault certificate discovery for the Azure Application Gateway TLS step
// (see wizard.mjs's runAzureLbStep) — lets the operator reuse a certificate
// ALREADY imported into this deployment's Key Vault (e.g. from an earlier
// `az keyvault certificate import` under a different name, or a wildcard
// cert someone pre-loaded for reuse) instead of always requiring a fresh
// manual import. Azure has no equivalent of AWS ACM/GCP's managed-cert
// issuance to query — this is purely "what's already sitting in MY vault",
// scoped to the ONE Key Vault this deployment owns (unlike AWS's
// listCertificatesForDomain, which searches the whole account/region).
//
// All az calls go through the injectable `execImpl`, same pattern as
// azure-dns.mjs / azure-cloud.mjs, so this is fully unit-testable without a
// live account.

/**
 * Lists every certificate object in the vault, normalized to { name }.
 * Prefers the `name` field az CLI includes directly; falls back to parsing
 * it out of `id` (".../certificates/<name>/<version>") for older az CLI
 * versions that omit it — same defensive fallback pattern as
 * azure-dns.mjs's listDnsZones resourceGroup parsing.
 */
export async function listCertificates({ vaultName, execImpl = execFileAsync } = {}) {
  if (!vaultName) throw new Error('listCertificates requires { vaultName }');
  const { stdout } = await execImpl('az', [
    'keyvault', 'certificate', 'list',
    '--vault-name', vaultName,
    '--output', 'json',
  ], { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout || '[]');
  return parsed
    .map((c) => ({ name: c.name || c.id?.match(/\/certificates\/([^/]+)/)?.[1] || null }))
    .filter((c) => c.name);
}

/**
 * Fetches one certificate's public portion (base64 DER, the `cer` field —
 * a stable part of Key Vault's GetCertificate response) and decodes it with
 * Node's built-in X509Certificate. Deliberately does NOT touch the private
 * key / pfx secret — this is a read-only "what does this cert cover"
 * check, requires only the `certificates/get` permission the deployer
 * already holds (Key Vault Certificates Officer, see cc-secrets-azure).
 */
export async function describeCertificate({ vaultName, name, execImpl = execFileAsync } = {}) {
  if (!vaultName) throw new Error('describeCertificate requires { vaultName }');
  if (!name) throw new Error('describeCertificate requires { name }');
  const { stdout } = await execImpl('az', [
    'keyvault', 'certificate', 'show',
    '--vault-name', vaultName,
    '--name', name,
    '--output', 'json',
  ], { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout || 'null');
  if (!parsed || !parsed.cer) return null;
  const der = Buffer.from(parsed.cer, 'base64');
  const x509 = new X509Certificate(der);
  return {
    name,
    subject: x509.subject,
    validTo: x509.validTo,
    enabled: parsed.attributes?.enabled !== false,
    checkHost: (host) => Boolean(x509.checkHost(host)),
  };
}

/**
 * Lists every USABLE certificate (enabled, not expired) in the vault that
 * covers BOTH `domain` and every entry in `altNames` (e.g. the streaming
 * ws.<domain> host from cc-compute-single-azure's multi-site App Gateway
 * listeners, see PR #1199) — the set the wizard should actually offer the
 * operator to reuse. A cert covering only the primary domain but not
 * ws.<domain> is silently excluded rather than offered and failing
 * `terraform apply` later on the second listener.
 */
export async function findCertificatesForDomain({
  vaultName, domain, altNames = [], execImpl = execFileAsync,
} = {}) {
  if (!vaultName) throw new Error('findCertificatesForDomain requires { vaultName }');
  if (!domain) throw new Error('findCertificatesForDomain requires { domain }');
  const certs = await listCertificates({ vaultName, execImpl });
  const results = [];
  // Sequential, not Promise.all: a vault holds a handful of certs at most
  // (this is a per-deployment vault, not a shared account-wide store) and
  // sequential calls keep az CLI's own auth-token cache from being hammered
  // concurrently, mirroring findCertificateInOtherRegions' loop style.
  for (const { name } of certs) {
    // eslint-disable-next-line no-await-in-loop -- intentional, see above.
    const described = await describeCertificate({ vaultName, name, execImpl }).catch(() => null);
    if (!described || !described.enabled) continue;
    if (new Date(described.validTo).getTime() <= Date.now()) continue;
    const coversDomain = described.checkHost(domain);
    const coversAll = coversDomain && altNames.every((alt) => described.checkHost(alt));
    if (coversAll) results.push(described);
  }
  return results;
}

/**
 * Copies an existing certificate (found via findCertificatesForDomain,
 * addressed by `sourceName`) to the EXACT secret name Terraform's
 * Application Gateway hard-codes (`${deploymentName}-tls-cert` —
 * see cc-compute-single-azure's ssl_certificate block). Required because
 * `az keyvault certificate import` names the imported object, and there is
 * no "alias"/rename operation in Key Vault — reusing a cert an operator
 * imported under their own name (or one left over from a previous
 * deployment attempt with a different deployment name) means re-importing
 * its exact bytes under the name Terraform expects.
 *
 * Downloads the FULL certificate (private key included) as a base64 PFX
 * via the paired secret of the same name — Key Vault always maintains one
 * (documented behavior: every certificate object has a same-named secret
 * holding the complete PKCS#12/PEM bundle, `az keyvault certificate show`
 * alone only exposes the public portion) — then re-imports those exact
 * bytes under `targetName`. No re-encoding/no re-keying: byte-for-byte the
 * same certificate, just addressable under the name the Application
 * Gateway will read.
 *
 * Uses a private (0700) temp directory + 0600 file for the PFX material in
 * transit, deleted in a `finally` — this file briefly holds a private key
 * on local disk, same handling rigor as ui.mjs's persistGeneratedSecrets
 * (chmod 600) for other locally-cached secrets.
 */
export async function copyCertificateToName({
  vaultName, sourceName, targetName, execImpl = execFileAsync,
} = {}) {
  if (!vaultName) throw new Error('copyCertificateToName requires { vaultName }');
  if (!sourceName) throw new Error('copyCertificateToName requires { sourceName }');
  if (!targetName) throw new Error('copyCertificateToName requires { targetName }');
  if (sourceName === targetName) return { copied: false, reason: 'already-named-correctly' };

  const dir = await mkdtemp(join(tmpdir(), 'cc-kv-cert-'));
  const pfxPath = join(dir, 'cert.pfx');
  try {
    const { stdout: secretRaw } = await execImpl('az', [
      'keyvault', 'secret', 'show',
      '--vault-name', vaultName,
      '--name', sourceName,
      '--query', 'value', '-o', 'tsv',
    ], { maxBuffer: 1024 * 1024 * 16 });
    const b64 = secretRaw.trim();
    if (!b64) throw new Error(`Key Vault secret "${sourceName}" (the certificate's paired secret) came back empty`);
    await writeFile(pfxPath, Buffer.from(b64, 'base64'), { mode: 0o600 });

    await execImpl('az', [
      'keyvault', 'certificate', 'import',
      '--vault-name', vaultName,
      '--name', targetName,
      '--file', pfxPath,
    ], { maxBuffer: 1024 * 1024 * 8 });

    return { copied: true, targetName };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

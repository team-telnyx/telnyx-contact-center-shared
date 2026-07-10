import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// ACM request/validate/poll helper for the multi-node (HA) TLS path (plan
// §4c). Single-node never touches this module — it reuses the existing
// docker/production/compose.yaml `cloud` profile's Caddy container for
// automatic Let's Encrypt instead (see cc-compute-single). HA needs an ACM
// cert because the ALB terminates TLS and N nodes independently racing for
// the same domain's HTTP-01 challenge behind a load balancer is unreliable.

/**
 * Looks for a Route53 hosted zone matching `domain` (or one of its parent
 * zones) in the user's own AWS account. Returns { zoneId, zoneName } or null
 * if none found — a null result routes the caller into the semi-automated
 * "print the CNAME, ask the user to add it at their DNS provider" path
 * instead of the fully-automated one.
 */
export async function findHostedZoneForDomain({ domain, execImpl = execFileAsync } = {}) {
  if (!domain) throw new Error('findHostedZoneForDomain requires { domain }');
  const { stdout } = await execImpl('aws', ['route53', 'list-hosted-zones', '--output', 'json'], { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout);
  const zones = parsed?.HostedZones || [];
  // Longest-matching-suffix wins (e.g. "cc.example.com" should prefer a zone
  // for "example.com" over accidentally matching an unrelated zone whose
  // name happens to be a substring). Compare on normalized (trailing-dot-free,
  // lowercase) names.
  const normalizedDomain = String(domain).toLowerCase().replace(/\.$/, '');
  let best = null;
  for (const zone of zones) {
    const zoneName = String(zone.Name || '').toLowerCase().replace(/\.$/, '');
    if (normalizedDomain === zoneName || normalizedDomain.endsWith(`.${zoneName}`)) {
      if (!best || zoneName.length > best.zoneName.length) {
        best = { zoneId: zone.Id.replace('/hostedzone/', ''), zoneName: zone.Name };
      }
    }
  }
  return best;
}

/**
 * Requests a new ACM certificate for `domain` (+ optional SANs, e.g. the
 * streaming-ws subdomain) via DNS validation. Returns the certificate ARN
 * immediately — the cert starts in PENDING_VALIDATION status until the
 * validation CNAME is created and propagates, which is why this is split
 * from waitForCertificateIssued below (the wizard needs to show the CNAME
 * to the user / create it itself in between).
 */
export async function requestCertificate({ domain, alternativeNames = [], region, execImpl = execFileAsync } = {}) {
  if (!domain) throw new Error('requestCertificate requires { domain }');
  const args = [
    'acm', 'request-certificate',
    '--domain-name', domain,
    '--validation-method', 'DNS',
    '--output', 'json',
  ];
  if (region) args.push('--region', region);
  if (alternativeNames.length > 0) {
    args.push('--subject-alternative-names', ...alternativeNames);
  }
  const { stdout } = await execImpl('aws', args);
  const parsed = JSON.parse(stdout);
  if (!parsed.CertificateArn) throw new Error('acm request-certificate did not return a CertificateArn');
  return parsed.CertificateArn;
}

/**
 * Fetches the current certificate description, including per-domain DNS
 * validation records (name/type/value) once ACM has generated them — this
 * can take a few seconds after requestCertificate returns, so callers should
 * poll this (see waitForValidationRecords) rather than assuming the records
 * are present on the very first describe-certificate call.
 */
export async function describeCertificate({ certificateArn, region, execImpl = execFileAsync } = {}) {
  if (!certificateArn) throw new Error('describeCertificate requires { certificateArn }');
  const args = ['acm', 'describe-certificate', '--certificate-arn', certificateArn, '--output', 'json'];
  if (region) args.push('--region', region);
  const { stdout } = await execImpl('aws', args);
  const parsed = JSON.parse(stdout);
  return parsed.Certificate;
}

/**
 * Extracts { name, type, value } validation records per domain from a
 * describe-certificate response, once ACM has populated them. Returns []
 * if not populated yet.
 */
export function extractValidationRecords(certificate) {
  const options = certificate?.DomainValidationOptions || [];
  return options
    .filter((o) => o.ResourceRecord)
    .map((o) => ({
      domainName: o.DomainName,
      name: o.ResourceRecord.Name,
      type: o.ResourceRecord.Type,
      value: o.ResourceRecord.Value,
    }));
}

export async function waitForValidationRecords({
  certificateArn, region, execImpl = execFileAsync,
  timeoutMs = 60_000, intervalMs = 3000,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const start = now();
  while (now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    const cert = await describeCertificate({ certificateArn, region, execImpl });
    const records = extractValidationRecords(cert);
    if (records.length > 0) return records;
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    await sleep(intervalMs);
  }
  return [];
}

/**
 * Creates the DNS validation CNAME record(s) in a Route53 zone the caller
 * already found via findHostedZoneForDomain — the fully-automated path from
 * plan §4c path 1. UPSERT so this is safe to call more than once (e.g. on
 * wizard resume after a crash mid-validation).
 */
export async function createValidationRecords({ zoneId, records, execImpl = execFileAsync } = {}) {
  if (!zoneId) throw new Error('createValidationRecords requires { zoneId }');
  if (!records || records.length === 0) throw new Error('createValidationRecords requires a non-empty { records } array');
  const changeBatch = {
    Changes: records.map((r) => ({
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: r.name,
        Type: r.type,
        TTL: 300,
        ResourceRecords: [{ Value: r.value }],
      },
    })),
  };
  const { stdout } = await execImpl('aws', [
    'route53', 'change-resource-record-sets',
    '--hosted-zone-id', zoneId,
    '--change-batch', JSON.stringify(changeBatch),
    '--output', 'json',
  ]);
  return JSON.parse(stdout);
}

/**
 * Polls describe-certificate until Status is ISSUED, or times out. Used
 * after either the automated (createValidationRecords) or semi-automated
 * (user adds the CNAME at their own DNS provider) validation path — both
 * converge on this same wait. Long default timeout (30 min) because DNS
 * propagation + ACM's own validation polling interval can genuinely take
 * that long, especially for the semi-automated path where the user has to
 * go create the record themselves first.
 */
export async function waitForCertificateIssued({
  certificateArn, region, execImpl = execFileAsync,
  timeoutMs = 30 * 60_000, intervalMs = 15_000,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt,
} = {}) {
  if (!certificateArn) throw new Error('waitForCertificateIssued requires { certificateArn }');
  const start = now();
  let attempts = 0;
  let lastStatus = null;
  while (now() - start < timeoutMs) {
    attempts += 1;
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    const cert = await describeCertificate({ certificateArn, region, execImpl });
    lastStatus = cert?.Status || null;
    const elapsedMs = now() - start;
    if (onAttempt) onAttempt({ attempt: attempts, status: lastStatus, elapsedMs });
    if (lastStatus === 'ISSUED') return { issued: true, attempts, elapsedMs, status: lastStatus };
    if (lastStatus === 'FAILED' || lastStatus === 'VALIDATION_TIMED_OUT') {
      return { issued: false, attempts, elapsedMs, status: lastStatus, terminal: true };
    }
    // eslint-disable-next-line no-await-in-loop -- intentional poll loop.
    await sleep(intervalMs);
  }
  return { issued: false, attempts, elapsedMs: now() - start, status: lastStatus, terminal: false };
}

/**
 * Lists ACM certificates in the account/region that could plausibly cover
 * `domain` — either an exact match or a wildcard one level up (e.g.
 * "*.example.com" covers "cc.example.com"). Used by the wizard's DNS step
 * (runAwsDnsStep) to offer "use an existing certificate" instead of always
 * requesting a fresh one, for users who already provision ACM certs via
 * their own process. Only ISSUED certificates are returned — a PENDING or
 * EXPIRED one isn't usable by an ALB listener.
 */
export async function listCertificatesForDomain({ domain, region, execImpl = execFileAsync } = {}) {
  if (!domain) throw new Error('listCertificatesForDomain requires { domain }');
  const args = ['acm', 'list-certificates', '--certificate-statuses', 'ISSUED', '--output', 'json'];
  if (region) args.push('--region', region);
  const { stdout } = await execImpl('aws', args, { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout);
  const summaries = parsed?.CertificateSummaryList || [];
  const normalizedDomain = String(domain).toLowerCase().replace(/\.$/, '');
  const parentWildcard = `*.${normalizedDomain.split('.').slice(1).join('.')}`;
  const matches = summaries.filter((c) => {
    const certDomain = String(c.DomainName || '').toLowerCase();
    if (certDomain === normalizedDomain) return true;
    if (certDomain === parentWildcard) return true;
    const sans = (c.SubjectAlternativeNameSummaries || []).map((s) => String(s).toLowerCase());
    return sans.includes(normalizedDomain) || sans.includes(parentWildcard);
  });
  return matches.map((c) => ({ certificateArn: c.CertificateArn, domainName: c.DomainName }));
}

/**
 * Searches for a certificate covering `domain` across MULTIPLE regions (not
 * just the deployment's own) and returns the first match plus which region
 * it lives in. Used only for a diagnostic message — an ACM certificate ARN
 * can only be attached to an ALB listener in the SAME region as the
 * certificate (a hard AWS limitation, not a bug in this codebase), so a
 * match found here is never directly usable; it just lets the wizard tell
 * the operator *why* it's requesting a new certificate instead of silently
 * doing so when there's a perfectly good wildcard cert one region over.
 *
 * Added after a real 2026-07-06 case: the account had `*.demotelnyx.com`
 * issued in us-east-2, but the deployment's region was us-west-2 —
 * listCertificatesForDomain (region-scoped) correctly found nothing, and
 * the wizard silently requested + issued a brand new per-host certificate
 * with no explanation, leaving the operator confused about why their
 * existing wildcard wasn't offered.
 */
export async function findCertificateInOtherRegions({
  domain, excludeRegion, regions, execImpl = execFileAsync,
} = {}) {
  if (!domain) throw new Error('findCertificateInOtherRegions requires { domain }');
  const candidateRegions = (regions || []).filter((r) => r && r !== excludeRegion);
  for (const region of candidateRegions) {
    // eslint-disable-next-line no-await-in-loop -- sequential probe across a short, fixed region list; simplicity over parallelism here.
    const matches = await listCertificatesForDomain({ domain, region, execImpl }).catch(() => []);
    if (matches.length > 0) {
      return { region, certificates: matches };
    }
  }
  return null;
}

/**
 * Deletes an ACM certificate by ARN. Best-effort/idempotent-on-not-found,
 * mirroring the Telnyx deletion helpers in telnyx-bootstrap.mjs: a
 * ResourceNotFoundException (already gone) is success, not an error.
 *
 * Callers MUST only invoke this for certificates the wizard itself created
 * (state.infra.acm.createdByWizard === true) — see cc.mjs's cmdDestroyAws.
 * A certificate the operator picked from an existing list (e.g. a shared
 * wildcard covering other deployments too) must never be deleted here, since
 * ACM has no concept of "in use by this deployment only" and deleting a
 * certificate still referenced by another ALB listener elsewhere would break
 * that other deployment's HTTPS.
 */
export async function deleteCertificate({ certificateArn, region, execImpl = execFileAsync } = {}) {
  if (!certificateArn) return { outcome: 'skipped', reason: 'no certificateArn' };
  const args = ['acm', 'delete-certificate', '--certificate-arn', certificateArn];
  if (region) args.push('--region', region);
  try {
    await execImpl('aws', args);
    return { outcome: 'deleted' };
  } catch (err) {
    const message = String(err?.stderr || err?.message || '');
    if (/ResourceNotFoundException/.test(message)) return { outcome: 'not-found' };
    if (/ResourceInUseException/.test(message)) {
      // Still attached to a listener somewhere (e.g. terraform destroy ran
      // but the ALB listener deletion hasn't propagated yet, or the cert is
      // unexpectedly shared). Surface this distinctly so the caller can tell
      // the operator exactly why deletion didn't happen instead of a raw
      // AWS CLI stack trace.
      return { outcome: 'in-use', error: message.trim() };
    }
    throw new Error(`acm delete-certificate failed: ${message.trim() || err.message}`);
  }
}

/**
 * High-level orchestrator combining the pieces above into the exact two
 * paths described in plan §4c. Returns a state machine snapshot the wizard
 * can persist to .cc-state.json (certificateArn + pending validation
 * records) so a Ctrl-C mid-validation is resumable — the wizard should call
 * this once per `cc up` invocation with any previously-stored certificateArn
 * passed back in, rather than requesting a fresh certificate every retry.
 */
export async function ensureCertificate({
  domain,
  alternativeNames = [],
  region,
  existingCertificateArn = null,
  execImpl = execFileAsync,
  waitForIssued = true,
  onValidationRecordsReady, // callback({ records, automated }) — wizard prints CNAME instructions when automated=false
} = {}) {
  const certificateArn = existingCertificateArn || await requestCertificate({ domain, alternativeNames, region, execImpl });

  const existing = existingCertificateArn ? await describeCertificate({ certificateArn, region, execImpl }) : null;
  if (existing?.Status === 'ISSUED') {
    return { certificateArn, issued: true, automated: null };
  }

  const zone = await findHostedZoneForDomain({ domain, execImpl });
  const records = await waitForValidationRecords({ certificateArn, region, execImpl });

  let automated = false;
  if (zone && records.length > 0) {
    await createValidationRecords({ zoneId: zone.zoneId, records, execImpl });
    automated = true;
  }
  if (onValidationRecordsReady) onValidationRecordsReady({ records, automated, zone });

  if (!waitForIssued) {
    return { certificateArn, issued: false, automated, records, zone };
  }
  const result = await waitForCertificateIssued({ certificateArn, region, execImpl });
  return { certificateArn, issued: result.issued, automated, records, zone, status: result.status };
}

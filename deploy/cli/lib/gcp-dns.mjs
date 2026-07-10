import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// Cloud DNS orchestration for the GCP cloud target's "dns" wizard step (see
// wizard.mjs's runGcpDnsStep) — the GCP counterpart to route53.mjs. Same
// flow the AWS path already offers, ported to `gcloud dns`:
//   1. List the account's Cloud DNS public managed zones and find one whose
//      dnsName is a suffix of the operator's domain.
//   2. Check whether an A record already exists for that exact hostname —
//      if so, ask whether to overwrite it (mirrors route53.mjs's
//      findRecordForHost + the wizard's own confirm prompt).
//   3. If no zone matches, or the operator declines, the domain is NOT
//      Terraform-managed — the operator points it at the Load Balancer's IP
//      by hand (same fallback as AWS's no-Route53-zone / declined path).
//
// Only reached when the operator has already opted into the HTTPS Load
// Balancer (runGcpLbStep) — same design as AWS's DNS automation, which is
// only wired to the ALB path (a plain-HTTP deployment has no stable load
// balancer IP/DNS target worth automating against; the instance's own
// public IP is more likely to change across `cc destroy`+`cc up` cycles).
//
// All gcloud calls go through the injectable `execImpl`, same pattern as
// gcp-cloud.mjs, so this is fully unit-testable without a live account.

/**
 * Lists every Cloud DNS PUBLIC managed zone in the project, normalized to
 * { name, dnsName } (dnsName without the trailing dot) — `name` is the
 * managed zone's resource name (what Terraform's dns_managed_zone_name
 * variable / `gcloud dns record-sets` commands expect), `dnsName` is the
 * zone's actual domain suffix (e.g. "example.com"). Private (VPC-scoped)
 * zones are filtered out since the goal is a publicly resolvable record for
 * the deployment's app URL — mirrors route53.mjs's listHostedZones filtering
 * out PrivateZone entries.
 */
export async function listManagedZones({ project, execImpl = execFileAsync } = {}) {
  const args = ['dns', 'managed-zones', 'list', '--format=json'];
  if (project) args.push('--project', project);
  const { stdout } = await execImpl('gcloud', args, { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout || '[]');
  return parsed
    .filter((z) => (z.visibility || 'public') === 'public')
    .map((z) => ({ name: z.name, dnsName: String(z.dnsName || '').replace(/\.$/, '') }));
}

/**
 * Looks up an existing record set for `fqdn` (any type) in the given
 * managed zone. Returns null when no record exists for that exact name.
 * Mirrors route53.mjs's findRecordForHost.
 */
export async function findRecordForHost({
  zoneName, fqdn, project, execImpl = execFileAsync,
} = {}) {
  if (!zoneName) throw new Error('findRecordForHost requires { zoneName }');
  if (!fqdn) throw new Error('findRecordForHost requires { fqdn }');
  const normalized = `${String(fqdn).toLowerCase().replace(/\.$/, '')}.`;
  const args = [
    'dns', 'record-sets', 'list',
    '--zone', zoneName,
    '--name', normalized,
    '--format=json',
  ];
  if (project) args.push('--project', project);
  const { stdout } = await execImpl('gcloud', args, { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout || '[]');
  const match = parsed.find((r) => String(r.name || '').toLowerCase() === normalized);
  if (!match) return null;
  return {
    name: String(match.name).replace(/\.$/, ''),
    type: match.type,
    ttl: match.ttl,
    values: match.rrdatas || [],
  };
}

/**
 * Longest-suffix-match helper: given a set of managed zones (each with a
 * `dnsName` field) and a candidate hostname (e.g. "cc-main.example.com"),
 * returns the zone whose dnsName is a suffix of the hostname, preferring the
 * most specific (longest) match. Returns null if no zone matches. Same
 * algorithm as route53.mjs's findZoneForHostname, duplicated here (rather
 * than imported) so this module has no AWS-side dependency at all.
 */
export function findZoneForHostname(zones, hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  let best = null;
  for (const zone of zones) {
    const zoneName = String(zone.dnsName || '').toLowerCase().replace(/\.$/, '');
    if (!zoneName) continue;
    if (normalized === zoneName || normalized.endsWith(`.${zoneName}`)) {
      if (!best || zoneName.length > best.dnsName.length) best = zone;
    }
  }
  return best;
}

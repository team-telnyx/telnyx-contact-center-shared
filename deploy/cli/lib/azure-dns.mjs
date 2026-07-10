import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// Azure DNS orchestration for the Azure cloud target's "dns" wizard step
// (see wizard.mjs's runAzureDnsStep) — the Azure counterpart to
// route53.mjs (AWS) and gcp-dns.mjs (GCP). Same flow:
//   1. List the subscription's Azure DNS zones and find one whose zone
//      name is a suffix of the operator's domain.
//   2. Check whether an A record already exists for that exact hostname —
//      if so, ask whether to overwrite it.
//   3. If no zone matches, or the operator declines, the domain is NOT
//      Terraform-managed — the operator points it at the Application
//      Gateway's IP by hand.
//
// Only reached when the operator has already opted into the Application
// Gateway (runAzureLbStep) — same design as AWS/GCP's DNS automation, only
// wired to the load-balancer path (a plain-HTTP deployment has no stable
// Terraform-managed IP worth automating DNS against).
//
// Structural difference from AWS/GCP: Azure DNS zones are addressed by
// NAME + RESOURCE GROUP, not a single globally-unique id/name the way
// Route53 zone ids or Cloud DNS managed zone names are — every function
// here that identifies a zone returns/accepts both fields.
//
// All az calls go through the injectable `execImpl`, same pattern as
// azure-cloud.mjs, so this is fully unit-testable without a live account.

/**
 * Lists every Azure DNS zone in the subscription, normalized to
 * { name, resourceGroup } — `name` is the zone's domain suffix itself
 * (Azure DNS zone names ARE the domain, e.g. "example.com", unlike
 * Route53/Cloud DNS which have a separate resource name distinct from the
 * domain), `resourceGroup` is required for every subsequent `az network
 * dns record-set` call against this zone.
 */
export async function listDnsZones({ subscriptionId, execImpl = execFileAsync } = {}) {
  const args = ['network', 'dns', 'zone', 'list', '--output', 'json'];
  if (subscriptionId) args.push('--subscription', subscriptionId);
  const { stdout } = await execImpl('az', args, { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout || '[]');
  return parsed.map((z) => ({
    name: String(z.name || '').replace(/\.$/, ''),
    resourceGroup: (z.resourceGroup || z.id?.match(/resourceGroups\/([^/]+)/)?.[1] || ''),
  }));
}

/**
 * Looks up an existing A record for `fqdn` inside the given zone. Returns
 * null when no record exists. Mirrors route53.mjs's findRecordForHost /
 * gcp-dns.mjs's findRecordForHost.
 */
export async function findRecordForHost({
  zoneName, resourceGroup, fqdn, subscriptionId, execImpl = execFileAsync,
} = {}) {
  if (!zoneName) throw new Error('findRecordForHost requires { zoneName }');
  if (!resourceGroup) throw new Error('findRecordForHost requires { resourceGroup }');
  if (!fqdn) throw new Error('findRecordForHost requires { fqdn }');
  const normalized = String(fqdn).toLowerCase().replace(/\.$/, '');
  const zoneSuffix = String(zoneName).toLowerCase().replace(/\.$/, '');
  // Azure DNS record-sets are addressed by their relative name within the
  // zone ("@" for the apex, otherwise the subdomain label) — not the full
  // fqdn the way Route53/Cloud DNS record lookups accept directly.
  const relativeName = normalized === zoneSuffix
    ? '@'
    : normalized.slice(0, -(zoneSuffix.length + 1));
  const args = [
    'network', 'dns', 'record-set', 'a', 'show',
    '--zone-name', zoneName,
    '--resource-group', resourceGroup,
    '--name', relativeName,
    '--output', 'json',
  ];
  if (subscriptionId) args.push('--subscription', subscriptionId);
  try {
    const { stdout } = await execImpl('az', args, { maxBuffer: 1024 * 1024 * 8 });
    const match = JSON.parse(stdout || 'null');
    if (!match) return null;
    return {
      name: normalized,
      type: 'A',
      ttl: match.ttl,
      values: (match.aRecords || []).map((r) => r.ipv4Address),
    };
  } catch {
    // `az network dns record-set a show` exits non-zero (ResourceNotFound)
    // when no record exists — that's the expected "no record" outcome,
    // not an error worth surfacing.
    return null;
  }
}

/**
 * Longest-suffix-match helper: given a set of zones (each with a `name`
 * field, itself the domain suffix) and a candidate hostname, returns the
 * zone whose name is a suffix of the hostname, preferring the most
 * specific (longest) match. Returns null if no zone matches. Same
 * algorithm as route53.mjs's findZoneForHostname / gcp-dns.mjs's
 * findZoneForHostname, duplicated here so this module has no cross-cloud
 * dependency.
 */
export function findZoneForHostname(zones, hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  let best = null;
  for (const zone of zones) {
    const zoneName = String(zone.name || '').toLowerCase().replace(/\.$/, '');
    if (!zoneName) continue;
    if (normalized === zoneName || normalized.endsWith(`.${zoneName}`)) {
      if (!best || zoneName.length > best.name.length) best = zone;
    }
  }
  return best;
}

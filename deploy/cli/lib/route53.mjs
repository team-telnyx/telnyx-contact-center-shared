import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// Route53 DNS orchestration for the AWS cloud target's "dns" wizard step
// (see wizard.mjs's runAwsDnsStep). Implements the flow the user asked for
// explicitly:
//   1. "Create a DNS record in Route53?" — if yes, list the account's
//      registered (hosted-zone) domains and let the user pick one.
//   2. Ask for a hostname to prepend to that zone (e.g. "cc-main" ->
//      cc-main.example.com).
//   3. Check whether a record already exists for that exact hostname — if
//      so, ask whether to overwrite it or pick a different hostname instead
//      of silently clobbering an existing record.
//   4. If the user declines Route53 management entirely, they type their own
//      full public domain and are told (here + in the final summary) that
//      they must point it at the deployment themselves.
//
// All AWS calls go through the injectable `execImpl` (aws CLI), same pattern
// as acm.mjs/aws-cloud.mjs, so this is fully unit-testable without a live
// account.

/**
 * Lists every Route53 hosted zone in the account, normalized to
 * { id, name } (name without the trailing dot). Public zones only — Route53
 * private (VPC-associated) zones aren't useful here since the goal is a
 * publicly resolvable record for the deployment's app URL.
 */
export async function listHostedZones({ execImpl = execFileAsync } = {}) {
  const { stdout } = await execImpl('aws', ['route53', 'list-hosted-zones', '--output', 'json'], { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout);
  const zones = parsed?.HostedZones || [];
  return zones
    .filter((z) => !z.Config?.PrivateZone)
    .map((z) => ({ id: z.Id.replace('/hostedzone/', ''), name: String(z.Name || '').replace(/\.$/, '') }));
}

/**
 * Looks up an existing record set for `fqdn` (A or CNAME) in the given zone.
 * Route53's list-resource-record-sets doesn't support an exact-name filter
 * server-side in a portable way across CLI versions, so this fetches with
 * --start-record-name as an optimization (skips most of a large zone) and
 * then does an exact-match scan of the (small) page returned. Returns null
 * when no record exists for that exact name.
 */
export async function findRecordForHost({ zoneId, fqdn, execImpl = execFileAsync } = {}) {
  if (!zoneId) throw new Error('findRecordForHost requires { zoneId }');
  if (!fqdn) throw new Error('findRecordForHost requires { fqdn }');
  const normalized = `${String(fqdn).toLowerCase().replace(/\.$/, '')}.`;
  const { stdout } = await execImpl('aws', [
    'route53', 'list-resource-record-sets',
    '--hosted-zone-id', zoneId,
    '--start-record-name', normalized,
    '--max-items', '10',
    '--output', 'json',
  ], { maxBuffer: 1024 * 1024 * 8 });
  const parsed = JSON.parse(stdout);
  const sets = parsed?.ResourceRecordSets || [];
  const match = sets.find((r) => String(r.Name || '').toLowerCase() === normalized && (r.Type === 'A' || r.Type === 'CNAME' || r.Type === 'AAAA'));
  if (!match) return null;
  return {
    name: match.Name.replace(/\.$/, ''),
    type: match.Type,
    ttl: match.TTL,
    values: (match.ResourceRecords || []).map((r) => r.Value),
    alias: match.AliasTarget ? { dnsName: match.AliasTarget.DNSName, hostedZoneId: match.AliasTarget.HostedZoneId } : null,
  };
}

/**
 * Longest-suffix-match helper: given a set of hosted zones and a candidate
 * hostname (e.g. "cc-main.example.com"), returns the zone whose name is a
 * suffix of the hostname, preferring the most specific (longest) match.
 * Returns null if no zone matches.
 */
export function findZoneForHostname(zones, hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  let best = null;
  for (const zone of zones) {
    const zoneName = String(zone.name || '').toLowerCase().replace(/\.$/, '');
    if (normalized === zoneName || normalized.endsWith(`.${zoneName}`)) {
      if (!best || zoneName.length > best.name.length) best = zone;
    }
  }
  return best;
}

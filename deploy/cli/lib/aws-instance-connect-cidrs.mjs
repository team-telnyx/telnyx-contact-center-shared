// Resolves the CIDR(s) that should be allowed to reach port 22 on AWS app
// nodes, WITHOUT ever asking the user. AWS publishes the IP ranges its
// browser-based EC2 "Connect" button (EC2 Instance Connect) originates
// from — one narrow range (typically a /29) per region — at a well-known,
// stable URL:
//
//   https://ip-ranges.amazonaws.com/ip-ranges.json  (service === 'EC2_INSTANCE_CONNECT')
//
// Opening port 22 to just that range lets an admin click "Connect" in the
// EC2 console and get a browser SSH session (AWS pushes a short-lived key
// via the EC2 Instance Connect API at click-time — no distributed key pair,
// no public 0.0.0.0/0 exposure). This mirrors how cc-prod/cc-ha are already
// configured by hand; this module makes `cc up` do it automatically.
//
// The list rarely changes (new region launches, occasional IP churn), so we
// always try the live document first and only fall back to a built-in
// snapshot if the fetch fails (offline dev machine, endpoint down, etc).
// Falling back to `[]` would silently reopen the "no SSH access at all"
// default, which is safe but defeats the point of this module — so the
// snapshot exists specifically to avoid that failure mode for the regions
// this project's users actually deploy to.

const IP_RANGES_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json';

// Snapshot of `service === 'EC2_INSTANCE_CONNECT'` prefixes from the live
// document, captured 2026-07-06 (see aws-instance-connect-cidrs.test.mjs for
// how to re-verify these; AWS's createDate for this snapshot was
// 2026-07-05-21-57-05). Only the standard AWS partition is listed (no
// cn-north-1/cn-northwest-1 or us-gov-*, which use separate console/API
// endpoints this project doesn't target).
export const EC2_INSTANCE_CONNECT_CIDRS_FALLBACK = {
  'af-south-1': ['13.244.121.196/30'],
  'ap-east-1': ['43.198.192.104/29'],
  'ap-northeast-1': ['3.112.23.0/29'],
  'ap-northeast-2': ['13.209.1.56/29'],
  'ap-northeast-3': ['15.168.105.160/29'],
  'ap-south-1': ['13.233.177.0/29'],
  'ap-south-2': ['18.60.252.248/29'],
  'ap-southeast-1': ['3.0.5.32/29'],
  'ap-southeast-2': ['13.239.158.0/29'],
  'ap-southeast-3': ['43.218.193.64/29'],
  'ap-southeast-4': ['16.50.248.80/29'],
  'ap-southeast-5': ['43.216.87.48/29'],
  'ap-southeast-6': ['3.103.24.208/29'],
  'ap-southeast-7': ['43.209.155.96/29'],
  'ca-central-1': ['35.183.92.176/29'],
  'ca-west-1': ['40.176.213.168/29'],
  'eu-central-1': ['3.120.181.40/29'],
  'eu-central-2': ['16.63.77.8/29'],
  'eu-north-1': ['13.48.4.200/30'],
  'eu-south-1': ['15.161.135.164/30'],
  'eu-south-2': ['18.101.90.48/29'],
  'eu-west-1': ['18.202.216.48/29'],
  'eu-west-2': ['3.8.37.24/29'],
  'eu-west-3': ['35.180.112.80/29'],
  'il-central-1': ['51.16.183.224/29'],
  'me-central-1': ['3.29.147.40/29'],
  'me-south-1': ['16.24.46.56/29'],
  'mx-central-1': ['78.12.207.8/29'],
  'sa-east-1': ['18.228.70.32/29'],
  'us-east-1': ['18.206.107.24/29'],
  'us-east-2': ['3.16.146.0/29'],
  'us-west-1': ['13.52.6.112/29'],
  'us-west-2': ['18.237.140.160/29'],
};

/**
 * Returns the list of CIDRs to feed into Terraform's `admin_ssh_cidrs` for
 * the given AWS region — always the live EC2 Instance Connect range when
 * reachable, the built-in snapshot as a fallback, and `[]` (no SSH ingress
 * at all — SSM remains available) only for a region this module has never
 * heard of and couldn't fetch live data for.
 */
export async function resolveAdminSshCidrs({ region, fetchImpl = fetch, io } = {}) {
  if (!region) return [];

  try {
    const res = await fetchImpl(IP_RANGES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cidrs = (data.prefixes || [])
      .filter((p) => p.service === 'EC2_INSTANCE_CONNECT' && p.region === region)
      .map((p) => p.ip_prefix);
    if (cidrs.length > 0) return cidrs;
    io?.log?.(`  ⚠ AWS ip-ranges.json has no EC2 Instance Connect entry for ${region} — falling back to built-in snapshot.`);
  } catch (err) {
    io?.log?.(`  ⚠ Could not fetch live AWS IP ranges (${err.message}) — using built-in snapshot for SSH access CIDR.`);
  }
  return EC2_INSTANCE_CONNECT_CIDRS_FALLBACK[region] || [];
}

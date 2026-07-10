import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// AWS EIP (Elastic IP) quota precheck — added after a real 2026-07-06
// incident: a `cc up` AWS deploy got 35+ minutes into `terraform apply`
// (VPC, RDS, ALB all created) before failing on `aws_eip.app` with
// `AddressLimitExceeded: The maximum number of addresses has been reached`,
// leaving a half-provisioned deployment that needed manual `terraform
// destroy` + Telnyx cleanup to unwind.
//
// This check runs the SAME class of "will apply fail partway through" probe
// as aws-iam-check.mjs's IAM precheck, but for the EC2 EIP quota specifically
// — the single-node module always allocates exactly one EIP
// (cc-compute-single/main.tf's `aws_eip.app`), and the multi-node/HA module
// allocates one EIP per node (aws_lb fronts HA, but each node still gets its
// own EIP per cc-compute-ha/main.tf) PLUS one more if cc-network's optional
// NAT gateway is enabled (off by default, see enable_nat).
//
// Deliberately uses the legacy `ec2:DescribeAccountAttributes
// vpc-max-elastic-ips` attribute rather than the Service Quotas API
// (`servicequotas:GetServiceQuota`, code L-0263D0A3): the legacy attribute
// requires no extra IAM permission beyond what every EC2-using operator
// already has (it's a DescribeAccountAttributes call, already implied by the
// ec2-networking action group), whereas GetServiceQuota needs a SEPARATE
// servicequotas:GetServiceQuota grant most operator policies don't include
// (confirmed via AccessDeniedException against our own fde-app-bot policy
// during the 2026-07-06 incident investigation) — asking users to grant yet
// another permission just for this precheck isn't worth it when the legacy
// attribute already gives an accurate, always-on ceiling.
export async function getEipQuota({ region, execImpl = execFileAsync } = {}) {
  const { stdout } = await execImpl('aws', [
    'ec2', 'describe-account-attributes',
    '--attribute-names', 'vpc-max-elastic-ips',
    '--region', region,
    '--output', 'json',
  ]);
  const parsed = JSON.parse(stdout);
  const attr = parsed?.AccountAttributes?.[0];
  const raw = attr?.AttributeValues?.[0]?.AttributeValue;
  const quota = Number(raw);
  if (!Number.isFinite(quota)) throw new Error('could not parse vpc-max-elastic-ips from AWS response');
  return quota;
}

export async function getEipUsage({ region, execImpl = execFileAsync } = {}) {
  const { stdout } = await execImpl('aws', [
    'ec2', 'describe-addresses',
    '--region', region,
    '--output', 'json',
  ]);
  const parsed = JSON.parse(stdout);
  const addresses = Array.isArray(parsed?.Addresses) ? parsed.Addresses : [];
  return addresses.length;
}

/**
 * How many NEW EIPs this deployment's `terraform apply` will try to
 * allocate. Single-node: always 1 (cc-compute-single's `aws_eip.app`).
 * HA/multi-node: 1 per node (cc-compute-ha allocates one EIP per instance,
 * same pattern) plus 1 more if the network module's optional NAT gateway is
 * turned on (off by default — see cc-network's enable_nat variable, which
 * the wizard never currently sets to true, but this stays defensive in case
 * that changes).
 */
export function eipsNeededFor({ topology = 'single', nodeCount = 1, natEnabled = false } = {}) {
  const perNode = topology === 'ha' ? Math.max(1, nodeCount) : 1;
  return perNode + (natEnabled ? 1 : 0);
}

/**
 * Preflight check: does this AWS account/region have enough EIP headroom
 * left for the deployment about to run? Returns the same
 * { key, status, label, detail, hint } shape as the other preflight checks
 * so it slots directly into checkAwsCloudPreflight's results array.
 *
 * Deliberately a 'fail' (not just 'warn') when headroom is insufficient —
 * unlike the IAM precheck (which can be legitimately unsure and warns), EIP
 * quota is a hard, unambiguous ceiling: if requested > (quota - inUse), the
 * apply WILL fail on AllocateAddress, full stop. Failing fast here before ANY
 * resource is created is strictly better than discovering it 5-8 minutes into
 * an apply with a VPC/RDS/ALB already provisioned (the actual 2026-07-06
 * incident this check exists to prevent).
 */
export async function checkAwsEipQuota({
  region, topology = 'single', nodeCount = 1, natEnabled = false, execImpl = execFileAsync,
} = {}) {
  if (!region) {
    return {
      key: 'aws-eip-quota', status: 'warn', label: 'AWS EIP quota',
      detail: 'no region known yet — will be checked once a region is chosen',
    };
  }
  const needed = eipsNeededFor({ topology, nodeCount, natEnabled });
  let quota;
  let inUse;
  try {
    [quota, inUse] = await Promise.all([
      getEipQuota({ region, execImpl }),
      getEipUsage({ region, execImpl }),
    ]);
  } catch (err) {
    return {
      key: 'aws-eip-quota', status: 'warn', label: 'AWS EIP quota',
      detail: `could not check (${err.message}) — will fail at apply time if insufficient`,
      hint: 'Requires ec2:DescribeAccountAttributes and ec2:DescribeAddresses (read-only, already part of the required EC2 policy).',
    };
  }
  const headroom = quota - inUse;
  if (headroom < needed) {
    return {
      key: 'aws-eip-quota', status: 'fail', label: 'AWS EIP quota',
      detail: `${inUse}/${quota} Elastic IPs already allocated in ${region} — this deployment needs ${needed} more, only ${headroom} free`,
      hint: `Either release unused EIPs (\`aws ec2 describe-addresses --region ${region}\` to find them, \`aws ec2 release-address --allocation-id <id>\` to free one) or request a quota increase: AWS Console → Service Quotas → Amazon EC2 → "Number of EIPs - VPC EIPs" (usually auto-approved within minutes).`,
    };
  }
  return {
    key: 'aws-eip-quota', status: 'ok', label: 'AWS EIP quota',
    detail: `${inUse}/${quota} in use in ${region}, ${headroom} free (need ${needed})`,
  };
}

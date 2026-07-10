import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// AWS IAM permission precheck (plan §4g). `aws sts get-caller-identity`
// succeeding only proves the credentials are VALID, not that they are
// SUFFICIENT — a narrowly-scoped IAM user/role can pass that check and then
// have `terraform apply` die partway through a 30-resource plan, leaving a
// half-created deployment. This module probes the exact action list our
// Terraform modules need via `iam:SimulatePrincipalPolicy` (read-only, no
// side effects) BEFORE any `terraform apply` runs.
//
// Action groups mirror cc-network/cc-database/cc-storage/cc-secrets/
// cc-compute-single/cc-compute-ha 1:1 (see plan §4b/§4g). Grouped (not
// flat) so the preflight UI can render one summary row per resource area
// instead of a 40-line action dump.
//
// IMPORTANT — resource scoping (real bug found in 2026-07-06 E2E testing):
// `simulate-principal-policy` defaults every action to `EvalResourceName:
// "*"` unless `--resource-arns` is passed explicitly. Real-world operator
// policies (including our own internal fde-app-bot-* policies, generated
// from THIS module's generateRequiredPolicyJson) scope S3/Secrets
// Manager/IAM to deployment-name-prefixed resource patterns like
// `arn:aws:s3:::cc-*` rather than granting blanket `Resource: "*"` — so a
// simulate call with no resource-arns comes back `implicitDeny` for every
// one of those actions even when the real policy would allow them at
// apply-time against the actual (deployment-name-scoped) resource. That
// produced a false "28 actions denied" precheck failure against a fully
// correctly-provisioned operator policy. EC2/RDS/SSM/ALB/ACM/Route53
// groups don't have this problem (our policy grants those with
// `Resource: "*"` since they don't have a stable pre-apply resource name
// to scope to), so only s3/secrets-manager/iam define `resourceArns`
// below — every other group is simulated against `*` same as before.

export const ACTION_GROUPS = {
  'ec2-networking': {
    label: 'EC2 + networking',
    requiredFor: 'all',
    actions: [
      'ec2:RunInstances', 'ec2:TerminateInstances', 'ec2:CreateVpc', 'ec2:DeleteVpc',
      'ec2:CreateSubnet', 'ec2:DeleteSubnet', 'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup',
      'ec2:AuthorizeSecurityGroupIngress', 'ec2:AuthorizeSecurityGroupEgress',
      'ec2:CreateTags', 'ec2:DescribeInstances', 'ec2:DescribeVpcs', 'ec2:DescribeSubnets',
      'ec2:DescribeSecurityGroups', 'ec2:DescribeImages', 'ec2:AllocateAddress',
      'ec2:AssociateAddress', 'ec2:ReleaseAddress', 'ec2:CreateInternetGateway',
      'ec2:AttachInternetGateway', 'ec2:CreateRouteTable', 'ec2:CreateRoute',
      'ec2:AssociateRouteTable',
    ],
  },
  rds: {
    label: 'RDS',
    requiredFor: 'all',
    actions: [
      'rds:CreateDBInstance', 'rds:DeleteDBInstance', 'rds:ModifyDBInstance',
      'rds:CreateDBSubnetGroup', 'rds:DeleteDBSubnetGroup', 'rds:CreateDBParameterGroup',
      'rds:DeleteDBParameterGroup', 'rds:DescribeDBInstances', 'rds:DescribeDBSubnetGroups',
      'rds:DescribeDBParameterGroups', 'rds:AddTagsToResource',
    ],
  },
  s3: {
    label: 'S3',
    requiredFor: 'all',
    actions: [
      's3:CreateBucket', 's3:PutBucketVersioning', 's3:PutBucketPublicAccessBlock',
      's3:PutEncryptionConfiguration', 's3:PutBucketCORS', 's3:PutLifecycleConfiguration',
      's3:PutObject', 's3:GetObject', 's3:ListBucket', 's3:GetBucketLocation',
    ],
  },
  'secrets-manager': {
    label: 'Secrets Manager',
    requiredFor: 'all',
    actions: [
      'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue',
      'secretsmanager:GetSecretValue', 'secretsmanager:TagResource',
      'secretsmanager:DescribeSecret', 'secretsmanager:DeleteSecret',
    ],
  },
  iam: {
    label: 'IAM',
    requiredFor: 'all',
    actions: [
      'iam:CreateRole', 'iam:DeleteRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy',
      'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:CreateInstanceProfile',
      'iam:DeleteInstanceProfile', 'iam:AddRoleToInstanceProfile',
      'iam:RemoveRoleFromInstanceProfile', 'iam:PassRole', 'iam:TagRole',
    ],
  },
  ssm: {
    label: 'SSM',
    requiredFor: 'all',
    actions: [
      'ssm:SendCommand', 'ssm:GetCommandInvocation', 'ssm:DescribeInstanceInformation',
      'ssm:ListCommandInvocations',
    ],
  },
  'alb-acm-route53': {
    label: 'ALB/ACM/Route53',
    requiredFor: 'ha',
    actions: [
      'elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:DeleteLoadBalancer',
      'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteTargetGroup',
      'elasticloadbalancing:CreateListener', 'elasticloadbalancing:RegisterTargets',
      'elasticloadbalancing:DeregisterTargets', 'elasticloadbalancing:DescribeTargetHealth',
      'acm:RequestCertificate', 'acm:DescribeCertificate', 'acm:DeleteCertificate',
      'route53:ChangeResourceRecordSets', 'route53:ListHostedZones', 'route53:GetHostedZone',
    ],
  },
};

/**
 * Which groups matter for a given topology. 'single' skips the ALB/ACM/
 * Route53 group entirely (single-node has no load balancer/ACM requirement —
 * TLS is Caddy-on-instance, see plan §4c).
 */
export function groupsFor(topology) {
  return Object.entries(ACTION_GROUPS).filter(
    ([, group]) => group.requiredFor === 'all' || group.requiredFor === topology,
  );
}

async function getCallerIdentity({ execImpl = execFileAsync } = {}) {
  const { stdout } = await execImpl('aws', ['sts', 'get-caller-identity', '--output', 'json']);
  const parsed = JSON.parse(stdout);
  return { arn: parsed.Arn, account: parsed.Account };
}

/**
 * Builds the `--resource-arns` list (+ any `--context-entries` needed, e.g.
 * iam:PassedToService for PassRole) a group's simulate call should use, so
 * the precheck evaluates against the SAME deployment-name-scoped resource
 * pattern a real operator policy actually grants — not the default `*`,
 * which produces false denials against any policy scoped to
 * `cc-<deployment>-*`-style resource names (see module header comment).
 * Returns `null` (meaning: simulate against implicit `*`, unscoped) for
 * groups that don't have a stable pre-apply resource name to scope to
 * (EC2/RDS/SSM/ALB/ACM/Route53 — same as before this fix), or when the
 * caller didn't supply enough info (deploymentName/region/account) to build
 * a real ARN, in which case falling back to unscoped `*` is strictly safer
 * than fabricating a wrong ARN that would itself cause a false denial.
 */
function resourceContextFor({
  groupKey, deploymentName, region, account,
}) {
  if (!deploymentName || !account) return null;
  if (groupKey === 's3') {
    return {
      resourceArns: [
        `arn:aws:s3:::${deploymentName}-*`,
        `arn:aws:s3:::${deploymentName}-*/*`,
      ],
    };
  }
  if (groupKey === 'secrets-manager') {
    if (!region) return null;
    return {
      resourceArns: [
        `arn:aws:secretsmanager:${region}:${account}:secret:${deploymentName}/app/env*`,
        `arn:aws:secretsmanager:${region}:${account}:secret:${deploymentName}/db/credentials*`,
      ],
    };
  }
  if (groupKey === 'iam') {
    return {
      resourceArns: [
        `arn:aws:iam::${account}:role/${deploymentName}-*`,
        `arn:aws:iam::${account}:instance-profile/${deploymentName}-*`,
      ],
    };
  }
  return null;
}

// iam:PassRole is handled outside the normal action-list simulation (see
// checkAwsIamPermissions): the real policy only ever grants it conditionally
// on `iam:PassedToService` (see generateRequiredPolicyJson's Condition
// block), and Terraform always passes the role to exactly ONE service per
// call (ec2 when launching the instance, ssm implicitly via the instance
// profile) — never both at once. A single simulate call with BOTH services
// in one stringList context entry evaluates as "any of these N values must
// simultaneously satisfy StringLike" in some AWS API edge cases and is not
// how PassRole is actually invoked at apply-time, so this checks each
// service independently and treats the group as satisfied if EITHER passes
// (mirroring the Condition's StringLike, which itself is an any-of over the
// list — this just evaluates that any-of correctly instead of asking the
// simulator to do it in one shot).
const PASS_ROLE_SERVICES = ['ec2.amazonaws.com', 'ssm.amazonaws.com'];

async function simulatePassRole({
  callerArn, execImpl, resourceArns,
}) {
  for (const service of PASS_ROLE_SERVICES) {
    // eslint-disable-next-line no-await-in-loop -- small fixed list (2 services), sequential for simplicity/debuggability.
    const { evaluated, deniedActions, error } = await simulateGroup({
      callerArn,
      actions: ['iam:PassRole'],
      execImpl,
      resourceArns,
      contextEntries: [`iam:PassedToService=${service}`],
    });
    if (evaluated && deniedActions.length === 0) {
      return { evaluated: true, deniedActions: [] };
    }
    if (!evaluated) {
      return { evaluated: false, deniedActions: [], error };
    }
  }
  return { evaluated: true, deniedActions: ['iam:PassRole'] };
}

/**
 * Runs `aws iam simulate-principal-policy` for one group's action list
 * against the caller's own ARN. Returns { evaluated: boolean, deniedActions }.
 * `evaluated: false` means the simulate call itself failed (e.g. the
 * caller's principal isn't allowed to call SimulatePrincipalPolicy — a real
 * possibility on tightly-locked-down accounts) — callers must treat this as
 * "unknown", not "denied".
 */
async function simulateGroup({
  callerArn, actions, execImpl = execFileAsync, resourceArns, contextEntries,
}) {
  try {
    const args = [
      'iam', 'simulate-principal-policy',
      '--policy-source-arn', callerArn,
      '--action-names', ...actions,
    ];
    if (resourceArns && resourceArns.length > 0) {
      args.push('--resource-arns', ...resourceArns);
    }
    if (contextEntries && contextEntries.length > 0) {
      // JSON form (not the `Key=k,Values=v1,v2` shorthand) because the AWS
      // CLI's shorthand parser treats every comma as a new top-level field
      // separator — it can't represent a single context key with MULTIPLE
      // values (e.g. iam:PassedToService=[ec2.amazonaws.com,
      // ssm.amazonaws.com]) without this. Verified against a live account:
      // the shorthand form silently mis-parses to "expected a single value,
      // but received 2".
      args.push('--context-entries', JSON.stringify(contextEntries.map((e) => {
        const [key, values] = e.split('=');
        const valueList = values.split(',');
        return {
          ContextKeyName: key,
          ContextKeyValues: valueList,
          // AWS rejects ContextKeyType: "string" with >1 value ("expected a
          // single value, but received N") — stringList is required for any
          // multi-value context entry (single-value ones accept either, so
          // this branch is safe for both cases).
          ContextKeyType: valueList.length > 1 ? 'stringList' : 'string',
        };
      })));
    }
    args.push('--output', 'json');
    const { stdout } = await execImpl('aws', args, { maxBuffer: 1024 * 1024 * 8 });
    const parsed = JSON.parse(stdout);
    const evaluationResults = parsed.EvaluationResults || [];
    const deniedActions = evaluationResults
      .filter((r) => r.EvalDecision !== 'allowed')
      .map((r) => r.EvalActionName);
    return { evaluated: true, deniedActions };
  } catch (err) {
    return { evaluated: false, deniedActions: [], error: err?.message || String(err) };
  }
}

/**
 * Runs the full precheck for a given topology ('single' | 'ha') and returns
 * one summary row per action group, shaped for preflight.mjs's existing
 * { key, status, label, detail, hint } row convention (see preflight.mjs's
 * other check* functions) so it plugs into the same renderer without a
 * special case.
 *
 * `deploymentName`/`region` are optional but strongly recommended — without
 * them, s3/secrets-manager/iam groups fall back to unscoped `*` simulation,
 * which under-reports real permission gaps for wildcard-`Resource: "*"`
 * policies but over-reports (false failures) for the far more common
 * deployment-name-scoped policy shape. Callers (wizard.mjs) should always
 * pass these once `state.deploymentName`/`state.region` are known.
 */
export async function checkAwsIamPermissions({
  topology = 'single', deploymentName, region, execImpl = execFileAsync,
} = {}) {
  let callerArn;
  let account;
  try {
    ({ arn: callerArn, account } = await getCallerIdentity({ execImpl }));
  } catch (err) {
    return {
      key: 'aws-iam', status: 'fail', label: 'AWS IAM permissions',
      detail: 'could not resolve caller identity (aws sts get-caller-identity failed)',
      hint: `${err?.message || err}`,
      groups: [],
    };
  }

  const wanted = groupsFor(topology);
  const groupResults = [];
  for (const [key, group] of wanted) {
    const ctx = resourceContextFor({
      groupKey: key, deploymentName, region, account,
    });
    if (key === 'iam' && ctx?.resourceArns) {
      // PassRole is simulated separately per-service (see simulatePassRole's
      // comment) — the rest of the IAM group's actions go through the
      // normal path against the same scoped role/instance-profile ARNs.
      const nonPassRoleActions = group.actions.filter((a) => a !== 'iam:PassRole');
      // eslint-disable-next-line no-await-in-loop -- sequential to keep simulate-principal-policy calls easy to reason about/debug; each call is cheap and this only runs once per preflight pass.
      const rest = await simulateGroup({
        callerArn, actions: nonPassRoleActions, execImpl, resourceArns: ctx.resourceArns,
      });
      // eslint-disable-next-line no-await-in-loop -- see above.
      const passRole = await simulatePassRole({ callerArn, execImpl, resourceArns: ctx.resourceArns });
      const evaluated = rest.evaluated && passRole.evaluated;
      const deniedActions = [...rest.deniedActions, ...passRole.deniedActions];
      const error = rest.error || passRole.error;
      groupResults.push({
        key, label: group.label, evaluated, deniedActions, error,
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential to keep simulate-principal-policy calls easy to reason about/debug; each call is cheap and this only runs once per preflight pass.
    const { evaluated, deniedActions, error } = await simulateGroup({
      callerArn, actions: group.actions, execImpl,
      resourceArns: ctx?.resourceArns, contextEntries: ctx?.contextEntries,
    });
    groupResults.push({ key, label: group.label, evaluated, deniedActions, error });
  }

  const anyUnevaluated = groupResults.some((g) => !g.evaluated);
  const failedGroups = groupResults.filter((g) => g.evaluated && g.deniedActions.length > 0);
  const okGroups = groupResults.filter((g) => g.evaluated && g.deniedActions.length === 0);

  if (anyUnevaluated && failedGroups.length === 0) {
    // The simulate call itself is denied for at least one group and nothing
    // else came back denied — we genuinely don't know. Warn, don't block:
    // a tightly-locked-down account may deny iam:SimulatePrincipalPolicy
    // itself while still granting everything else.
    return {
      key: 'aws-iam', status: 'warn', label: 'AWS IAM permissions',
      detail: 'could not pre-verify permissions for all groups (simulate call itself denied for some) — will fail at apply time if insufficient',
      hint: 'Re-run `terraform apply` after fixing any errors it reports, or ask your AWS admin to grant iam:SimulatePrincipalPolicy so this precheck can run.',
      groups: groupResults,
    };
  }

  if (failedGroups.length === 0) {
    return {
      key: 'aws-iam', status: 'ok', label: 'AWS IAM permissions',
      detail: `${okGroups.map((g) => g.label).join(', ')} — all OK`,
      groups: groupResults,
    };
  }

  // Single-node: any failing group is a hard blocker (there's no smaller
  // topology to fall back to). HA: the alb-acm-route53 group failing alone
  // is still a hard blocker for THIS topology (HA needs it) — grouping logic
  // here is deliberately simple: any denied group for the requested topology
  // fails preflight. The "single-node can continue" messaging from the plan
  // doc applies at the wizard level (offering to switch topology), not by
  // silently downgrading severity here.
  const missingSummary = failedGroups
    .map((g) => `${g.label}: ${g.deniedActions.join(', ')}`)
    .join(' | ');
  return {
    key: 'aws-iam', status: 'fail', label: 'AWS IAM permissions',
    detail: `${failedGroups.map((g) => g.label).join(', ')} — ${failedGroups.reduce((n, g) => n + g.deniedActions.length, 0)} action(s) denied`,
    hint: `Missing: ${missingSummary}. Ask your AWS admin to attach the policy generated by aws-required-policy.json (see deploy/terraform/aws-required-policy.json), or run \`deploy/cli/cc.mjs\` with --print-required-policy to regenerate it.`,
    groups: groupResults,
  };
}

/**
 * Generates the ready-made IAM policy JSON (deploy/terraform/aws-required-policy.json)
 * from the SAME action-group source of truth used by checkAwsIamPermissions,
 * so the printable policy document and the precheck can never drift apart.
 * Resource scoping: `*` for everything except IAM (scoped to
 * `<deployment-name>-*` role/instance-profile names, since IAM is the one
 * service where handing out unscoped CreateRole/PassRole is meaningfully
 * riskier than the rest). This is intentionally narrower than the internal
 * fde-app-bot-aws-operator-policy.sh's wide `cc-*`/`fde-*` patterns, which
 * only make sense for our own consolidated internal account.
 */
export function generateRequiredPolicyJson({ deploymentNamePattern = '*' } = {}) {
  const statements = [];
  for (const [key, group] of Object.entries(ACTION_GROUPS)) {
    if (key === 'iam') {
      statements.push({
        Sid: 'IamManageDeploymentRolesAndProfiles',
        Effect: 'Allow',
        Action: group.actions.filter((a) => a !== 'iam:PassRole'),
        Resource: [
          `arn:aws:iam::*:role/${deploymentNamePattern}`,
          `arn:aws:iam::*:instance-profile/${deploymentNamePattern}`,
        ],
      });
      statements.push({
        Sid: 'IamPassDeploymentRoleToEc2AndSsm',
        Effect: 'Allow',
        Action: 'iam:PassRole',
        Resource: `arn:aws:iam::*:role/${deploymentNamePattern}`,
        Condition: {
          StringLike: {
            'iam:PassedToService': ['ec2.amazonaws.com', 'ssm.amazonaws.com'],
          },
        },
      });
      continue;
    }
    statements.push({
      Sid: `${key.replace(/[^a-zA-Z0-9]/g, '')}Access`,
      Effect: 'Allow',
      Action: group.actions,
      Resource: '*',
    });
  }
  return {
    Version: '2012-10-17',
    Statement: statements,
  };
}

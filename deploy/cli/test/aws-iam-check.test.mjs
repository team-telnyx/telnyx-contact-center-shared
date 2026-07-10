import assert from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTION_GROUPS, groupsFor, checkAwsIamPermissions, generateRequiredPolicyJson,
} from '../lib/aws-iam-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function callerIdentityExec(arn = 'arn:aws:iam::123456789012:user/test-user') {
  return async (cmd, args) => {
    if (args[0] === 'sts') {
      return { stdout: JSON.stringify({ Arn: arn, Account: '123456789012', UserId: 'AID...' }) };
    }
    throw new Error(`unexpected command in test stub: ${cmd} ${args.join(' ')}`);
  };
}

function allowAllSimulate() {
  return async (cmd, args) => {
    if (args[0] === 'sts') return { stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/test-user' }) };
    if (args[0] === 'iam' && args[1] === 'simulate-principal-policy') {
      const actionsIdx = args.indexOf('--action-names');
      const actions = args.slice(actionsIdx + 1).filter((a) => !a.startsWith('--'));
      return {
        stdout: JSON.stringify({
          EvaluationResults: actions.map((a) => ({ EvalActionName: a, EvalDecision: 'allowed' })),
        }),
      };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

function denySpecificActions(deniedSet) {
  return async (cmd, args) => {
    if (args[0] === 'sts') return { stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/test-user' }) };
    if (args[0] === 'iam' && args[1] === 'simulate-principal-policy') {
      const actionsIdx = args.indexOf('--action-names');
      const actions = args.slice(actionsIdx + 1).filter((a) => !a.startsWith('--'));
      return {
        stdout: JSON.stringify({
          EvaluationResults: actions.map((a) => ({
            EvalActionName: a,
            EvalDecision: deniedSet.has(a) ? 'explicitDeny' : 'allowed',
          })),
        }),
      };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

describe('aws-iam-check.mjs', () => {
  it('groupsFor("single"): excludes alb-acm-route53', () => {
    const groups = groupsFor('single').map(([key]) => key);
    assert.ok(!groups.includes('alb-acm-route53'));
    assert.ok(groups.includes('ec2-networking'));
    assert.ok(groups.includes('ssm'));
  });

  it('groupsFor("ha"): includes alb-acm-route53', () => {
    const groups = groupsFor('ha').map(([key]) => key);
    assert.ok(groups.includes('alb-acm-route53'));
  });

  it('checkAwsIamPermissions: fails fast with a clear detail when get-caller-identity fails', async () => {
    const execImpl = async () => { throw new Error('Unable to locate credentials'); };
    const result = await checkAwsIamPermissions({ topology: 'single', execImpl });
    assert.strictEqual(result.status, 'fail');
    assert.match(result.detail, /caller identity/);
  });

  it('checkAwsIamPermissions: ok when every group is allowed', async () => {
    const execImpl = allowAllSimulate();
    const result = await checkAwsIamPermissions({ topology: 'single', execImpl });
    assert.strictEqual(result.status, 'ok');
    assert.match(result.detail, /all OK/);
  });

  it('checkAwsIamPermissions: fail when a required group has denied actions, with actionable hint', async () => {
    const execImpl = denySpecificActions(new Set(['ec2:RunInstances']));
    const result = await checkAwsIamPermissions({ topology: 'single', execImpl });
    assert.strictEqual(result.status, 'fail');
    assert.match(result.detail, /EC2 \+ networking/);
    assert.match(result.hint, /ec2:RunInstances/);
    assert.match(result.hint, /aws-required-policy\.json/);
  });

  it('checkAwsIamPermissions: single-node topology never evaluates alb-acm-route53', async () => {
    const seenActionSets = [];
    const execImpl = async (cmd, args) => {
      if (args[0] === 'sts') return { stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/x' }) };
      if (args[0] === 'iam' && args[1] === 'simulate-principal-policy') {
        const actionsIdx = args.indexOf('--action-names');
        seenActionSets.push(args.slice(actionsIdx + 1).filter((a) => !a.startsWith('--')));
        return { stdout: JSON.stringify({ EvaluationResults: [] }) };
      }
      throw new Error('unexpected');
    };
    await checkAwsIamPermissions({ topology: 'single', execImpl });
    const flat = seenActionSets.flat();
    assert.ok(!flat.includes('acm:RequestCertificate'));
  });

  it('checkAwsIamPermissions: warns (does not hard-fail) when simulate call itself is denied and nothing else failed', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'sts') return { stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/x' }) };
      if (args[0] === 'iam' && args[1] === 'simulate-principal-policy') {
        throw new Error('AccessDenied: not authorized to call iam:SimulatePrincipalPolicy');
      }
      throw new Error('unexpected');
    };
    const result = await checkAwsIamPermissions({ topology: 'single', execImpl });
    assert.strictEqual(result.status, 'warn');
    assert.match(result.detail, /could not pre-verify/);
  });

  it('generateRequiredPolicyJson: covers every action from every group', () => {
    const policy = generateRequiredPolicyJson();
    const allActionsInPolicy = new Set(
      policy.Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])),
    );
    for (const group of Object.values(ACTION_GROUPS)) {
      for (const action of group.actions) {
        assert.ok(allActionsInPolicy.has(action), `missing action in generated policy: ${action}`);
      }
    }
  });

  it('generateRequiredPolicyJson: IAM statements are scoped, not resource "*"', () => {
    const policy = generateRequiredPolicyJson({ deploymentNamePattern: 'cc-main-*' });
    const iamStatements = policy.Statement.filter((s) => s.Sid.startsWith('Iam'));
    assert.ok(iamStatements.length >= 2);
    for (const stmt of iamStatements) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const r of resources) assert.notStrictEqual(r, '*');
    }
  });

  it('deploy/terraform/aws-required-policy.json on disk matches the generator output (regenerate via scripts/generate-aws-required-policy.mjs if this fails)', async () => {
    const onDisk = await readFile(join(__dirname, '..', '..', 'terraform', 'aws-required-policy.json'), 'utf8');
    const generated = `${JSON.stringify(generateRequiredPolicyJson({ deploymentNamePattern: '<deployment-name>-*' }), null, 2)}\n`;
    assert.strictEqual(onDisk, generated);
  });

  // Regression coverage for the 2026-07-06 E2E false-negative: a
  // deployment-name-scoped operator policy (the exact shape
  // generateRequiredPolicyJson produces, and the shape our own internal
  // fde-app-bot-* policies use) was reported as "28 actions denied" because
  // simulate-principal-policy defaults to evaluating against Resource: "*"
  // when no --resource-arns is passed — see aws-iam-check.mjs's module
  // header comment for the full story.
  describe('checkAwsIamPermissions — resource-scoped simulation (deploymentName/region)', () => {
    // Mimics a real deployment-name-scoped policy: S3/Secrets Manager/IAM
    // actions are only `allowed` when the resource-arns the CLI passed
    // actually match the deployment's own prefix; PassRole additionally
    // requires the iam:PassedToService context key to be one of the two
    // services Terraform actually passes to.
    function scopedPolicySimulate({ allowedDeploymentPrefix = 'cc-main' } = {}) {
      return async (cmd, args) => {
        if (args[0] === 'sts') {
          return { stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/fde-app-bot', Account: '123456789012' }) };
        }
        if (args[0] === 'iam' && args[1] === 'simulate-principal-policy') {
          const actionsIdx = args.indexOf('--action-names');
          const nextFlagIdx = args.findIndex((a, i) => i > actionsIdx && a.startsWith('--'));
          const actions = args.slice(actionsIdx + 1, nextFlagIdx === -1 ? undefined : nextFlagIdx);
          const resourceIdx = args.indexOf('--resource-arns');
          const resourceArns = resourceIdx === -1 ? ['*'] : (() => {
            const nextIdx = args.findIndex((a, i) => i > resourceIdx && a.startsWith('--'));
            return args.slice(resourceIdx + 1, nextIdx === -1 ? undefined : nextIdx);
          })();
          const scopedOk = resourceArns.some((r) => r === '*' || r.includes(`/${allowedDeploymentPrefix}-`) || r.includes(`:::${allowedDeploymentPrefix}-`) || r.includes(`:${allowedDeploymentPrefix}/`));
          if (actions.includes('iam:PassRole')) {
            const ctxIdx = args.indexOf('--context-entries');
            const ctxRaw = ctxIdx === -1 ? '[]' : args[ctxIdx + 1];
            const ctx = JSON.parse(ctxRaw);
            const passedService = ctx[0]?.ContextKeyValues?.[0];
            const serviceOk = passedService === 'ec2.amazonaws.com' || passedService === 'ssm.amazonaws.com';
            return {
              stdout: JSON.stringify({
                EvaluationResults: [{ EvalActionName: 'iam:PassRole', EvalDecision: scopedOk && serviceOk ? 'allowed' : 'implicitDeny' }],
              }),
            };
          }
          return {
            stdout: JSON.stringify({
              EvaluationResults: actions.map((a) => ({ EvalActionName: a, EvalDecision: scopedOk ? 'allowed' : 'implicitDeny' })),
            }),
          };
        }
        throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
      };
    }

    it('passes S3/Secrets Manager/IAM groups when deploymentName+region are supplied and the policy is scoped to that prefix', async () => {
      const execImpl = scopedPolicySimulate({ allowedDeploymentPrefix: 'cc-main' });
      const result = await checkAwsIamPermissions({
        topology: 'single', deploymentName: 'cc-main', region: 'us-west-2', execImpl,
      });
      assert.strictEqual(result.status, 'ok', `expected ok, got: ${JSON.stringify(result)}`);
    });

    it('without deploymentName/region, the SAME scoped policy falsely reports denials (documents the bug this fix addresses)', async () => {
      const execImpl = scopedPolicySimulate({ allowedDeploymentPrefix: 'cc-main' });
      const result = await checkAwsIamPermissions({ topology: 'single', execImpl });
      assert.strictEqual(result.status, 'fail');
    });

    it('still fails when the resource-arns are correctly scoped but genuinely denied (a real gap is not masked)', async () => {
      const execImpl = scopedPolicySimulate({ allowedDeploymentPrefix: 'some-other-deployment' });
      const result = await checkAwsIamPermissions({
        topology: 'single', deploymentName: 'cc-main', region: 'us-west-2', execImpl,
      });
      assert.strictEqual(result.status, 'fail');
    });

    it('iam:PassRole is satisfied when EITHER ec2 or ssm iam:PassedToService is allowed, not requiring both simultaneously', async () => {
      const execImpl = async (cmd, args) => {
        if (args[0] === 'sts') return { stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/x', Account: '123456789012' }) };
        if (args[0] === 'iam' && args[1] === 'simulate-principal-policy') {
          const actionsIdx = args.indexOf('--action-names');
          const nextFlagIdx = args.findIndex((a, i) => i > actionsIdx && a.startsWith('--'));
          const actions = args.slice(actionsIdx + 1, nextFlagIdx === -1 ? undefined : nextFlagIdx);
          if (actions.includes('iam:PassRole')) {
            const ctxIdx = args.indexOf('--context-entries');
            const ctx = JSON.parse(args[ctxIdx + 1]);
            const service = ctx[0]?.ContextKeyValues?.[0];
            // Only ec2 is granted, ssm is not — group should still pass overall.
            return { stdout: JSON.stringify({ EvaluationResults: [{ EvalActionName: 'iam:PassRole', EvalDecision: service === 'ec2.amazonaws.com' ? 'allowed' : 'implicitDeny' }] }) };
          }
          return { stdout: JSON.stringify({ EvaluationResults: actions.map((a) => ({ EvalActionName: a, EvalDecision: 'allowed' })) }) };
        }
        throw new Error('unexpected');
      };
      const result = await checkAwsIamPermissions({
        topology: 'single', deploymentName: 'cc-main', region: 'us-west-2', execImpl,
      });
      assert.strictEqual(result.status, 'ok', `expected ok, got: ${JSON.stringify(result)}`);
    });
  });
});

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  tfvarsPath, writeTfvars, terraformInit, terraformPlan, parsePlanSummary,
  streamTerraform, terraformApply, terraformDestroy, terraformOutputs, terraformVersion,
  terraformStateList, terraformStateRm,
  humanizeResourceAddress, createTerraformLineFilter,
} from '../lib/terraform.mjs';

function fakeChildProcess({ exitCode = 0, stdoutChunks = [], stderrChunks = [], emitErrorInstead = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (emitErrorInstead) {
      child.emit('error', emitErrorInstead);
      return;
    }
    for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk));
    for (const chunk of stderrChunks) child.stderr.emit('data', Buffer.from(chunk));
    child.emit('close', exitCode);
  });
  return child;
}

describe('terraform.mjs', () => {
  it('tfvarsPath: appends cc.auto.tfvars.json', () => {
    assert.strictEqual(tfvarsPath('/tmp/foo'), '/tmp/foo/cc.auto.tfvars.json');
  });

  it('writeTfvars: writes JSON and creates the dir', async () => {
    const calls = { mkdir: [], writeFile: [] };
    const mkdirImpl = async (dir, opts) => { calls.mkdir.push([dir, opts]); };
    const writeFileImpl = async (path, content, enc) => { calls.writeFile.push([path, content, enc]); };
    const path = await writeTfvars('/tmp/root', { deployment_name: 'cc-main' }, { mkdirImpl, writeFileImpl });
    assert.strictEqual(path, '/tmp/root/cc.auto.tfvars.json');
    assert.strictEqual(calls.mkdir[0][0], '/tmp/root');
    assert.deepStrictEqual(calls.mkdir[0][1], { recursive: true });
    assert.strictEqual(calls.writeFile[0][0], '/tmp/root/cc.auto.tfvars.json');
    assert.match(calls.writeFile[0][1], /"deployment_name": "cc-main"/);
  });

  it('parsePlanSummary: parses the standard "Plan: N to add..." line', () => {
    const stdout = 'Terraform will perform the following actions...\n\nPlan: 12 to add, 2 to change, 1 to destroy.\n';
    assert.deepStrictEqual(parsePlanSummary(stdout), { toAdd: 12, toChange: 2, toDestroy: 1 });
  });

  it('parsePlanSummary: recognizes "No changes"', () => {
    const stdout = 'No changes. Your infrastructure matches the configuration.\n';
    assert.deepStrictEqual(parsePlanSummary(stdout), { toAdd: 0, toChange: 0, toDestroy: 0 });
  });

  it('parsePlanSummary: returns null when it cannot recognize the output', () => {
    assert.strictEqual(parsePlanSummary('some unrelated text'), null);
  });

  it('terraformInit: calls terraform init with -input=false', async () => {
    let seenArgs;
    const execImpl = async (cmd, args) => { seenArgs = args; return { stdout: '' }; };
    await terraformInit({ cwd: '/tmp/root', execImpl });
    assert.strictEqual(seenArgs[0], 'init');
    assert.ok(seenArgs.includes('-input=false'));
  });

  it('terraformPlan: returns stdout + parsed summary + planFile', async () => {
    const execImpl = async () => ({ stdout: 'Plan: 3 to add, 0 to change, 0 to destroy.\n' });
    const result = await terraformPlan({ cwd: '/tmp/root', execImpl });
    assert.deepStrictEqual(result.summary, { toAdd: 3, toChange: 0, toDestroy: 0 });
    assert.strictEqual(result.planFile, 'cc.tfplan');
  });

  it('streamTerraform: forwards stdout lines to onLine and resolves on close', async () => {
    const lines = [];
    const spawnImpl = () => fakeChildProcess({ exitCode: 0, stdoutChunks: ['line one\nline two\n'] });
    const result = await streamTerraform({ cwd: '/tmp', args: ['apply'], onLine: (l) => lines.push(l), spawnImpl });
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(lines, ['line one', 'line two']);
  });

  it('streamTerraform: rejects when spawn itself throws', async () => {
    const spawnImpl = () => { throw new Error('ENOENT: terraform not found'); };
    await assert.rejects(() => streamTerraform({ cwd: '/tmp', args: ['apply'], spawnImpl }), /ENOENT/);
  });

  it('terraformApply: throws with stderr context on non-zero exit', async () => {
    const spawnImpl = () => fakeChildProcess({ exitCode: 1, stderrChunks: ['Error: something broke\n'] });
    await assert.rejects(
      () => terraformApply({ cwd: '/tmp', spawnImpl }),
      /terraform apply failed \(exit 1\).*something broke/s,
    );
  });

  it('terraformApply: resolves on exit 0', async () => {
    const spawnImpl = () => fakeChildProcess({ exitCode: 0, stdoutChunks: ['Apply complete!\n'] });
    const result = await terraformApply({ cwd: '/tmp', spawnImpl });
    assert.match(result.stdout, /Apply complete/);
  });

  it('terraformDestroy: throws with stderr context on non-zero exit', async () => {
    const spawnImpl = () => fakeChildProcess({ exitCode: 1, stderrChunks: ['Error: dependency violation\n'] });
    await assert.rejects(
      () => terraformDestroy({ cwd: '/tmp', spawnImpl }),
      /terraform destroy failed \(exit 1\).*dependency violation/s,
    );
  });

  // Regression test for the bug reported by the user right after PR #1204:
  // `cc destroy` still printed a full raw Terraform plan diff ("# X will be
  // destroyed" / '- resource "..." { ... }' blocks) even though
  // createTerraformLineFilter was wired into the destroy path. Root cause:
  // terraformDestroy used to run bare `terraform destroy -auto-approve`
  // (no plan file), which makes Terraform recompute AND reprint the entire
  // destroy plan before doing any teardown — a completely different output
  // phase from "Destroying.../Creation complete" that the line filter was
  // never meant to (and can't reasonably) suppress. The fix makes
  // terraformDestroy apply a previously-computed plan file, exactly like
  // terraformApply already does, so no diff gets recomputed/reprinted.
  it('terraformDestroy: applies the given plan file instead of running a bare "destroy"', async () => {
    let seenArgs;
    const spawnImpl = (cmd, args) => {
      seenArgs = args;
      return fakeChildProcess({ exitCode: 0, stdoutChunks: ['Apply complete!\n'] });
    };
    await terraformDestroy({ cwd: '/tmp', planFile: 'cc.tfplan', spawnImpl });
    assert.deepStrictEqual(seenArgs, ['apply', '-input=false', '-no-color', '-auto-approve', 'cc.tfplan']);
    assert.ok(!seenArgs.includes('destroy'), 'must not pass the bare "destroy" subcommand — that recomputes and reprints the full plan diff');
  });

  it("terraformDestroy: defaults planFile to cc.tfplan (matches terraformPlan's default)", async () => {
    let seenArgs;
    const spawnImpl = (cmd, args) => {
      seenArgs = args;
      return fakeChildProcess({ exitCode: 0, stdoutChunks: ['Apply complete!\n'] });
    };
    await terraformDestroy({ cwd: '/tmp', spawnImpl });
    assert.ok(seenArgs.includes('cc.tfplan'));
  });

  it('terraformOutputs: unwraps the {value,type,sensitive} envelope', async () => {
    const raw = {
      public_ip: { value: '1.2.3.4', type: 'string', sensitive: false },
      bucket_name: { value: 'cc-main-abcd1234', type: 'string', sensitive: false },
    };
    const execImpl = async () => ({ stdout: JSON.stringify(raw) });
    const result = await terraformOutputs({ cwd: '/tmp', execImpl });
    assert.deepStrictEqual(result, { public_ip: '1.2.3.4', bucket_name: 'cc-main-abcd1234' });
  });

  it('terraformOutputs: empty outputs -> empty object', async () => {
    const execImpl = async () => ({ stdout: '{}' });
    const result = await terraformOutputs({ cwd: '/tmp', execImpl });
    assert.deepStrictEqual(result, {});
  });

  it('terraformVersion: parses -json output', async () => {
    const execImpl = async () => ({ stdout: JSON.stringify({ terraform_version: '1.9.8' }) });
    const version = await terraformVersion({ execImpl });
    assert.strictEqual(version, '1.9.8');
  });

  it('terraformVersion: falls back to parsing plain text when -json fails', async () => {
    const execImpl = async (cmd, args) => {
      if (args.includes('-json')) throw new Error('unknown flag');
      return { stdout: 'Terraform v1.5.2\non darwin_arm64\n' };
    };
    const version = await terraformVersion({ execImpl });
    assert.strictEqual(version, '1.5.2');
  });

  it('terraformVersion: returns null when terraform is not installed at all', async () => {
    const execImpl = async () => { throw new Error('ENOENT'); };
    const version = await terraformVersion({ execImpl });
    assert.strictEqual(version, null);
  });
});

describe('terraform.mjs — humanizeResourceAddress', () => {
  it('strips module path + azurerm_ prefix, humanizes underscores', () => {
    assert.strictEqual(humanizeResourceAddress('module.database.azurerm_postgresql_flexible_server.main'), 'postgresql flexible server');
  });

  it('strips a trailing [0] count index', () => {
    assert.strictEqual(humanizeResourceAddress('module.compute.azurerm_application_gateway.app[0]'), 'application gateway');
  });

  it('handles a bare (non-module) resource address', () => {
    assert.strictEqual(humanizeResourceAddress('azurerm_resource_group.main'), 'resource group');
  });

  it('handles nested module paths (module.x.module.y.resource.name)', () => {
    assert.strictEqual(humanizeResourceAddress('module.secrets.azurerm_role_assignment.deployer_certificates_officer'), 'role assignment');
  });

  it('handles aws_/google_/random_/tls_ prefixes too', () => {
    assert.strictEqual(humanizeResourceAddress('module.compute.aws_instance.app'), 'instance');
    assert.strictEqual(humanizeResourceAddress('module.database.google_sql_database_instance.main'), 'sql database instance');
    assert.strictEqual(humanizeResourceAddress('module.database.random_password.db'), 'password');
    assert.strictEqual(humanizeResourceAddress('module.compute.tls_private_key.vm_throwaway'), 'private key');
  });

  it('falls back to the full (module-path-stripped-only) address for an unrecognized prefix', () => {
    assert.strictEqual(humanizeResourceAddress('module.x.kubernetes_deployment.app'), 'module.x.kubernetes_deployment.app');
  });
});

describe('terraform.mjs — createTerraformLineFilter', () => {
  it('suppresses "Still creating..." heartbeat spam entirely (returns null)', () => {
    const filter = createTerraformLineFilter();
    assert.strictEqual(filter('module.secrets.azurerm_key_vault.main: Still creating... [01m20s elapsed]'), null);
    assert.strictEqual(filter('module.database.azurerm_postgresql_flexible_server.main: Still destroying... [00m10s elapsed]'), null);
  });

  it('REGRESSION: suppresses "Refreshing state..." / "Still refreshing..." / data source Reading/Read complete — the pre-flight refresh phase every apply AND destroy starts with (reported live on a real cc destroy run right after PR #1204 merged)', () => {
    const filter = createTerraformLineFilter();
    assert.strictEqual(filter('module.database.azurerm_postgresql_flexible_server_configuration.extensions: Refreshing state... [id=/subscriptions/x/resourceGroups/cc-azure-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/cc-azure-pg/configurations/azure.extensions]'), null);
    assert.strictEqual(filter('module.storage.azurerm_role_assignment.deployer_storage_blob_contributor: Refreshing state... [id=/subscriptions/x/roleAssignments/dcec7beb-4ca5-fabb-1f1b-060088cdfde9]'), null);
    assert.strictEqual(filter('module.compute.tls_private_key.vm_throwaway: Refreshing state... [id=f5a1433d29850ce0b3cb5e99a47da8b61bb4a6af]'), null);
    assert.strictEqual(filter('azurerm_resource_group.main: Still refreshing state... [00m10s elapsed]'), null);
    assert.strictEqual(filter('data.azurerm_client_config.current: Reading...'), null);
    assert.strictEqual(filter('data.azurerm_client_config.current: Read complete after 1s [id=/tenants/x]'), null);
  });

  it('suppresses blank lines', () => {
    const filter = createTerraformLineFilter();
    assert.strictEqual(filter(''), null);
    assert.strictEqual(filter('   '), null);
  });

  it('announces a resource the first time it starts creating, humanized', () => {
    const filter = createTerraformLineFilter();
    const out = filter('module.secrets.azurerm_key_vault.main: Creating...');
    assert.strictEqual(out, '  Creating: key vault');
  });

  it('does not re-announce the same resource address twice', () => {
    const filter = createTerraformLineFilter();
    assert.strictEqual(filter('azurerm_resource_group.main: Creating...'), '  Creating: resource group');
    assert.strictEqual(filter('azurerm_resource_group.main: Creating...'), null);
  });

  it('summarizes "Creation complete after Ns [id=...]" to a short checkmark line with duration only, no id', () => {
    const filter = createTerraformLineFilter();
    const out = filter('module.secrets.azurerm_key_vault.main: Creation complete after 2m42s [id=/subscriptions/x/resourceGroups/cc-azure-rg/providers/Microsoft.KeyVault/vaults/cc-azure-kv]');
    assert.strictEqual(out, '  ✔ key vault (2m42s)');
  });

  it('handles Destroying.../Destruction complete for cc destroy output', () => {
    const filter = createTerraformLineFilter();
    assert.strictEqual(filter('module.compute.azurerm_linux_virtual_machine.app: Destroying...'), '  Destroying: linux virtual machine');
    assert.strictEqual(filter('module.compute.azurerm_linux_virtual_machine.app: Destruction complete after 12s'), '  ✔ linux virtual machine (12s)');
  });

  // Regression test for the bug reported live by the user on PR #1206:
  // unlike apply's bare "X: Creating..." lines, terraform's real destroy
  // output appends "[id=...]" directly onto the SAME "Destroying..." line
  // (e.g. "module.compute.azurerm_dns_a_record.app[0]: Destroying...
  // [id=/subscriptions/.../A/cc-azure]") — the old regex was anchored with
  // a hard `$` right after the three dots, so it never matched a real
  // destroy run and every single "Destroying..." line leaked through
  // unfiltered, full Azure resource id and all.
  it('REGRESSION: matches "Destroying... [id=...]" (real destroy shape, not the bare form the old regex assumed)', () => {
    const filter = createTerraformLineFilter();
    const out = filter('module.compute.azurerm_dns_a_record.app[0]: Destroying... [id=/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo-rg/providers/Microsoft.Network/dnsZones/demo.example.com/A/cc-azure]');
    assert.strictEqual(out, '  Destroying: dns a record');
  });

  it('passes through Warning:/Error:/Apply complete!/Plan: lines unchanged — operators need to actually read these', () => {
    const filter = createTerraformLineFilter();
    assert.strictEqual(filter('Apply complete! Resources: 5 added, 0 changed, 0 destroyed.'), 'Apply complete! Resources: 5 added, 0 changed, 0 destroyed.');
    assert.strictEqual(filter('Warning: Applied changes may be incomplete'), 'Warning: Applied changes may be incomplete');
    assert.strictEqual(filter('Error: 403 Forbidden'), 'Error: 403 Forbidden');
  });

  it('end-to-end: a real captured Azure apply log collapses from 14 raw lines to 4 announcements', () => {
    const filter = createTerraformLineFilter();
    const rawLines = [
      'azurerm_resource_group.main: Creating...',
      'azurerm_resource_group.main: Still creating... [00m10s elapsed]',
      'azurerm_resource_group.main: Still creating... [00m20s elapsed]',
      'azurerm_resource_group.main: Creation complete after 26s [id=/subscriptions/x/resourceGroups/cc-azure-rg]',
      'module.secrets.azurerm_key_vault.main: Creating...',
      'module.secrets.azurerm_key_vault.main: Still creating... [00m10s elapsed]',
      'module.secrets.azurerm_key_vault.main: Still creating... [00m20s elapsed]',
      'module.secrets.azurerm_key_vault.main: Still creating... [00m30s elapsed]',
      'module.secrets.azurerm_key_vault.main: Still creating... [00m40s elapsed]',
      'module.secrets.azurerm_key_vault.main: Still creating... [00m50s elapsed]',
      'module.secrets.azurerm_key_vault.main: Still creating... [01m00s elapsed]',
      'module.secrets.azurerm_key_vault.main: Still creating... [01m10s elapsed]',
      'module.secrets.azurerm_key_vault.main: Still creating... [01m20s elapsed]',
      'module.secrets.azurerm_key_vault.main: Creation complete after 2m42s [id=/subscriptions/x/resourceGroups/cc-azure-rg/providers/Microsoft.KeyVault/vaults/cc-azure-kv]',
    ];
    const results = rawLines.map(filter).filter((l) => l !== null);
    assert.deepStrictEqual(results, [
      '  Creating: resource group',
      '  ✔ resource group (26s)',
      '  Creating: key vault',
      '  ✔ key vault (2m42s)',
    ]);
  });
});

describe('terraform.mjs — terraformStateList', () => {
  it('splits `terraform state list` stdout into a trimmed, non-empty-lines array', async () => {
    const execImpl = async (cmd, args) => {
      assert.strictEqual(cmd, 'terraform');
      assert.deepStrictEqual(args, ['state', 'list']);
      return { stdout: 'module.network.google_compute_network.main\nmodule.database.google_sql_database_instance.main\n\n' };
    };
    const result = await terraformStateList({ cwd: '/tmp/x', execImpl });
    assert.deepStrictEqual(result, [
      'module.network.google_compute_network.main',
      'module.database.google_sql_database_instance.main',
    ]);
  });

  it('returns an empty array (never throws) when the command fails, e.g. no state yet', async () => {
    const execImpl = async () => { throw new Error('no state file found'); };
    const result = await terraformStateList({ cwd: '/tmp/x', execImpl });
    assert.deepStrictEqual(result, []);
  });
});

describe('terraform.mjs — terraformStateRm', () => {
  it('requires an address', async () => {
    await assert.rejects(() => terraformStateRm({ cwd: '/tmp/x' }), /requires \{ address \}/);
  });

  it('runs `terraform state rm <address>` and reports removed:true on success', async () => {
    let seenArgs = null;
    const execImpl = async (cmd, args) => {
      seenArgs = args;
      return { stdout: '' };
    };
    const result = await terraformStateRm({ cwd: '/tmp/x', address: 'module.database.google_sql_user.app', execImpl });
    assert.deepStrictEqual(seenArgs, ['state', 'rm', 'module.database.google_sql_user.app']);
    assert.deepStrictEqual(result, { removed: true });
  });

  it('treats "no matching objects" as a successful no-op, not a failure', async () => {
    const execImpl = async () => {
      const err = new Error('Command failed');
      err.stderr = 'No matching objects found.';
      throw err;
    };
    const result = await terraformStateRm({ cwd: '/tmp/x', address: 'module.database.google_sql_user.app', execImpl });
    assert.deepStrictEqual(result, { removed: false, alreadyAbsent: true });
  });

  it('re-throws any other error (e.g. a real terraform failure) instead of swallowing it', async () => {
    const execImpl = async () => { throw new Error('some unrelated terraform error'); };
    await assert.rejects(
      () => terraformStateRm({ cwd: '/tmp/x', address: 'module.database.google_sql_user.app', execImpl }),
      /some unrelated terraform error/,
    );
  });
});

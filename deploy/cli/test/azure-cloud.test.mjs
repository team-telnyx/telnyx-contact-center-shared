import assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { provisionAzureKeyVaultOnly } from '../lib/azure-cloud.mjs';

// Focused tests for provisionAzureKeyVaultOnly — the targeted
// (`-target=module.secrets`) terraform apply that bootstraps ONLY the
// resource group + Key Vault ahead of the certificate step, making the
// Azure wizard flow single-pass (see wizard.mjs's runAzureWizardTail and
// runAzureCertificateStep for the full picture). Mirrors gcp-cloud.test.mjs's
// fakeSpawnFactory/makeIo test-double style.

function fakeSpawnFactory({ exitCode = 0, stdoutChunks = ['Apply complete!\n'] } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk));
      child.emit('close', exitCode);
    });
    return child;
  };
}

function makeIo(overrides = {}) {
  const logs = [];
  return {
    log: (...args) => logs.push(args.join(' ')),
    confirm: overrides.confirm || (async () => true),
    step: (label) => {
      logs.push(`STEP: ${label}`);
      return {
        succeed: (m) => logs.push(`OK: ${m}`),
        fail: (m) => logs.push(`FAIL: ${m}`),
        warn: (m) => logs.push(`WARN: ${m}`),
        info: (m) => logs.push(m),
      };
    },
    longStep: (label) => {
      logs.push(`STEP: ${label}`);
      return {
        succeed: (m) => logs.push(`OK: ${m}`),
        fail: (m) => logs.push(`FAIL: ${m}`),
        warn: (m) => logs.push(`WARN: ${m}`),
        info: (m) => logs.push(m),
        stop: () => {},
      };
    },
    _logs: logs,
  };
}

async function makeDeployDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-azure-cloud-test-'));
  await mkdir(join(dir, 'terraform', 'azure', 'single-node'), { recursive: true });
  return dir;
}

describe('azure-cloud.mjs — provisionAzureKeyVaultOnly', () => {
  it('runs init/plan/apply scoped to module.secrets and returns the resulting keyVaultName/azureResourceGroup', async () => {
    const deployDir = await makeDeployDir();
    try {
      const seenPlanArgs = [];
      const execImpl = async (cmd, args) => {
        if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
        if (cmd === 'terraform' && args[0] === 'plan') {
          seenPlanArgs.push(args);
          return { stdout: 'Plan: 2 to add, 0 to change, 0 to destroy.\n' };
        }
        if (cmd === 'terraform' && args[0] === 'output') {
          return {
            stdout: JSON.stringify({
              key_vault_name: { value: 'cc-main-kv-a1b2' },
              resource_group_name: { value: 'cc-main-rg' },
            }),
          };
        }
        if (cmd === 'az') return { stdout: JSON.stringify({ id: 'x', user: { name: 'me@example.com' } }) };
        throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
      };
      const io = makeIo();
      const state = {
        deploymentName: 'cc-main', region: 'eastus2', infra: { azureSubscriptionId: 'sub-123', lbEnabled: true },
      };
      const result = await provisionAzureKeyVaultOnly({
        state, io, deployDir, execImpl, spawnImpl: fakeSpawnFactory(),
      });

      assert.strictEqual(result.aborted, false);
      assert.strictEqual(result.state.infra.keyVaultName, 'cc-main-kv-a1b2');
      assert.strictEqual(result.state.infra.azureResourceGroup, 'cc-main-rg');
      assert.ok(seenPlanArgs[0].includes('-target'), 'plan should be scoped with -target');
      assert.ok(seenPlanArgs[0].includes('module.secrets'), 'plan should target module.secrets specifically, not the full stack');
    } finally {
      await rm(deployDir, { recursive: true, force: true });
    }
  });

  it('aborts and returns aborted=true when the operator declines the confirm prompt', async () => {
    const deployDir = await makeDeployDir();
    try {
      const execImpl = async (cmd, args) => {
        if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
        if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 2 to add, 0 to change, 0 to destroy.\n' };
        if (cmd === 'az') return { stdout: JSON.stringify({ id: 'x', user: { name: 'me@example.com' } }) };
        throw new Error(`unexpected apply call after decline: ${cmd} ${args.join(' ')}`);
      };
      const io = makeIo({ confirm: async () => false });
      const state = { deploymentName: 'cc-main', region: 'eastus2', infra: { azureSubscriptionId: 'sub-123', lbEnabled: true } };
      const result = await provisionAzureKeyVaultOnly({
        state, io, deployDir, execImpl, spawnImpl: fakeSpawnFactory(),
      });
      assert.strictEqual(result.aborted, true);
    } finally {
      await rm(deployDir, { recursive: true, force: true });
    }
  });

  it('aborts cleanly when terraform init fails', async () => {
    const deployDir = await makeDeployDir();
    try {
      const execImpl = async (cmd, args) => {
        if (cmd === 'terraform' && args[0] === 'init') throw new Error('no azurerm provider credentials');
        if (cmd === 'az') return { stdout: JSON.stringify({ id: 'x', user: { name: 'me@example.com' } }) };
        throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
      };
      const io = makeIo();
      const state = { deploymentName: 'cc-main', region: 'eastus2', infra: { azureSubscriptionId: 'sub-123', lbEnabled: true } };
      const result = await provisionAzureKeyVaultOnly({ state, io, deployDir, execImpl, spawnImpl: fakeSpawnFactory() });
      assert.strictEqual(result.aborted, true);
    } finally {
      await rm(deployDir, { recursive: true, force: true });
    }
  });

  it('aborts cleanly when the targeted apply itself fails', async () => {
    const deployDir = await makeDeployDir();
    try {
      const execImpl = async (cmd, args) => {
        if (cmd === 'terraform' && args[0] === 'init') return { stdout: '' };
        if (cmd === 'terraform' && args[0] === 'plan') return { stdout: 'Plan: 2 to add, 0 to change, 0 to destroy.\n' };
        if (cmd === 'az') return { stdout: JSON.stringify({ id: 'x', user: { name: 'me@example.com' } }) };
        throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
      };
      const io = makeIo();
      const state = { deploymentName: 'cc-main', region: 'eastus2', infra: { azureSubscriptionId: 'sub-123', lbEnabled: true } };
      const result = await provisionAzureKeyVaultOnly({
        state, io, deployDir, execImpl, spawnImpl: fakeSpawnFactory({ exitCode: 1, stdoutChunks: ['Error: 403 Forbidden\n'] }),
      });
      assert.strictEqual(result.aborted, true);
    } finally {
      await rm(deployDir, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  CLEAN_TARGETS,
  tfStateHasLiveResources,
  buildCleanPlan,
  performClean,
} from '../lib/clean.mjs';

describe('clean.mjs', () => {
  let repoRoot;
  let deployDir;
  let dockerDir;

  beforeEach(async () => {
    // Mirror the layout cc.mjs uses at runtime (deploy/, docker/production/,
    // deploy/terraform/aws/<topology>/) so the path math in CLEAN_TARGETS
    // resolves exactly as it does for a real repo.
    repoRoot = await mkdtemp(join(tmpdir(), 'cc-clean-repo-'));
    deployDir = join(repoRoot, 'deploy');
    dockerDir = join(repoRoot, 'docker', 'production');
    await mkdir(join(deployDir, 'terraform', 'aws', 'single-node'), { recursive: true });
    await mkdir(join(deployDir, 'terraform', 'aws', 'multi-node'), { recursive: true });
    await mkdir(dockerDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  describe('tfStateHasLiveResources', () => {
    it('reports not-live when resources array is empty', async () => {
      const p = join(repoRoot, 'tfstate.json');
      await writeFile(p, JSON.stringify({ version: 4, resources: [] }));
      const result = await tfStateHasLiveResources(p);
      assert.strictEqual(result.live, false);
      assert.strictEqual(result.resourceCount, 0);
      assert.strictEqual(result.unreadable, false);
    });

    it('reports live when resources array is non-empty', async () => {
      const p = join(repoRoot, 'tfstate.json');
      await writeFile(p, JSON.stringify({
        version: 4,
        resources: [{ type: 'aws_instance', name: 'app', instances: [{}] }],
      }));
      const result = await tfStateHasLiveResources(p);
      assert.strictEqual(result.live, true);
      assert.strictEqual(result.resourceCount, 1);
    });

    it('treats unparseable state as live (fail-safe)', async () => {
      const p = join(repoRoot, 'tfstate.json');
      await writeFile(p, 'this is not json {{{');
      const result = await tfStateHasLiveResources(p);
      assert.strictEqual(result.live, true);
      assert.strictEqual(result.unreadable, true);
    });

    it('treats state without a resources array as live (fail-safe)', async () => {
      const p = join(repoRoot, 'tfstate.json');
      await writeFile(p, JSON.stringify({ version: 4 }));
      const result = await tfStateHasLiveResources(p);
      assert.strictEqual(result.live, true);
      assert.strictEqual(result.unreadable, true);
    });
  });

  describe('buildCleanPlan', () => {
    it('lists every expected kind from CLEAN_TARGETS', () => {
      const kinds = new Set(CLEAN_TARGETS.map((t) => t.kind));
      for (const required of ['state', 'credentials', 'secrets', 'env', 'tfvars', 'tfstate', 'tfstate-backup', 'tf-dir', 'tf-lock']) {
        assert.ok(kinds.has(required), `CLEAN_TARGETS missing required kind: ${required}`);
      }
    });

    it('reports no live tfstate when nothing is on disk', async () => {
      const plan = await buildCleanPlan({ repoRoot });
      assert.strictEqual(plan.hasLiveTfState, false);
      assert.strictEqual(plan.items.filter((i) => i.exists).length, 0);
    });

    it('flags a non-empty tfstate as live', async () => {
      const singleNode = join(deployDir, 'terraform', 'aws', 'single-node');
      await writeFile(join(singleNode, 'terraform.tfstate'), JSON.stringify({
        version: 4,
        resources: [{ type: 'aws_instance', name: 'app', instances: [{}] }],
      }));
      const plan = await buildCleanPlan({ repoRoot });
      assert.strictEqual(plan.hasLiveTfState, true);
      assert.strictEqual(plan.liveTfStateDetails.length, 1);
      assert.strictEqual(plan.liveTfStateDetails[0].resourceCount, 1);
      const tfstateItem = plan.items.find((i) => i.kind === 'tfstate' && i.exists);
      assert.strictEqual(tfstateItem.tfStateCheck.live, true);
    });

    it('flags a non-empty HA tfstate as live', async () => {
      const multiNode = join(deployDir, 'terraform', 'aws', 'multi-node');
      await writeFile(join(multiNode, 'terraform.tfstate'), JSON.stringify({
        version: 4,
        resources: [{ type: 'aws_instance', name: 'a', instances: [{}] }, { type: 'aws_lb', name: 'b', instances: [{}] }],
      }));
      const plan = await buildCleanPlan({ repoRoot });
      assert.strictEqual(plan.hasLiveTfState, true);
      assert.strictEqual(plan.liveTfStateDetails[0].resourceCount, 2);
    });
  });

  describe('performClean', () => {
    it('copies every existing item into a timestamped backup, then removes the originals', async () => {
      await writeFile(join(deployDir, '.cc-state.json'), '{"version":2,"target":"local"}');
      await writeFile(join(deployDir, '.cc-credentials.txt'), 'placeholder');
      await writeFile(join(dockerDir, '.env'), 'POSTGRES_PASSWORD=placeholder');

      const plan = await buildCleanPlan({ repoRoot });
      const result = await performClean({ items: plan.items, deployDir, repoRoot, now: new Date('2026-07-06T14:30:00Z') });

      assert.strictEqual(result.movedCount, 3);
      assert.ok(result.backupDir.includes('backup_20260706_'), 'backup dir should embed timestamp');
      // Originals are gone
      assert.strictEqual(existsSync(join(deployDir, '.cc-state.json')), false);
      assert.strictEqual(existsSync(join(deployDir, '.cc-credentials.txt')), false);
      assert.strictEqual(existsSync(join(dockerDir, '.env')), false);
      // Backups exist with the same content
      const backupState = JSON.parse(await readFile(join(result.backupDir, 'deploy/.cc-state.json'), 'utf8'));
      assert.strictEqual(backupState.target, 'local');
      assert.strictEqual(await readFile(join(result.backupDir, 'deploy/.cc-credentials.txt'), 'utf8'), 'placeholder');
      assert.strictEqual(await readFile(join(result.backupDir, 'docker/production/.env'), 'utf8'), 'POSTGRES_PASSWORD=placeholder');
    });

    it('handles a single topology with a live terraform.tfstate + .terraform dir', async () => {
      const singleNode = join(deployDir, 'terraform', 'aws', 'single-node');
      await writeFile(join(singleNode, 'terraform.tfstate'), JSON.stringify({
        version: 4,
        resources: [{ type: 'aws_instance', name: 'app', instances: [{}] }],
      }));
      await writeFile(join(singleNode, 'terraform.tfstate.backup'), '{"version":4,"resources":[]}');
      await writeFile(join(singleNode, 'cc.auto.tfvars.json'), '{"deployment_name":"cc-x"}');
      await writeFile(join(singleNode, '.terraform.lock.hcl'), '# lockfile');
      await mkdir(join(singleNode, '.terraform'), { recursive: true });
      await writeFile(join(singleNode, '.terraform', 'terraform.tfstate'), 'cached');

      const plan = await buildCleanPlan({ repoRoot });
      const result = await performClean({ items: plan.items, deployDir, repoRoot });

      assert.ok(result.movedCount >= 5, `expected >=5 backed-up items, got ${result.movedCount}`);
      assert.strictEqual(existsSync(join(singleNode, 'terraform.tfstate')), false);
      assert.strictEqual(existsSync(join(singleNode, 'terraform.tfstate.backup')), false);
      assert.strictEqual(existsSync(join(singleNode, 'cc.auto.tfvars.json')), false);
      assert.strictEqual(existsSync(join(singleNode, '.terraform.lock.hcl')), false);
      assert.strictEqual(existsSync(join(singleNode, '.terraform')), false);
      // Backup preserves the .terraform directory tree (verifies recursive copy)
      const backedUpTfDir = join(result.backupDir, 'deploy/terraform/aws/single-node/.terraform');
      assert.ok(existsSync(backedUpTfDir));
      assert.strictEqual(await readFile(join(backedUpTfDir, 'terraform.tfstate'), 'utf8'), 'cached');
    });

    it('two consecutive runs do not collide (each gets its own timestamped dir)', async () => {
      await writeFile(join(deployDir, '.cc-state.json'), 'first');
      const plan1 = await buildCleanPlan({ repoRoot });
      const result1 = await performClean({ items: plan1.items, deployDir, repoRoot, now: new Date('2026-07-06T14:30:00Z') });

      // Re-create the file so the second run has something to clean
      await writeFile(join(deployDir, '.cc-state.json'), 'second');
      const plan2 = await buildCleanPlan({ repoRoot });
      const result2 = await performClean({ items: plan2.items, deployDir, repoRoot, now: new Date('2026-07-06T14:35:00Z') });

      assert.notStrictEqual(result1.backupDir, result2.backupDir);
      const entries = await readdir(join(deployDir, '.cc-backups'));
      assert.ok(entries.length >= 2, 'both backups should coexist on disk');
    });

    it('no-op when nothing exists: returns movedCount=0', async () => {
      const plan = await buildCleanPlan({ repoRoot });
      const result = await performClean({ items: plan.items, deployDir, repoRoot });
      assert.strictEqual(result.movedCount, 0);
    });
  });
});

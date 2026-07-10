import { readFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// `cc clean` resets a deploy/ checkout to a brand-new-clone state, without
// requiring the user to know every file the wizard leaves behind across a
// local run (.cc-state.json, .cc-credentials.txt, .cc-telnyx-secrets.json,
// .env, .cc-tunnel.log) and an AWS run (cc.auto.tfvars.json, terraform.tfstate
// [+ .backup], .terraform/, .terraform.lock.hcl in each Terraform root).
//
// Design: this NEVER deletes outright. Every existing target is copied into
// a single timestamped backup folder (deploy/.cc-backups/backup_<ts>/,
// mirroring each file's path relative to the repo root) and only then
// removed from its original location — so a user who ran `cc clean` by
// reflex and actually wanted `cc destroy` first can still recover
// everything (including, critically, the Terraform state needed to tear
// down real AWS resources).

// All paths are relative to the repo root (one level above deploy/).
export const CLEAN_TARGETS = [
  { relPath: 'deploy/.cc-state.json', kind: 'state' },
  { relPath: 'deploy/.cc-credentials.txt', kind: 'credentials' },
  { relPath: 'deploy/.cc-telnyx-secrets.json', kind: 'secrets' },
  { relPath: 'deploy/.cc-tunnel.log', kind: 'log' },
  { relPath: 'deploy/cc.answers.json', kind: 'answers' },
  { relPath: 'docker/production/.env', kind: 'env' },
  ...['single-node', 'multi-node'].flatMap((topology) => [
    { relPath: `deploy/terraform/aws/${topology}/cc.auto.tfvars.json`, kind: 'tfvars' },
    { relPath: `deploy/terraform/aws/${topology}/terraform.tfstate`, kind: 'tfstate', topology },
    { relPath: `deploy/terraform/aws/${topology}/terraform.tfstate.backup`, kind: 'tfstate-backup' },
    { relPath: `deploy/terraform/aws/${topology}/.terraform.lock.hcl`, kind: 'tf-lock' },
    { relPath: `deploy/terraform/aws/${topology}/.terraform`, kind: 'tf-dir', isDir: true },
  ]),
];

/**
 * Reads a terraform.tfstate file and reports whether it still tracks any
 * real resources. A state file with an empty `resources` array is safe to
 * throw away (nothing to orphan); a non-empty one means real AWS
 * infrastructure may still exist that only this file knows how to find and
 * destroy. Unparseable/unexpected content is treated as "live" — fail safe,
 * never silently wave through a state file we can't actually verify.
 */
export async function tfStateHasLiveResources(absPath) {
  try {
    const raw = await readFile(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.resources)) return { live: true, resourceCount: null, unreadable: true };
    return { live: parsed.resources.length > 0, resourceCount: parsed.resources.length, unreadable: false };
  } catch {
    return { live: true, resourceCount: null, unreadable: true };
  }
}

/**
 * Scans CLEAN_TARGETS against disk and returns which ones actually exist,
 * plus a rollup of any `terraform.tfstate` files that still reference live
 * resources (so the caller can gate the destructive move behind an extra
 * warning instead of silently orphaning real AWS infra).
 */
export async function buildCleanPlan({ repoRoot }) {
  const items = [];
  const liveTfStateDetails = [];
  for (const target of CLEAN_TARGETS) {
    const absPath = join(repoRoot, target.relPath);
    const exists = existsSync(absPath);
    const item = { ...target, absPath, exists };
    if (exists && target.kind === 'tfstate') {
      const check = await tfStateHasLiveResources(absPath);
      item.tfStateCheck = check;
      if (check.live) liveTfStateDetails.push({ relPath: target.relPath, ...check });
    }
    items.push(item);
  }
  return { items, hasLiveTfState: liveTfStateDetails.length > 0, liveTfStateDetails };
}

function backupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Copies every existing item into deploy/.cc-backups/backup_<timestamp>/
 * (preserving its path relative to the repo root) and only removes the
 * original once the copy has landed — so an interrupted/failed copy never
 * leaves the user with neither a backup nor the original file.
 */
export async function performClean({ items, deployDir, repoRoot, now = new Date() }) {
  const existing = items.filter((i) => i.exists);
  const timestamp = backupTimestamp(now);
  const backupDir = join(deployDir, '.cc-backups', `backup_${timestamp}`);
  await mkdir(backupDir, { recursive: true });

  const movedPaths = [];
  for (const item of existing) {
    const dest = join(backupDir, item.relPath);
    await mkdir(dirname(dest), { recursive: true });
    await cp(item.absPath, dest, { recursive: true });
    // Verify the copy landed before touching the original.
    await stat(dest);
    await rm(item.absPath, { recursive: true, force: true });
    movedPaths.push(item.relPath);
  }

  return { backupDir, movedCount: movedPaths.length, movedPaths };
}

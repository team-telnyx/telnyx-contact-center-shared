import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFileCb);

// Thin driver around the `terraform` CLI for every cloud target (AWS
// single-node + multi-node, GCP single-node — Phase 3, any future
// provider root that follows the same layout). Mirrors compose.mjs's
// shape: real process execution goes through injectable
// `execImpl`/`spawnImpl` so wizard.mjs's orchestration logic (and this
// module's own tests) never actually shell out to a real `terraform`
// binary unless explicitly running an integration test against a
// throwaway cloud account.
//
// Design choices:
//   - tfvars are written as a `.auto.tfvars.json` file, NOT interpolated HCL
//     strings. JSON needs no HCL-string-escaping (quotes, ${...} interpolation
//     syntax, etc.) and Terraform natively merges any `*.auto.tfvars.json` file
//     in the working directory without an explicit `-var-file` flag.
//   - `apply`/`destroy` always pass `-auto-approve` at the terraform-CLI level
//     — the *wizard* is responsible for getting real user confirmation first
//     (plan preview + explicit y/N, per the existing Step 6 UX and the
//     double-confirm on destroy). This module never prompts by itself; it's
//     a pure command runner.
//   - Progress streaming: `apply`/`destroy` run via `spawnImpl` (not execFile)
//     so stdout can be forwarded line-by-line to an `onLine` callback for the
//     wizard's spinner/longStep UI, since a `terraform apply` can run for
//     several minutes with no output otherwise.

export function tfvarsPath(dir) {
  return join(dir, 'cc.auto.tfvars.json');
}

/**
 * Writes the wizard's answers as a `cc.auto.tfvars.json` file inside the
 * given Terraform root directory. `vars` should already be the exact
 * variable-name -> value map the root's variables.tf expects — this
 * function does no key translation, keeping that mapping visible and
 * testable at the call site (aws-single-node.mjs / aws-multi-node.mjs
 * wizard glue) rather than hidden inside a generic writer.
 */
export async function writeTfvars(dir, vars, { writeFileImpl = writeFile, mkdirImpl = mkdir } = {}) {
  await mkdirImpl(dir, { recursive: true });
  const path = tfvarsPath(dir);
  await writeFileImpl(path, `${JSON.stringify(vars, null, 2)}\n`, 'utf8');
  return path;
}

export async function terraformInit({ cwd, execImpl = execFileAsync } = {}) {
  return execImpl('terraform', ['init', '-input=false', '-no-color'], { cwd, maxBuffer: 1024 * 1024 * 32 });
}

/**
 * Runs `terraform plan -out=<planfile>` and returns both the raw stdout (for
 * the wizard to optionally display) and a resource-count summary parsed from
 * the standard "Plan: N to add, M to change, K to destroy." line, so the
 * wizard's Step 6 preview can show a one-line count without the user having
 * to read the full plan output.
 *
 * `destroy: true` runs `terraform plan -destroy` instead — used by `cc
 * destroy` to show the user exactly what will be torn down before they
 * confirm, mirroring the same preview-then-confirm UX Step 6 already uses
 * for creation.
 */
export async function terraformPlan({
  cwd, planFile = 'cc.tfplan', destroy = false, targets = [], execImpl = execFileAsync,
} = {}) {
  const args = ['plan', '-input=false', '-no-color', `-out=${planFile}`];
  if (destroy) args.splice(1, 0, '-destroy');
  // `-target` scopes the plan (and the apply that later replays this exact
  // plan file) to only the named resources/modules PLUS whatever they
  // transitively depend on — Terraform resolves that dependency graph
  // itself, so passing e.g. just 'module.secrets' automatically pulls in
  // the resource group it depends on without listing it explicitly. Used
  // by Azure's Key Vault bootstrap pass (see azure-cloud.mjs's
  // provisionAzureKeyVaultOnly) to create ONLY the Resource Group + Key
  // Vault ahead of the certificate step, instead of the full stack.
  for (const target of targets) args.push('-target', target);
  const { stdout } = await execImpl(
    'terraform',
    args,
    { cwd, maxBuffer: 1024 * 1024 * 32 },
  );
  return { stdout, summary: parsePlanSummary(stdout), planFile };
}

export function parsePlanSummary(stdout) {
  const match = String(stdout || '').match(
    /Plan:\s*(\d+)\s*to add,\s*(\d+)\s*to change,\s*(\d+)\s*to destroy/,
  );
  if (match) {
    return { toAdd: Number(match[1]), toChange: Number(match[2]), toDestroy: Number(match[3]) };
  }
  if (/No changes\. Your infrastructure matches the configuration\./.test(String(stdout || ''))) {
    return { toAdd: 0, toChange: 0, toDestroy: 0 };
  }
  return null;
}

// Strips the module path + resource type prefix off a terraform resource
// address for display, e.g. "module.database.azurerm_postgresql_flexible_server.main"
// -> "postgresql flexible server", "module.compute.azurerm_application_gateway.app[0]"
// -> "application gateway". Operators care about WHAT is being created
// ("the database", "the Application Gateway"), not the internal Terraform
// resource type/address — this humanizes provider-prefixed resource types
// (azurerm_/aws_/google_) into plain words. Falls back to the raw address
// (module path stripped only) if the resource type doesn't match the
// provider-prefix pattern, so unexpected/future resource types still show
// something reasonable instead of being silently dropped.
export function humanizeResourceAddress(address) {
  const withoutIndex = String(address || '').replace(/\[\d+\]$/, '');
  const parts = withoutIndex.split('.');
  // Address shapes: "azurerm_foo.bar", "module.x.azurerm_foo.bar",
  // "module.x.module.y.azurerm_foo.bar" — the resource TYPE is always the
  // second-to-last dot-segment.
  const resourceType = parts.length >= 2 ? parts[parts.length - 2] : withoutIndex;
  const stripped = resourceType.replace(/^(azurerm|aws|google|google-beta|random|tls|null|local|time)_/, '');
  if (stripped === resourceType) return withoutIndex; // no known provider prefix — show the full address, don't guess
  return stripped.replace(/_/g, ' ');
}

// Line-oriented filter that condenses a raw `terraform apply`/`destroy`
// stdout stream (which repeats "Still creating... [Ns elapsed]" once per
// second PER resource, and dumps a full "Creating..."/"Creation complete
// after Ns [id=...]" pair for every single resource — 30+ resources on a
// typical Azure/AWS/GCP apply) into a small number of human-relevant
// lines: one the first time each resource starts, one when it finishes
// (success or failure), and passthrough for anything that looks like a
// warning/error/plan-drift notice the operator should actually read.
// Returns null for a line that should be suppressed entirely (the
// "Still creating..." heartbeat spam) — callers should skip forwarding
// null results to onLine/io.log rather than printing an empty line.
//
// Deliberately stateful per invocation (the returned function closes over
// a Set of already-announced resource addresses) so repeat "Creating..."
// lines for the SAME resource (which terraform doesn't normally emit, but
// -target reruns or retried applies theoretically could) don't re-announce.
export function createTerraformLineFilter() {
  const announced = new Set();
  return function filterLine(rawLine) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Heartbeat spam — the single biggest source of noise (can repeat
    // 50+ times for a single slow resource like Postgres Flexible Server
    // or an Application Gateway). Always suppressed. Covers every phase
    // terraform reports progress on: creating/destroying/modifying (the
    // apply/destroy phase) AND refreshing (the pre-flight state-refresh
    // phase every apply/destroy starts with).
    if (/:\s*Still (creating|destroying|modifying)\.\.\./.test(trimmed)) return null;
    if (/:\s*Still refreshing state\.\.\./.test(trimmed)) return null;

    // "Refreshing state..." — terraform's pre-flight step (both apply AND
    // destroy start with this) that re-reads the CURRENT cloud state of
    // every resource already in the .tfstate file before computing a
    // diff/destroy plan. One line per resource, each with the full
    // Azure/AWS/GCP resource id — on a 32-resource stack that's 32 lines
    // of noise before any actual create/destroy work has even started.
    // Same suppression treatment as "Still creating..." — the longStep
    // spinner's own "Applying terraform destroy..." label + elapsed timer
    // already tells the operator something is happening.
    if (/:\s*Refreshing state\.\.\./.test(trimmed)) return null;

    // Data source reads ("data.azurerm_client_config.current: Reading..." /
    // "...: Read complete after 1s [id=...]") — happen during refresh on
    // both apply and destroy, same noise profile as Refreshing state above
    // (one pair per data source, full resource id, zero actionable info
    // for the operator).
    if (/:\s*Reading\.\.\./.test(trimmed)) return null;
    if (/:\s*Read complete after \S+/.test(trimmed)) return null;

    // Standalone "(still running — ...)" hints already come from longStep's
    // own threshold logic (ui.mjs), not from terraform's stdout — nothing
    // to do here, but guard against double-printing if a future terraform
    // version ever emits similar text verbatim.
    if (/^\(still running/i.test(trimmed)) return null;

    // BUG FIX (reported live by user on PR #1206): unlike `apply`'s
    // "X: Creating..." lines (no suffix), terraform's `destroy` phase
    // appends the resource id directly onto the SAME line —
    // "X: Destroying... [id=/subscriptions/.../A/ws.cc-azure]" — so the
    // previous regex, anchored with a hard `\.\.\.$` right after the verb,
    // never matched a real destroy run and every "Destroying..." line fell
    // through unfiltered to the raw passthrough at the bottom, full
    // Azure/AWS/GCP resource id and all. Made the trailing `[id=...]`
    // optional (and captured-but-discarded) so both apply's bare
    // "Creating..." and destroy's "Destroying... [id=...]" match the same
    // regex.
    const creatingMatch = trimmed.match(/^([\w.[\]-]+):\s*(Creating|Destroying|Modifying)\.\.\.(?:\s*\[id=.*\])?$/);
    if (creatingMatch) {
      const [, address, verb] = creatingMatch;
      if (announced.has(address)) return null;
      announced.add(address);
      const verbLabel = verb === 'Creating' ? 'Creating' : verb === 'Destroying' ? 'Destroying' : 'Updating';
      return `  ${verbLabel}: ${humanizeResourceAddress(address)}`;
    }

    const completeMatch = trimmed.match(/^([\w.[\]-]+):\s*(Creation|Destruction|Modification) complete after (\S+)/);
    if (completeMatch) {
      const [, address, , duration] = completeMatch;
      return `  ✔ ${humanizeResourceAddress(address)} (${duration})`;
    }

    // Anything else (Error:, Warning:, "Apply complete!", "Plan:", blank
    // separators around a warning block, etc.) passes through unchanged —
    // these are the lines an operator actually needs to see.
    return line;
  };
}

/**
 * Streams `terraform apply` (or `destroy` via the `destroy` option) line by
 * line to `onLine` (used by the wizard to feed its longStep spinner /
 * progress log) and resolves with { exitCode, stdout }. Uses spawnImpl (not
 * execFileAsync) specifically so long-running applies don't block on a
 * single buffered promise with no intermediate feedback.
 */
export function streamTerraform({
  cwd,
  args,
  onLine = () => {},
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('terraform', args, { cwd });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let buffer = '';

    const flushLines = (chunk, isErr) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (isErr) stderr += `${line}\n`;
        else stdout += `${line}\n`;
        onLine(line, { stream: isErr ? 'stderr' : 'stdout' });
      }
    };

    child.stdout?.on('data', (data) => flushLines(data.toString('utf8'), false));
    child.stderr?.on('data', (data) => flushLines(data.toString('utf8'), true));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (buffer) {
        stdout += buffer;
        onLine(buffer, { stream: 'stdout' });
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function terraformApply({ cwd, planFile = 'cc.tfplan', onLine, spawnImpl = spawn } = {}) {
  const { exitCode, stdout, stderr } = await streamTerraform({
    cwd,
    args: ['apply', '-input=false', '-no-color', '-auto-approve', planFile],
    onLine,
    spawnImpl,
  });
  if (exitCode !== 0) {
    throw new Error(`terraform apply failed (exit ${exitCode}): ${stderr || stdout}`.slice(0, 4000));
  }
  return { stdout };
}

// BUG FIX (reported by user after PR #1204): this used to run
// `terraform destroy -auto-approve` with no plan file — which makes
// Terraform recompute the destroy plan FROM SCRATCH and print the full
// human-readable diff (the "# X will be destroyed" / '- resource "..." {
// ... }' blocks, with every attribute of every resource) before doing any
// actual teardown work. That's a completely different output phase from
// the "Destroying.../Still destroying.../Destruction complete" progress
// lines createTerraformLineFilter already handles, so all of it leaked
// through unfiltered as raw noise. `terraformApply` never had this problem
// because it always applies a previously-computed `planFile` (see the
// `terraform apply <planfile>` branch below) instead of letting `apply`
// recompute-and-reprint a plan on its own.
//
// Fix: mirror terraformApply's shape exactly — accept the destroy plan
// file already produced by terraformPlan({ destroy: true, ... }) (the
// wizard already computes and shows a summary of this plan pre-confirm,
// see destroyAzureInfra/destroyAwsInfra/destroyGcpInfra) and `apply` that
// saved plan file instead of re-running `destroy` blind. Applying a saved
// plan file — destroy-mode or not — never reprints the diff; it goes
// straight to the Destroying.../Destruction complete progress lines that
// the line filter already condenses.
export async function terraformDestroy({
  cwd, planFile = 'cc.tfplan', onLine, spawnImpl = spawn,
} = {}) {
  const args = ['apply', '-input=false', '-no-color', '-auto-approve', planFile];
  const { exitCode, stdout, stderr } = await streamTerraform({ cwd, args, onLine, spawnImpl });
  if (exitCode !== 0) {
    throw new Error(`terraform destroy failed (exit ${exitCode}): ${stderr || stdout}`.slice(0, 4000));
  }
  return { stdout };
}

/**
 * Lists every resource address currently tracked in the Terraform state
 * (`terraform state list`). Returns an empty array (not a throw) if the
 * state is empty/missing — same "never blocks the caller" contract as
 * cloud-status.mjs's terraformManagedResourceCount, which this
 * duplicates in miniature (kept separate since that one is status-only
 * and swallows errors into a log line, while this one is a building
 * block other flows branch on).
 */
export async function terraformStateList({ cwd, execImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execImpl('terraform', ['state', 'list'], { cwd, maxBuffer: 1024 * 1024 * 8 });
    return String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Removes a resource address from the Terraform state WITHOUT calling any
 * provider delete API (`terraform state rm`) — the CLI-level equivalent of
 * an in-config `deletion_policy = "ABANDON"` for a resource whose state was
 * written before that policy existed in the .tf source. Terraform's
 * destroy-time provider calls read `deletion_policy` (and everything else)
 * from the STATE, not the current .tf files — adding the field to source
 * later never retroactively updates state written by an earlier apply, so
 * existing deployments need this one-time state surgery instead. See
 * destroyGcpInfra's pre-destroy reconciliation step for the call site and
 * full rationale. Best-effort: a missing/already-gone address is not an
 * error (nothing to remove), matches `terraform state rm`'s own semantics.
 */
export async function terraformStateRm({ cwd, address, execImpl = execFileAsync } = {}) {
  if (!address) throw new Error('terraformStateRm requires { address }');
  try {
    await execImpl('terraform', ['state', 'rm', address], { cwd, maxBuffer: 1024 * 1024 * 4 });
    return { removed: true };
  } catch (err) {
    // "No matching objects found" (or similar) means it's already gone —
    // treat that as success, not failure, so callers can call this
    // unconditionally without pre-checking terraformStateList first.
    const msg = String(err?.stderr || err?.message || '');
    if (/no matching (object|resource)/i.test(msg)) return { removed: false, alreadyAbsent: true };
    throw err;
  }
}

/**
 * Parses `terraform output -json` into a plain { name: value } map (unwraps
 * the { value, type, sensitive } envelope terraform's JSON output uses).
 * Used after apply to pull instance IPs / ALB DNS name / bucket name /
 * secret ARNs into the wizard's state file (never secret VALUES — those stay
 * in Secrets Manager, see cc-secrets/cc-database modules).
 */
export async function terraformOutputs({ cwd, execImpl = execFileAsync } = {}) {
  const { stdout } = await execImpl('terraform', ['output', '-json', '-no-color'], { cwd, maxBuffer: 1024 * 1024 * 8 });
  const raw = JSON.parse(stdout || '{}');
  const result = {};
  for (const [key, entry] of Object.entries(raw)) {
    result[key] = entry?.value ?? null;
  }
  return result;
}

export async function terraformVersion({ execImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execImpl('terraform', ['version', '-json']);
    const parsed = JSON.parse(stdout);
    return parsed.terraform_version || null;
  } catch {
    // Older terraform (<0.14) doesn't support `-json` — fall back to parsing
    // the first line of plain `terraform version`.
    try {
      const { stdout } = await execImpl('terraform', ['version']);
      const match = String(stdout).match(/Terraform\s+v?([\d.]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
}

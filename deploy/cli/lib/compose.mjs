import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Thin wrapper around `docker compose` for the Local target, scoped to
// docker/production/compose.yaml. Kept as a small pure-ish module (all real
// process execution goes through `execImpl`) so wizard.mjs's orchestration
// logic can be tested without actually invoking Docker.

/**
 * Builds a `docker compose ...` argv. Supports one or more `--profile <name>`
 * flags (compose v2 repeats `--profile` to OR them) and an `excludeProfiles`
 * list rendered as `--profile no-<name>` (negative profiles ship in compose v2
 * 2.24+). The `excludeProfiles` form is what we use to *suppress* a service
 * (e.g. drop the bundled Postgres when the wizard is pointing at an existing one).
 */
export function composeArgs(subcommand, { profile, profiles, excludeProfiles } = {}) {
  const args = ['compose', '-f', 'compose.yaml'];
  // Back-compat: callers/tests still pass `profile: 'cloud'` (singular). Treat it
  // as the one-element `profiles` array; newer callers should pass `profiles: [...]`
  // (compose v2 supports repeated `--profile` for OR semantics).
  const include = Array.isArray(profiles) ? profiles : (profiles ? [profiles] : (profile ? [profile] : []));
  for (const p of include) args.push('--profile', p);
  const exclude = Array.isArray(excludeProfiles) ? excludeProfiles : (excludeProfiles ? [excludeProfiles] : []);
  for (const p of exclude) args.push('--profile', `no-${p}`);
  return [...args, ...subcommand];
}

export async function composeUp({ cwd, build = true, profiles, excludeProfiles, execImpl = execFileAsync } = {}) {
  const args = composeArgs(['up', '-d', ...(build ? ['--build'] : [])], { profiles, excludeProfiles });
  return execImpl('docker', args, { cwd });
}

export async function composeDown({ cwd, volumes = false, execImpl = execFileAsync } = {}) {
  const args = composeArgs(['down', ...(volumes ? ['-v'] : [])]);
  return execImpl('docker', args, { cwd });
}

export async function composeLogs({ cwd, follow = false, tail = 200, execImpl = execFileAsync } = {}) {
  const args = composeArgs(['logs', `--tail=${tail}`, ...(follow ? ['-f'] : [])]);
  return execImpl('docker', args, { cwd });
}

export async function composePs({ cwd, execImpl = execFileAsync } = {}) {
  const args = composeArgs(['ps', '--format', 'json']);
  return execImpl('docker', args, { cwd });
}

export function detectComposeBinary({ execImpl = execFileAsync } = {}) {
  // docker compose (v2 plugin) is required; legacy docker-compose (v1) is not
  // supported (v1 is EOL). Callers should surface preflight.checkDockerCompose's
  // failure to guide the user to upgrade rather than silently falling back.
  return execImpl('docker', ['compose', 'version']).then(() => true).catch(() => false);
}

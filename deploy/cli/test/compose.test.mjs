import assert from 'node:assert';
import { describe, it, before } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE_DIR = join(REPO_ROOT, 'docker', 'production');

let dockerComposeAvailable = false;

async function composeConfig(envOverrides = {}, { profile, localOverride = false } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'cc-compose-config-'));
  const workDir = join(tmp, 'production');
  await cp(COMPOSE_DIR, workDir, { recursive: true });
  await writeFile(join(workDir, '.env'), [
    'POSTGRES_DB=x',
    'POSTGRES_USER=x',
    'POSTGRES_PASSWORD=x',
    'COMPOSE_PROFILES=with-pg',
    ...Object.entries(envOverrides).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n'), 'utf8');
  const args = ['compose', '-f', 'compose.yaml'];
  if (localOverride) args.push('-f', 'compose.local.yaml');
  if (profile) args.push('--profile', profile);
  args.push('config');
  try {
    const { stdout } = await execFileAsync('docker', args, {
      cwd: workDir,
      env: { ...process.env, ...envOverrides },
    });
    return stdout;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('docker/production/compose.yaml parametrization', () => {
  before(async () => {
    try {
      await execFileAsync('docker', ['compose', 'version']);
      dockerComposeAvailable = true;
    } catch {
      dockerComposeAvailable = false;
    }
  });

  it('uses SCRAM for fresh bundled Postgres volumes and never configures trust', async () => {
    const source = await readFile(join(COMPOSE_DIR, 'compose.yaml'), 'utf8');
    const postgresBlock = source.slice(source.indexOf('  postgres:'), source.indexOf('\n  app:'));
    assert.match(postgresBlock, /POSTGRES_HOST_AUTH_METHOD:\s*scram-sha-256/);
    assert.match(postgresBlock, /POSTGRES_INITDB_ARGS:\s*["']--auth-host=scram-sha-256["']/);
    assert.doesNotMatch(postgresBlock, /POSTGRES_HOST_AUTH_METHOD:\s*trust/);
    assert.match(postgresBlock, /psql -h 127\.0\.0\.1/);
  });

  it('does not publish PostgreSQL from the base production compose file', async (t) => {
    const source = await readFile(join(COMPOSE_DIR, 'compose.yaml'), 'utf8');
    const postgresBlock = source.slice(source.indexOf('  postgres:'), source.indexOf('\n  app:'));
    assert.doesNotMatch(postgresBlock, /^\s+ports:/m);
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig();
    const renderedPostgres = rendered.slice(rendered.indexOf('  postgres:'), rendered.indexOf('\n  app:'));
    assert.doesNotMatch(renderedPostgres, /published:/);
  });

  it('publishes bundled PostgreSQL only on loopback through the Local override', async (t) => {
    const source = await readFile(join(COMPOSE_DIR, 'compose.local.yaml'), 'utf8');
    assert.match(source, /127\.0\.0\.1:\$\{POSTGRES_HOST_PORT:-5432\}:5432/);
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig({ POSTGRES_HOST_PORT: '55432' }, { localOverride: true });
    assert.match(rendered, /host_ip: 127\.0\.0\.1/);
    assert.match(rendered, /published: "55432"/);
  });

  it('defaults to named volumes (cc_media, cc_logs) when CC_MEDIA_PATH/CC_LOGS_PATH are unset', async (t) => {
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig({
      POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x',
      CC_MEDIA_PATH: '', CC_LOGS_PATH: '',
    });
    assert.match(rendered, /source: cc_media/);
    assert.match(rendered, /source: cc_logs/);
    assert.doesNotMatch(rendered, /\/home\/ubuntu\/apps\/media/);
  });

  it('regression: existing GMR/EC2 deployments setting CC_MEDIA_PATH/CC_LOGS_PATH keep their exact old bind-mount paths', async (t) => {
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig({
      POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x',
      CC_MEDIA_PATH: '/home/ubuntu/apps/media',
      CC_LOGS_PATH: '/home/ubuntu/apps/logs',
    });
    assert.match(rendered, /source: \/home\/ubuntu\/apps\/media/);
    assert.match(rendered, /source: \/home\/ubuntu\/apps\/logs/);
  });

  it('caddy service only appears under the cloud profile, not by default', async (t) => {
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const withoutProfile = await composeConfig({
      POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x', CC_DOMAIN: 'cc.example.com',
    });
    assert.doesNotMatch(withoutProfile, /telnyx-contact-center-caddy/);

    const withProfile = await composeConfig(
      { POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x', CC_DOMAIN: 'cc.example.com' },
      { profile: 'cloud' },
    );
    assert.match(withProfile, /telnyx-contact-center-caddy/);
  });

  it('CC_IMAGE lets a pre-built GHCR image replace the local build image name', async (t) => {
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig({
      POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x',
      CC_IMAGE: 'ghcr.io/team-telnyx/telnyx-contact-center:v1.2.3',
    });
    assert.match(rendered, /image: ghcr\.io\/team-telnyx\/telnyx-contact-center:v1\.2\.3/);
  });

  it('default image name is unchanged when CC_IMAGE is unset (no behavior change for existing deployments)', async (t) => {
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig({
      POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x',
    });
    assert.match(rendered, /image: telnyx-contact-center-prod/);
  });

  it('pins compose project name to telnyx-contact-center so docker compose -p ... matches container_name/CLI expectations', async (t) => {
    // Regression: without an explicit `name:`, docker compose v2 derives the
    // project name from the parent directory of compose.yaml
    // (`docker/production/` -> `production`). That breaks:
    //   - the legacy container_name: telnyx-contact-center-* contract (a stale
    //     `production-postgres-1` container ends up running instead of
    //     `telnyx-contact-center-postgres`)
    //   - users' existing CLI invocations like
    //     `docker compose -p telnyx-contact-center down -v` (no project named
    //     `telnyx-contact-center` exists)
    //   - the postgres volume ends up as `production_postgres_data` instead of
    //     the project-scoped name users expect.
    // Pinning `name:` to `telnyx-contact-center` re-establishes all three.
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig({
      POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x',
    });
    // First non-blank line of `docker compose config` is the project name.
    assert.match(rendered, /^name: telnyx-contact-center/m);
  });

  it('allows per-shell override via COMPOSE_PROJECT_NAME so multiple deployments can coexist', async (t) => {
    // Users on the same host who want a second CC deployment (different slug,
    // different port range) shouldn't be locked into the canonical project
    // name. The compose-level `name:` is the default but COMPOSE_PROJECT_NAME
    // in the env still overrides it — this test pins that escape hatch so a
    // future refactor that hard-codes `--project-name` in the CLI doesn't
    // quietly break it.
    if (!dockerComposeAvailable) return t.skip('docker compose not available in this environment');
    const rendered = await composeConfig(
      { POSTGRES_DB: 'x', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x', COMPOSE_PROJECT_NAME: 'cc-staging-2026-07' },
    );
    assert.match(rendered, /^name: cc-staging-2026-07/m);
  });
});

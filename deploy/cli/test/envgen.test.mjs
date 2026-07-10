import assert from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSampleEnvKeys,
  buildEnvValues,
  renderEnvFile,
  generateEnvFile,
  applyEnvUpdates,
} from '../lib/envgen.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_ENV_PATH = join(__dirname, '..', '..', '..', 'docker', 'production', 'sample.env');

async function loadSampleEnv() {
  return readFile(SAMPLE_ENV_PATH, 'utf8');
}

const baseAnswers = {
  telnyxApiKey: 'KEY_TEST_123',
  ownerEmail: 'owner@example.com',
  ownerPassword: '',
  baseUrl: 'https://cc.example.com',
};

describe('envgen.mjs', () => {
  it('parity: every KEY= in docker/production/sample.env has a default in buildEnvValues (real repo file)', async () => {
    const sampleEnvText = await loadSampleEnv();
    const sampleKeys = parseSampleEnvKeys(sampleEnvText);
    assert.ok(sampleKeys.length > 20, 'sanity check: sample.env should have plenty of keys');

    const { missingKeys } = buildEnvValues({ sampleKeys, answers: baseAnswers, target: 'local' });
    assert.deepStrictEqual(
      missingKeys,
      [],
      `envgen.mjs is missing defaults for: ${missingKeys.join(', ')} — add them to buildEnvValues()`,
    );
  });

  it('generateEnvFile throws instead of silently dropping unknown future keys', () => {
    const sampleEnvText = 'FUTURE_NEW_KEY=\nTELNYX_API_KEY=\n';
    assert.throws(
      () => generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' }),
      /FUTURE_NEW_KEY/,
    );
  });

  it('generateEnvFile fills required fields from wizard answers', () => {
    const sampleEnvText = [
      'TELNYX_API_KEY=',
      'DEFAULT_OWNER_EMAIL=owner@domain.com',
      'DEFAULT_OWNER_PASSWORD=',
      'NEXT_PUBLIC_BASE_URL=https://cc.domain.com',
    ].join('\n');
    const { content, values } = generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' });
    assert.match(content, /TELNYX_API_KEY=KEY_TEST_123/);
    assert.match(content, /DEFAULT_OWNER_EMAIL=owner@example\.com/);
    assert.match(content, /NEXT_PUBLIC_BASE_URL=https:\/\/cc\.example\.com/);
    assert.ok(values.DEFAULT_OWNER_PASSWORD.length >= 8, 'auto-generated password should be a real length');
  });

  it('auto-generates a password when ownerPassword is blank, and reuses a provided one otherwise', () => {
    const sampleEnvText = 'DEFAULT_OWNER_PASSWORD=\n';
    const auto = generateEnvFile({ sampleEnvText, answers: { ...baseAnswers, ownerPassword: '' }, target: 'local' });
    assert.ok(auto.values.DEFAULT_OWNER_PASSWORD.length > 0);

    const explicit = generateEnvFile({ sampleEnvText, answers: { ...baseAnswers, ownerPassword: 'MyChosenPass123' }, target: 'local' });
    assert.strictEqual(explicit.values.DEFAULT_OWNER_PASSWORD, 'MyChosenPass123');
  });

  it('returned generatedSecrets tracks auto-generated ownerPassword but not user-supplied one', () => {
    // The wizard surfaces these in the on-screen summary and writes them to
    // deploy/.cc-credentials.txt so the user can actually log in. Without
    // generatedSecrets, the auto-gen path leaves the user with no way to log
    // in. This test pins both directions so future refactors don't regress
    // either one.
    const sampleEnvText = 'DEFAULT_OWNER_PASSWORD=\n';

    const auto = generateEnvFile({ sampleEnvText, answers: { ...baseAnswers, ownerPassword: '' }, target: 'local' });
    assert.ok(auto.generatedSecrets.ownerPassword, 'auto-gen must surface ownerPassword in generatedSecrets');
    assert.strictEqual(auto.generatedSecrets.ownerPassword, auto.values.DEFAULT_OWNER_PASSWORD);
    assert.ok(auto.generatedSecrets.ownerPassword.length >= 8);

    const explicit = generateEnvFile({ sampleEnvText, answers: { ...baseAnswers, ownerPassword: 'MyChosenPass123' }, target: 'local' });
    assert.strictEqual(explicit.generatedSecrets.ownerPassword, undefined,
      'user-supplied password must NOT appear in generatedSecrets (would expose it in summary)');
  });

  it('POSTGRES_VOLUME_NAME comes from answers.postgresVolumeName and defaults to "main"', () => {
    // compose.yaml names the named volume cc-postgres-${POSTGRES_VOLUME_NAME}
    // so a fresh install on a host with no prior volume gets cc-postgres-main,
    // while a fresh install on a host with a stale main volume can pick any
    // other slug to bypass the old data.
    const sampleEnvText = 'POSTGRES_VOLUME_NAME=\n';

    const def = generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' });
    assert.strictEqual(def.values.POSTGRES_VOLUME_NAME, 'main');

    const named = generateEnvFile({ sampleEnvText, answers: { ...baseAnswers, postgresVolumeName: 'cc-prod-2026-07' }, target: 'local' });
    assert.strictEqual(named.values.POSTGRES_VOLUME_NAME, 'cc-prod-2026-07');
  });

  it('generates distinct secrets on every call (NEXTAUTH_SECRET, POSTGRES_PASSWORD, SECRETS_ENCRYPTION_KEY)', () => {
    const sampleEnvText = 'NEXTAUTH_SECRET=\nPOSTGRES_PASSWORD=\nSECRETS_ENCRYPTION_KEY=\n';
    const a = generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' });
    const b = generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' });
    assert.notStrictEqual(a.values.NEXTAUTH_SECRET, b.values.NEXTAUTH_SECRET);
    assert.notStrictEqual(a.values.POSTGRES_PASSWORD, b.values.POSTGRES_PASSWORD);
    assert.notStrictEqual(a.values.SECRETS_ENCRYPTION_KEY, b.values.SECRETS_ENCRYPTION_KEY);
  });

  it('renderEnvFile preserves comments, blank lines and key ordering from sample.env', () => {
    const sampleEnvText = [
      '# a comment',
      'FOO=',
      '',
      '# another comment',
      'BAR=old',
    ].join('\n');
    const rendered = renderEnvFile(sampleEnvText, { FOO: 'new-foo', BAR: 'new-bar' });
    assert.strictEqual(
      rendered,
      ['# a comment', 'FOO=new-foo', '', '# another comment', 'BAR=new-bar'].join('\n'),
    );
  });

  it('sets local target POSTGRES_HOST to the compose service name, not "localhost"', () => {
    // Regression: sample.env's own default (localhost) is wrong once the app
    // runs inside the compose network; envgen must override it for local target.
    const sampleEnvText = 'POSTGRES_HOST=localhost\n';
    const { values } = generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' });
    assert.strictEqual(values.POSTGRES_HOST, 'postgres');
  });

  it('quotes values containing spaces or special characters', () => {
    const sampleEnvText = 'FOO=';
    const rendered = renderEnvFile(sampleEnvText, { FOO: 'value with spaces' });
    assert.strictEqual(rendered, 'FOO="value with spaces"');
  });

  it('leaves Telnyx resource-id fields blank — those are filled by telnyx-bootstrap, not envgen', () => {
    const sampleEnvText = [
      'TELNYX_CALL_CONTROL_ID=',
      'TELNYX_SIP_CONNECTION_ID=',
      'TELNYX_OUTBOUND_VOICE_PROFILE=',
    ].join('\n');
    const { values } = generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' });
    assert.strictEqual(values.TELNYX_CALL_CONTROL_ID, '');
    assert.strictEqual(values.TELNYX_SIP_CONNECTION_ID, '');
    assert.strictEqual(values.TELNYX_OUTBOUND_VOICE_PROFILE, '');
  });

  describe('applyEnvUpdates (Telnyx-bootstrap in-place write)', () => {
    it('rewrites only the listed keys in place, preserving comments/blank lines/other values', () => {
      const existing = [
        '# header comment',
        'TELNYX_API_KEY=OLD',
        '',
        'NEXTAUTH_SECRET=keep-this',
        'TELNYX_CALL_CONTROL_ID=',
        'TELNYX_SIP_CONNECTION_ID=',
      ].join('\n');
      const { content, updatedKeys } = applyEnvUpdates(existing, {
        TELNYX_CALL_CONTROL_ID: 'app-123',
        TELNYX_SIP_CONNECTION_ID: 'conn-456',
      });
      assert.strictEqual(updatedKeys.length, 2);
      assert.match(content, /^# header comment/);
      assert.match(content, /TELNYX_API_KEY=OLD/);
      assert.match(content, /NEXTAUTH_SECRET=keep-this/);
      assert.match(content, /TELNYX_CALL_CONTROL_ID=app-123/);
      assert.match(content, /TELNYX_SIP_CONNECTION_ID=conn-456/);
    });

    it('appends keys that are not yet present in the file', () => {
      const existing = 'TELNYX_API_KEY=K\n';
      const { content, updatedKeys } = applyEnvUpdates(existing, { TELNYX_NEW_KEY: 'val' });
      assert.deepStrictEqual(updatedKeys, ['TELNYX_NEW_KEY']);
      assert.ok(content.endsWith('TELNYX_NEW_KEY=val\n') || content.endsWith('TELNYX_NEW_KEY=val'));
    });

    it('is idempotent — calling twice with the same updates does not double-append', () => {
      const initial = 'TELNYX_API_KEY=K\n';
      const first = applyEnvUpdates(initial, { TELNYX_NEW_KEY: 'v1' });
      const second = applyEnvUpdates(first.content, { TELNYX_NEW_KEY: 'v1' });
      assert.strictEqual(first.content, second.content);
    });

    it('returns the list of updated keys so the caller can log what changed', () => {
      const existing = 'A=1\nB=2\n';
      const { updatedKeys } = applyEnvUpdates(existing, { A: 'x', B: 'y' });
      assert.deepStrictEqual(updatedKeys.sort(), ['A', 'B']);
    });
  });

  describe('postgres wiring (bundled vs existing)', () => {
    const sampleEnvText = [
      'POSTGRES_HOST=localhost',
      'POSTGRES_PORT=5432',
      'POSTGRES_DB=contact_center',
      'POSTGRES_USER=contact_center',
      'POSTGRES_PASSWORD=',
      'POSTGRES_MODE=bundled',
      'POSTGRES_HOST_PORT=5432',
      'COMPOSE_PROFILES=with-pg',
    ].join('\n');

    it('bundled mode (default): POSTGRES_HOST=postgres (compose service), POSTGRES_MODE=bundled, COMPOSE_PROFILES=with-pg', () => {
      const { values } = generateEnvFile({ sampleEnvText, answers: baseAnswers, target: 'local' });
      assert.strictEqual(values.POSTGRES_HOST, 'postgres');
      assert.strictEqual(values.POSTGRES_PORT, '5432');
      assert.strictEqual(values.POSTGRES_MODE, 'bundled');
      assert.strictEqual(values.COMPOSE_PROFILES, 'with-pg');
      assert.strictEqual(values.POSTGRES_HOST_PORT, '5432');
    });

    it('existing mode: POSTGRES_HOST=user-supplied, COMPOSE_PROFILES=no-with-pg, password comes from existingPostgres', () => {
      const { values } = generateEnvFile({
        sampleEnvText,
        answers: baseAnswers,
        target: 'local',
        postgresMode: 'existing',
        existingPostgres: {
          host: 'localhost',
          port: 5433,
          user: 'leszek',
          password: 'dev-pg-pw',
          database: 'cc_dev',
        },
      });
      assert.strictEqual(values.POSTGRES_HOST, 'localhost');
      assert.strictEqual(values.POSTGRES_PORT, '5433');
      assert.strictEqual(values.POSTGRES_USER, 'leszek');
      assert.strictEqual(values.POSTGRES_PASSWORD, 'dev-pg-pw');
      assert.strictEqual(values.POSTGRES_DB, 'cc_dev');
      assert.strictEqual(values.POSTGRES_MODE, 'existing');
      assert.strictEqual(values.COMPOSE_PROFILES, 'no-with-pg');
    });

    it('existing mode: defaults host to host.docker.internal when the user did not supply one', () => {
      const { values } = generateEnvFile({
        sampleEnvText,
        answers: baseAnswers,
        target: 'local',
        postgresMode: 'existing',
        existingPostgres: { port: 5432, user: 'postgres', password: '' },
      });
      assert.strictEqual(values.POSTGRES_HOST, 'host.docker.internal');
      assert.strictEqual(values.COMPOSE_PROFILES, 'no-with-pg');
    });

    it('answers.postgresHostPort flows into POSTGRES_HOST_PORT when bundled + custom port chosen', () => {
      const { values } = generateEnvFile({
        sampleEnvText,
        answers: { ...baseAnswers, postgresHostPort: 5433 },
        target: 'local',
      });
      // .env values are always strings — number 5433 should be coerced.
      assert.strictEqual(values.POSTGRES_HOST_PORT, '5433');
      assert.strictEqual(values.POSTGRES_MODE, 'bundled');
    });
  });
});

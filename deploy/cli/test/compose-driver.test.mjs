import assert from 'node:assert';
import { describe, it } from 'node:test';
import { composeArgs, composeUp, composeDown, composeLogs } from '../lib/compose.mjs';

describe('compose.mjs', () => {
  it('composeArgs builds the base -f compose.yaml invocation', () => {
    assert.deepStrictEqual(composeArgs(['up', '-d']), ['compose', '-f', 'compose.yaml', 'up', '-d']);
  });

  it('composeArgs adds the Local-only override when requested', () => {
    assert.deepStrictEqual(
      composeArgs(['up', '-d'], { localOverride: true }),
      ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'up', '-d'],
    );
  });

  it('composeArgs adds --profile when requested', () => {
    assert.deepStrictEqual(
      composeArgs(['up', '-d'], { profile: 'cloud' }),
      ['compose', '-f', 'compose.yaml', '--profile', 'cloud', 'up', '-d'],
    );
  });

  it('composeUp includes the Local override and builds by default', async () => {
    let captured;
    const execImpl = async (cmd, args, opts) => { captured = { cmd, args, opts }; return { stdout: '' }; };
    await composeUp({ cwd: '/tmp/x', execImpl });
    assert.strictEqual(captured.cmd, 'docker');
    assert.deepStrictEqual(captured.args, ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'up', '-d', '--build']);
    assert.strictEqual(captured.opts.cwd, '/tmp/x');
  });

  it('composeUp skips --build when build:false (e.g. --image/GHCR path from Phase 3)', async () => {
    let captured;
    const execImpl = async (cmd, args) => { captured = args; return { stdout: '' }; };
    await composeUp({ cwd: '/tmp/x', build: false, execImpl });
    assert.deepStrictEqual(captured, ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'up', '-d']);
  });

  it('composeDown adds -v only when volumes:true (destructive, opt-in)', async () => {
    let captured;
    const execImpl = async (cmd, args) => { captured = args; return { stdout: '' }; };
    await composeDown({ cwd: '/tmp/x', execImpl });
    assert.deepStrictEqual(captured, ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'down']);

    await composeDown({ cwd: '/tmp/x', volumes: true, execImpl });
    assert.deepStrictEqual(captured, ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'down', '-v']);
  });

  it('composeLogs supports follow and tail options', async () => {
    let captured;
    const execImpl = async (cmd, args) => { captured = args; return { stdout: '' }; };
    await composeLogs({ cwd: '/tmp/x', follow: true, tail: 50, execImpl });
    assert.deepStrictEqual(captured, ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'logs', '--tail=50', '-f']);
  });

  it('composeArgs: profiles (array) adds repeated --profile flags', () => {
    assert.deepStrictEqual(
      composeArgs(['up', '-d'], { profiles: ['with-pg', 'tools'] }),
      ['compose', '-f', 'compose.yaml', '--profile', 'with-pg', '--profile', 'tools', 'up', '-d'],
    );
  });

  it('composeArgs: excludeProfiles emits `no-<name>` profiles (compose v2 negative profiles)', () => {
    assert.deepStrictEqual(
      composeArgs(['up', '-d'], { excludeProfiles: ['with-pg'] }),
      ['compose', '-f', 'compose.yaml', '--profile', 'no-with-pg', 'up', '-d'],
    );
  });

  it('composeUp(excludeProfiles): passes --profile no-<name> to suppress the bundled Postgres container', async () => {
    let captured;
    const execImpl = async (cmd, args, opts) => { captured = { cmd, args, opts }; return { stdout: '' }; };
    await composeUp({ cwd: '/tmp/x', execImpl, excludeProfiles: ['with-pg'] });
    assert.strictEqual(captured.cmd, 'docker');
    assert.deepStrictEqual(captured.args, ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', '--profile', 'no-with-pg', 'up', '-d', '--build']);
  });
});

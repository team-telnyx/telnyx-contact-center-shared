import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRoute } from './helpers/route-harness.mjs';

async function fixture() {
  const state = { user: { id: 'test-user', username: 'test@example.test', active: false, verified: true, auth_strategy: 'local', roles: ['agent'] }, writes: 0, provisioning: 0, sessions: 0, failLookup: false };
  const lookup = async () => { if (state.failLookup) throw new Error('database unavailable'); return state.user; };
  const providers = Object.fromEntries(['google', 'github', 'facebook', 'credentials'].map(provider => [`next-auth/providers/${provider}`, { default: options => ({ ...options, id: provider }) }]));
  const { authOptions } = await loadRoute('app/api/auth/[...nextauth]/route.js', {
    ...providers,
    'next-auth': { default: () => () => {} },
    '@/lib/nextauth-pg-adapter': { PostgresNextAuthAdapter: () => ({}) },
    '@/lib/pgdb': { PgDb: { findUserByUsername: lookup, findUserById: lookup, updateUserById: async () => { state.writes++; }, upsertUserByUsername: async () => { state.writes++; } } },
    '@/lib/auth': { verifyUserPassword: () => true },
    '@/lib/postgres.mjs': { getPostgresPool: () => ({ query: async () => ({ rows: [{ enabled: true }] }) }) },
    '@/lib/telnyx-credentials': { createUserTelephonyCredentials: async () => { state.provisioning++; return { id: 'credential' }; } },
    '@/lib/auth-logging.mjs': { authErrorPayload: () => ({}), authUserPayload: () => ({}), logAuthEvent: () => {}, normalizeAuthEmail: email => String(email || '').trim().toLowerCase() },
    '@/lib/auth-session-tracking.mjs': { completeTrackedLogout: async () => {}, openTrackedAuthSession: async () => { state.sessions++; return {}; } },
    '@/lib/authz/page-access-server.mjs': { authzSnapshotFor: async () => ({ screens: [] }) },
  });
  return { state, authOptions };
}

function assertNoEffects(state) {
  assert.deepEqual([state.writes, state.provisioning, state.sessions], [0, 0, 0]);
}

test('NextAuth credentials rejects inactive accounts before telephony provisioning', async () => {
  const { state, authOptions } = await fixture();
  const credentials = authOptions.providers.find(provider => provider.id === 'credentials');
  const input = { username: state.user.username, password: 'valid-test-password' };
  assert.equal(await credentials.authorize(input), null);
  assertNoEffects(state);
  state.user.active = true;
  state.user.telephony_credentials_id = 'existing-credential';
  assert.equal((await credentials.authorize(input)).id, state.user.id);
});

for (const provider of ['credentials', 'google', 'github', 'facebook']) {
  test(`NextAuth ${provider} sign-in rejects inactive accounts and lookup failures before writes`, async () => {
    const { state, authOptions } = await fixture();
    const input = { user: { id: state.user.id, email: state.user.username }, account: { provider }, profile: { email: state.user.username } };
    assert.equal(await authOptions.callbacks.signIn(input), false);
    assertNoEffects(state);
    state.user.active = true;
    assert.equal(await authOptions.callbacks.signIn(input), true);
    state.failLookup = true;
    assert.equal(await authOptions.callbacks.signIn(input), false);
    assertNoEffects(state);
  });
}

for (const oauth of [false, true]) {
  test(`NextAuth JWT rejects inactive accounts before provisioning or tracking (OAuth: ${oauth})`, async () => {
    const { state, authOptions } = await fixture();
    const token = { id: state.user.id, email: state.user.username };
    const input = { token, user: { id: state.user.id, email: state.user.username }, ...(oauth ? { account: { provider: 'google' }, profile: { email: state.user.username } } : {}) };
    assert.equal(await authOptions.callbacks.jwt(input), null);
    assertNoEffects(state);
    state.user.active = true;
    state.user.telephony_credentials_id = 'existing-credential';
    assert.equal((await authOptions.callbacks.jwt(input)).id, state.user.id);
    assert.equal(state.sessions, 1);
  });
}

for (const withEmail of [false, true]) {
  test(`NextAuth session rejects a disabled existing session (email lookup: ${withEmail})`, async () => {
    const { state, authOptions } = await fixture();
    const input = { session: { user: {} }, token: { id: state.user.id, ...(withEmail ? { email: state.user.username } : {}) } };
    assert.equal(await authOptions.callbacks.session(input), null);
    assertNoEffects(state);
    state.user.active = true;
    state.user.telephony_credentials_id = 'existing-credential';
    assert.equal((await authOptions.callbacks.session(input)).user.id, state.user.id);
  });
}

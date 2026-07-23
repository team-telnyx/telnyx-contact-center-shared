import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  auditCredentialConnection,
  repairCredentialConnection,
} from '../lib/telnyx-credential-connection-repair.mjs';

const API_KEY = 'KEY_TEST';
const BASE_PATH = 'https://api.telnyx.test';

function makeMock({ preference = null, ignorePatch = false } = {}) {
  const state = {
    connection: {
      id: 'conn/legacy 1',
      connection_name: 'legacy-contact-center',
      sip_uri_calling_preference: preference,
    },
    calls: [],
  };

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ url: String(url), method, body, headers: init.headers });
    if (method === 'PATCH' && !ignorePatch) {
      Object.assign(state.connection, body);
    }
    return new Response(JSON.stringify({ data: state.connection }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return { state, fetchImpl };
}

describe('legacy Telnyx Credential Connection audit/repair', () => {
  it('reports null/default preference as requiring repair without writing', async () => {
    const mock = makeMock();
    const result = await auditCredentialConnection({
      fetchImpl: mock.fetchImpl,
      basePath: BASE_PATH,
      apiKey: API_KEY,
      connectionId: mock.state.connection.id,
    });

    assert.strictEqual(result.compliant, false);
    assert.strictEqual(result.currentPreference, null);
    assert.strictEqual(result.requiredPreference, 'unrestricted');
    assert.deepStrictEqual(mock.state.calls.map((call) => call.method), ['GET']);
    assert.match(mock.state.calls[0].url, /conn%2Flegacy%201$/);
  });

  it('does not PATCH a connection that is already compliant', async () => {
    const mock = makeMock({ preference: 'unrestricted' });
    const result = await repairCredentialConnection({
      fetchImpl: mock.fetchImpl,
      basePath: BASE_PATH,
      apiKey: API_KEY,
      connectionId: mock.state.connection.id,
    });

    assert.strictEqual(result.outcome, 'already-compliant');
    assert.deepStrictEqual(mock.state.calls.map((call) => call.method), ['GET']);
  });

  it('PATCHes only sip_uri_calling_preference and verifies it with a fresh GET', async () => {
    const mock = makeMock({ preference: null });
    const result = await repairCredentialConnection({
      fetchImpl: mock.fetchImpl,
      basePath: `${BASE_PATH}/`,
      apiKey: API_KEY,
      connectionId: mock.state.connection.id,
    });

    assert.strictEqual(result.outcome, 'repaired');
    assert.strictEqual(result.after.compliant, true);
    assert.deepStrictEqual(mock.state.calls.map((call) => call.method), ['GET', 'PATCH', 'GET']);
    assert.deepStrictEqual(mock.state.calls[1].body, {
      sip_uri_calling_preference: 'unrestricted',
    });
    assert.strictEqual(mock.state.calls[1].headers.Authorization, `Bearer ${API_KEY}`);
  });

  it('fails when Telnyx accepts but silently ignores the PATCH', async () => {
    const mock = makeMock({ preference: null, ignorePatch: true });
    await assert.rejects(
      repairCredentialConnection({
        fetchImpl: mock.fetchImpl,
        basePath: BASE_PATH,
        apiKey: API_KEY,
        connectionId: mock.state.connection.id,
      }),
      /accepted the PATCH.*still null/,
    );
    assert.deepStrictEqual(mock.state.calls.map((call) => call.method), ['GET', 'PATCH', 'GET']);
  });

  it('surfaces Telnyx API errors with endpoint context', async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ errors: [{ detail: 'connection not found' }] }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
    await assert.rejects(
      auditCredentialConnection({
        fetchImpl,
        basePath: BASE_PATH,
        apiKey: API_KEY,
        connectionId: 'missing',
      }),
      /Telnyx API 404.*connection not found/,
    );
  });
});

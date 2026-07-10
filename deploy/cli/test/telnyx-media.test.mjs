import assert from 'node:assert';
import { describe, it } from 'node:test';
import { findMedia, upsertMedia, ensureMediaFiles } from '../lib/telnyx-media.mjs';

// Simple in-memory mock of the Telnyx Media Storage API (GET by name -> 404
// or 200, POST multipart upload -> 200), same shape/conventions as
// telnyx-bootstrap.test.mjs's makeTelnyxMock (see that file's header).
function makeMediaMock({ existing = [] } = {}) {
  const state = {
    media: existing.map((m) => ({ ...m })),
    callLog: [],
  };

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    state.callLog.push({ url: String(url), method });
    const u = new URL(url);

    if (method === 'GET' && u.pathname.startsWith('/v2/media/')) {
      const name = decodeURIComponent(u.pathname.split('/').pop());
      const found = state.media.find((m) => m.media_name === name);
      if (!found) return json(404, { errors: [{ detail: 'Not found' }] });
      return json(200, { data: found });
    }
    if (method === 'POST' && u.pathname === '/v2/media') {
      // init.body is a real FormData in these tests (Node's global FormData).
      const name = init.body.get('media_name');
      const created = { media_name: name, content_type: 'audio/mpeg' };
      state.media.push(created);
      return json(200, { data: created });
    }
    return json(404, { errors: [{ detail: `Mock has no default for ${method} ${u.pathname}` }] });
  }

  return { state, fetchImpl };
}

function json(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    clone() { return this; },
  };
}

const API_KEY = 'KEY_TEST_123';
const BASE = 'https://api.telnyx.com';
const fakeReadFile = async () => Buffer.from('fake mp3 bytes');

describe('telnyx-media.mjs', () => {
  describe('findMedia', () => {
    it('returns null when the media resource does not exist (404)', async () => {
      const mock = makeMediaMock();
      const result = await findMedia({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'spring_field' });
      assert.equal(result, null);
    });

    it('returns the resource data when it exists', async () => {
      const mock = makeMediaMock({ existing: [{ media_name: 'spring_field', content_type: 'audio/mpeg' }] });
      const result = await findMedia({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'spring_field' });
      assert.equal(result.media_name, 'spring_field');
    });

    it('throws when name is missing', async () => {
      await assert.rejects(() => findMedia({ fetchImpl: async () => {}, apiKey: API_KEY }));
    });
  });

  describe('upsertMedia', () => {
    it('uploads a new file when no existing media with that name is found', async () => {
      const mock = makeMediaMock();
      const result = await upsertMedia({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'spring_field', filePath: '/fake/spring_field.mp3', readFileImpl: fakeReadFile,
      });
      assert.equal(result.outcome, 'created');
      assert.equal(result.name, 'spring_field');
      assert.equal(mock.state.media.length, 1);
      const postCalls = mock.state.callLog.filter((c) => c.method === 'POST');
      assert.equal(postCalls.length, 1);
    });

    it('is idempotent — skips upload and returns "found" when media already exists', async () => {
      const mock = makeMediaMock({ existing: [{ media_name: 'spring_field', content_type: 'audio/mpeg' }] });
      const result = await upsertMedia({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'spring_field', filePath: '/fake/spring_field.mp3', readFileImpl: fakeReadFile,
      });
      assert.equal(result.outcome, 'found');
      assert.equal(mock.state.media.length, 1);
      const postCalls = mock.state.callLog.filter((c) => c.method === 'POST');
      assert.equal(postCalls.length, 0);
    });

    it('throws when name or filePath is missing', async () => {
      const mock = makeMediaMock();
      await assert.rejects(() => upsertMedia({ fetchImpl: mock.fetchImpl, apiKey: API_KEY, filePath: '/x.mp3' }));
      await assert.rejects(() => upsertMedia({ fetchImpl: mock.fetchImpl, apiKey: API_KEY, name: 'x' }));
    });
  });

  describe('ensureMediaFiles', () => {
    it('uploads all files in the list and returns a per-file outcome map', async () => {
      const mock = makeMediaMock();
      const files = [
        { name: 'spring_field', filePath: '/fake/spring_field.mp3' },
        { name: 'roa_haru', filePath: '/fake/roa_haru.mp3' },
        { name: 'sweet-dreams', filePath: '/fake/sweet-dreams.mp3' },
      ];
      const results = await ensureMediaFiles({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, files, readFileImpl: fakeReadFile,
      });
      assert.equal(Object.keys(results).length, 3);
      assert.equal(results.spring_field.outcome, 'created');
      assert.equal(results.roa_haru.outcome, 'created');
      assert.equal(results['sweet-dreams'].outcome, 'created');
      assert.equal(mock.state.media.length, 3);
    });

    it('continues past a single file failure and reports it as an error entry, without aborting the rest', async () => {
      const mock = makeMediaMock();
      const failingReadFile = async (path) => {
        if (path.includes('roa_haru')) throw new Error('disk read failed');
        return Buffer.from('fake mp3 bytes');
      };
      const files = [
        { name: 'spring_field', filePath: '/fake/spring_field.mp3' },
        { name: 'roa_haru', filePath: '/fake/roa_haru.mp3' },
        { name: 'sweet-dreams', filePath: '/fake/sweet-dreams.mp3' },
      ];
      const results = await ensureMediaFiles({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, files, readFileImpl: failingReadFile,
      });
      assert.equal(results.spring_field.outcome, 'created');
      assert.equal(results.roa_haru.outcome, 'error');
      assert.match(results.roa_haru.error, /disk read failed/);
      assert.equal(results['sweet-dreams'].outcome, 'created');
      // Only the two successful uploads actually hit the mock's media store.
      assert.equal(mock.state.media.length, 2);
    });

    it('returns an empty map when given no files', async () => {
      const mock = makeMediaMock();
      const results = await ensureMediaFiles({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, files: [] });
      assert.deepEqual(results, {});
    });
  });
});

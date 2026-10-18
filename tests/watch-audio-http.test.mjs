import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createHTTPAudio } from '../lib/watch-audio/http-audio.mjs';

async function fixture(t, maxBytes) {
  let client, calls = 0, uploads = 0;
  const bridge = createHTTPAudio({ authorized: req => req.headers.authorization === 'Bearer test',
    isBusy: () => client?.readyState === 1, maxBytes,
    connect: value => { client = value; calls++; value.on('message', () => uploads++); } });
  const server = http.createServer(async (req, res) => {
    if (!await bridge.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/watch-ai/session/`;
  const id = randomUUID();
  return { get client() { return client }, get calls() { return calls }, get uploads() { return uploads },
    request: (method, path = '', body, options = {}) => fetch(base + (options.id ?? id) + path, {
      method, headers: { Authorization: options.token ?? 'Bearer test', 'Content-Type': 'application/json', ...(options.window ? {'X-CC-Audio-Window':String(options.window)} : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) };
}
test('authentication, idempotent creation, concurrent call rejection and ended tombstone', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('PUT', '', undefined, { token: 'bad' })).status, 401);
  assert.equal(f.calls, 0);
  assert.equal((await f.request('PUT')).status, 201);
  assert.equal((await f.request('PUT')).status, 200);
  assert.equal(f.calls, 1);
  assert.equal((await f.request('PUT', '', undefined, { id: randomUUID() })).status, 409);
  assert.equal((await f.request('DELETE')).status, 204);
  assert.equal((await f.request('PUT')).status, 410);
});
test('cancel before creation prevents an orphan upstream call', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('DELETE')).status, 204);
  assert.equal((await f.request('PUT')).status, 410);
  assert.equal(f.calls, 0);
});
test('lost poll responses can be replayed until acknowledged, without losing later audio', async t => {
  const f = await fixture(t); await f.request('PUT');
  f.client.send(JSON.stringify({ type: 'session.created' }));
  f.client.send(JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }));
  const first = await (await f.request('GET', '/events?after=0')).json();
  assert.deepEqual(first.events.map(e => e.sequence), [1, 2]);
  assert.deepEqual(await (await f.request('GET', '/events?after=0')).json(), first);
  f.client.send(JSON.stringify({ type: 'response.done' }));
  const next = await (await f.request('GET', '/events?after=2')).json();
  assert.deepEqual(next.events.map(e => e.sequence), [3]);
  assert.equal((await f.request('GET', '/events?after=1')).status, 409);
  assert.equal((await f.request('GET', '/events?after=99')).status, 409);
});
test('upload retries are deduplicated and gaps rejected', async t => {
  const f = await fixture(t); await f.request('PUT');
  const input = { sequence: 1, frame: { type: 'input_audio_buffer.append', audio: 'AAAA' } };
  assert.equal((await f.request('POST', '/input', input)).status, 204);
  assert.equal((await f.request('POST', '/input', input)).status, 204);
  assert.equal(f.uploads, 1);
  assert.equal((await f.request('POST', '/input', { ...input, sequence: 3 })).status, 409);
  assert.equal((await f.request('POST', '/input', { ...input, sequence: 2 })).status, 204);
  assert.equal(f.uploads, 2);
});
test('bounded output queue terminates slow playback and clears audio', async t => {
  const f = await fixture(t, 100); await f.request('PUT');
  f.client.send(JSON.stringify({ type: 'audio', delta: 'a'.repeat(101) }));
  assert.equal(f.client.readyState, 3);
  assert.equal(f.client.bufferedAmount, 0);
  const ended = await (await f.request('GET', '/events?after=0')).json();
  assert.equal(ended.ended, true); assert.equal(ended.reason, 'Playback too slow');
  assert.deepEqual(ended.events, []);
});
test('long poll wakes on audio and rejects simultaneous poll', async t => {
  const f = await fixture(t); await f.request('PUT');
  const poll = f.request('GET', '/events?after=0');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.request('GET', '/events?after=0')).status, 409);
  f.client.send(JSON.stringify({ type: 'session.created' }));
  assert.equal((await (await poll).json()).events.length, 1);
});

test('negotiated parallel uploads preserve order, deduplicate and bound the reorder window', async t => {
  const f = await fixture(t);
  const created=await f.request('PUT','',undefined,{window:4});
  assert.equal((await created.json()).inputWindow,4);
  const seen=[];f.client.on('message',data=>seen.push(JSON.parse(data).audio));
  const send=n=>f.request('POST','/input',{sequence:n,frame:{type:'input_audio_buffer.append',audio:String(n)}});
  assert.equal((await send(3)).status,204);assert.equal((await send(2)).status,204);
  assert.deepEqual(seen,[]);
  assert.equal((await send(5)).status,409);
  assert.equal((await send(1)).status,204);assert.deepEqual(seen,['1','2','3']);
  assert.equal((await send(2)).status,204);assert.deepEqual(seen,['1','2','3']);
  assert.equal((await send(4)).status,204);assert.deepEqual(seen,['1','2','3','4']);
});
test('missing parallel upload ends the stream rather than growing audio latency', async t => {
  const f=await fixture(t);await f.request('PUT','',undefined,{window:4});
  await f.request('POST','/input',{sequence:2,frame:{type:'input_audio_buffer.append',audio:'AAAA'}});
  await new Promise(resolve=>setTimeout(resolve,2100));
  assert.equal(f.client.readyState,3);assert.equal(f.uploads,0);
  assert.equal(f.client.inputs.size,0);
});

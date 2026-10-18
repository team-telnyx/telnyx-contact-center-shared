import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { issueAssistantCallSession, readAssistantCallSession, assistantCallSocketUrl, assistantCallSettings } from '../lib/ai/assistant-call-session.mjs';
import { createAssistantCallRelay } from '../lib/ai/assistant-call-relay.mjs';
const env = { NEXTAUTH_SECRET: 'test-secret-with-more-than-thirty-two-characters' }, origin = 'https://cc.example.com';
const assistant = { id: 'assistant-test', name: 'Controlled assistant', avatar_settings: null, voice_settings: { voice: 'Telnyx.Ultra.test' }, telephony_settings: { supports_unauthenticated_web_calls: false } };
const claims = { userId: 'operator', assistantId: assistant.id, avatar: null, origin };
const options = { env, now: 1000000 };

test('call authorization is purpose scoped, signed, short lived, and origin bound', () => {
  const token = issueAssistantCallSession(claims, options);
  assert.equal(readAssistantCallSession(token, origin, options).userId, 'operator');
  assert.throws(() => readAssistantCallSession(token, 'https://untrusted.example', options));
  assert.throws(() => readAssistantCallSession(token, origin, { ...options, now: 1120000 }));
  assert.throws(() => readAssistantCallSession(`${token}x`, origin, options));
  assert.throws(() => readAssistantCallSession(`${token}.extra`, origin, options));
  assert.throws(() => readAssistantCallSession(undefined, origin, options));
  assert.throws(() => issueAssistantCallSession(claims, { env: {} }));
  const forged = Buffer.from(JSON.stringify({ ...claims, assistantId: 'other' })).toString('base64url') + '.' + token.split('.')[1];
  assert.throws(() => readAssistantCallSession(forged, origin, options));
  assert.equal(assistantCallSocketUrl('https://cc.example.com/api/call', {}), 'wss://cc.example.com/ws/assistant-call');
  assert.equal(assistantCallSocketUrl('http://localhost:3000/api/call', { WS_BASE_URL: 'wss://tunnel-ws.example.com', STREAMING_WS_PORT: '3001' }, { pageOrigin: 'http://localhost:3000' }), 'ws://localhost:3001/assistant-call');
  assert.equal(assistantCallSocketUrl('http://localhost:3000/api/call', { WS_BASE_URL: 'wss://tunnel-ws.example.com' }, { pageOrigin: 'https://tunnel.example.com' }), 'wss://tunnel-ws.example.com/assistant-call');
});

async function harness(t, { avatar = false, authorize, readSession, heartbeatMs, request } = {}) {
  let upstream, opened = [], forwarded = [];
  const saved = { ...assistant, avatar_settings: avatar ? { provider: 'telnyx', model: 'foxtrot-1', avatar_id: 'elena', background_id: 'studio' } : null };
  const scoped = { ...claims, avatar: assistantCallSettings(saved).avatar };
  const token = issueAssistantCallSession(scoped, { env });
  const relay = createAssistantCallRelay({
    readSession: readSession || ((value, from) => readAssistantCallSession(value, from, { env })), authorize: authorize || (async () => {}), heartbeatMs,
    request: request || (async () => saved), apiKey: () => 'server-secret-never-sent-to-client',
    openUpstream: (url, options) => {
      opened.push({ url, options });
      upstream = new EventEmitter(); upstream.readyState = WebSocket.OPEN; upstream.bufferedAmount = 0;
      upstream.send = data => forwarded.push(JSON.parse(data)); upstream.close = () => {}; upstream.terminate = () => {};
      setImmediate(() => { upstream.emit('open'); upstream.emit('message', JSON.stringify({ type: 'session.created', session: { conversation_id: 'controlled-conversation' } })); });
      return upstream;
    },
  });
  const server = http.createServer(); server.on('upgrade', (req, socket, head) => relay.upgrade(req, socket, head));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { origin });
  const received = []; client.on('message', data => received.push(JSON.parse(data)));
  t.after(async () => { client.terminate(); await relay.close(); await new Promise(resolve => server.close(resolve)); });
  await once(client, 'open');
  return { client, token, opened, received, forwarded, get upstream() { return upstream; } };
}
for (const avatar of [false, true]) test(`authenticated ${avatar ? 'avatar' : 'voice'} calls work without anonymous access`, async t => {
  const h = await harness(t, { avatar });
  const ready = once(h.client, 'message');
  h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token }));
  await ready;
  assert.equal(h.opened.length, 1);
  const { url, options } = h.opened[0];
  assert.equal(new URL(url).searchParams.get('avatar'), avatar ? 'true' : null);
  assert.equal(options.headers.Authorization, 'Bearer server-secret-never-sent-to-client');
  assert.equal(url.includes('secret'), false);
  assert.equal(JSON.stringify(h.received).includes('secret'), false);
  const closed = once(h.client, 'close');
  h.client.send(JSON.stringify({ type: 'session.update', session: { assistant: { id: 'forged-assistant' } } }));
  assert.equal((await closed)[0], 1008);
  assert.equal(h.forwarded.length, avatar ? 1 : 0, 'only avatars require a server-owned session update; voice auto-starts');
});
for (const mode of ['anonymous', 'bad-token', 'permission-denied']) test(`reject ${mode} before any Telnyx connection`, async t => {
  const h = await harness(t, { authorize: async () => { if (mode === 'permission-denied') throw new Error('Forbidden'); } });
  const closed = once(h.client, 'close');
  h.client.send(JSON.stringify({ type: mode === 'anonymous' ? 'widget.authenticate' : 'assistant.call.authenticate', token: mode === 'bad-token' ? 'invalid' : h.token }));
  assert.equal((await closed)[0], 1008); assert.equal(h.opened.length, 0);
});
test('revoked Contact Center access closes an ongoing call', async t => {
  let permitted = true;
  const h = await harness(t, { heartbeatMs: 30, authorize: async () => { if (!permitted) throw new Error('Revoked'); } });
  const ready = once(h.client, 'message'); h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token })); await ready;
  permitted = false;
  const [code] = await once(h.client, 'close'); assert.equal(code, 1008);
  assert.match(h.received.at(-1).error.message, /session or call permission has ended/);
});
test('upstream authentication failure produces an actionable message without credentials', async t => {
  const h = await harness(t);
  const ready = once(h.client, 'message'); h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token })); await ready;
  const closed = once(h.client, 'close');
  h.upstream.emit('unexpected-response', {}, { statusCode: 401, resume() {} });
  assert.equal((await closed)[0], 1011);
  assert.match(h.received.at(-1).error.message, /Contact Center credentials/);
  assert.equal(JSON.stringify(h.received).includes('server-secret'), false);
});

test('a failed Telnyx settings request is not presented as failed user authentication', async t => {
  const h = await harness(t, { request: async () => { throw new Error('Upstream timeout'); } });
  const closed = once(h.client, 'close');
  h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token }));
  assert.equal((await closed)[0], 1011);
  assert.equal(h.opened.length, 0);
  assert.match(h.received.at(-1).error.message, /load the assistant from Telnyx/);
});

test('voice-only client uses the authenticated relay and plays PCM without creating video', async t => {
  const { TelnyxAvatarClient } = await import('../lib/ai/telnyx-avatar-client.mjs');
  const sent = [];
  const node = () => ({ connect() { return this; }, disconnect() {} });
  const globals = {
    AudioContext: class {
      sampleRate = 16000; audioWorklet = { addModule: async () => {} };
      async resume() {} async close() { this.state = 'closed'; }
      createGain() { return { ...node(), gain: {} }; } createMediaStreamSource() { return node(); }
    },
    AudioWorkletNode: class { port = {}; connect() { return this; } disconnect() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    WebSocket: class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0;
      constructor() { setImmediate(() => this.onopen?.()); }
      send(data) { sent.push(JSON.parse(data)); setImmediate(() => this.onmessage?.({ data: JSON.stringify({ type: 'session.created', session: { audio: { output: { format: { rate: 16000 } } } } }) })); }
      close() { this.readyState = 3; }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  }
  const client = new TelnyxAvatarClient(), played = [];
  client.playPcm = data => played.push(data);
  await client.startConversation({ avatarSession: async () => ({ url: 'ws://test/assistant-call', authentication: 'assistant.call.authenticate', token: 'scoped-capability', avatarEnabled: false }) });
  assert.equal(client.active, true); assert.equal(client.fallback, true); assert.equal(client.pc, undefined);
  assert.deepEqual(sent[0], { type: 'assistant.call.authenticate', token: 'scoped-capability' });
  await client.receive({ type: 'response.output_audio.delta', delta: 'AAA=' }); assert.deepEqual(played, ['AAA=']);
  await client.endConversation(); assert.equal(client.microphone, null); assert.equal(client.context, null);
});

test('a temporary congested audio upload drops stale PCM and resumes without ending the call', async t => {
  const h = await harness(t);
  const ready = once(h.client, 'message'); h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token })); await ready;
  h.upstream.bufferedAmount = 128001;
  const audio = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAA=' });
  h.client.send(audio);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.client.readyState, WebSocket.OPEN); assert.equal(h.forwarded.length, 0);
  h.upstream.bufferedAmount = 0; h.client.send(audio);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.client.readyState, WebSocket.OPEN); assert.equal(h.forwarded.at(-1).type, 'input_audio_buffer.append');
});

test('speech indicators follow caller recognition, streamed assistant items, interruptions and hangup', async () => {
  const { TelnyxAvatarClient } = await import('../lib/ai/telnyx-avatar-client.mjs');
  const client = new TelnyxAvatarClient(), user = [], agent = [], transcript = [];
  client.on('conversation.user.state', event => user.push(event.state));
  client.on('conversation.agent.state', event => agent.push(event));
  client.on('transcript.item', event => transcript.push(event));
  await client.receive({ type: 'input_audio_buffer.speech_started' });
  await client.receive({ type: 'input_audio_buffer.speech_stopped' });
  await client.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'caller-1', transcript: 'Hello' });
  assert.deepEqual(user, ['speaking', 'transcribing', 'idle']);
  assert.equal(transcript[0].role, 'user');
  await client.receive({ type: 'response.output_audio_transcript.delta', item_id: 'reply-1', delta: 'Hello ' });
  await client.receive({ type: 'response.output_audio_transcript.delta', item_id: 'reply-1', delta: 'there.' });
  assert.deepEqual(agent.at(-1), { state: 'speaking', itemId: 'reply-1' });
  await client.receive({ type: 'response.done' });
  assert.deepEqual(agent.at(-1), { state: 'listening' });
  await client.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(user.at(-1), 'speaking');
  assert.deepEqual(agent.at(-1), { state: 'listening' });
  await client.endConversation();
  assert.equal(user.at(-1), 'idle');
  assert.deepEqual(agent.at(-1), { state: 'listening' });
});

test('a spoken paragraph may queue beyond fifteen seconds and interruption clears queued audio', async () => {
  const { TelnyxAvatarClient } = await import('../lib/ai/telnyx-avatar-client.mjs');
  const client = new TelnyxAvatarClient();
  let stopped = 0;
  client.outputRate = 16000;
  client.context = {
    currentTime: 0,
    createBuffer: (_channels, length, rate) => ({ length, duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() { stopped++; } }),
  };
  const second = Buffer.alloc(32000).toString('base64');
  for (let i = 0; i < 30; i++) client.playPcm(second);
  assert.equal(client.sources.size, 30);
  assert(client.nextAudioTime > 30);
  client.clearPcm();
  assert.equal(stopped, 30); assert.equal(client.sources.size, 0); assert.equal(client.nextAudioTime, 0);
  client.nextAudioTime = 121;
  assert.throws(() => client.playPcm(second), /response is too long/);
});

// --- Workflow "Test AI Agent" voice sessions (scope: workflow-test) ---------
//2.
import { authorizeAssistantCaller, assistantCallPermission, WORKFLOW_TEST_SCOPE } from '../lib/ai/assistant-call-session.mjs';
const workflowClaims = { ...claims, avatar: null, scope: WORKFLOW_TEST_SCOPE, workflowId: 'workflow-1' };

test('workflow test sessions are authorized by the workflow permission and the workflow → assistant binding', async () => {
  assert.equal(assistantCallPermission(claims), 'ai_assistants:test');
  assert.equal(assistantCallPermission(workflowClaims), 'workflows:ai');
  const token = issueAssistantCallSession(workflowClaims, options);
  assert.equal(readAssistantCallSession(token, origin, options).scope, WORKFLOW_TEST_SCOPE);
  assert.throws(() => readAssistantCallSession(issueAssistantCallSession({ ...claims, scope: 'other' }, options), origin, options), /Invalid call authorization/);
  assert.throws(() => readAssistantCallSession(issueAssistantCallSession({ ...workflowClaims, workflowId: undefined }, options), origin, options), /Invalid call authorization/);
  // Access is resolved per user: the owner holds every permission (wildcard);
  // the agent holds only the assistant-test permission, which is not enough
  // for a workflow-scoped session.
  const pool = (binding) => ({ query: async (sql, params) => {
    if (sql.startsWith('SELECT * FROM users')) return { rows: [{ id: params[0], active: true, roles: [params[0]] }] };
    if (sql.startsWith('SELECT ai_assistant_id')) return { rows: binding === null ? [] : [{ ai_assistant_id: binding }] };
    throw new Error(`unexpected query ${sql}`);
  } });
  const resolveAccess = async (user) => user.id === 'owner' ? { wildcard: true } : { wildcard: false, keys: ['ai_assistants:test'], screens: new Set(), operations: new Set(['ai_assistants:test']) };
  await authorizeAssistantCaller({ ...workflowClaims, userId: 'owner' }, pool(assistant.id), { resolveAccess });
  await authorizeAssistantCaller({ ...claims, userId: 'agent' }, pool(assistant.id), { resolveAccess });
  await assert.rejects(authorizeAssistantCaller({ ...workflowClaims, userId: 'agent' }, pool(assistant.id), { resolveAccess }), /no longer have permission/);
  await assert.rejects(authorizeAssistantCaller({ ...workflowClaims, userId: 'owner' }, pool('assistant-other'), { resolveAccess }), /workflow's assistant changed/);
  await assert.rejects(authorizeAssistantCaller({ ...workflowClaims, userId: 'owner' }, pool(null), { resolveAccess }), /workflow's assistant changed/);
});

test('a workflow test call is voice-only even when the assistant has an avatar, and tags the conversation', async t => {
  let upstream; const opened = [], forwarded = [];
  const saved = { ...assistant, avatar_settings: { provider: 'telnyx', model: 'foxtrot-1', avatar_id: 'elena', background_id: 'studio' } };
  const token = issueAssistantCallSession(workflowClaims, { env });
  const relay = createAssistantCallRelay({
    readSession: (value, from) => readAssistantCallSession(value, from, { env }), authorize: async () => {}, request: async () => saved, apiKey: () => 'server-secret',
    openUpstream: (url, options) => {
      opened.push({ url, options });
      upstream = new EventEmitter(); upstream.readyState = WebSocket.OPEN; upstream.bufferedAmount = 0;
      upstream.send = data => forwarded.push(JSON.parse(data)); upstream.close = () => {}; upstream.terminate = () => {};
      setImmediate(() => { upstream.emit('open'); upstream.emit('message', JSON.stringify({ type: 'session.created', session: { conversation_id: 'workflow-conversation' } })); });
      return upstream;
    },
  });
  const server = http.createServer(); server.on('upgrade', (req, socket, head) => relay.upgrade(req, socket, head));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { origin });
  const received = []; client.on('message', data => received.push(JSON.parse(data)));
  t.after(async () => { client.terminate(); await relay.close(); await new Promise(resolve => server.close(resolve)); });
  await once(client, 'open');
  const ready = once(client, 'message');
  client.send(JSON.stringify({ type: 'assistant.call.authenticate', token }));
  await ready;
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0].url).searchParams.get('avatar'), null, 'workflow tests never request the avatar');
  assert.deepEqual(forwarded, [{ type: 'session.update', session: { assistant: { dynamic_variables: { cc_user_id: 'operator', cc_call_source: 'workflow-test', cc_workflow_id: 'workflow-1' } } } }]);
  assert.equal(received[0].session.conversation_id, 'workflow-conversation');
  // Caller audio and text turns are forwarded; avatar frames are refused.
  client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAA=' }));
  client.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(forwarded.slice(1).map(f => f.type), ['input_audio_buffer.append', 'conversation.item.create']);
  const closed = once(client, 'close');
  client.send(JSON.stringify({ type: 'avatar.media.ready' }));
  assert.equal((await closed)[0], 1008);
});

test('the client can open a conversation without a microphone and push paced PCM16 as the caller', async t => {
  const { TelnyxAvatarClient } = await import('../lib/ai/telnyx-avatar-client.mjs');
  const sent = []; let microphoneRequests = 0;
  const node = () => ({ connect() { return this; }, disconnect() {} });
  const globals = {
    AudioContext: class {
      sampleRate = 16000; audioWorklet = { addModule: async () => {} };
      async resume() {} async close() { this.state = 'closed'; }
      createGain() { return { ...node(), gain: {} }; } createMediaStreamSource() { return node(); }
    },
    AudioWorkletNode: class { port = {}; connect() { return this; } disconnect() {} },
    navigator: { mediaDevices: { getUserMedia: async () => { microphoneRequests++; return { getTracks: () => [{ stop() {} }] }; } } },
    WebSocket: class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0;
      constructor() { setImmediate(() => this.onopen?.()); }
      send(data) { sent.push(JSON.parse(data)); if (sent.length === 1) setImmediate(() => this.onmessage?.({ data: JSON.stringify({ type: 'session.created', session: { conversation_id: 'conv-9', audio: { output: { format: { rate: 24000 } } } } }) })); }
      close() { this.readyState = 3; }
    },
    btoa: (binary) => Buffer.from(binary, 'binary').toString('base64'),
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  }
  const client = new TelnyxAvatarClient(), raw = [];
  client.on('assistant.event', frame => raw.push(frame.type));
  assert.throws(() => client.appendInputAudio(new Uint8Array(2)), /not ready/);
  await client.startConversation({ capture: 'none', avatarSession: async () => ({ url: 'ws://test/assistant-call', authentication: 'assistant.call.authenticate', token: 'scoped', avatarEnabled: false }) });
  assert.equal(microphoneRequests, 0, 'AUTO mode must not touch the microphone');
  assert.equal(client.microphone, null);
  assert.equal(client.conversationId, 'conv-9');
  assert.deepEqual(raw, ['session.created']);
  client.appendInputAudio(Uint8Array.of(1, 0, 255, 127));
  assert.deepEqual(sent.at(-1), { type: 'input_audio_buffer.append', audio: Buffer.from([1, 0, 255, 127]).toString('base64') });
  assert.throws(() => client.appendInputAudio(new Uint8Array(3)), /Invalid PCM16/);
  await client.endConversation();
  assert.throws(() => client.appendInputAudio(new Uint8Array(2)), /not ready/);
});

test('a hangup or timeout after session.created ends the call cleanly instead of reporting a failure', async t => {
  for (const code of ['conversation_ended', 'session_idle_timeout']) {
    const h = await harness(t);
    const ready = once(h.client, 'message'); h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token })); await ready;
    const closed = once(h.client, 'close');
    h.upstream.emit('message', JSON.stringify({ type: 'error', error: { code, message: 'Conversation ended' } }));
    assert.equal((await closed)[0], 1000);
    assert.deepEqual(h.received.at(-1), { type: 'session.ended', reason: code });
  }
  // Before the session starts, or for any other code, the failure is still reported.
  const h = await harness(t);
  const ready = once(h.client, 'message'); h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token })); await ready;
  const closed = once(h.client, 'close');
  h.upstream.emit('message', JSON.stringify({ type: 'error', error: { code: 'conversation_start_failed', message: 'Start failed' } }));
  assert.equal((await closed)[0], 1011);
  assert.match(h.received.at(-1).error.message, /could not start or continue/);
});

test('documented Telnyx start errors produce actionable copy; unknown codes stay generic', async t => {
  const { upstreamErrorMessage } = await import('../lib/ai/assistant-call-relay.mjs');
  assert.match(upstreamErrorMessage({ code: 'unsupported_voice_output_format', message: 'Assistant voice output format "mp3" is not supported over the Realtime websocket' }), /voice streams compressed audio.*NaturalHD or Ultra/);
  assert.match(upstreamErrorMessage({ code: 'something_new' }), /could not start or continue/);
  assert.match(upstreamErrorMessage(undefined), /could not start or continue/);
  const h = await harness(t);
  h.client.send(JSON.stringify({ type: 'assistant.call.authenticate', token: h.token }));
  await once(h.client, 'message');
  const closed = once(h.client, 'close');
  h.upstream.emit('message', JSON.stringify({ type: 'error', error: { code: 'unsupported_voice_output_format', message: 'mp3' } }));
  assert.equal((await closed)[0], 1011);
  assert.match(h.received.at(-1).error.message, /voice streams compressed audio/);
});

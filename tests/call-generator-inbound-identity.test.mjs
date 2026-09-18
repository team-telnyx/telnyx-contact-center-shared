import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { generatorInboundHeaders, parseGeneratorInboundIdentity } from '../lib/call-generator/inbound-identity.mjs';

test('SIP generator identity authenticates run, attempt and destination; rejects tampering and duplicate headers', () => {
  const ids = { runId: randomUUID(), ledgerId: randomUUID(), flowId: randomUUID() };
  const headers = generatorInboundHeaders(ids, 'fixture-key');
  assert.deepEqual(parseGeneratorInboundIdentity(headers, 'fixture-key'), { v: 1, ...ids });
  assert.equal(parseGeneratorInboundIdentity(headers, 'another-key'), null);
  assert.equal(parseGeneratorInboundIdentity([...headers, ...headers], 'fixture-key'), null);
  assert.equal(parseGeneratorInboundIdentity([{ ...headers[0], value: headers[0].value + '.extra' }], 'fixture-key'), null);
  const changed = Buffer.from(JSON.stringify({ v: 1, ...ids, ledgerId: randomUUID() })).toString('base64url');
  assert.equal(parseGeneratorInboundIdentity([{ ...headers[0], value: changed + '.' + headers[0].value.split('.')[1] }], 'fixture-key'), null);
  assert.equal(parseGeneratorInboundIdentity([{ name: headers[0].name, value: 'invalid' }], 'fixture-key'), null);
  assert.equal(parseGeneratorInboundIdentity(generatorInboundHeaders({ ...ids, ledgerId: 'not-a-uuid' }, 'fixture-key'), 'fixture-key'), null);
});

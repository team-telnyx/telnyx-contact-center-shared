import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailAttachmentResponse } from '../lib/email/attachment-response.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5foAAAAASUVORK5CYII=', 'base64');
const respond = (query, bytes = png, content_type = 'image/png', filename = 'photo.png', headers) =>
  emailAttachmentResponse(new Request(`https://cc.test/attachment${query}`, { headers }), {
    file: { filename, content_type }, bytes, conversationId: 'authorized-conversation',
  });

test('email image preview is inline and private while its original download stays unchanged', async () => {
  const download = await respond('');
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  const preview = await respond('?preview=1');
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
});

test('existing CID image requests preserve their raster-only policy and size limit', async () => {
  assert.equal((await respond('?inline=1')).headers.get('content-type'), 'image/png');
  await assert.rejects(respond('?inline=1', Buffer.alloc(5_000_001)), { status: 415 });
  await assert.rejects(respond('?inline=1', Buffer.from('<svg/>'), 'image/svg+xml'), { status: 415 });
});

test('email text documents use the shared document renderer', async () => {
  const response = await respond('?preview=1', Buffer.from('Order 00123\nZażółć'), 'text/plain', 'order.txt');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: 'text', text: 'Order 00123\nZażółć', truncated: false });
});

test('email PDF preview is frameable and media range requests return the requested bytes', async () => {
  const pdf = Buffer.from('%PDF-1.7\nfixture');
  const response = await respond('?preview=1', pdf, 'application/pdf', 'order.pdf');
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.doesNotMatch(response.headers.get('content-security-policy'), /sandbox/);
  const audio = Buffer.from('ID3audio-fixture');
  const range = await respond('?preview=1', audio, 'audio/mpeg', 'voice.mp3', { Range: 'bytes=0-2' });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-length'), '3');
  assert.equal(await range.text(), 'ID3');
});

test('unsafe or falsely declared media are download-only and conversion failures stay explicit', async () => {
  for (const type of ['image/svg+xml', 'text/html', 'image/png', 'application/pdf', 'audio/mpeg']) {
    await assert.rejects(respond('?preview=1', Buffer.from('<script>alert(1)</script>'), type), { status: 415 });
  }
  const unsupported = await respond('', Buffer.from('<svg/>'), 'image/svg+xml', 'image.svg');
  assert.match(unsupported.headers.get('content-disposition'), /^attachment;/);
  const corrupt = await respond('?preview=1', Buffer.from('bad'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'orders.xlsx');
  assert.equal(corrupt.status, 422);
  assert.deepEqual(await corrupt.json(), { error: 'invalid_document' });
});

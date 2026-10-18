import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { parseWordPreview } from '../lib/documents/word-preview.mjs';

const require = createRequire(import.meta.url);

test('Word preview does not load the vulnerable Mammoth CLI formatter or build-time glob parser', async () => {
  const bytes = await readFile(new URL('./fixtures/documents/word.docx', import.meta.url));
  const preview = await parseWordPreview(bytes);
  assert.match(preview.text, /Zażółć gęślą jaźń/);
  for (const filename of Object.keys(require.cache)) {
    assert.doesNotMatch(filename, /node_modules\/(?:argparse|sprintf-js|braces)\//);
  }
});

for (const sdk of ['@telnyx/webrtc', '@telnyx/video']) {
  test(`${sdk} resolves a CommonJS-compatible UUID with guarded output buffers`, () => {
    const fromSdk = createRequire(require.resolve(sdk));
    const uuid = fromSdk('uuid');
    assert(uuid.validate(uuid.v1()));
    assert(uuid.validate(uuid.v4()));
    for (const create of [
      buffer => uuid.v3('test', uuid.v3.DNS, buffer, 4),
      buffer => uuid.v5('test', uuid.v5.DNS, buffer, 4),
      buffer => uuid.v6({}, buffer, 4),
    ]) {
      const buffer = new Uint8Array(8).fill(170);
      assert.throws(() => create(buffer), RangeError);
      assert.deepEqual(buffer, new Uint8Array(8).fill(170));
    }
  });
}

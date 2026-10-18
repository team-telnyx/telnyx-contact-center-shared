import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

const bundle = await build({
  entryPoints: [new URL('./entry.jsx', import.meta.url).pathname],
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"production"' },
});
let apiRequests = 0;
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url.startsWith('/api/')) {
    apiRequests++; res.writeHead(404); res.end();
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ headless: true, args: process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    window.imageUrls = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.imageUrls.created.push(url); return url; };
    URL.revokeObjectURL = url => { window.imageUrls.revoked.push(url); revoke(url); };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
  await page.waitForSelector('form input');
  async function attach(method, name) {
    await page.evaluate(async (method, name) => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      canvas.getContext('2d').fillRect(0, 0, 16, 16);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const data = new DataTransfer(); data.items.add(new File([blob], name, { type: 'image/png' }));
      const event = method === 'drop'
        ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
        : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      document.querySelector('form input').dispatchEvent(event);
    }, method, name);
    await page.waitForSelector('[aria-label="Images to send"]');
  }
  for (const method of ['drop', 'paste']) {
    const name = `${method}-preview.png`;
    await attach(method, name);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Images to send"]'));
    assert.equal(await page.$eval(`img[alt="${name}"]`, image => !image.closest('button').disabled), true);
    await page.waitForFunction(name => { const image = document.querySelector(`img[alt="${name}"]`); return image?.complete && image.naturalWidth === 16; }, {}, name);
    assert.equal(await page.evaluate(() => window.imageUrls.revoked.length), 0, 'Sent preview images must stay readable');
    await page.type('form input', `Text after ${method}`);
    await page.click('button[type="submit"]');
    assert.equal((await page.$$(`img[alt="${name}"]`)).length, 1, 'Later messages must not reuse the sent image');
  }
  await attach('drop', 'remove-me.png');
  await page.click('button[aria-label="Remove remove-me.png"]');
  await page.waitForFunction(() => !document.querySelector('[aria-label="Images to send"]'));
  assert.equal(await page.evaluate(() => window.imageUrls.revoked.length), 1);
  await page.evaluate(() => window.unmountPreview());
  assert.deepEqual(await page.evaluate(() => [...window.imageUrls.revoked].sort()), await page.evaluate(() => [...window.imageUrls.created].sort()), 'Unmount must release every retained URL');
  assert.equal(apiRequests, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: preview drop/paste images clear from the composer, remain visible, are not reattached, and release object URLs. No API requests.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

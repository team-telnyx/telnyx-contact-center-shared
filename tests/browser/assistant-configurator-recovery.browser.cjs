const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), req = require('node:module').createRequire(path.join(root, 'package.json'));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-assistant-recovery-'));
(async () => {
  await req('esbuild').build({ entryPoints: [path.join(__dirname, 'assistant-configurator-recovery.fixture.jsx')], bundle: true, outfile: path.join(output, 'app.js'), platform: 'browser', jsx: 'automatic', alias: { '@': root }, define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'boundaries', setup(build) {
    const mocks = {
      '@/components/i18n/use-ui-text': 'const text=s=>s;export const useUiText=()=>text;',
      '@/components/ToastNotify': 'export const notify=()=>{};',
      '@/components/ai-elements/mic-overlay': 'export default ()=>null;',
      'next/link': 'import React from "react";export default ({children,...props})=><a {...props}>{children}</a>;',
    };
    build.onResolve({ filter: /^(next\/link|@\/components\/(i18n\/use-ui-text|ToastNotify|ai-elements\/mic-overlay))$/ }, args => ({ path: args.path, namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'jsx', resolveDir: root }));
  } }] });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/app.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/app.js' ? fs.readFileSync(path.join(output, 'app.js')) : '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await req('puppeteer').launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : fs.existsSync(mac) ? { executablePath: mac } : {}), args: process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('[role="alert"]');
    assert.match(await page.$eval('[role="alert"]', node => node.textContent), /voice catalog/);
    await page.click('#noise-suppression-toggle');
    await page.waitForFunction(() => fixture.voice.noise_suppression !== false);
    assert.match(await page.$eval('body', node => node.textContent), /Background Audio Type/);
    const timeout = '[data-setting-path="messaging_settings.conversation_inactivity_minutes"] input';
    await page.focus(timeout); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await page.waitForSelector('#messaging-timeout-error');
    assert.equal(await page.evaluate(() => fixture.payload.messaging_settings.conversation_inactivity_minutes), '');
    assert.ok((await page.evaluate(() => fixture.errors)).length > 0, 'empty timeout blocks save before a Telnyx write');
    await page.type(timeout, '60');
    await page.waitForFunction(() => fixture.errors.length === 0);
    assert.equal(await page.evaluate(() => fixture.payload.messaging_settings.conversation_inactivity_minutes), 60);
    await page.evaluate(() => { fixture.catalogReady = true; });
    await page.$$eval('[role="alert"] button', buttons => buttons.find(button => button.textContent === 'Try again').click());
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
    assert.equal(await page.$eval('#noise-suppression-toggle', node => node.getAttribute('aria-checked')), 'true');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: ['catalog failure leaves noise/background settings available', 'audio edit persists across catalog retry', 'blank timeout remains invalid and blocks save', 'corrected timeout passes validation', 'no browser errors'] }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import puppeteer from 'puppeteer';
import { parse as parseMessage } from '@formatjs/icu-messageformat-parser';
import { UI_LOCALES, messageId } from '../../lib/i18n/locales.mjs';
import { DEFAULT_AGENT_STATUSES } from '../../lib/i18n/status-labels.mjs';
const require = createRequire(import.meta.url),
  root = process.cwd(),
  output = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-i18n-browser-'));
await build({
  entryPoints: ['tests/i18n-browser/entry.jsx'],
  bundle: true,
  outfile: path.join(output, 'app.js'),
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  alias: {
    '@': root
  },
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env': '{}'
  },
  plugins: [{
    name: 'node-resolution',
    setup(b) {
      b.onResolve({filter: /^[^./]/}, a => {
        // Resolve installed packages despite a parent-directory PnP manifest;
        // let esbuild handle package-local #imports and their browser condition.
        if (a.path.startsWith('@/') || a.path.startsWith('#')) return;
        return {path: require.resolve(a.path)};
      });
    },
  }],

});
const css = (await postcss([tailwindcss()]).process(fs.readFileSync('app/globals.css', 'utf8'), {
  from: path.join(root, 'app/globals.css')
})).css;
const server = createServer((req, res) => {
  if (req.url === '/app.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(css);
    return;
  }
  res.setHeader('Content-Type', req.url === '/app.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/app.js' ? fs.readFileSync(path.join(output, 'app.js')) : '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root" class="mx-auto max-w-xl space-y-4 p-8"></div><script src="/app.js"></script></body></html>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await puppeteer.launch({
    headless: true,
    ...(fs.existsSync(mac) ? {
      executablePath: mac
    } : {}),
    args: process.env.CI ? ['--no-sandbox'] : []
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1280,
    height: 900
  });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.stack); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('[data-testid="draft"]');
  await page.type('[data-testid="draft"]', ' retained');
  for (const {
    id
  } of UI_LOCALES) {
    await page.evaluate(async locale => {
      await window.fixture.changeLocale(locale);
    }, id);
    await page.waitForFunction(locale => document.documentElement.lang === locale, {}, id);
    assert.equal(await page.$eval('[data-testid="draft"]', el => el.value), 'customer draft retained');
    assert.equal(await page.$eval('[data-testid="number"]', el => el.textContent), 12345.67.toLocaleString(id));
    const catalogue = JSON.parse(fs.readFileSync(`messages/${id}.json`, 'utf8'));
    const raw = catalogue.ui[messageId('Interface language')];
    assert(raw, `${id} profile translation is present`);
    const expected = parseMessage(raw).map(node => node.value).join('');
    assert.equal(await page.$eval('[data-testid="heading"]', el => el.textContent), expected);
    const textOf = (source, context, values = {}) => parseMessage(catalogue.ui[messageId(source, context)]).map(node => node.type === 0 ? node.value : values[node.value]).join('');
    const emojiCopy = id === 'pt-PT' ? JSON.parse(fs.readFileSync('messages/emoji-pt-PT.json', 'utf8')) : require(`@emoji-mart/data/i18n/${id.split('-')[0]}.json`);
    await page.waitForFunction(search => document.querySelector('[data-testid="emoji-picker"] em-emoji-picker')?.shadowRoot?.querySelector('input[type="search"]')?.placeholder === search, {}, emojiCopy.search).catch(async error => {
      console.error('Emoji localization mismatch', id, await page.$eval('[data-testid="emoji-picker"]', el => ({html: el.innerHTML.slice(0, 600), inputs: [...(el.querySelector('em-emoji-picker')?.shadowRoot?.querySelectorAll('input') || [])].map(input => ({type: input.type, placeholder: input.placeholder}))})));
      throw error;
    });
    for (const [selector, source, context] of [
      ['call-action', 'Call', 'phone action'], ['call-noun', 'Call'],
      ['open-action', 'Open', 'action'], ['open-state', 'Open'],
    ]) assert.equal(await page.$eval(`[data-testid="${selector}"]`, el => el.textContent), textOf(source, context));
    assert.equal(await page.$eval('[data-interaction-state="held"]', el => el.textContent.trim()), textOf('On Hold'));
    assert.equal(await page.$eval('[data-interaction-state="queued"]', el => el.textContent.trim()), textOf('Queued'));
    await page.waitForSelector('[data-interaction-row="native-row"]');
    assert.equal(await page.$eval('[data-testid="campaign-activation"] span', e => e.textContent), textOf('Campaigns {value0}/{value1}', undefined, {value0:2,value1:3}));
    await page.click('[data-testid="campaign-activation"]');
    for (const [key, name] of [['campaigns','Campaigns'],['available','Available'],['save','Save']]) {
      assert.equal(await page.$eval(`label[for="campaign-activation-${key}"]`,e=>e.textContent.trim()),name);
    }
    assert((await page.$eval('[data-slot="popover-content"]',e=>e.textContent)).includes(textOf('Progressive')));
    await page.keyboard.press('Escape');
    const liveHeaders = await page.$$eval('[data-testid="live-interactions-view"] th',els=>els.map(e=>e.textContent.trim()));
    for (const source of ['Channel','From','To','Type','State','Queue','Agent','Required skills','Priority','Wait time','Handling elapsed','SLA','Actions']) assert(liveHeaders.includes(textOf(source)), `${id}: ${source}`);
    const liveText = await page.$eval('[data-testid="live-interactions-view"]',e=>e.textContent);
    for (const source of ['Active interactions','Additional live legs','Waiting / offered','Longest running']) assert(liveText.includes(textOf(source)), `${id}: ${source}`);
    const values = await page.$$eval('[data-interaction-row="native-row"] td',els=>els.map(e=>e.textContent));
    assert.equal(values[1],'Save'); assert.equal(values[5],'Available'); assert.equal(values[6],'Training'); assert.equal(values[7],'Campaigns (3)');
    const report = await page.$eval('[data-testid="report"]',e=>e.textContent);
    for (const source of ['1 day','7 days','30 days','Custom','Within SLA','Breached','Unserved','Pending','At risk','Not configured','Disabled','Excluded','No historical rule','Customer first response','Queue wait','Handling elapsed']) assert(report.includes(textOf(source)), `${id}: report ${source}`);
    assert.equal(await page.$eval('[data-testid="report"] option[value="native-queue"]',e=>e.textContent),'Save');
    await page.waitForSelector('[data-testid="agent-status"]:not([disabled])');
    await page.click('[data-testid="agent-status"]');
    await page.waitForSelector('[role="option"][data-status="Training"]');
    const options = await page.$$eval('[role="option"][data-status]', elements => elements.map(el => ({ value: el.dataset.status, text: el.textContent })));
    for (const status of DEFAULT_AGENT_STATUSES) assert(options.find(option => option.value === status.name)?.text.includes(textOf(status.name)), `${id}: ${status.name} is localized`);
    assert.equal(options.find(option => option.value === 'Training for client A')?.text, 'Training for client A');
    await page.click('[role="option"][data-status="Training"]');
    await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
    assert.equal(await page.evaluate(() => fixture.selectedAgentStatus), 'Training');
  }
  assert.deepEqual(await page.evaluate(() => [fixture.mounts, fixture.unmounts]), [1, 0]);
  await page.evaluate(async () => {
    const first = fixture.changeLocale('de-DE');
    const second = fixture.changeLocale('pl-PL');
    await Promise.all([first, second]);
  });
  assert.equal(await page.$eval('[data-testid="locale"]', e => e.textContent), 'pl-PL');
  await page.click('[data-testid="campaign-activation"]');
  await page.click('#campaign-activation-campaigns');
  await page.waitForFunction(()=>window.fixture.campaignRequest);
  assert.deepEqual(await page.evaluate(()=>window.fixture.campaignRequest),{campaignIds:['available']});
  await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(output,'polish-coverage.png'),fullPage:true});
  // A fresh RTL render tests the shared direction plumbing independently of the release list.
  await page.goto(`http://127.0.0.1:${server.address().port}/?rtl=1`);
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  assert.equal(await page.$eval('[data-testid="heading"]', e => e.textContent), 'لغة الواجهة');
  assert.equal(await page.$eval('[data-testid="phone"]', e => e.dir), 'ltr');
  assert.equal(await page.$eval('[data-testid="customer"]', e => e.textContent), 'مرحبا Alice +971501234567');
  await page.click('[data-testid="status"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Away');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.changes), ['Away']);
  await page.evaluate(() => fixture.openPanel());
  await page.waitForSelector('[data-testid="sheet"]');
  assert.equal(await page.$eval('[data-testid="sheet"]', e => e.classList.contains('left-0')), true);
  assert.equal(await page.$eval('[data-testid="sheet"]', e => e.classList.contains('right-0')), false);
  await page.waitForFunction(() => Math.abs(document.querySelector('[data-testid="sheet"]').getBoundingClientRect().left) < 1);
  assert.equal(await page.$eval('[data-testid="phone"]', e => getComputedStyle(e).direction), 'ltr');
  await page.screenshot({
    path: path.join(output, 'rtl.png')
  });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    passed: true,
    languages: UI_LOCALES.length,
    agentStatusesPerLanguage: DEFAULT_AGENT_STATUSES.length,
    contextualTerminology: true,
    rawStatusValuesPreserved: true,
    realMonitoringComponents: true,
    campaignAndCustomerNamesPreserved: true,
    canonicalCampaignRequest: true,
    emojiPickerLanguages: UI_LOCALES.length,
    mounts: 1,
    unmounts: 0,
    output
  }));
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}

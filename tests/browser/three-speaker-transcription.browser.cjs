const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync('/tmp/cc-speaker-ui-');
(async () => {
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'three-speaker-transcription.fixture.jsx')], bundle: true, outfile: path.join(output, 'app.js'), platform: 'browser', jsx: 'automatic', alias: { '@': root }, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'test-exports', setup(build) {
    build.onLoad({ filter: /components\/contact-center\/(AgentAssistWorkflow|WorkflowHistoryView|AgentAssist)\.jsx$/ }, ({ path: file }) => ({ contents: fs.readFileSync(file, 'utf8') + `\nexport { ${file.endsWith('WorkflowHistoryView.jsx') ? 'TranscriptionBubbleReadOnly' : 'TranscriptionBubble'} as TestBubble };`, loader: 'jsx' }));
    build.onResolve({ filter: /^@\/components\/i18n\/use-ui-text$/ }, args => ({ path: args.path, namespace: 'locale' }));
    build.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({ contents: 'const text=s=>s;text.locale="en";export const useUiText=()=>text;' }));
  } }] });
  const cssDir = path.join(root, process.env.NEXT_DIST_DIR || '.next', 'static/css');
  const css = fs.readdirSync(cssDir).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join(cssDir, name), 'utf8')).join('\n');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/app.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/app.js' ? fs.readFileSync(path.join(output, 'app.js')) : req.url === '/app.css' ? css : '<!doctype html><html class="dark"><head><link rel="stylesheet" href="/app.css"></head><body style="background:#080808;color:white"><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await require('puppeteer').launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : fs.existsSync(mac) ? { executablePath: mac } : {}), args: process.env.CI ? ['--no-sandbox'] : [] });
    const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1400, height: 600 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('[data-speaker="assistant"]');
    await page.evaluate(() => document.getAnimations().forEach(animation => {
      if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
    }));
    const columns = await page.$$eval('[data-testid="transcript-column"]', nodes => nodes.map(column => [...column.querySelectorAll('[data-speaker]')].map(row => {
      const bubble = [...row.children].find(child => child.className.includes('border'));
      const r = row.getBoundingClientRect(), b = bubble.getBoundingClientRect();
      return { speaker: row.dataset.speaker, text: row.innerText, left: b.left - r.left, right: r.right - b.right, width: b.width, available: r.width, color: getComputedStyle(bubble).backgroundColor };
    })));
    for (const [customer, agent, ai] of columns) {
      assert.match(customer.text, /Customer/); assert.match(agent.text, /Agent/); assert.match(ai.text, /AI Assistant/);
      assert.ok(customer.left < 2 && customer.right > 15, 'Customer bubble must align left');
      assert.ok(agent.right < 2 && agent.left > 15, 'Agent bubble must align right');
      assert.ok(Math.abs(ai.width - ai.available) < 2, 'AI bubble must fill the column');
      assert.notEqual(ai.color, customer.color); assert.notEqual(ai.color, agent.color);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'three-speakers.png') });
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, columns }, null, 2));
    console.log(JSON.stringify({ passed: true, output }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

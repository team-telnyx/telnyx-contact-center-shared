const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const output=fs.mkdtempSync(path.join(os.tmpdir(),'cc-voice-selector-'));
(async()=>{
  await req('esbuild').build({entryPoints:[path.join(__dirname,'voice-endpoint.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'},plugins:[
    {name:'test-boundaries',setup(build){
      const mocks={
        '@/components/auth-provider':'export const useAuth=()=>({loaded:true,can:()=>true});',
        '@/components/ToastNotify':'export const notify=()=>{};',
        '@telnyx/webrtc':`export const TELNYX_ERROR_CODES={}; export class TelnyxRTC {
          events=new Map(); connected=false;
          on(name,fn){this.events.set(name,[...(this.events.get(name)||[]),fn]);}
          off(){} disconnect(){this.connected=false;}
          connect(){this.connected=true;queueMicrotask(()=>{for(const fn of this.events.get('telnyx.ready')||[])fn();});}
        }`,
      };
      build.onResolve({filter:/^(@\/components\/(auth-provider|ToastNotify)|@telnyx\/webrtc)$/},args=>({path:args.path,namespace:'mock'}));
      build.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js'}));
      build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/'))return;return {path:req.resolve(args.path)};});
    }},
  ]});
  const css=await req('postcss')([req('@tailwindcss/postcss')({base:root})]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
  fs.writeFileSync(path.join(output,'app.css'),css.css);
  const server=http.createServer((request,response)=>{
    const asset=request.url==='/app.js'?'app.js':request.url==='/app.css'?'app.css':null;
    response.setHeader('Content-Type',asset==='app.js'?'text/javascript':asset==='app.css'?'text/css':'text/html');
    response.end(asset?fs.readFileSync(path.join(output,asset)):'<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body class="bg-background text-foreground"><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const mac='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser=await req('puppeteer').launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:fs.existsSync(mac)?{executablePath:mac}:{}),args:process.env.CI?['--no-sandbox']:[]});
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.setViewport({width:1000,height:760});
    const mini='[data-testid="mini-phone"] button',floating='[data-testid="floating-phone"] button';
    await page.goto(base);
    await page.click(mini);
    await page.waitForSelector('[role="alert"]');
    assert.match(await page.$eval('[role="alert"]',e=>e.textContent),/Finish the current interaction/);
    assert.equal(await page.$('[aria-label="Loading voice devices"]'),null,'409 ends the loading skeleton');
    const count=await page.evaluate(()=>fixture.registrations);
    await new Promise(resolve=>setTimeout(resolve,2300));
    assert.equal(await page.evaluate(()=>fixture.registrations),count,'409 does not loop remote provisioning');
    await page.evaluate(()=>{fixture.status=200;});
    await page.click('[data-testid="voice-endpoint-selector"] button');
    await page.waitForSelector('[data-endpoint-id="web"]');
    await page.waitForFunction(()=>fixture.heartbeats.some(h=>h.voiceReady===true));
    assert.equal(await page.$('select'),null,'old dropdown is removed');
    assert.equal((await page.$$('[data-endpoint-id]')).length,2,'old registrations do not duplicate platform tiles');
    assert.equal(await page.$('[data-endpoint-id="old-web"], [data-endpoint-id="old-phone"]'),null);
    assert.equal(await page.$('[data-endpoint-id][aria-pressed="true"]'),null,'retry never auto-selects a device');
    assert.equal(await page.$eval('[data-endpoint-id="phone"]',e=>e.disabled),true);
    await page.evaluate(()=>{fixture.selectionStatus=409;});
    await page.click('[data-endpoint-id="web"]');
    await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('wrap-up'));
    assert.equal(await page.$('[data-endpoint-id][aria-pressed="true"]'),null,'failed selection preserves authoritative snapshot');
    await page.evaluate(()=>{fixture.selectionStatus=200;});
    await page.click('[data-endpoint-id="web"]');
    await page.waitForSelector('[aria-busy="true"]');
    assert.equal(await page.$eval('[data-endpoint-id="web"]',e=>e.disabled),true,'switching prevents duplicate selection');
    await page.waitForSelector('[data-endpoint-id="web"][aria-pressed="true"]');
    await new Promise(resolve=>setTimeout(resolve,250));
    await page.screenshot({path:path.join(output,'devices-mini-light.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('[data-slot="popover-content"]'));
    assert.equal(await page.$eval(mini,e=>e===document.activeElement),true,'Escape returns focus to connection status');
    await page.evaluate(()=>document.documentElement.classList.add('dark'));
    await page.click(floating);
    await page.waitForSelector('[data-endpoint-id="web"][aria-pressed="true"]');
    await page.evaluate(()=>fixture.enablePhone());
    await page.waitForFunction(()=>!document.querySelector('[data-endpoint-id="phone"]').disabled);
    await page.click('[data-endpoint-id="phone"]');
    await page.waitForSelector('[data-endpoint-id="phone"][aria-pressed="true"]');
    const bounds=await page.$eval('[data-slot="popover-content"]',e=>{
      const r=e.getBoundingClientRect();return {z:Number(getComputedStyle(e).zIndex),inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight};
    });
    assert.ok(bounds.z>1000&&bounds.inside,'menu is above floating phone and inside viewport');
    await page.screenshot({path:path.join(output,'devices-floating-dark.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('[data-slot="popover-content"]'));
    await page.focus(floating);await page.keyboard.press('Enter');
    await page.waitForSelector('[data-endpoint-id="phone"][aria-pressed="true"]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('[data-slot="popover-content"]'));
    await page.click(mini);
    await page.waitForSelector('[data-endpoint-id="phone"][aria-pressed="true"]');
    // Remote selection travels through the real ACD SSE provider, without
    // clicking, refreshing, or waiting for a heartbeat in this browser.
    const heartbeatCount = await page.evaluate(() => fixture.heartbeats.length);
    for (const id of ['web', 'phone']) {
      await page.evaluate(id => fixture.remoteSelection(id), id);
      await page.waitForSelector(`[data-endpoint-id="${id}"][aria-pressed="true"]`, {timeout: 1500});
    }
    assert.equal(await page.evaluate(() => fixture.heartbeats.length), heartbeatCount, 'remote changes arrive before heartbeat');
    const reads = await page.evaluate(() => fixture.endpointReads);
    await page.evaluate(() => fixture.emitSnapshot(null));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.evaluate(() => fixture.endpointReads), reads, 'empty SSE ticks do not refetch endpoints');
    for (const [oldID, currentID] of [['old-phone','phone'], ['old-web','web']]) {
      const selections = await page.evaluate(() => fixture.selections.length);
      await page.evaluate(id => fixture.remoteSelection(id), oldID);
      await page.waitForFunction(id => document.querySelector(`[data-endpoint-id="${id}"]`)?.textContent.includes('Reconnect'), {}, currentID);
      assert.equal((await page.$$('[data-endpoint-id]')).length,2);
      assert.equal(await page.evaluate(() => fixture.selections.length),selections,'deduplication never switches routing automatically');
      await page.click(`[data-endpoint-id="${currentID}"]`);
      await page.waitForFunction(id => document.querySelector(`[data-endpoint-id="${id}"]`)?.textContent.includes('Active device'), {}, currentID);
      assert.equal(await page.evaluate(() => fixture.selections.at(-1)), currentID, 'reconnect selects the current reachable session');
    }
    await page.screenshot({path:path.join(output,'devices-deduplicated-dark.png')});
    await page.goto(`${base}/?status=503`);
    await page.click(mini);
    await page.waitForSelector('[role="alert"]');
    await page.waitForFunction(()=>fixture.registrations>=2,{timeout:7000});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:22,checks:['409 actionable error','loading ends on failure','no conflict retry loop','manual retry reaches readiness','no dropdown','explicit selection','unavailable disabled','conflict preserves snapshot','switching indicator and duplicate guard','confirmed active tile','Escape restores focus','mini and floating share selection','floating menu layering and keyboard access','available iPhone selection propagates to mini','503 recovery','SSE remote selection in both directions','SSE selection precedes heartbeat','empty SSE tick ignored','one tile per platform with old sessions','stale iPhone reconnect','stale computer reconnect','no automatic routing change'],output},null,2));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

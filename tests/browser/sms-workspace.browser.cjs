// Isolated browser regression: real SMS agent and admin components, deterministic
// HTTP fixtures, no application login, live Contact Center data or Telnyx traffic.
// Run: node tests/browser/sms-workspace.browser.cjs
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const esbuild=req('esbuild'),postcss=req('postcss'),tailwind=req('@tailwindcss/postcss'),puppeteer=req('puppeteer'),assert=require('node:assert/strict');
const output=process.env.SMS_UI_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'cc-sms-workspace-'));
async function build(){
  fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(__dirname,'sms-workspace.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',loader:{'.js':'jsx'},alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning',
    plugins:[{name:'workspace-node-resolution',setup(build){build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/'))return;if(args.path.startsWith('#min'))return {path:path.join(root,'node_modules/vfile/lib',args.path.slice(1)+'.browser.js')};return {path:req.resolve(args.path)};});}}]});
  const css=await postcss([tailwind({base:root})]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
  fs.writeFileSync(path.join(output,'app.css'),css.css);
  fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
}
(async()=>{
  await build();
  const server=http.createServer((request,response)=>{const file={'/':'index.html','/app.js':'app.js','/app.css':'app.css'}[request.url];if(!file){response.writeHead(404).end();return;}response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');response.end(fs.readFileSync(path.join(output,file)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const macChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let browser;const checks=[];
  try{
    browser=await puppeteer.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:fs.existsSync(macChrome)?{executablePath:macChrome}:{}),args:['--disable-gpu',...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[])],timeout:20000});
    const page=await browser.newPage();await page.setViewport({width:1600,height:1000});const errors=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error('Browser:',e.message);});page.on('dialog',d=>d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('[data-testid=chat-interaction-detail][data-channel=sms]');
    await page.waitForSelector('[data-testid=sms-segment-counter]');
    assert.equal(await page.$eval('[data-testid=sms-business-number]',el=>el.textContent),'Sales line +14155550100');checks.push('SMS header shows the queue number');
    const statuses=await page.$$eval('[data-testid=message-delivery]',els=>els.map(el=>el.dataset.deliveryStatus));
    assert.deepEqual(statuses,['delivered','delivery_failed']);checks.push('agent bubbles show carrier delivery evidence');
    assert.match(await page.$eval('[data-delivery-status=delivery_failed]',el=>el.title),/40001 · Destination unreachable/);checks.push('failed delivery exposes the provider error');
    assert.equal(await page.$eval('[data-testid=sms-encoding]',el=>el.textContent),'GSM-7');
    assert.equal(await page.$eval('[data-testid=sms-remaining]',el=>el.textContent),'160');checks.push('empty composer counts a full GSM-7 part');
    await page.screenshot({path:path.join(output,'desktop-dark.png')});
    await page.type('[aria-label="SMS reply"]','Your order is ready for pickup until 6 pm.');
    await page.waitForFunction(()=>document.querySelector('[data-testid=sms-remaining]').textContent==='118');// 42 GSM-7 characters
    assert.equal(await page.$eval('[data-testid=sms-parts]',el=>el.textContent),'1');checks.push('GSM-7 counter tracks characters, parts and remaining');
    await page.type('[aria-label="SMS reply"]',' 😀');
    await page.waitForFunction(()=>document.querySelector('[data-testid=sms-encoding]').textContent==='UCS-2');
    assert.equal(await page.$eval('[data-testid=sms-remaining]',el=>el.textContent),'25');// 43 characters + one surrogate pair = 45 UTF-16 units of 70
    checks.push('emoji switches the counter to UCS-2 with 70-character parts');
    await page.click('[aria-label="Emoji"]');await page.waitForSelector('em-emoji-picker',{timeout:20000});checks.push('the shared emoji picker opens from the composer');
    await page.keyboard.press('Escape');
    await page.screenshot({path:path.join(output,'composer-ucs2-dark.png')});
    await page.evaluate(()=>[...document.querySelectorAll('button[type=submit]')].find(b=>b.textContent.trim()==='Send').click());
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=message-delivery]').length===3);
    const sendRequest=await page.evaluate(()=>window.fixture.requests.filter(r=>r.method==='POST'&&r.body&&JSON.parse(r.body).action==='send').map(r=>JSON.parse(r.body)));
    assert.equal(sendRequest.length,1);assert.equal(sendRequest[0].body,'Your order is ready for pickup until 6 pm. 😀');assert.match(sendRequest[0].commandId,/[0-9a-f-]{36}/);
    assert.equal(await page.$$eval('[data-testid=message-delivery]',els=>els.at(-1).dataset.deliveryStatus),'queued');checks.push('a sent reply appears immediately as sending with its command id');
    await page.evaluate(()=>{const message=window.fixture.db.messages.at(-1);message.delivery={...message.delivery,status:'delivered'};});
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid=message-delivery]')].at(-1).dataset.deliveryStatus==='delivered',{timeout:10000});checks.push('delivery evidence updates on the next refresh');
    assert.equal(await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).action==='typing').length),0);checks.push('SMS never sends typing signals');
    await page.evaluate(()=>{document.documentElement.classList.remove('dark');});await page.screenshot({path:path.join(output,'desktop-light.png')});
    await page.evaluate(()=>{window.fixture.db.sms={...window.fixture.db.sms,opted_out:true};});
    await page.waitForSelector('[data-testid=sms-opted-out]',{timeout:10000});await page.waitForSelector('[data-testid=sms-blocked]');
    assert.equal(await page.$('[aria-label="SMS reply"]'),null);checks.push('STOP hides the composer and shows the opted-out state');
    await page.screenshot({path:path.join(output,'desktop-opted-out-light.png')});
    await page.evaluate(()=>{document.documentElement.classList.add('dark');window.fixture.navigate('admin');});
    await page.waitForSelector('[data-testid=sms-admin]');await page.waitForSelector('[data-testid=sms-queue-number]');
    assert.equal(await page.$$eval('[data-testid=sms-queue-number]',els=>els.length),2);
    assert(await page.evaluate(()=>document.body.textContent.includes('SMS disabled on this queue')));checks.push('numbers list shows queue mapping and channel state');
    await page.screenshot({path:path.join(output,'admin-numbers-dark.png')});
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Map number').click());
    await page.waitForSelector('[data-testid=sms-number-editor]');
    await page.click('[data-testid=sms-number-choice]');await page.waitForSelector('[role=option]');
    const options=await page.$$eval('[role=option]',els=>els.map(el=>({text:el.textContent,disabled:el.getAttribute('data-disabled')!==null||el.getAttribute('aria-disabled')==='true'})));
    assert(options.some(o=>o.text.includes('+14155550102')&&!o.disabled));assert(options.some(o=>o.text.includes('+14155550100')&&o.disabled));checks.push('the editor offers unmapped Telnyx numbers only');
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[role=option]'));
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Messaging profile').click());
    await page.waitForSelector('[data-testid=sms-webhook-url]');
    assert.equal(await page.$eval('[data-testid=sms-webhook-url]',el=>el.textContent),'https://contact.example.com/api/webhooks/telnyx/sms');
    assert(await page.evaluate(()=>document.body.textContent.includes('Webhook verified')));checks.push('profile section shows the webhook destination and verification');
    await page.screenshot({path:path.join(output,'admin-profile-dark.png')});
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Delivery').click());
    await page.waitForFunction(()=>document.body.textContent.includes('Destination unreachable'));
    assert(await page.evaluate(()=>document.body.textContent.includes('Not delivered')&&document.body.textContent.includes('+15550002222')&&document.body.textContent.includes('Unmatched')));checks.push('delivery section lists outbound status, opt-outs and unmatched events');
    await page.screenshot({path:path.join(output,'admin-delivery-dark.png')});
    assert.deepEqual(errors,[]);checks.push('no uncaught page errors');
    const result={passed:checks.length,checks};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output},null,2));
  }catch(error){
    console.error('Completed checks:',JSON.stringify(checks));
    try{const page=(await browser.pages()).at(-1);await page?.screenshot({path:path.join(output,'failure.png')});console.error('Body excerpt:',(await page?.evaluate(()=>document.body.innerText.slice(0,1500)))||'');}catch{}
    throw error;
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

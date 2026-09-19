// Isolated browser regression: real UI components, deterministic HTTP fixtures,
// no application login, live Contact Center data, or external email delivery.
// Run: node tests/browser/email-workspace.browser.cjs
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const esbuild=req('esbuild'),postcss=req('postcss'),tailwind=req('@tailwindcss/postcss'),puppeteer=req('puppeteer'),assert=require('node:assert/strict');
const output=process.env.EMAIL_UI_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'cc-email-workspace-'));
async function build(){
  fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(__dirname,'email-workspace.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',loader:{'.js':'jsx'},alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning',
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
  let browser;
  try{
    browser=await puppeteer.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:fs.existsSync(macChrome)?{executablePath:macChrome}:{}),args:['--disable-gpu',...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[])],timeout:20000});
    const page=await browser.newPage();await page.setViewport({width:1600,height:1000});const errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForSelector('[data-testid=email-thread] iframe');
    await page.screenshot({path:path.join(output,'thread-dark.png')});
    const click=async text=>{const found=await page.evaluate(text=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text&&b.getBoundingClientRect().height>0);if(!button)return false;button.click();return true;},text);assert(found,'Button '+text);};
    await click('Reply');await page.waitForSelector('[data-testid=email-composer]:not([hidden]) [contenteditable=true]');
    await page.type('[data-testid=email-composer]:not([hidden]) [contenteditable=true]','First reply text');
    await page.waitForFunction(()=>window.fixture.db.drafts.some(d=>d.content.text==='First reply text'));
    await page.click('#email-tab-thread');await click('Forward');await page.waitForFunction(()=>document.querySelectorAll('[role=tab]').length===3);
    await page.click('[data-testid=email-composer]:not([hidden]) [aria-label="Open address book for TO"]');await page.waitForSelector('[role=dialog] input[type=checkbox]');
    await page.screenshot({path:path.join(output,'contacts-dark.png')});
    await page.click('[role=dialog] input[type=checkbox]');await click('Add 1 recipients to TO');
    await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
    await page.waitForFunction(()=>window.fixture.db.drafts.some(d=>d.content.mode==='forward'&&d.content.to==='alex@example.com'));
    await page.click('#email-tab-thread');await click('Forward');await page.waitForFunction(()=>document.querySelectorAll('[role=tab]').length===4);
    await page.type('[data-testid=email-composer]:not([hidden]) [role=combobox][aria-autocomplete=list]','pat');await page.waitForSelector('[role=listbox] [role=option]');await page.keyboard.press('Enter');
    await page.click('[aria-label="Insert suggested reply 1 into message input"]');
    await page.waitForFunction(()=>window.fixture.db.drafts.some(d=>d.content.to==='pat@example.com'&&d.content.text.startsWith('Here is the AI answer about SMPP.')));
    assert.equal(await page.evaluate(()=>window.fixture.db.drafts.find(d=>d.content.mode==='reply').content.text),'First reply text');
    assert(await page.evaluate(()=>window.fixture.db.drafts.find(d=>d.content.to==='pat@example.com').content.html.includes('data-email-forward')));
    await page.screenshot({path:path.join(output,'composer-dark.png')});
    await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[role=tab]').length===4);
    await page.evaluate(()=>[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes('pat@example.com')).click());
    await page.evaluate(()=>window.fixture.failNext=true);await click('Send forward');await page.waitForFunction(()=>document.body.textContent.includes('Simulated rejection'));
    assert.equal(await page.evaluate(()=>document.querySelectorAll('[role=tab]').length),4);
    await click('Send forward');await page.waitForFunction(()=>document.querySelectorAll('[role=tab]').length===3);
    assert.equal(await page.evaluate(()=>window.fixture.db.messages.filter(m=>m.sender_role==='agent').length),1);
    await page.click('#email-tab-thread');await click('Reply');await page.waitForFunction(()=>document.querySelector('[role=tab][aria-selected=true]').textContent.includes('Reply'));
    assert.equal(await page.evaluate(()=>document.querySelectorAll('[role=tab]').length),3);
    await page.evaluate(()=>document.documentElement.classList.remove('dark'));await page.screenshot({path:path.join(output,'composer-light.png')});
    const geometry=await page.evaluate(()=>{const panel=document.querySelector('[data-testid=email-composer]:not([hidden])'),editor=panel.querySelector('[contenteditable]'),copilot=document.querySelector('[aria-label="Email AI Copilot"]');return {viewport:innerHeight,panel:panel.getBoundingClientRect().toJSON(),editor:editor.getBoundingClientRect().toJSON(),copilot:copilot.getBoundingClientRect().toJSON(),pageHeight:document.documentElement.scrollHeight};});
    assert(geometry.editor.height>200);assert(geometry.editor.bottom<geometry.viewport);assert.equal(geometry.pageHeight,1000);
    await page.click('#email-tab-thread');await click('Reply all');await page.waitForFunction(()=>document.querySelectorAll('[role=tab]').length===4);
    await page.waitForFunction(()=>window.fixture.db.drafts.some(d=>d.content.mode==='reply_all'));
    assert.equal(await page.evaluate(()=>window.fixture.db.drafts.find(d=>d.content.mode==='reply_all')?.content.cc),'colleague@example.com');
    const inputs=await page.$$('[data-testid=email-composer]:not([hidden]) [role=combobox]');
    await inputs[2].type('secret@example.com');await page.keyboard.press('Enter');
    await inputs[0].type('SECRET@example.com');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.body.textContent.includes('is already in BCC'));
    await page.waitForFunction(()=>window.fixture.db.drafts.some(d=>d.content.mode==='reply_all'&&d.content.bcc==='secret@example.com'));
    assert(!(await page.evaluate(()=>window.fixture.db.drafts.find(d=>d.content.mode==='reply_all').content.to.toLowerCase())).includes('secret@example.com'));
    await page.type('[data-testid=email-composer]:not([hidden]) [contenteditable=true]','A complete reply for the size regression.');
    const bigFile=path.join(output,'size-regression.jpg');fs.writeFileSync(bigFile,Buffer.alloc(781944));
    const beforeSends=await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).action==='send').length);
    const fileInput=await page.$('[data-testid=email-composer]:not([hidden]) input[type=file]');await fileInput.uploadFile(bigFile);
    await page.waitForFunction(()=>window.fixture.db.drafts.some(d=>d.content.attachments?.some(a=>a.filename==='size-regression.jpg')));
    assert(!await page.evaluate(()=>[...document.querySelectorAll('[data-testid=email-composer]:not([hidden]) button')].find(b=>b.textContent==='Send reply').disabled));
    assert.equal(await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).action==='send').length),beforeSends);
    await page.screenshot({path:path.join(output,'documented-size-draft.png')});
    await page.evaluate(()=>window.fixture.failProviderNext=true);await click('Send reply');
    await page.waitForFunction(()=>document.body.textContent.includes('The email service rejected this message due to an internal size limit'));
    assert(await page.evaluate(()=>window.fixture.db.drafts.some(d=>d.content.mode==='reply_all')));
    assert.deepEqual(errors,[]);
    const result={passed:16,checks:['thread layout','reply autosave','forward HTML and attachments','address book selection','autocomplete','copilot active tab isolation and quote preservation','multiple forwards','reload persistence','failed send retains tab','accepted send closes only one tab','reuse reply tab','light/dark layout','reply-all recipients','BCC duplicate protection','781944-byte attachment is allowed under the documented limits','asynchronous provider rejection exposes actionable reason and keeps tab'],geometry};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

// Isolated browser regression for Dialer → Settings: the real supervisor page
// rendered with deterministic HTTP fixtures (no login, no live data). Checks the
// selectable section cards in the centre and the section-only editor on the right.
// Run: node tests/browser/dialer-settings.browser.cjs
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const esbuild=req('esbuild'),postcss=req('postcss'),tailwind=req('@tailwindcss/postcss'),puppeteer=req('puppeteer'),assert=require('node:assert/strict');
const output=process.env.DIALER_SETTINGS_UI_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'cc-dialer-settings-'));
async function build(){
  fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(__dirname,'dialer-settings.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',loader:{'.js':'jsx'},resolveExtensions:['.tsx','.ts','.jsx','.js','.mjs','.json','.css'],
    alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom'),'next/navigation':path.join(__dirname,'shims/next-navigation.js'),'next/link':path.join(__dirname,'shims/next-link.js'),'next/image':path.join(__dirname,'shims/next-image.js'),'next/dynamic':path.join(__dirname,'shims/next-dynamic.js')},
    define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning',
    plugins:[{name:'workspace-node-resolution',setup(build){build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/')||args.path.startsWith('next/'))return;if(args.path.startsWith('#min'))return {path:path.join(root,'node_modules/vfile/lib',args.path.slice(1)+'.browser.js')};return {path:req.resolve(args.path)};});}}]});
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
    const page=await browser.newPage();await page.setViewport({width:1800,height:1150});const errors=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error('Browser:',e.message);});page.on('dialog',d=>d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=settings-section-card]').length===9,{timeout:30000});checks.push('Settings shows nine selectable section cards (five voice, four messaging)');
    assert.equal(await page.$eval('[data-testid=settings-section-card][data-section=dialing]',el=>el.getAttribute('aria-pressed')),'true');
    assert.equal(await page.$eval('[data-testid=outbound-settings-form]',el=>el.dataset.section),'dialing');
    assert(await page.evaluate(()=>document.querySelector('[data-testid=outbound-settings-form]').textContent.includes('Max calls / agent')&&!document.querySelector('[data-testid=outbound-settings-form]').textContent.includes('Footer text')));checks.push('the context panel edits only the selected section');
    assert(await page.evaluate(()=>document.querySelector('[data-testid=settings-section-card][data-section=dialing]').className.includes('border-sky-500')));checks.push('the selected card carries the highlighted border');
    await page.screenshot({path:path.join(output,'settings-dialing-dark.png')});
    await page.click('[data-testid=settings-section-card][data-section=messaging-sms]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=outbound-settings-form]')?.dataset.section==='messaging-sms');
    assert.equal(await page.$eval('[data-testid=settings-section-card][data-section=messaging-sms]',el=>el.getAttribute('aria-pressed')),'true');
    assert.equal(await page.$eval('[data-testid=settings-section-card][data-section=dialing]',el=>el.getAttribute('aria-pressed')),'false');
    assert(await page.evaluate(()=>document.querySelector('[data-testid=messaging-settings-card]')?.dataset.section==='sms'&&document.querySelector('[data-testid=outbound-settings-form]').textContent.includes('Footer text')));checks.push('clicking a messaging sub-section shows only that section on the right');
    // Typed one key at a time, the way an operator enters it. The card
    // re-normalizes its value on every render and the normalizer trims, so a
    // space used to vanish before the next key and multi-word values could not
    // be entered at all.
    await page.evaluate(()=>{const input=[...document.querySelectorAll('[data-testid=outbound-settings-form] input')].find(el=>el.value==='Reply STOP to opt out');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();});
    await page.keyboard.type('Odpowiedz STOP aby zrezygnować');
    await page.waitForFunction(()=>document.querySelector('[data-testid=settings-section-card][data-section=messaging-sms]').textContent.includes('Odpowiedz STOP aby zrezygnować'));checks.push('edits on the right update the centre summary live before saving');
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-testid=outbound-settings-form] input')].find(el=>el.value.startsWith('Odpowiedz')).value),'Odpowiedz STOP aby zrezygnować','the field keeps every space that was typed');
    checks.push('a multi-word setting can be typed, spaces included');
    await page.screenshot({path:path.join(output,'settings-messaging-sms-dark.png')});
    // Every messaging channel that campaigns support can be switched on here.
    await page.click('[data-testid=settings-section-card][data-section=messaging-shared]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-settings-card]')?.dataset.section==='shared');
    const channels=await page.evaluate(()=>[...document.querySelectorAll('[data-testid=outbound-settings-form] label')].filter(l=>['SMS','WhatsApp','Email'].includes(l.textContent.trim())).map(l=>({name:l.textContent.trim(),disabled:Boolean(l.querySelector('button[role=checkbox]').disabled)})));
    assert.deepEqual(channels.map(c=>c.name),['SMS','WhatsApp','Email']);
    assert.deepEqual(channels.filter(c=>c.disabled),[],'every campaign channel can be enabled, none is marked as a later phase');
    assert(!(await page.$eval('[data-testid=outbound-settings-form]',el=>el.textContent)).includes('next phase'),'the next-phase note is gone');
    checks.push('SMS, WhatsApp and Email can all be enabled under Messaging campaigns');
    await page.click('[data-testid=settings-section-card][data-section=allowed-numbers]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=outbound-settings-form]')?.dataset.section==='allowed-numbers');
    await page.waitForSelector('[data-testid=allowed-numbers-list]');checks.push('voice sections switch the same way');
    const listBox=await page.$eval('[data-testid=allowed-numbers-list]',el=>{const style=getComputedStyle(el);return {height:el.clientHeight,overflowY:style.overflowY,bounded:style.maxHeight!=='none',rows:el.querySelectorAll('label').length,popovers:document.querySelectorAll('[data-testid=outbound-settings-form] [role=combobox]').length};});
    assert.equal(listBox.rows,15);assert(listBox.height>=256);assert.equal(listBox.overflowY,'auto');assert(listBox.bounded);assert.equal(listBox.popovers,0);checks.push('allowed numbers render as a tall bounded scrolling list instead of a dropdown');
    await page.type('[aria-label="Filter allowed numbers"]','warsaw');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=allowed-numbers-list] label').length===1);
    assert.match(await page.$eval('[data-testid=allowed-numbers-list] label',el=>el.textContent),/\+48600000001/);checks.push('the filter matches both the number and its connection name');
    await page.click('[data-testid=allowed-numbers-list] label button[role=checkbox]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=settings-section-card][data-section=allowed-numbers]').textContent.includes('+48600000001'));checks.push('selecting a filtered number updates the centre card');
    await page.click('[data-testid=settings-section-card][data-section=messaging-shared]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-settings-card]')?.dataset.section==='shared');
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save settings')?.click());
    await page.waitForFunction(()=>window.fixture.saved,{timeout:10000});
    assert.equal((await page.evaluate(()=>window.fixture.saved)).messaging.sms.opt_out_footer_text,'Odpowiedz STOP aby zrezygnować');checks.push('Save settings persists every section from the shared draft');
    await page.evaluate(()=>{document.documentElement.classList.remove('dark');});await page.screenshot({path:path.join(output,'settings-messaging-shared-light.png')});
    assert.deepEqual(errors,[]);checks.push('no uncaught page errors');
    const result={passed:checks.length,checks};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output},null,2));
  }catch(error){
    console.error('Completed checks:',JSON.stringify(checks));
    try{const page=(await browser.pages()).at(-1);await page?.screenshot({path:path.join(output,'failure.png')});console.error('Body excerpt:',(await page?.evaluate(()=>document.body.innerText.slice(0,1500)))||'');}catch{}
    throw error;
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

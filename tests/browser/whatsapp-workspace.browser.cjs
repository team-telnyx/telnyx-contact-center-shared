// Isolated browser regression: real WhatsApp agent and admin components, deterministic
// HTTP fixtures, no application login, live Contact Center data or Telnyx traffic.
// Run: node tests/browser/whatsapp-workspace.browser.cjs
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const esbuild=req('esbuild'),postcss=req('postcss'),tailwind=req('@tailwindcss/postcss'),puppeteer=req('puppeteer'),assert=require('node:assert/strict');
const output=process.env.WHATSAPP_UI_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'cc-whatsapp-workspace-'));
async function build(){
  fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(__dirname,'whatsapp-workspace.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',loader:{'.js':'jsx'},alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning',
    plugins:[{name:'workspace-node-resolution',setup(build){build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/'))return;if(args.path.startsWith('#min'))return {path:path.join(root,'node_modules/vfile/lib',args.path.slice(1)+'.browser.js')};return {path:req.resolve(args.path)};});}}]});
  const css=await postcss([tailwind({base:root})]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
  fs.writeFileSync(path.join(output,'app.css'),css.css);
  fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  fs.writeFileSync(path.join(output,'receipt.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64'));
}
async function rail(page,label){
  await page.evaluate(label=>[...document.querySelectorAll('nav[aria-label="WhatsApp administration sections"] button')].find(b=>b.textContent.trim()===label).click(),label);
  await page.waitForFunction(label=>document.querySelector('nav[aria-label="WhatsApp administration sections"] [aria-current=page]')?.textContent.trim()===label,{timeout:10000},label)
    .catch(async()=>{throw new Error(`Rail did not switch to ${label}; active=${await page.evaluate(()=>document.querySelector('nav[aria-label="WhatsApp administration sections"] [aria-current=page]')?.textContent)} section=${await page.evaluate(()=>document.querySelector('[data-testid=whatsapp-admin-content]')?.getAttribute('aria-label'))}`);});
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
    // Map tiles are served locally: the regression must not depend on the tile server.
    const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
    await page.setRequestInterception(true);
    page.on('request',request=>{if(request.url().includes('tile.openstreetmap.org'))request.respond({status:200,contentType:'image/png',body:tile});
      else if(request.url().includes('google.com/maps'))request.respond({status:200,contentType:'text/html',body:'<!doctype html><p>map</p>'});else request.continue();});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('[data-testid=chat-interaction-detail][data-channel=whatsapp]');
    await page.waitForSelector('[data-testid=whatsapp-counter]');
    assert.equal(await page.$eval('[data-testid=whatsapp-business-number]',el=>el.textContent),'Support WhatsApp +14155550100');checks.push('WhatsApp header shows the business number');
    assert.equal(await page.$eval('[data-testid=whatsapp-window]',el=>el.dataset.windowOpen),'true');
    assert.match(await page.$eval('[data-testid=whatsapp-window]',el=>el.textContent),/Window \d+ h/);checks.push('the 24-hour window badge shows the remaining time');
    assert.deepEqual(await page.$$eval('[data-testid=message-delivery]',els=>els.map(el=>el.dataset.deliveryStatus)),['delivered','read']);checks.push('agent bubbles show delivered and read receipts');
    await page.waitForSelector('[data-testid=whatsapp-location] [data-testid=location-map]');
    assert.ok((await page.$$('[data-testid=whatsapp-location] [data-testid=location-map-tile]')).length>=2);checks.push('a shared location shows a static map preview');
    await page.evaluate(()=>document.querySelector('[data-testid=whatsapp-location]').click());
    await page.waitForSelector('[data-testid=location-preview-dialog] [data-testid=location-google-map]');
    assert.match(await page.$eval('[data-testid=location-google-map]',el=>el.src),/^https:\/\/maps\.google\.com\/maps\?q=52\.23%2C21\.01&z=15&output=embed$/);
    assert.match(await page.$eval('[data-testid=location-open-maps]',el=>el.href),/google\.com\/maps/);
    assert.equal(await page.$eval('[data-testid=location-open-maps]',el=>el.target),'_blank');
    await page.screenshot({path:path.join(output,'location-preview-dark.png')});
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-testid=location-preview-dialog]'));checks.push('the map thumbnail opens a preview modal with an embedded Google map and an external link');
    assert.deepEqual(await page.$$eval('[data-testid=message-reactions] [data-emoji]',els=>els.map(el=>[el.dataset.emoji,el.dataset.sender])),[['😮','customer']]);checks.push("the customer's reaction is pinned to the agent bubble instead of a separate bubble");
    await page.screenshot({path:path.join(output,'desktop-dark.png')});
    await page.type('[aria-label="WhatsApp reply"]','Zamówienie gotowe');
    await page.waitForFunction(()=>document.querySelector('[data-testid=whatsapp-bytes]').textContent==='18');checks.push('the byte counter follows UTF-8 length');
    const input=await page.$('input[type=file]');await input.uploadFile(path.join(output,'receipt.png'));
    await page.waitForSelector('[data-testid=whatsapp-media-kind]');
    assert.equal(await page.$eval('[data-testid=whatsapp-media-kind]',el=>el.value),'image');
    await page.select('[data-testid=whatsapp-media-kind]','sticker');checks.push('an attached picture can be sent as an image, sticker or document');
    await page.screenshot({path:path.join(output,'composer-media-dark.png')});
    await page.evaluate(()=>[...document.querySelectorAll('button[type=submit]')].find(b=>b.textContent.trim()==='Send').click());
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=message-delivery]').length===3);
    const upload=await page.evaluate(()=>window.fixture.requests.filter(r=>r.form).map(r=>({...JSON.parse(r.form.message),files:r.form.files})));
    assert.equal(upload.length,1);assert.deepEqual(upload[0].mediaKinds,['sticker']);assert.equal(upload[0].body,'Zamówienie gotowe');assert.equal(upload[0].files[0].name,'receipt.png');checks.push('media replies go through the multipart endpoint with the chosen media kinds');
    await page.click('[aria-label="Search Pexels photos"]');await page.waitForSelector('[data-testid=pexels-picker]');
    await page.type('[aria-label="Pexels search"]','sunset');await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=pexels-picker] img');
    await page.evaluate(()=>document.querySelector('[aria-label^="Attach photo"]').click());
    await page.waitForFunction(()=>document.body.textContent.includes('sunset-42.jpg'));checks.push('a Pexels photo is fetched through the proxy and attached to the reply');
    await page.evaluate(()=>document.querySelector('[aria-label="Remove attachment sunset-42.jpg"]').click());
    // The Pexels dialog is still animating out; wait for it before opening the next one.
    await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
    await page.evaluate(()=>document.querySelector('[aria-label="Send a location"]').click());await page.waitForSelector('[data-testid=whatsapp-location-dialog]');
    await page.type('[aria-label="Address search"]','Nowy Swiat');
    await page.waitForSelector('[data-testid=whatsapp-location-results] button');await page.click('[data-testid=whatsapp-location-results] button');
    await page.waitForSelector('[data-testid=whatsapp-location-dialog] [data-testid=location-map]');
    assert.equal(await page.$eval('[data-testid=whatsapp-location-latitude]',el=>el.value),'52.2297');checks.push('address search fills the coordinates and previews the map');
    await page.screenshot({path:path.join(output,'location-dialog-light.png')});
    await page.click('[data-testid=whatsapp-location-send]');
    await page.waitForFunction(()=>!document.querySelector('[data-testid=whatsapp-location-dialog]')&&document.querySelectorAll('[data-testid=message-delivery]').length===4);
    const locationSend=await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).location).map(r=>JSON.parse(r.body)));
    assert.equal(locationSend.length,1);assert.deepEqual(locationSend[0].location,{latitude:52.2297,longitude:21.0122,name:'Telnyx office',address:'Nowy Świat 1, 00-497 Warszawa, Polska'});checks.push('the location is sent through the command endpoint and renders with a map');
    await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
    await page.evaluate(()=>document.querySelector('[aria-label="Send a contact card"]').click());await page.waitForSelector('[data-testid=whatsapp-contact-dialog]');
    await page.waitForSelector('[data-testid=whatsapp-contact-option]');await page.click('[data-testid=whatsapp-contact-option]');
    await page.click('[data-testid=whatsapp-contact-send]');
    await page.waitForFunction(()=>!document.querySelector('[data-testid=whatsapp-contact-dialog]')&&document.querySelector('[data-testid=whatsapp-contact-card]'));
    const contactSend=await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).contactIds).map(r=>JSON.parse(r.body)));
    assert.deepEqual(contactSend.map(r=>r.contactIds),[['ct-1']]);checks.push('a directory contact is sent as a WhatsApp contact card');
    await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
    await page.evaluate(()=>document.querySelector('[data-testid=chat-message][data-role=customer] [data-testid=message-react]').click());
    await page.waitForSelector('[data-testid=message-react-option]');
    // The popover animates into place; click through the DOM rather than by coordinates.
    await page.evaluate(()=>document.querySelector('[data-testid=message-react-option][data-emoji="👍"]').click());
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid=message-reactions] [data-emoji]')].some(el=>el.dataset.sender==='agent'&&el.dataset.emoji==='👍'));
    const reactionSend=await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).reaction).map(r=>JSON.parse(r.body)));
    assert.deepEqual(reactionSend.map(r=>r.reaction),[{messageId:'m1',emoji:'👍'}]);checks.push('the agent reacts to a customer message from its bubble');
    await page.evaluate(()=>{window.fixture.db.whatsapp={...window.fixture.db.whatsapp,window:{open:false,expiresAt:null,remainingMs:0}};});
    await page.waitForSelector('[data-testid=whatsapp-blocked]',{timeout:10000});
    assert.equal(await page.$('[aria-label="WhatsApp reply"]'),null);checks.push('a closed window hides the composer and offers a template');
    await page.evaluate(()=>{document.documentElement.classList.remove('dark');});await page.screenshot({path:path.join(output,'window-closed-light.png')});
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Send template').click());
    await page.waitForSelector('[data-testid=whatsapp-template-choice]');
    await page.waitForSelector('[data-testid=whatsapp-template-dialog] [data-testid=whatsapp-phone-preview]');
    assert.match(await page.$eval('[data-testid=whatsapp-template-choice]',el=>el.textContent),/order_update/);
    const fields=await page.$$('[data-testid=whatsapp-template-dialog] input');await fields[fields.length-1].type('1234');
    await page.waitForFunction(()=>document.querySelector('[data-testid=whatsapp-template-dialog] [data-testid=whatsapp-phone-preview]').textContent.includes('Hi Anna, your order 1234 is ready.'));checks.push('the iPhone preview fills in the agent values');
    await page.screenshot({path:path.join(output,'template-dialog-light.png')});
    await page.evaluate(()=>[...document.querySelectorAll('[data-testid=whatsapp-template-dialog] button')].find(b=>b.textContent.trim()==='Send template').click());
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=message-delivery]').length===6);
    const templateSend=await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).template).map(r=>JSON.parse(r.body)));
    assert.equal(templateSend.length,1);assert.equal(templateSend[0].template.id,'tpl-1');assert.equal(templateSend[0].template.values['body:2'],'1234');checks.push('an approved template is sent with the filled variables');
    assert.equal(await page.evaluate(()=>window.fixture.requests.filter(r=>r.body&&JSON.parse(r.body).action==='typing').length),0);checks.push('WhatsApp never sends typing signals');
    await page.evaluate(()=>{document.documentElement.classList.add('dark');window.fixture.navigate('admin');});
    await page.waitForSelector('[data-testid=whatsapp-admin]');await page.waitForSelector('[data-testid=whatsapp-queue-number]');
    assert.equal(await page.$$eval('[data-testid=whatsapp-queue-number]',els=>els.length),2);
    assert(await page.evaluate(()=>document.body.textContent.includes('WhatsApp disabled on this queue')));checks.push('numbers list shows queue mapping and channel state');
    await page.screenshot({path:path.join(output,'admin-numbers-dark.png')});
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Map number').click());
    await page.waitForSelector('[data-testid=whatsapp-number-editor]');
    await page.click('[data-testid=whatsapp-number-choice]');await page.waitForSelector('[role=option]');
    const options=await page.$$eval('[role=option]',els=>els.map(el=>({text:el.textContent,disabled:el.getAttribute('data-disabled')!==null||el.getAttribute('aria-disabled')==='true'})));
    assert(options.some(o=>o.text.includes('+14155550101')&&!o.disabled));assert(options.some(o=>o.text.includes('+14155550100')&&o.disabled));checks.push('the editor offers unmapped WhatsApp numbers only');
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[role=option]'));
    await page.click('[data-testid=whatsapp-profile-choice]');await page.waitForSelector('[cmdk-input]');await page.type('[cmdk-input]','Contact');
    await page.waitForFunction(()=>[...document.querySelectorAll('[cmdk-item]')].some(el=>el.textContent.includes('Contact Center WhatsApp')));checks.push('the messaging profile picker filters profiles by name');
    await page.keyboard.press('Escape');
    await rail(page,'Details');
    await page.waitForSelector('[data-testid=whatsapp-webhook-url]');
    assert.equal(await page.$eval('[data-testid=whatsapp-webhook-url]',el=>el.textContent),'https://contact.example.com/api/webhooks/telnyx/whatsapp');
    await page.waitForFunction(()=>document.body.textContent.includes('Using the backup key')&&document.body.textContent.includes('waba-1'));checks.push('details show the resolved backup credentials, the webhook and the account');
    await page.screenshot({path:path.join(output,'admin-details-dark.png')});
    await rail(page,'Templates');
    await page.waitForSelector('[data-testid=whatsapp-template-select]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=whatsapp-template-count]')?.textContent.startsWith('1 template on waba-1'));
    await page.waitForSelector('[data-testid=whatsapp-templates] [data-testid=whatsapp-phone-preview]');
    await page.click('[data-testid=whatsapp-template-language]');await page.waitForSelector('[cmdk-input]');await page.type('[cmdk-input]','pol');
    await page.waitForFunction(()=>[...document.querySelectorAll('[cmdk-item]')].some(el=>el.textContent.includes('Polish')&&el.textContent.includes('🇵🇱')));checks.push('the language picker filters languages and shows flags');
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[cmdk-input]'));
    await page.click('[data-testid=whatsapp-template-select]');await page.waitForSelector('[role=option]');
    assert.deepEqual(await page.$$eval('[role=option]',els=>els.map(el=>el.textContent.includes('order_update'))),[false,true]);
    const templateOptions=await page.$$('[role=option]');for(const option of templateOptions){if((await option.evaluate(el=>el.textContent)).includes('order_update')){await option.click();break;}}
    await page.waitForFunction(()=>document.querySelector('[data-testid=whatsapp-templates] [data-testid=whatsapp-phone-preview]').textContent.includes('Hi Anna, your order WA-1 is ready.')||document.querySelector('[data-testid=whatsapp-templates] [data-testid=whatsapp-phone-preview]').textContent.includes('Hi {{1}}'));checks.push('templates section lists the account templates and renders the iPhone preview');
    await page.screenshot({path:path.join(output,'admin-templates-dark.png')});
    await rail(page,'Phone numbers');
    await page.waitForSelector('[data-testid=whatsapp-phone-card]');
    assert.equal(await page.$$eval('[data-testid=whatsapp-phone-card]',els=>els.length),3);
    await page.evaluate(()=>document.querySelectorAll('[data-testid=whatsapp-phone-card]')[0].click());
    await page.waitForSelector('[data-testid=whatsapp-phone-editor]');
    await page.waitForFunction(()=>document.body.textContent.includes('Business profile')&&document.querySelector('input[placeholder="Messaging profile ID"]')?.value==='mp-cc');checks.push('phone numbers section opens the business profile editor with the inbound messaging profile');
    await page.screenshot({path:path.join(output,'admin-phone-numbers-dark.png')});
    await rail(page,'Delivery');
    await page.waitForFunction(()=>document.body.textContent.includes('Message undeliverable'));
    assert(await page.evaluate(()=>document.body.textContent.includes('Not delivered')&&document.body.textContent.includes('Read')&&document.body.textContent.includes('Unmatched')));checks.push('delivery section lists outbound status and unmatched events');
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

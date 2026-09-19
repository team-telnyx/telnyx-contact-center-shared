// Isolated browser regression for messaging campaigns: the Admin → SMS →
// Templates section, the campaign editor panel and the dialer settings card
// rendered with deterministic HTTP fixtures (no login, no Telnyx traffic).
// Run: node tests/browser/messaging-campaigns.browser.cjs
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const esbuild=req('esbuild'),postcss=req('postcss'),tailwind=req('@tailwindcss/postcss'),puppeteer=req('puppeteer'),assert=require('node:assert/strict');
const output=process.env.MESSAGING_UI_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'cc-messaging-campaigns-'));
async function build(){
  fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(__dirname,'messaging-campaigns.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',loader:{'.js':'jsx'},resolveExtensions:['.jsx','.js','.mjs','.json','.css','.tsx','.ts'],alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning',
    plugins:[{name:'workspace-node-resolution',setup(build){build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/'))return;if(args.path.startsWith('#min'))return {path:path.join(root,'node_modules/vfile/lib',args.path.slice(1)+'.browser.js')};return {path:req.resolve(args.path)};});}}]});
  const css=await postcss([tailwind({base:root})]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
  fs.writeFileSync(path.join(output,'app.css'),css.css);
  fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
}
// The context panel is a fixed 380px column. Anything that makes it scroll
// sideways hides the left edge of every label, which is how the configuration
// forms became unreadable. `scrollWidth` still reports the overflow even though
// the panel clips it, and `wide` names the offenders when the check fails.
const panelOverflow=page=>page.evaluate(()=>{
  const panel=document.querySelector('[data-testid=config-panel]');
  const scroller=panel.querySelector('[data-testid=config-panel-scroll]')||panel.querySelector('.overflow-y-auto')||panel;
  const box=scroller.getBoundingClientRect();
  const wide=[...scroller.querySelectorAll('*')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.right>box.right+1&&getComputedStyle(el.parentElement||el).overflowX==='visible';})
    .map(el=>`${el.tagName.toLowerCase()}[${String(el.getAttribute('class')||'').slice(0,70)}]`);
  return {overflow:scroller.scrollWidth-scroller.clientWidth,width:box.width,wide:[...new Set(wide)].slice(0,6)};
});
const assertFits=async(page,what)=>{const result=await panelOverflow(page);assert.equal(result.overflow,0,`${what}: the ${result.width}px panel scrolls ${result.overflow}px sideways. Widest: ${JSON.stringify(result.wide)}`);};
const clickButton=(page,label)=>page.evaluate(text=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!button)throw new Error(`Button ${text} not found`);button.click();},label);
(async()=>{
  await build();
  const server=http.createServer((request,response)=>{const file={'/':'index.html','/app.js':'app.js','/app.css':'app.css'}[request.url];if(!file){response.writeHead(404).end();return;}response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');response.end(fs.readFileSync(path.join(output,file)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const macChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let browser;const checks=[];
  try{
    browser=await puppeteer.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:fs.existsSync(macChrome)?{executablePath:macChrome}:{}),args:['--disable-gpu',...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[])],timeout:20000});
    const page=await browser.newPage();await page.setViewport({width:1600,height:1100});const errors=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error('Browser:',e.message);});page.on('dialog',d=>d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    // Admin → SMS → Templates
    await page.waitForSelector('[data-testid=sms-templates]');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=sms-template-row]').length===1);checks.push('Templates section opens from the initial section and lists stored templates');
    await page.type('[data-testid=sms-template-name]','Appointment reminder');
    await page.type('[data-testid=sms-template-body]','Cześć {{first_name}}, przypominamy o wizycie {{appointment_date}}.');
    await page.waitForFunction(()=>document.querySelector('[data-testid=sms-template-segments]').textContent.includes('UCS-2'));
    assert.match(await page.$eval('[data-testid=sms-template-segments]',el=>el.textContent),/UCS-2 · 2 parts/);checks.push('Polish characters switch the template counter to UCS-2 with the footer counted');
    await page.waitForSelector('[data-testid=sms-template-sample-first_name]');
    await page.type('[data-testid=sms-template-sample-first_name]','Anna');
    await page.waitForFunction(()=>document.querySelector('[data-testid=sms-phone-preview]').textContent.includes('Cześć Anna'));
    assert(await page.evaluate(()=>document.querySelector('[data-testid=sms-phone-preview]').textContent.includes('Reply STOP to opt out')));checks.push('phone preview renders sample values and the inherited opt-out footer');
    // Emoji picker: same component as the agent composer, inserted at the caret.
    await page.evaluate(()=>{const field=document.querySelector('[data-testid=sms-template-body]');field.focus();field.setSelectionRange(5,5);});
    await page.click('[data-testid=sms-template-emoji]');
    await page.waitForSelector('em-emoji-picker',{timeout:20000});
    await page.waitForFunction(()=>document.querySelector('em-emoji-picker')?.shadowRoot?.querySelector('span.emoji-mart-emoji'),{timeout:20000});
    const emoji=await page.evaluate(()=>{
      const button=document.querySelector('em-emoji-picker').shadowRoot.querySelector('span.emoji-mart-emoji').closest('button');
      const native=button.getAttribute('aria-label');button.click();return native;
    });
    await page.waitForFunction(()=>!document.querySelector('em-emoji-picker'));
    const withEmoji=await page.$eval('[data-testid=sms-template-body]',el=>el.value);
    assert.equal(withEmoji,`Cześć${emoji} {{first_name}}, przypominamy o wizycie {{appointment_date}}.`);checks.push('the shared emoji picker inserts the chosen emoji at the caret');
    await page.waitForFunction(()=>document.querySelector('[data-testid=sms-phone-preview]').textContent.includes('Anna'));
    await page.evaluate(()=>{const field=document.querySelector('[data-testid=sms-template-body]');const native=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;native.call(field,'Cześć {{first_name}}, przypominamy o wizycie {{appointment_date}}.');field.dispatchEvent(new Event('input',{bubbles:true}));});
    // Language: the WhatsApp catalogue with flags and name search.
    await page.click('#sms-template-language');
    await page.waitForSelector('[role=option]');
    await page.type('input[placeholder="Filter languages…"]','Polish');
    await page.waitForFunction(()=>document.querySelectorAll('[role=option]').length===1);
    await page.evaluate(()=>document.querySelector('[role=option]').click());
    await page.waitForFunction(()=>document.querySelector('#sms-template-language').textContent.includes('Polish'));
    assert(await page.evaluate(()=>document.querySelector('#sms-template-language').textContent.includes('🇵🇱')));checks.push('the language picker filters the shared catalogue by name and shows its flag');
    // Opt-out footer: editable under "Append footer", explained under "No footer".
    await page.waitForSelector('[data-testid=sms-template-footer-text]');
    await page.type('[data-testid=sms-template-footer-text]','STOP konczy wysylke');
    await page.waitForFunction(()=>document.querySelector('[data-testid=sms-phone-preview]').textContent.includes('STOP konczy wysylke'));
    assert(!await page.evaluate(()=>document.querySelector('[data-testid=sms-phone-preview]').textContent.includes('Reply STOP to opt out')));checks.push('an edited footer replaces the workspace default in the preview');
    await page.evaluate(()=>{const field=document.querySelector('[data-testid=sms-template-footer-text]');const native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;native.call(field,'');field.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('[data-testid=sms-template-footer]');await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()==='No footer').click());
    await page.waitForSelector('[data-testid=sms-template-footer-required]');
    assert(await page.evaluate(()=>document.querySelector('[data-testid=sms-phone-preview]').textContent.includes('Reply STOP to opt out')));checks.push('choosing "No footer" explains that the workspace still requires one');
    await page.evaluate(()=>{window.fixture.footerPolicy.required=false;});
    await clickButton(page,'Refresh');
    await page.waitForSelector('[data-testid=sms-template-footer-off]');
    await page.waitForFunction(()=>!document.querySelector('[data-testid=sms-phone-preview]').textContent.includes('Reply STOP to opt out'));checks.push('the footer disappears once the workspace stops requiring it');
    await page.click('[data-testid=sms-template-footer]');await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()==='Append footer').click());
    await page.waitForSelector('[data-testid=sms-template-footer-text]');
    await page.screenshot({path:path.join(output,'admin-templates-dark.png')});
    await page.click('[data-testid=sms-template-save]');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=sms-template-row]').length===2);
    const saved=await page.evaluate(()=>window.fixture.requests.filter(r=>r.method==='POST').map(r=>JSON.parse(r.body)).find(b=>b.action==='save_template'));
    assert.equal(saved.name,'Appointment reminder');assert.equal(saved.category,'marketing');assert.match(saved.body,/\{\{appointment_date\}\}/);
    assert.equal(saved.language,'pl');assert.equal(saved.footer_mode,'inherit');checks.push('creating a template posts name, category, body, language and footer mode');
    await page.evaluate(()=>{document.documentElement.classList.remove('dark');});await page.screenshot({path:path.join(output,'admin-templates-light.png')});
    // Campaign editor panel
    await page.evaluate(()=>{document.documentElement.classList.add('dark');window.fixture.navigate('campaign');});
    await page.waitForSelector('[data-testid=messaging-message-card]');
    assert.match(await page.$eval('[data-testid=messaging-requirements]',el=>el.textContent),/Destination fields, Sender, Template/);checks.push('the editor lists the missing messaging requirements');
    await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-sender-card] label')].find(l=>l.textContent.includes('+14155550100'));label.querySelector('button[role=checkbox]').click();});
    await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-destination-card] label')].find(l=>l.textContent.includes('number · mobile'));label.querySelector('button[role=checkbox]').click();});
    await page.click('[data-testid=messaging-template-select]');await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Order ready')).click());
    await page.waitForSelector('[data-testid=messaging-mapping-first_name]');await page.waitForSelector('[data-testid=messaging-mapping-code]');checks.push('selecting a template creates a mapping row per variable');
    await clickButton(page,'Auto-map');
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-mapping-first_name]').textContent.includes('First Name')&&document.querySelector('[data-testid=messaging-mapping-code]').textContent.includes('code'));checks.push('auto-map matches template variables to contact-list columns');
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-preview-status]').textContent.includes('Ready to send for this contact'),{timeout:15000});
    assert.match(await page.$eval('[data-testid=messaging-preview-text]',el=>el.textContent),/Hi Anna, your order A1 is ready\./);
    assert.equal(await page.$('[data-testid=sms-phone-preview]'),null,'the campaign editor previews the message as text, without the phone mock-up');checks.push('the live preview renders the first contact through the mapping as plain text');
    const draft=await page.evaluate(()=>window.fixture.draft.metadata.messaging);
    assert.deepEqual(draft.destination_fields,['number:mobile']);assert.deepEqual(draft.sender.sms.number_ids,['n1']);assert.equal(draft.template.sms.template_id,'t1');checks.push('the campaign draft stores sender, destination and template in metadata.messaging');
    // A test send and an audience validation both run against the stored
    // campaign, so switching the channel of a saved campaign must disable them
    // until the campaign is saved, instead of reporting a confusing server error.
    await page.evaluate(()=>window.fixture.setUnsaved(true));
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-test-send]').disabled);
    const blocked=await page.evaluate(()=>({
      send:document.querySelector('[data-testid=messaging-test-send]').disabled,
      validate:document.querySelector('[data-testid=messaging-validate]').disabled,
      sendHint:document.querySelector('[data-testid=messaging-test-hint]').textContent,
      validateHint:document.querySelector('[data-testid=messaging-validate-hint]').textContent,
    }));
    assert(blocked.send&&blocked.validate,'both actions are disabled while the draft is unsaved');
    assert(/Save the campaign to test it/.test(blocked.sendHint),'the send hint says to save first');
    assert(/Save the campaign to validate it/.test(blocked.validateHint),'the validation hint says to save first');
    await page.evaluate(()=>window.fixture.setUnsaved(false));
    await page.waitForFunction(()=>!document.querySelector('[data-testid=messaging-test-send]').disabled);
    checks.push('an unsaved channel change disables the test send and audience validation until the campaign is saved');
    // The workspace policy overrides "No footer", so the campaign says so too.
    const footerNote=await page.$eval('[data-testid=messaging-footer-note]',el=>el.textContent);
    assert(/requires an opt-out footer/.test(footerNote),'the campaign panel explains the workspace footer policy');checks.push('the campaign panel explains that a required opt-out footer overrides "No footer"');
    // Layout: the drawer is the width the forms get, so they must fit it.
    await assertFits(page,'SMS campaign');checks.push('the SMS campaign panel fits the 380px context column without scrolling sideways');
    const trigger=await page.evaluate(()=>{const el=document.querySelector('[data-testid=messaging-template-select]');const r=el.getBoundingClientRect();const panel=document.querySelector('[data-testid=config-panel]').getBoundingClientRect();return {text:el.textContent.trim(),fits:r.right<=panel.right+1,clipped:el.scrollWidth<=el.clientWidth+1};});
    assert(trigger.text.startsWith('Order ready'),trigger.text);assert(trigger.fits&&trigger.clipped,JSON.stringify(trigger));
    assert(await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-mapping-first_name] span')].map(s=>s.textContent.trim());return label.includes('Source')&&label.includes('Fallback');}),'mapping rows stack with their own labels in a narrow panel');
    checks.push('the template name is truncated inside the trigger and mapping rows stack with labels');
    // An empty catalogue explains itself below the field instead of rendering
    // the whole sentence as the selected value inside the trigger.
    await page.evaluate(()=>window.fixture.setTemplates({sms:[]}));
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-message-card]').textContent.includes('Create templates under Admin'));
    const emptyTrigger=await page.$eval('[data-testid=messaging-template-select]',el=>el.textContent.trim());
    assert(!emptyTrigger.includes('Create templates'),`the hint is rendered as the selected value: ${emptyTrigger}`);
    await assertFits(page,'SMS campaign without templates');
    await page.evaluate(()=>window.fixture.setTemplates(null));
    await page.waitForSelector('[data-testid=messaging-mapping-first_name]');
    checks.push('with no templates the source hint renders under the field, not inside the trigger');
    await page.click('[data-testid=messaging-sample-next]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-preview-status]').textContent.includes('No valid phone number'),{timeout:15000});checks.push('stepping to the next sample contact surfaces a missing destination');
    await clickButton(page,'Validate audience');
    await page.waitForSelector('[data-testid=messaging-validation]');
    const validation=await page.$eval('[data-testid=messaging-validation]',el=>el.textContent);
    assert.match(validation,/1 of 3 contacts sendable/);assert.match(validation,/1 outside the test-mode allowlist/,'contacts the test-mode allowlist suppresses are named instead of "No problems found"');checks.push('audience validation summarises sendable and problematic contacts, test-mode suppressions included');
    await page.screenshot({path:path.join(output,'campaign-editor-dark.png')});
    await page.evaluate(()=>{document.documentElement.classList.remove('dark');});await page.screenshot({path:path.join(output,'campaign-editor-light.png')});
    // WhatsApp and email campaigns: their own senders, templates and options.
    await page.evaluate(()=>{document.documentElement.classList.add('dark');window.fixture.setChannel('whatsapp');});
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-sender-card]').textContent.includes('+14155550900'));
    assert(await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-sender-card] label')].find(l=>l.textContent.includes('+14155550901'));return label.querySelector('button[role=checkbox]').disabled;}),'a WhatsApp number without a messaging profile cannot send');
    await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-sender-card] label')].find(l=>l.textContent.includes('+14155550900'));label.querySelector('button[role=checkbox]').click();});
    await page.click('[data-testid=messaging-template-select]');await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('order_ready')).click());
    await page.waitForSelector('[data-testid=messaging-mapping-body\\:1]');
    assert(await page.evaluate(()=>Boolean(document.querySelector('[data-testid=messaging-mapping-body\\:2]'))),'each positional template variable gets a mapping row');
    assert.equal(await page.evaluate(()=>window.fixture.draft.metadata.messaging.sender.whatsapp.number_id),'w1');
    assert.equal(await page.evaluate(()=>window.fixture.draft.metadata.messaging.template.whatsapp.template_id),'wa1');
    await assertFits(page,'WhatsApp campaign');
    checks.push('a WhatsApp campaign picks an approved template and maps its positional variables');
    await page.screenshot({path:path.join(output,'campaign-whatsapp-dark.png')});
    await page.evaluate(()=>{window.fixture.setChannel('email');});
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-sender-card]').textContent.includes('campaigns@cc.example.com'));
    assert(await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-sender-card] label')].find(l=>l.textContent.includes('paused@cc.example.com'));return label.querySelector('button[role=checkbox]').disabled;}),'a mailbox with sending paused cannot be selected');
    await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-sender-card] label')].find(l=>l.textContent.includes('campaigns@cc.example.com'));label.querySelector('button[role=checkbox]').click();});
    await page.evaluate(()=>{const inputs=[...document.querySelectorAll('[data-testid=messaging-sender-card] input')];const native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;native.call(inputs[0],'Telnyx Store');inputs[0].dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('[data-testid=messaging-template-select]');await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Order ready')).click());
    await page.waitForSelector('[data-testid=messaging-mapping-first_name]');
    await page.evaluate(()=>{const input=[...document.querySelectorAll('input')].find(i=>i.placeholder&&i.placeholder.includes('your order is ready'));const native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;native.call(input,'Pick up {{first_name}}');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>window.fixture.draft.metadata.messaging.template.email.subject_override==='Pick up {{first_name}}');
    assert.equal(await page.evaluate(()=>window.fixture.draft.metadata.messaging.sender.email.mailbox_id),'m1');
    assert.equal(await page.evaluate(()=>window.fixture.draft.metadata.messaging.sender.email.from_name),'Telnyx Store');
    await assertFits(page,'email campaign');
    const mailboxes=await page.evaluate(()=>{const card=document.querySelector('[data-testid=messaging-sender-card]').getBoundingClientRect();const labels=[...document.querySelectorAll('[data-testid=messaging-sender-card] label')];
      return {rows:new Set(labels.map(label=>Math.round(label.getBoundingClientRect().top))).size,count:labels.length,inside:labels.every(label=>label.getBoundingClientRect().right<=card.right+1)};});
    assert(mailboxes.inside,'the FROM mailbox list stays inside the sender card');
    assert.equal(mailboxes.rows,mailboxes.count,'the FROM mailbox list is one address per row in a narrow panel, not two cramped columns');
    checks.push('an email campaign picks a sending mailbox, a from name and a subject override');

    // Typed one key at a time, the way an operator enters it. The panel
    // re-derives its form from the normalized config on every render and the
    // normalizer trims, so a space used to be removed before the next key.
    await page.evaluate(()=>{const inputs=[...document.querySelectorAll('[data-testid=messaging-sender-card] input')];const native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;native.call(inputs[0],'');inputs[0].dispatchEvent(new Event('input',{bubbles:true}));inputs[0].focus();});
    await page.keyboard.type('Telnyx Contact Centre');
    await page.waitForFunction(()=>window.fixture.draft.metadata.messaging.sender.email.from_name==='Telnyx Contact Centre');
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-testid=messaging-sender-card] input')][0].value),'Telnyx Contact Centre','the field shows every space that was typed');
    // The subject override takes spaces the same way.
    await page.evaluate(()=>{const input=[...document.querySelectorAll('input')].find(i=>i.placeholder&&i.placeholder.includes('your order is ready'));const native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;native.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();});
    await page.keyboard.type('Your order is ready');
    await page.waitForFunction(()=>window.fixture.draft.metadata.messaging.template.email.subject_override==='Your order is ready');
    checks.push('multi-word From name and subject override can be typed, spaces included');
    // A variable the subject override introduces is not in the stored template,
    // yet the server requires it to be mapped: the editor shows a row for it.
    await page.evaluate(()=>{const input=document.querySelector('[data-testid=messaging-subject-override]');const native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;native.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();});
    await page.keyboard.type('{{promo_code}} for {{first_name}}');
    await page.waitForSelector('[data-testid=messaging-mapping-promo_code]');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-testid=messaging-mapping-first_name]').length),1,'a variable the template already has is not listed twice');
    checks.push('a variable introduced by the subject override gets its own mapping row');
    await page.screenshot({path:path.join(output,'campaign-email-dark.png')});
    await page.evaluate(()=>{window.fixture.setChannel('sms');});
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-sender-card]').textContent.includes('+14155550100'));
    // React #185 regression: the real dialer campaign form, where selecting a
    // template used to re-register the header save action on every render.
    await page.evaluate(()=>{document.documentElement.classList.add('dark');window.fixture.navigate('campaign-form');});
    await page.waitForSelector('[data-testid=messaging-message-card]');
    // WhatsApp and email stay listed with the reason they cannot run a broadcast.
    const channelTrigger=await page.evaluateHandle(()=>[...document.querySelectorAll('button[role=combobox]')].find(button=>button.closest('div')?.textContent.includes('Channel')));
    await channelTrigger.asElement().click();await page.waitForSelector('[role=option]');
    const channelOptions=await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].map(option=>({text:option.textContent.trim(),disabled:option.getAttribute('aria-disabled')==='true'||option.hasAttribute('data-disabled')})));
    assert(channelOptions.some(option=>/WhatsApp/.test(option.text)&&option.disabled),JSON.stringify(channelOptions));
    assert(channelOptions.some(option=>/Email/i.test(option.text)&&option.disabled));
    assert(channelOptions.some(option=>option.text==='SMS'&&!option.disabled));
    await page.keyboard.press('Escape');
    assert.match(await page.$eval('[data-testid=campaign-channel-availability]',el=>el.textContent),/not implemented yet/);
    checks.push('WhatsApp and email stay in the channel list, disabled with the reason broadcasts are unavailable');

    // A channel the build supports but the workspace has switched off stays
    // selectable, because a campaign can be prepared before the channel is
    // enabled, and says so rather than letting Start be the first refusal.
    await page.evaluate(()=>window.fixture.setAllChannelsAvailable(true));
    await page.waitForFunction(()=>!document.querySelector('[data-testid=campaign-channel-availability]'));
    await (await page.evaluateHandle(()=>[...document.querySelectorAll('button[role=combobox]')].find(button=>button.closest('div')?.textContent.includes('Channel')))).asElement().click();
    await page.waitForSelector('[role=option]');
    const settingsGated=await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].map(option=>({text:option.textContent.trim(),disabled:option.getAttribute('aria-disabled')==='true'||option.hasAttribute('data-disabled')})));
    assert(settingsGated.some(option=>/WhatsApp — disabled in Settings/.test(option.text)&&!option.disabled),JSON.stringify(settingsGated));
    assert(settingsGated.some(option=>option.text==='SMS'&&!option.disabled),'a channel enabled in Settings keeps its plain name');
    // Radix options activate on pointer-down, so use a real click, not DOM click.
    const whatsappOption=await page.evaluateHandle(()=>[...document.querySelectorAll('[role=option]')].find(o=>/WhatsApp/.test(o.textContent)));
    await whatsappOption.asElement().click();
    await page.waitForSelector('[data-testid=campaign-channel-disabled]');
    assert.match(await page.$eval('[data-testid=campaign-channel-disabled]',el=>el.textContent),/switched off under Settings/);
    checks.push('a channel switched off in Settings is selectable but says Start will be refused');
    // Put the form back where the next check expects it: SMS, on the schema
    // that keeps WhatsApp and email unavailable.
    await (await page.evaluateHandle(()=>[...document.querySelectorAll('button[role=combobox]')].find(button=>button.closest('div')?.textContent.includes('Channel')))).asElement().click();
    await page.waitForSelector('[role=option]');
    await (await page.evaluateHandle(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()==='SMS'))).asElement().click();
    await page.waitForFunction(()=>!document.querySelector('[data-testid=campaign-channel-disabled]'));
    await page.evaluate(()=>window.fixture.setAllChannelsAvailable(false));
    await page.waitForSelector('[data-testid=messaging-message-card]');
    await page.evaluate(()=>{window.fixture.saveActionRegistrations=0;});
    const before=0;
    await page.click('[data-testid=messaging-template-select]');await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Order ready')).click());
    await page.waitForSelector('[data-testid=messaging-mapping-first_name]');
    await new Promise(resolve=>setTimeout(resolve,1500));
    const registrations=await page.evaluate(()=>window.fixture.saveActionRegistrations)-before;
    assert(registrations>0&&registrations<10,`selecting a template re-registered the save action ${registrations} times`);
    assert(await page.evaluate(()=>Boolean(document.querySelector('[data-testid=messaging-message-card]'))),'the campaign form stays mounted after selecting a template');
    checks.push('selecting a template in the dialer campaign form does not loop the header save action');
    await assertFits(page,'SMS campaign form');
    const voiceTrigger=await page.evaluateHandle(()=>[...document.querySelectorAll('button[role=combobox]')].find(button=>button.closest('div')?.textContent.includes('Channel')));
    await voiceTrigger.asElement().click();await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()==='Voice').click());
    await page.waitForFunction(()=>document.body.textContent.includes('Dialing Strategy'));
    // A voice campaign with an agent script also renders the forms mapping table.
    const scriptTrigger=await page.evaluateHandle(()=>[...document.querySelectorAll('button[role=combobox]')].find(button=>button.closest('div')?.textContent.includes('Agent Script')));
    await scriptTrigger.asElement().click();await page.waitForSelector('[role=option]');
    await page.evaluate(()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Qualification script')).click());
    await page.waitForFunction(()=>document.body.textContent.includes('Forms variable mapping'));
    await clickButton(page,'Add mapping');
    await page.waitForFunction(()=>document.body.textContent.includes('Form variable')&&document.body.textContent.includes('Contact field'));
    await assertFits(page,'voice campaign form');
    await page.screenshot({path:path.join(output,'campaign-form-voice-dark.png')});
    checks.push('the voice campaign form fits the same panel, including the FROM number slots and the mapping editor');
    // Settings card
    await page.evaluate(()=>{document.documentElement.classList.add('dark');window.fixture.navigate('settings');});
    await page.waitForSelector('[data-testid=messaging-settings-card]');
    await page.waitForFunction(()=>window.fixture.settings&&window.fixture.settings.enabled_channels.sms===true&&[...document.querySelectorAll('[data-testid=messaging-settings-card] label')].some(l=>l.textContent.trim().startsWith('SMS')&&l.querySelector('button[role=checkbox]')?.getAttribute('aria-checked')==='true'));
    await page.evaluate(()=>{const label=[...document.querySelectorAll('[data-testid=messaging-settings-card] label')].find(l=>l.textContent.trim().startsWith('SMS'));label.querySelector('button[role=checkbox]').click();});
    await page.waitForFunction(()=>window.fixture.settings&&window.fixture.settings.enabled_channels.sms===false,{timeout:10000});checks.push('the settings card toggles enabled channels through the normalized settings object');
    await page.click('[data-testid=settings-section-sms]');
    await page.waitForFunction(()=>document.querySelector('[data-testid=messaging-settings-card]')?.dataset.section==='sms'&&document.body.textContent.includes('Footer text'));
    assert(await page.evaluate(()=>document.body.textContent.includes('+14155550100')));checks.push('the SMS tab lists rate limits, compliance and allowed sender numbers');
    await page.screenshot({path:path.join(output,'settings-sms-dark.png')});
    assert.deepEqual(errors,[]);checks.push('no uncaught page errors');
    const result={passed:checks.length,checks};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output},null,2));
  }catch(error){
    console.error('Completed checks:',JSON.stringify(checks));
    try{const page=(await browser.pages()).at(-1);await page?.screenshot({path:path.join(output,'failure.png')});console.error('Body excerpt:',(await page?.evaluate(()=>document.body.innerText.slice(0,1500)))||'');}catch{}
    throw error;
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

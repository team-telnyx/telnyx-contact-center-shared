// Isolated browser regression: real UI components, deterministic HTTP fixtures,
// no application login, live Contact Center data, or external email delivery.
// Run: node tests/browser/interaction-alerts.browser.cjs
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const esbuild=req('esbuild'),postcss=req('postcss'),tailwind=req('@tailwindcss/postcss'),puppeteer=req('puppeteer'),assert=require('node:assert/strict');
const output=process.env.ALERT_UI_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'cc-interaction-alerts-'));
async function build(){
  fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(__dirname,'interaction-alerts.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',loader:{'.js':'jsx'},alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning',
    plugins:[{name:'fixture-auth',setup(build){build.onResolve({filter:/^@\/components\/auth-provider$/},()=>({path:'auth',namespace:'fixture-auth'}));build.onLoad({filter:/.*/,namespace:'fixture-auth'},()=>({contents:'const ROLES=["agent","supervisor","admin","owner"];function canScreen(screen){ const roles=window.fixture.auth&&window.fixture.auth.user?window.fixture.auth.user.roles:null; if(!Array.isArray(roles)) return false; if(roles.includes("owner")||roles.includes("admin")) return true; if(String(screen).startsWith("agent")) return roles.includes("agent")||roles.includes("supervisor"); if(String(screen).startsWith("supervisor")) return roles.includes("supervisor"); return false; }const defaults={loaded:true,isAuth:true,wildcard:false,screens:[],can:()=>true,canScreen};export function useAuth(){ return {...defaults,...(window.fixture.auth||{})}; }export function Can({children}){ return children; }export function ScreenGuard({children}){ return children; }'}));}},{name:'workspace-node-resolution',setup(build){build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/'))return;if(args.path.startsWith('#min'))return {path:path.join(root,'node_modules/vfile/lib',args.path.slice(1)+'.browser.js')};return {path:req.resolve(args.path)};});}}]});
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
    page.on('pageerror',e=>{errors.push(e.message);console.error('Browser:',e.message);});page.on('dialog',d=>d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>window.fixture?.sessions.length>=1);
    await page.evaluate(()=>window.fixture.update([window.fixture.offer('email-1')]));
    await page.waitForSelector('[data-testid=incoming-interaction-alert]');
    await page.waitForFunction(()=>window.fixture.plays.some(src=>!src.startsWith('data:')));
    assert.equal(await page.evaluate(()=>window.fixture.audio.length),1);
    await page.screenshot({path:path.join(output,'header-email-dark.png')});
    await page.click('[aria-label="Open Agent Desktop for email in Sales"]');
    await page.waitForFunction(()=>window.fixture.selected==='email-1');
    await page.waitForFunction(()=>!document.querySelector('[data-testid=incoming-interaction-alert]'));
    assert.equal(await page.evaluate(()=>new Set(window.fixture.sessions.map(s=>s.sessionId)).size),1,'navigation must preserve the presence session');
    assert.equal(await page.evaluate(()=>window.fixture.sessions.filter(s=>s.offline).length),0,'navigation must not drop presence');
    const plays=await page.evaluate(()=>window.fixture.plays.filter(src=>!src.startsWith('data:')).length);
    await page.evaluate(()=>{window.fixture.audio[0].onended();window.fixture.navigate('contacts');window.fixture.update(window.fixture.interactions);});
    await page.waitForSelector('[data-testid=incoming-interaction-alert]');
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal(await page.evaluate(()=>window.fixture.plays.filter(src=>!src.startsWith('data:')).length),plays,'one-shot must not replay across pages');
    await page.evaluate(()=>window.fixture.update([window.fixture.interactions[0],window.fixture.offer('chat-2','chat')]));
    await page.waitForFunction(()=>document.body.textContent.includes('2 new interactions'));
    await page.waitForFunction(()=>window.fixture.plays.filter(src=>!src.startsWith('data:')).length===2);
    await page.screenshot({path:path.join(output,'header-multiple-dark.png')});
    await page.evaluate(()=>{document.documentElement.classList.remove('dark');window.fixture.update([window.fixture.interactions[1]]);});
    await page.waitForFunction(()=>document.body.textContent.includes('New chat'));
    await page.screenshot({path:path.join(output,'header-chat-light.png')});
    await page.setViewport({width:1120,height:700});
    await page.screenshot({path:path.join(output,'header-compact.png')});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'header must fit compact viewport');
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    assert.equal(await page.$eval('.cc-header-interaction-dot',el=>getComputedStyle(el).animationName),'none');
    await page.evaluate(()=>window.fixture.update([{...window.fixture.interactions[0],state:'active',offer_id:null}]));
    await page.waitForFunction(()=>!document.querySelector('[data-testid=incoming-interaction-alert]'));
    assert.equal(await page.evaluate(()=>window.fixture.audio[0].onended),null,'accepted offer stops audio');
    await page.evaluate(()=>window.fixture.update([window.fixture.offer('expiry','email',750)]));
    await page.waitForSelector('[data-testid=incoming-interaction-alert]');
    await page.waitForFunction(()=>!document.querySelector('[data-testid=incoming-interaction-alert]'));
    await page.evaluate(()=>{window.fixture.blocked=true;window.fixture.update([window.fixture.offer('blocked')]);});
    await page.waitForSelector('[aria-label="Enable interaction notification sounds"]');
    await page.evaluate(()=>window.fixture.blocked=false);
    await page.click('[aria-label="Enable interaction notification sounds"]');
    await page.waitForFunction(()=>!document.querySelector('[aria-label="Enable interaction notification sounds"]'));
    await page.evaluate(()=>{window.fixture.fail=true;window.fixture.update(window.fixture.interactions);});
    await page.waitForFunction(()=>!document.querySelector('[data-testid=incoming-interaction-alert]'));
    await page.evaluate(()=>window.fixture.setAgent(null));
    await page.waitForFunction(()=>window.fixture.sessions.some(s=>s.offline));
    for(const role of ['supervisor','admin','owner']) {
      await page.evaluate(role=>{window.fixture.fail=false;window.fixture.setRoles([role]);window.fixture.setAgent(role+'-1');window.fixture.interactions=[window.fixture.offer(role+'-offer')];},role);
      await page.waitForSelector('[data-testid=incoming-interaction-alert]');
      await page.waitForFunction(role=>window.fixture.sessions.some(s=>s.authId===role+'-1'&&!s.offline),{},role);
      await page.evaluate(()=>window.fixture.setAgent(null));
      await page.waitForFunction(()=>!document.querySelector('[data-testid=incoming-interaction-alert]'));
    }
    for(const roles of [['customer'],[],null,'agent']) {
      await page.evaluate(roles=>{window.fixture.setRoles(roles);window.fixture.setAgent('ineligible');},roles);
      const before=await page.evaluate(()=>window.fixture.requests);
      await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
      await new Promise(resolve=>setTimeout(resolve,150));
      assert.equal(await page.evaluate(()=>window.fixture.requests),before,'ineligible role must not start the feed');
    }
    const requests=await page.evaluate(()=>window.fixture.requests);
    await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
    await new Promise(resolve=>setTimeout(resolve,3200));
    assert.equal(await page.evaluate(()=>window.fixture.requests),requests,'non-agent has no feed');
    assert.deepEqual(errors,[]);
    const result={passed:14,checks:['real auth provider: agent/supervisor/admin/owner feed and presence','ineligible and missing roles have no feed','global arrival audio','single persistent player','header navigation targets offer without accepting','route changes preserve presence','one-shot survives navigation','multiple channels','responsive light/dark header','reduced motion','acceptance clears sound and alert','local deadline expiration','autoplay unlock','connection loss and agent logout cleanup']};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

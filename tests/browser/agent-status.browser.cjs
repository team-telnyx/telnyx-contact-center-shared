// Header status selector: a break chosen while Busy is shown as a pending chip
// and marked in the option list; choosing Available cancels it.
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(root,'package.json'));
const output=fs.mkdtempSync(path.join(os.tmpdir(),'cc-agent-status-'));
(async()=>{
  await req('esbuild').build({entryPoints:[path.join(__dirname,'agent-status.fixture.jsx')],bundle:true,outfile:path.join(output,'app.js'),platform:'browser',jsx:'automatic',alias:{'@':root,react:req.resolve('react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'workspace-node-resolution',setup(build){build.onResolve({filter:/^[^./]/},args=>{if(args.path.startsWith('@/'))return;return {path:req.resolve(args.path)};});}}]});
  const server=http.createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/app.js'?'text/javascript':'text/html');response.end(request.url==='/app.js'?fs.readFileSync(path.join(output,'app.js')):'<!doctype html><div id="root"></div><script src="/app.js"></script>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const mac='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser=await req('puppeteer').launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:fs.existsSync(mac)?{executablePath:mac}:{}),args:process.env.CI?['--no-sandbox']:[]});
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('[data-testid="agent-status"][data-status="Busy"]:not([disabled])');
    // The effective status stays Busy; the pending choice is visible next to it.
    const chip=await page.waitForSelector('[data-testid="agent-status-pending"]');
    assert.equal(await chip.evaluate(e=>e.dataset.status),'Away');
    assert.equal((await chip.evaluate(e=>e.textContent)).trim(),'Away');
    // The cross on the chip cancels the pending status by requesting Available.
    await (await page.$('[data-testid="agent-status-pending-cancel"]')).click();
    await page.waitForFunction(()=>window.fixture.changes.length===1);
    assert.deepEqual(await page.evaluate(()=>fixture.changes),['Available']);
    assert.equal(await page.$eval('[data-testid="agent-status"]',e=>e.textContent.trim()),'Busy');
    // The option list marks the pending status and explains that Available cancels it.
    await (await page.$('[data-testid="agent-status"]')).click();
    await page.waitForSelector('[data-testid="agent-status-option"][data-status="Away"]');
    // Adjacent spans are laid out with flex gaps, so compare without whitespace.
    const optionText=async status=>(await page.$eval(`[data-testid="agent-status-option"][data-status="${status}"]`,e=>e.textContent)).replace(/\s+/g,'');
    assert.equal(await optionText('Away'),'Awaypending');
    assert.equal(await optionText('Available'),'AvailablecancelsAway');
    assert.equal(await optionText('Break'),'Break');
    assert.equal(await page.$eval('[data-testid="agent-status-option"][data-status="Busy"]',e=>e.getAttribute('data-disabled')!==null||e.getAttribute('aria-disabled')==='true'),true,'Busy cannot be chosen manually');
    await (await page.$('[data-testid="agent-status-option"][data-status="Available"]')).click();
    await page.waitForFunction(()=>window.fixture.changes.length===2);
    assert.deepEqual(await page.evaluate(()=>fixture.changes),['Available','Available']);
    // Once the server confirms the cancellation the chip disappears.
    await page.evaluate(()=>fixture.setState({value:'Busy',pendingStatus:null,pendingSince:null}));
    await page.waitForFunction(()=>!document.querySelector('[data-testid="agent-status-pending"]'));
    // When the work ends the chosen status simply becomes the current one.
    await page.evaluate(()=>fixture.setState({value:'Away',pendingStatus:null,pendingSince:null}));
    await page.waitForSelector('[data-testid="agent-status"][data-status="Away"]');
    assert.equal(await page.$('[data-testid="agent-status-pending"]'),null);
    assert.deepEqual(errors,[]);
    const result={passed:6,checks:['pending chip next to Busy','cross on the chip requests Available','option list marks pending status','Available option explains cancellation','Busy stays non-selectable','chip clears when pending status is cancelled or applied']};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output},null,2));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

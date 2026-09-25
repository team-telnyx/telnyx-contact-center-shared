import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const bundle = await build({ entryPoints: [new URL("./entry.js", import.meta.url).pathname],
  bundle: true, format: "iife", platform: "browser", write: false });
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(bundle.outputFiles[0].contents);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><html><body style="margin:0;font:16px system-ui">
    <button id="safe" type="button" data-cobrowse-control>Safe action</button>
    <button id="unsafe" type="button">No opt-in</button>
    <form id="form"><button id="submit" type="submit" data-cobrowse-control>Submit</button></form>
    <a id="local" href="/next" data-cobrowse-control>Local link</a><a id="foreign" href="https://example.org" data-cobrowse-control>Foreign link</a>
    <input id="name" name="fullName" data-cobrowse-control>
    <input id="plain" name="plain">
    <input id="password" type="password" data-cobrowse-control>
    <input id="card" name="cardNumber" autocomplete="cc-number" data-cobrowse-control>
    <input id="masked" class="custom-mask" data-cobrowse-control>
    <div class="custom-private"><input id="blocked" data-cobrowse-control></div>
    <div style="height:2400px"></div>
    <script>
      window.safeClicks=0;window.unsafeClicks=0;window.formSubmits=0;window.localClicks=0;
      document.querySelector('#safe').onclick=()=>window.safeClicks++;
      document.querySelector('#unsafe').onclick=()=>window.unsafeClicks++;
      document.querySelector('#form').onsubmit=(event)=>{event.preventDefault();window.formSubmits++};
      document.querySelector('#local').onclick=(event)=>{event.preventDefault();window.localClicks++};
    </script><script src="/bundle.js"></script></body></html>`);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  const command = async (id, action, value) => page.evaluate((targetId, kind, text) => {
    const command = { action: kind, targetId, value: text };
    return kind === "fill" ? window.fillAssistAt(command) : window.applyAssistCommand(command);
  }, id, action, value);
  assert.equal(await command("safe", "click"), true);
  assert.equal(await command("unsafe", "click"), false);
  assert.equal(await command("submit", "click"), false);
  assert.equal(await command("local", "click"), true);
  assert.equal(await command("foreign", "click"), false);
  assert.equal(await command("name", "fill", "Alex Example"), true);
  for (const id of ["plain", "password", "card", "masked", "blocked"])
    assert.equal(await command(id, "fill", "NOT_ALLOWED"), false, id);
  assert.equal(await page.evaluate(() => window.applyAssistCommand({ action: "click", targetId: "nonexistent" })), false);
  const result = await page.evaluate(() => ({ safe: window.safeClicks, unsafe: window.unsafeClicks,
    submits: window.formSubmits, local: window.localClicks, name: document.querySelector("#name").value,
    card: document.querySelector("#card").value }));
  assert.deepEqual(result, { safe: 1, unsafe: 0, submits: 0, local: 1, name: "Alex Example", card: "" });
  assert.equal(await page.evaluate(() => window.applyAssistCommand({ action: "scroll", deltaX: 0, deltaY: 400 })), true);
  assert.ok((await page.evaluate(() => window.scrollY)) > 0);
  console.log(JSON.stringify({ passed: true, safeClicks: true, blockedSubmit: true,
    optedInFill: true, sensitiveFieldsBlocked: true, scroll: true }));
} finally {
  await browser.close();
  await new Promise((closed) => server.close(closed));
}

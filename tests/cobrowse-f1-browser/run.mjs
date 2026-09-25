import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import puppeteer from "puppeteer";
import { WebSocketServer } from "ws";

const bundle = await readFile(new URL("../../public/widget/v1/cobrowse.js", import.meta.url));
const frames = [];
let tickets = 0;
let stopped = 0;
const html = `<!doctype html><html><head><title>F1 smoke?token=TITLE_SECRET_3984</title></head><body>
  <h1>PUBLIC_MARKER</h1><p data-cobrowse-mask>MASKED_SECRET_6592</p>
  <div data-cobrowse-block>BLOCKED_SECRET_9283</div>
  <input type="password" value="PASSWORD_SECRET_7392">
  <input autocomplete="cc-number" value="CARD_SECRET_4111111111111111">
  <input id="ordinary" value="INPUT_SECRET_7284">
  <a href="/checkout?token=URL_SECRET_8712#private">Continue</a>
  <div id="dynamic"></div><script src="/cobrowse.js"></script></body></html>`;

const server = createServer(async (request, response) => {
  if (request.url === "/cobrowse.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(bundle); return;
  }
  if (request.url === "/api/widget-cobrowse/sessions/test-session/token") {
    tickets += 1;
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ticket: `ticket-${tickets}`, browserCredential: `credential-${tickets}`,
      wsUrl: `ws://127.0.0.1:${server.address().port}/cobrowse` })); return;
  }
  if (request.url === "/api/widget-cobrowse/sessions/test-session/stop") {
    stopped += 1;
    setTimeout(() => { response.writeHead(200); response.end("{}"); }, 250);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" }); response.end(html);
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/cobrowse") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === "hello") ws.send(JSON.stringify({ v: 1, type: "ready" }));
  else if (["snapshot", "events"].includes(message.type)) frames.push(message);
}));

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/?auth=ROUTE_SECRET_7482`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.TelnyxCobrowseCapture);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(tickets, 0, "the production bundle must not start without consent");
  assert.equal(frames.length, 0, "no DOM frame may leave before explicit start");
  await page.evaluate(() => {
    window.capture = window.TelnyxCobrowseCapture.start({
      baseUrl: location.origin, sessionId: "test-session", browserCredential: "initial-credential",
      privacy: { preset: "balanced", maskSelectors: [], blockSelectors: [] },
    });
  });
  await page.waitForFunction(() => window.capture?.getCredential() === "credential-1");
  for (let retry = 0; retry < 50 && !frames.some((frame) => frame.type === "snapshot"); retry += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(frames.some((frame) => frame.type === "snapshot"), "consent starts a full snapshot");
  const payload = JSON.stringify(frames);
  for (const secret of ["MASKED_SECRET_6592", "BLOCKED_SECRET_9283", "PASSWORD_SECRET_7392",
    "CARD_SECRET_4111111111111111", "INPUT_SECRET_7284", "URL_SECRET_8712", "ROUTE_SECRET_7482", "TITLE_SECRET_3984"])
    assert.equal(payload.includes(secret), false, `${secret} leaked into the relay`);
  const beforeStop = frames.length;
  await page.evaluate(() => {
    void window.capture.stop();
    document.querySelector("#dynamic").textContent = "AFTER_STOP_SECRET_9901";
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(frames.length, beforeStop, "local stop must halt capture before the stop API returns");
  assert.equal(stopped, 1);
  console.log(JSON.stringify({ passed: true, tickets, frames: frames.length, stopped, bundleBytes: bundle.length }));
} finally {
  await browser.close();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}

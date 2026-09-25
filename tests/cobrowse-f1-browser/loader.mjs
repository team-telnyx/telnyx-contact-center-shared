import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import puppeteer from "puppeteer";
import { createDefaultWidgetConfig, publicWidgetConfig } from "../../lib/widgets/config.js";

const loader = await readFile(new URL("../../public/widget/v1/loader.js", import.meta.url));
const sessionId = "82c58d6f-5eb3-45a2-b6ce-33166c234d90";
const credential = `cbr_${"A".repeat(43)}`;
const config = createDefaultWidgetConfig("en-US");
config.allowedOrigins = ["http://127.0.0.1"];
let captureDownloads = 0;
let stops = 0;
const server = createServer((request, response) => {
  if (request.url === "/widget/v1/loader.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(loader); return;
  }
  if (request.url === "/widget/v1/cobrowse.js") {
    captureDownloads += 1;
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(`window.__captureStarts=window.__captureStarts||0;
      window.TelnyxCobrowseCapture={start:function(options){window.__captureStarts++;
      return {suspend:function(){window.__captureSuspends=(window.__captureSuspends||0)+1},
      stop:function(){options.onStopped();return Promise.resolve()}}}};`);
    return;
  }
  if (request.url === "/api/widgets/test-widget/bootstrap") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ widget: { id: "test-widget", name: "Test widget", revision: 1,
      config: publicWidgetConfig(config), launcherIconSvg: "", callbacks: { enabled: false } } }));
    return;
  }
  if (request.url === `/api/widget-cobrowse/sessions/${sessionId}/stop`) {
    stops += 1;
    response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return;
  }
  if (request.url?.startsWith("/widget/frame?")) {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<script>parent.postMessage({type:"telnyx-widget-ready"},location.origin);</script>`);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<main>Customer page</main><script src="/widget/v1/loader.js" data-widget-id="test-widget"></script>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  const address = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(address, { waitUntil: "load" });
  await page.waitForSelector("#telnyx-widget-test-widget");
  assert.equal(captureDownloads, 0, "disabled config must not fetch capture code");

  config.cobrowse.enabled = true;
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#telnyx-widget-test-widget");
  assert.equal(captureDownloads, 0, "enabled config alone must not fetch capture code");
  await page.evaluate(() => document.querySelector("#telnyx-widget-test-widget").shadowRoot.querySelector(".fab").click());
  await page.waitForFunction(() => !!document.querySelector("#telnyx-widget-test-widget").shadowRoot.querySelector("iframe"));
  const widgetFrame = page.frames().find((frame) => frame.url().includes("/widget/frame?"));
  await widgetFrame.evaluate(({ sessionId, credential }) => {
    parent.postMessage({ type: "telnyx-cobrowse-start", sessionId, browserCredential: credential }, location.origin);
  }, { sessionId, credential });
  await page.waitForFunction(() => window.__captureStarts === 1);
  assert.equal(captureDownloads, 1, "capture code loads only after a consent message");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  assert.equal(await page.evaluate(() => window.__captureSuspends), 1);
  assert.equal(await page.evaluate(() => !!document.querySelector("#telnyx-widget-test-widget").shadowRoot.querySelector(".cb-indicator")), false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.waitForFunction(() => window.__captureStarts === 2);
  assert.equal(captureDownloads, 1, "bfcache resume reuses the lazy bundle");
  assert.equal(await page.evaluate(() => !!document.querySelector("#telnyx-widget-test-widget").shadowRoot.querySelector(".cb-indicator")), true);
  await page.evaluate(() => document.querySelector("#telnyx-widget-test-widget").shadowRoot.querySelector('.cb-indicator button[aria-label="Stop sharing this page"]').click());
  assert.equal(await page.evaluate(() => !!document.querySelector("#telnyx-widget-test-widget").shadowRoot.querySelector(".cb-indicator")), false);
  assert.equal(stops, 0, "mock capture handles local Stop without a network request");
  console.log(JSON.stringify({ passed: true, captureDownloads, captureStarts: 2, bfcacheResume: true }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

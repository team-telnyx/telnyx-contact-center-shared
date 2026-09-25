import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const bundled = await build({
  entryPoints: [new URL("./entry.jsx", import.meta.url).pathname],
  bundle: true, format: "iife", platform: "browser", jsx: "automatic", write: false,
  alias: {
    "@": process.cwd(),
    react: resolve(process.cwd(), "node_modules/react"),
    "react-dom": resolve(process.cwd(), "node_modules/react-dom"),
    scheduler: resolve(process.cwd(), "node_modules/scheduler"),
    clsx: resolve(process.cwd(), "node_modules/clsx"),
    "tailwind-merge": resolve(process.cwd(), "node_modules/tailwind-merge"),
  },
});
const js = bundled.outputFiles[0].contents;
let grants = 0;
let unexpectedPosts = 0;
const server = createServer((request, response) => {
  if (request.url === "/test-host-bundle.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(js); return;
  }
  if (request.url === "/widget/v1/loader.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(`document.body.insertAdjacentHTML("beforeend",'<div id="telnyx-widget-wgt_demo"></div>')`); return;
  }
  if (request.url === "/api/admin/widgets/test-id/test-grant" && request.method === "POST") {
    grants += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ publicId: "wgt_demo", grant: "test-grant" })); return;
  }
  if (request.method === "POST") unexpectedPosts += 1;
  if (request.url === "/admin/widgets/test-host/frame") {
    response.writeHead(200, { "Content-Type": "text/html" }); response.end("SAME_ORIGIN_FRAME_MARKER"); return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end('<!doctype html><html><head><title>Widget test host</title></head><body><div id="app"></div><script src="/test-host-bundle.js"></script></body></html>');
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("Browser page error:", error));
  page.on("console", (message) => { if (message.type() === "error") console.error("Browser console:", message.text()); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/admin/widgets/test-host?widget=test-id`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("[data-testid=widget-test-host-status]")?.textContent?.includes("wgt_demo"));
  assert.equal((await page.$$('nav[aria-label="Test pages"] a')).length, 5);
  const initialBoot = await page.evaluate(() => window.__testBootId);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent === "SPA to products").click());
  await page.waitForFunction(() => document.body.textContent.includes("Products and live filters"));
  assert.equal(await page.evaluate(() => window.__testBootId), initialBoot, "SPA navigation must keep the document");
  await page.select("select", "office");
  assert.equal((await page.$$("article")).length, 2);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent === "Add demo item").click());
  assert.match(await page.evaluate(() => document.body.innerText), /Cart: 1 demo items/);

  await page.click('nav a[href*="/checkout"]');
  await page.waitForFunction(() => document.body.textContent.includes("Checkout and sensitive fields"));
  assert.notEqual(await page.evaluate(() => window.__testBootId), initialBoot, "real subpage link must reload the document");
  assert.equal((await page.$$("[data-cobrowse-mask]")).length >= 2, true);
  assert.equal((await page.$$("[data-cobrowse-block]")).length >= 2, true);
  assert.equal((await page.$$(".demo-secret-text")).length, 1);
  assert.equal((await page.$$(".demo-private-panel")).length, 1);
  await page.type('input[name="fullName"]', "Alex Example");
  await page.type('input[name="cardNumber"]', "4242424242424242");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.body.textContent.includes("Local form completed. No customer or payment data was sent."));
  assert.equal(unexpectedPosts, 0, "fixture forms must never submit to an API");

  await page.click('nav a[href*="/support"]');
  await page.waitForFunction(() => document.body.textContent.includes("FAQ and embedded content"));
  assert.equal((await page.$$("iframe")).length, 2);
  await page.click('nav a[href*="/account"]');
  await page.waitForFunction(() => document.body.textContent.includes("Account and shadow DOM"));
  assert.match(await page.evaluate(() => document.querySelector("[data-testid=cobrowse-shadow-fixture]")?.shadowRoot?.textContent || ""), /SHADOW_PUBLIC_MARKER/);
  assert.equal(grants >= 4, true);
  console.log(JSON.stringify({ passed: true, pages: 5, grants, unexpectedPosts, spaKeptDocument: true }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

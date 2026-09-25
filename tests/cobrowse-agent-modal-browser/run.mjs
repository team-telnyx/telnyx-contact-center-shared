import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const root = process.cwd();
const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [new URL("./entry.jsx", import.meta.url).pathname],
  bundle: true, format: "iife", platform: "browser", jsx: "automatic", write: false,
  alias: {
    "@": root,
    react: resolve(root, "node_modules/react"),
    "react-dom": resolve(root, "node_modules/react-dom"),
    scheduler: resolve(root, "node_modules/scheduler"),
    clsx: resolve(root, "node_modules/clsx"),
    "tailwind-merge": resolve(root, "node_modules/tailwind-merge"),
    "@radix-ui/react-dialog": resolve(root, "node_modules/@radix-ui/react-dialog"),
    "lucide-react": resolve(root, "node_modules/lucide-react"),
  },
  plugins: [{ name: "local-node-modules", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@/")) return null;
      try { return { path: require.resolve(args.path) }; } catch { return null; }
    });
  } }],
});

let mode = "inSession";
let rejectAction = false;
let session = null;
const actions = [];
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(bundled.outputFiles[0].contents);
    return;
  }
  if (request.url === "/api/contact-center/cobrowse/test-work") {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ session, entryPoint: mode === "unavailable"
        ? { kind: mode, reason: "Unsupported test interaction" } : { kind: mode } }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const action = JSON.parse(body);
      actions.push(action);
      response.writeHead(rejectAction ? 409 : 200, { "Content-Type": "application/json" });
      if (!rejectAction) session = { id: "session-1", state: action.action === "end" ? "ended" : "pending_consent" };
      response.end(JSON.stringify(rejectAction ? { error: "Test request rejected" } : { session }));
    });
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end('<!doctype html><html><body><div id="app"></div><script src="/bundle.js"></script></body></html>');
});

await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("Browser page error:", error));
  const address = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(address, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.textContent.includes("Request page sharing from visitor"));
  assert.equal(await page.$('input[aria-label="Visitor pairing code"]'), null);
  await page.click('[data-testid="cobrowse-close"]');
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  await page.click('#open-dialog');
  await page.waitForSelector('[data-testid="cobrowse-request"]');
  rejectAction = true;
  await page.click('[data-testid="cobrowse-request"]');
  await page.waitForFunction(() => document.body.textContent.includes("Test request rejected"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 2300));
  assert.match(await page.evaluate(() => document.body.textContent), /Test request rejected/, "poll must not erase the action error");
  assert.deepEqual(actions[0], { action: "request" });
  rejectAction = false;
  await page.click('[data-testid="cobrowse-request"]');
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  assert.match(await page.$eval('#cobrowse-event', (element) => element.textContent), /"workItemId":"test-work","open":true/);
  assert.deepEqual(actions[1], { action: "request" });
  await page.waitForSelector('[role="tab"][data-cobrowse-tab="cobrowse"][aria-selected="true"]');
  assert.match(await page.$eval('[data-testid="cobrowse-interaction-viewer"]', (element) => element.textContent), /Waiting for visitor consent/);
  assert.equal(await page.$eval('#chat-content', (element) => element.parentElement.classList.contains("hidden")), true);
  await page.click('[role="tab"][data-cobrowse-tab="interaction"]');
  assert.equal(await page.$eval('#chat-content', (element) => element.parentElement.hidden), false);
  await page.click('[role="tab"][data-cobrowse-tab="cobrowse"]');
  await page.click('[data-testid="cobrowse-interaction-viewer"] button');
  await page.waitForSelector('[role="tab"][data-cobrowse-tab="cobrowse"]', { hidden: true });
  assert.deepEqual(actions[2], { action: "end" });
  assert.equal(await page.$eval('#chat-content', (element) => element.parentElement.hidden), false);

  mode = "pairingCode";
  session = null;
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector('input[aria-label="Visitor pairing code"]');
  assert.equal(await page.evaluate(() => document.body.textContent.includes("Request page sharing from visitor")), false);
  await page.type('input[aria-label="Visitor pairing code"]', "123456");
  await page.click('[data-testid="cobrowse-claim"]');
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  assert.deepEqual(actions[3], { action: "claim", code: "123456" });

  mode = "unavailable";
  session = null;
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.body.textContent.includes("Unsupported test interaction"));
  assert.equal(await page.$('input[aria-label="Visitor pairing code"]'), null);
  console.log(JSON.stringify({ passed: true, modes: 3, actions: actions.length, pointerEventsRegression: true, autoClose: true, tabSwitch: true, errorSurvivesPolling: true }));
} finally {
  await browser.close();
  await new Promise((resolveClosed) => server.close(resolveClosed));
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer";
import { WebSocketServer } from "ws";

const root = process.cwd();
const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [new URL("./entry.jsx", import.meta.url).pathname],
  bundle: true, format: "iife", platform: "browser", jsx: "automatic", write: false,
  alias: {
    react: resolve(root, "node_modules/react"),
    "react-dom": resolve(root, "node_modules/react-dom"),
  },
  plugins: [{ name: "local-node-modules", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => {
      try { return { path: require.resolve(args.path) }; } catch { return null; }
    });
  } }],
});

let address;
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(bundled.outputFiles[0].contents);
    return;
  }
  if (request.url === "/api/contact-center/cobrowse/sessions/session-1/token") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ticket: "test-ticket", wsUrl: `ws://127.0.0.1:${address.port}/cobrowse` }));
    return;
  }
  if (request.url === "/cobrowse/replay") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><script>parent.postMessage({type:"cobrowse-replay-ready"},location.origin);addEventListener("message",e=>{if(e.data?.type==="cobrowse-hit-test")parent.postMessage({type:"cobrowse-hit-test-result",requestId:e.data.requestId,nodeId:42},location.origin)})</script>');
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><html><head><style>
    body { margin: 0; background: #222; }
    #app { width: 800px; height: 600px; }
    [data-testid="cobrowse-interaction-viewer"] { height: 100%; box-sizing: border-box; }
    .flex { display: flex; } .flex-col { flex-direction: column; }
    .flex-1 { flex: 1 1 0%; } .min-h-0 { min-height: 0; }
    .w-full { width: 100%; } .relative { position: relative; }
    .absolute { position: absolute; } .pointer-events-none { pointer-events: none; }
    .border-0 { border: 0; } .left-0 { left: 0; } .top-0 { top: 0; }
    [role="region"] { display: block; overflow: auto; box-sizing: border-box; background: white; }
    button { cursor: pointer; }
  </style></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>`);
});
const websocket = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/cobrowse") websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client));
  else socket.destroy();
});
const snapshot = JSON.stringify({ v: 1, type: "snapshot", epoch: "epoch_0123456789", seq: 1, events: [
  { type: 4, data: { width: 1600, height: 2000 } },
  { type: 2, data: {} },
] });
const controlMessages = [];
websocket.on("connection", (client) => client.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === "hello") {
    client.send(JSON.stringify({ v: 1, type: "ready" }));
    client.send(snapshot);
  } else if (message.type === "resync") client.send(snapshot);
  else if (message.type === "control") {
    controlMessages.push(message);
    client.send(JSON.stringify({ v: 1, type: "control_result", commandId: message.commandId,
      accepted: true, fieldSelected: message.action === "click" }));
  }
}));

await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
address = server.address();
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("Browser page error:", error));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector('iframe[title="Isolated co-browsing replay"]')?.style.width === "1600px");
  await page.waitForFunction(() => document.querySelector('[aria-label="Current zoom"]')?.textContent === "50%");
  assert.match(await page.$eval('[role="group"][aria-label="Co-browsing view controls"]', (element) => element.className), /bg-foreground/);
  await page.hover('button[aria-label="Zoom in"]');
  await page.waitForFunction(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent.includes("the visitor's page is unchanged"));
  await page.hover('button[aria-label="End sharing"]');
  await page.waitForFunction(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent.includes("Stop sharing the visitor's page"));

  const geometry = () => page.$eval('[role="region"]', (element) => ({
    width: element.clientWidth, height: element.clientHeight,
    scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
    scrollLeft: element.scrollLeft, scrollTop: element.scrollTop,
  }));
  const fitted = await geometry();
  assert.equal(fitted.width, 800);
  assert.equal(fitted.scrollWidth, 800, "fit width must show the whole source width");
  assert.ok(fitted.scrollHeight > fitted.height, "the long page remains vertically scrollable");

  await page.click('button[aria-label="Actual size"]');
  await page.waitForFunction(() => document.querySelector('[aria-label="Current zoom"]')?.textContent === "100%");
  const enlarged = await geometry();
  assert.equal(enlarged.scrollWidth, 1600);
  assert.equal(enlarged.scrollHeight, 2000);
  await page.click('button[aria-label="Zoom in"]');
  await page.waitForFunction(() => document.querySelector('[aria-label="Current zoom"]')?.textContent === "125%");
  assert.equal((await geometry()).scrollWidth, 2000);
  await page.click('button[aria-label="Zoom out"]');
  await page.waitForFunction(() => document.querySelector('[aria-label="Current zoom"]')?.textContent === "100%");
  const region = await page.$('[role="region"]');
  const box = await region.boundingBox();
  await page.mouse.move(box.x + 500, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 150, { steps: 5 });
  await page.mouse.up();
  const panned = await geometry();
  assert.ok(panned.scrollLeft >= 200, "dragging must reveal the right side");
  assert.ok(panned.scrollTop >= 100, "dragging must reveal the lower part");
  await page.mouse.wheel({ deltaY: 150 });
  await page.waitForFunction((previousTop) => document.querySelector('[role="region"]')?.scrollTop > previousTop, {}, panned.scrollTop);

  await page.click('button[aria-label="Fit width"]');
  await page.waitForFunction(() => document.querySelector('[aria-label="Current zoom"]')?.textContent === "50%");
  assert.equal((await geometry()).scrollWidth, 800);
  await page.hover('button[aria-label="Control page"]');
  await page.waitForFunction(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent.includes("site-approved elements"));
  assert.equal(await page.$eval('button[aria-label="Control page"]', (button) => button.getAttribute("aria-pressed")), "false");
  await page.click('button[aria-label="Control page"]');
  assert.equal(await page.$eval('button[aria-label="Return to pan"]', (button) => button.getAttribute("aria-pressed")), "true");
  assert.equal(await page.$eval('button[aria-label="Fill selected field"]', (button) => button.disabled), true);
  const controlBox = await region.boundingBox();
  await page.mouse.click(controlBox.x + 200, controlBox.y + 140);
  await page.waitForFunction(() => document.body.textContent.includes("Allowed field selected"));
  await page.type('input[aria-label="Text for an allowed customer field"]', "Alex Example");
  await page.click('button[aria-label="Fill selected field"]');
  await page.waitForFunction(() => document.body.textContent.includes("Action applied"));
  assert.equal(controlMessages[0]?.action, "click");
  assert.equal(controlMessages[0]?.nodeId, 42);
  assert.equal(controlMessages[1]?.action, "fill");
  assert.equal(controlMessages[1]?.selectionId, controlMessages[0]?.commandId);
  assert.equal(controlMessages[1]?.value, "Alex Example");
  const requestPage = await browser.newPage();
  await requestPage.goto(`http://127.0.0.1:${address.port}/?control=observe`, { waitUntil: "load" });
  await requestPage.waitForSelector('button[aria-label="Request control"]');
  assert.match(await requestPage.$eval('[role="group"][aria-label="Request page control"]', (element) => element.className), /bg-foreground/);
  await requestPage.hover('button[aria-label="Request control"]');
  await requestPage.waitForFunction(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent.includes("separate permission"));
  await requestPage.close();
  console.log(JSON.stringify({ passed: true, fitWidth: true, zoom: true, horizontalPan: true, verticalPan: true,
    wheelScroll: true, actionGroupStyle: true, hoverDescriptions: true }));
} finally {
  await browser.close();
  await new Promise((closed) => websocket.close(closed));
  await new Promise((closed) => server.close(closed));
}

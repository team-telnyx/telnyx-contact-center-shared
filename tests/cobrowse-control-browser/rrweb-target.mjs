import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const bundle = await build({ entryPoints: [new URL("./rrweb-entry.js", import.meta.url).pathname],
  bundle: true, format: "iife", platform: "browser", write: false,
  alias: { "@rrweb/record": resolve("node_modules/@rrweb/record/dist/record.js"),
    "@rrweb/replay": resolve("node_modules/@rrweb/replay/dist/replay.js") } });
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(bundle.outputFiles[0].contents);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end('<!doctype html><html><body><button id="safe-target" data-cobrowse-control>Safe action</button><div id="replay-root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("Browser page error:", error));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  const result = await page.evaluate(() => window.verifyMirrorTarget());
  assert.ok(result.sourceNodeId > 0, "source rrweb mirror must expose the allowed node");
  assert.equal(result.replayNodeId, result.sourceNodeId, "replay must retain the source node ID");
  assert.equal(result.hitNodeId, result.sourceNodeId, "hit-testing the replay must identify that node");
  assert.equal(result.sandbox, "allow-same-origin");
  console.log(JSON.stringify({ passed: true, nodeId: result.sourceNodeId }));
} finally {
  await browser.close();
  await new Promise((closed) => server.close(closed));
}

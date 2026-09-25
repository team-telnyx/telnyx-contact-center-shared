import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import puppeteer from "puppeteer";
import { WebSocket, WebSocketServer } from "ws";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SESSION_ID = "f0-session";
const MAX_CAPTURE_FRAME_BYTES = 8 * 1024 * 1024;
const TICKET_TTL_MS = 2_000;
const SECRETS = [
  "MASKED_TEXT_SECRET_9482",
  "BLOCKED_SUBTREE_SECRET_7391",
  "PASSWORD_SECRET_1847",
  "CARD_SECRET_4111111111111111",
  "NORMAL_INPUT_SECRET_6620",
  "URL_QUERY_SECRET_5519",
  "ATTRIBUTE_SECRET_3004",
  "HOSTILE_SCRIPT_SECRET_7190",
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function escapeInlineScript(source) {
  return source.replaceAll("</script", "<\\/script");
}

async function bundleBrowserEntries() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cobrowse-f0-"));
  const capturePath = path.join(directory, "capture.js");
  const replayPath = path.join(directory, "replay.js");
  await Promise.all([
    build({
      entryPoints: [path.join(ROOT, "tests/cobrowse-spike/capture-entry.js")],
      outfile: capturePath,
      alias: {
        "@rrweb/record": path.join(ROOT, "node_modules/@rrweb/record/dist/record.js"),
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome120",
      minify: true,
    }),
    build({
      entryPoints: [path.join(ROOT, "tests/cobrowse-spike/replay-entry.js")],
      outfile: replayPath,
      alias: {
        "@rrweb/replay": path.join(ROOT, "node_modules/@rrweb/replay/dist/replay.js"),
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome120",
      minify: true,
    }),
  ]);
  const replayCssPath = path.join(ROOT, "node_modules/@rrweb/replay/dist/style.css");
  return {
    captureBundle: await readFile(capturePath, "utf8"),
    replayBundle: await readFile(replayPath, "utf8"),
    replayCss: await readFile(replayCssPath, "utf8"),
  };
}

function createFixtureHtml(crossOriginBaseUrl) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Co-browsing F0 customer fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; color: #111827; }
      .card { border: 1px solid #d1d5db; border-radius: 12px; padding: 16px; margin-block: 12px; }
      iframe { width: 360px; height: 90px; border: 1px solid #9ca3af; }
      .cobrowse-cross-origin-placeholder { background: #f3f4f6; }
      #hostile-css { background-image: url('/canary-css?auth=URL_QUERY_SECRET_5519'); }
    </style>
  </head>
  <body>
    <h1>PUBLIC_FIXTURE_MARKER</h1>
    <p id="route-state">SPA home route</p>
    <section class="card">
      <p data-cobrowse-mask data-sensitive-value="ATTRIBUTE_SECRET_3004">MASKED_TEXT_SECRET_9482</p>
      <div data-cobrowse-block><strong>BLOCKED_SUBTREE_SECRET_7391</strong></div>
      <label>Password <input type="password" value="PASSWORD_SECRET_1847"></label>
      <label>Card <input autocomplete="cc-number" value="CARD_SECRET_4111111111111111"></label>
      <label>Ordinary input <input id="ordinary-input" value="NORMAL_INPUT_SECRET_6620"></label>
    </section>
    <section class="card" id="shadow-host"></section>
    <iframe title="same-origin fixture" src="/same-frame"></iframe>
    <iframe
      title="cross-origin fixture"
      class="cobrowse-cross-origin-placeholder"
      data-cobrowse-cross-origin
      src="${crossOriginBaseUrl}/cross-frame?auth=URL_QUERY_SECRET_5519"
    ></iframe>
    <div id="embedded-widget" class="card">EMBEDDED_WIDGET_PRIVATE_STATE</div>
    <div id="hostile-css" class="card">Hostile CSS URL fixture</div>
    <form action="/canary-form?auth=URL_QUERY_SECRET_5519"><button>Do not submit</button></form>
    <a href="/account?auth=URL_QUERY_SECRET_5519#private">Account link</a>
    <img alt="network canary" src="/canary-image?auth=URL_QUERY_SECRET_5519">
    <!-- COMMENT_SECRET_SHOULD_NOT_BE_RECORDED -->
    <div id="mutation-target"></div>
    <div id="stress-target"></div>
    <script>
      const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
      shadow.innerHTML = '<strong>SHADOW_DOM_MARKER</strong>';
    </script>
    <script>
      window.__cobrowseHostileExecuted = true;
      window.__customerOnlySecret = 'HOSTILE_SCRIPT_SECRET_7190';
    </script>
    <script src="/capture.js"></script>
  </body>
</html>`;
}

function createAgentHtml() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Co-browsing F0 agent fixture</title></head>
  <body>
    <h1>Agent replay</h1>
    <iframe id="replay-sandbox" src="/replay-frame" style="width: 900px; height: 700px"></iframe>
    <script>
      (() => {
        const sessionId = ${JSON.stringify(SESSION_ID)};
        const frame = document.querySelector('#replay-sandbox');
        let socket;
        let reconnectTimer;
        let replayReady = false;
        let epoch;
        let expectedSequence = 0;
        let pendingFrames = [];
        let resyncStartedAt = 0;
        const metrics = window.__agentMetrics = {
          connected: false,
          reconnects: 0,
          epochChanges: 0,
          gapsDetected: 0,
          resyncRequests: 0,
          resyncResolved: 0,
          resyncDurationsMs: [],
          framesApplied: 0,
          replayStatus: null,
          errors: [],
        };

        function postFrame(data) {
          if (!replayReady) {
            pendingFrames.push(data);
            return;
          }
          frame.contentWindow.postMessage({ type: 'events', events: data.events }, '*');
          metrics.framesApplied += 1;
        }

        function requestResync(reason) {
          if (socket?.readyState !== WebSocket.OPEN) return;
          resyncStartedAt = performance.now();
          metrics.resyncRequests += 1;
          socket.send(JSON.stringify({
            type: 'resync-request',
            sessionId,
            epoch,
            lastSeq: expectedSequence,
            reason,
          }));
        }

        function acceptCapture(data) {
          if (epoch !== data.epoch) {
            if (epoch && replayReady) frame.contentWindow.postMessage({ type: 'reset' }, '*');
            epoch = data.epoch;
            expectedSequence = 0;
            metrics.epochChanges += 1;
          }
          if (data.fromSeq !== expectedSequence + 1) {
            metrics.gapsDetected += 1;
            requestResync('sequence-gap');
            return;
          }
          expectedSequence = data.toSeq;
          postFrame(data);
          if (resyncStartedAt && data.events.some((event) => event.type === 2)) {
            metrics.resyncResolved += 1;
            metrics.resyncDurationsMs.push(performance.now() - resyncStartedAt);
            resyncStartedAt = 0;
          }
        }

        async function getTicket() {
          const response = await fetch('/ticket?role=viewer&session=' + encodeURIComponent(sessionId), { cache: 'no-store' });
          if (!response.ok) throw new Error('ticket request failed: ' + response.status);
          return (await response.json()).ticket;
        }

        async function connect() {
          clearTimeout(reconnectTimer);
          try {
            const ticket = await getTicket();
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            socket = new WebSocket(protocol + '//' + location.host + '/ws?role=viewer&session=' + encodeURIComponent(sessionId) + '&ticket=' + encodeURIComponent(ticket));
            socket.addEventListener('open', () => {
              socket.send(JSON.stringify({ type: 'hello', role: 'viewer', sessionId }));
            });
            socket.addEventListener('message', (message) => {
              const data = JSON.parse(message.data);
              if (data.type === 'hello-ack') {
                metrics.connected = true;
              } else if (data.type === 'capture') {
                acceptCapture(data);
              }
            });
            socket.addEventListener('close', () => {
              metrics.connected = false;
              metrics.reconnects += 1;
              reconnectTimer = setTimeout(connect, 150);
            });
          } catch (error) {
            metrics.errors.push(String(error));
            reconnectTimer = setTimeout(connect, 250);
          }
        }

        addEventListener('message', (message) => {
          if (message.source !== frame.contentWindow || !message.data) return;
          if (message.data.type === 'replay-ready') {
            replayReady = true;
            for (const data of pendingFrames.splice(0)) postFrame(data);
          } else if (message.data.type === 'replay-status') {
            metrics.replayStatus = message.data;
          }
        });

        connect();
      })();
    </script>
  </body>
</html>`;
}

class SpikeRelay {
  constructor({ captureBundle, replayBundle, replayCss }) {
    this.captureBundle = captureBundle;
    this.replayBundle = replayBundle;
    this.replayCss = replayCss;
    this.tickets = new Map();
    this.clients = new Set();
    this.publishers = new Set();
    this.viewers = new Set();
    this.dropNextPublisherFrame = false;
    this.crossOriginBaseUrl = "";
    this.metrics = {
      ticketsIssued: 0,
      ticketRejections: 0,
      captures: [],
      capturePayloads: [],
      canaryRequests: [],
      resyncRequests: [],
      droppedFrames: 0,
      connections: 0,
    };
    this.server = http.createServer(this.handleHttp.bind(this));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CAPTURE_FRAME_BYTES });
    this.server.on("upgrade", this.handleUpgrade.bind(this));
    this.wss.on("connection", this.handleConnection.bind(this));
  }

  issueTicket(role, sessionId) {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { role, sessionId, expiresAt: Date.now() + TICKET_TTL_MS, used: false });
    this.metrics.ticketsIssued += 1;
    return ticket;
  }

  handleUpgrade(request, socket, head) {
    const url = new URL(request.url, "http://localhost");
    const role = url.searchParams.get("role");
    const sessionId = url.searchParams.get("session");
    const ticketValue = url.searchParams.get("ticket");
    const ticket = this.tickets.get(ticketValue);
    const valid =
      ticket &&
      !ticket.used &&
      ticket.expiresAt >= Date.now() &&
      ticket.role === role &&
      ticket.sessionId === sessionId &&
      ["publisher", "viewer"].includes(role);

    if (!valid) {
      this.metrics.ticketRejections += 1;
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    ticket.used = true;
    this.wss.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.role = role;
      webSocket.sessionId = sessionId;
      this.wss.emit("connection", webSocket, request);
    });
  }

  handleConnection(socket) {
    this.clients.add(socket);
    (socket.role === "publisher" ? this.publishers : this.viewers).add(socket);
    this.metrics.connections += 1;

    socket.on("message", (raw) => {
      if (raw.length > MAX_CAPTURE_FRAME_BYTES) {
        socket.close(1009, "capture frame too large");
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(1003, "invalid json");
        return;
      }
      if (message.sessionId !== socket.sessionId) {
        socket.close(1008, "session mismatch");
        return;
      }
      if (message.type === "hello") {
        socket.send(JSON.stringify({ type: "hello-ack", role: socket.role, sessionId: socket.sessionId }));
        if (socket.role === "viewer") {
          setTimeout(() => this.requestPublisherResync("late-viewer"), 10);
        }
        return;
      }
      if (socket.role === "publisher" && message.type === "capture") {
        this.acceptCapture(message, raw);
      } else if (socket.role === "viewer" && message.type === "resync-request") {
        this.metrics.resyncRequests.push({ reason: message.reason, at: Date.now() });
        this.requestPublisherResync(message.reason || "viewer-request");
      } else {
        socket.close(1008, "message not allowed for role");
      }
    });
    socket.on("close", () => {
      this.clients.delete(socket);
      this.publishers.delete(socket);
      this.viewers.delete(socket);
    });
  }

  acceptCapture(message, raw) {
    assert.equal(message.type, "capture");
    assert.equal(message.sessionId, SESSION_ID);
    assert.equal(typeof message.epoch, "string");
    assert.equal(Number.isSafeInteger(message.fromSeq), true);
    assert.equal(message.fromSeq, message.toSeq);
    assert.equal(Array.isArray(message.events), true);
    assert.ok(message.events.length > 0 && message.events.length <= 100);

    const eventJson = JSON.stringify(message.events);
    const fullSnapshots = message.events.filter((event) => event.type === 2);
    this.metrics.capturePayloads.push(eventJson);
    this.metrics.captures.push({
      at: Date.now(),
      epoch: message.epoch,
      sequence: message.fromSeq,
      eventCount: message.events.length,
      eventTypes: message.events.map((event) => event.type),
      rawBytes: raw.length,
      gzipBytes: gzipSync(raw).length,
      fullSnapshotBytes: fullSnapshots.map((event) => Buffer.byteLength(JSON.stringify(event))),
      fullSnapshotGzipBytes: fullSnapshots.map((event) => gzipSync(JSON.stringify(event)).length),
    });

    if (this.dropNextPublisherFrame && !fullSnapshots.length) {
      this.dropNextPublisherFrame = false;
      this.metrics.droppedFrames += 1;
      return;
    }
    for (const viewer of this.viewers) {
      if (viewer.readyState === WebSocket.OPEN) viewer.send(raw.toString());
    }
  }

  requestPublisherResync(reason) {
    const payload = JSON.stringify({ type: "resync-request", sessionId: SESSION_ID, reason });
    for (const publisher of this.publishers) {
      if (publisher.readyState === WebSocket.OPEN) publisher.send(payload);
    }
  }

  forceDisconnect() {
    for (const client of [...this.clients]) client.terminate();
  }

  async handleHttp(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/ticket") {
      const role = url.searchParams.get("role");
      const sessionId = url.searchParams.get("session");
      if (!["publisher", "viewer"].includes(role) || sessionId !== SESSION_ID) {
        response.writeHead(400).end("invalid ticket request");
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ticket: this.issueTicket(role, sessionId), expiresInMs: TICKET_TTL_MS }));
      return;
    }
    if (url.pathname === "/capture.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(this.captureBundle);
      return;
    }
    if (url.pathname === "/customer" || url.pathname.startsWith("/checkout/")) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(createFixtureHtml(this.crossOriginBaseUrl));
      return;
    }
    if (url.pathname === "/agent") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(createAgentHtml());
      return;
    }
    if (url.pathname === "/replay-frame") {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'self' data: blob:; form-action 'none'; base-uri 'none'",
      );
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><meta charset="utf-8"><style>${this.replayCss}</style></head><body><div id="replay-root"></div><script>${escapeInlineScript(this.replayBundle)}</script></body></html>`);
      return;
    }
    if (url.pathname === "/same-frame") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><body><strong>SAME_ORIGIN_IFRAME_MARKER</strong></body>");
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith("/canary-")) {
      this.metrics.canaryRequests.push({ at: Date.now(), path: url.pathname, referer: request.headers.referer || "" });
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end("not found");
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  close() {
    this.forceDisconnect();
    return Promise.all([
      new Promise((resolve) => this.wss.close(resolve)),
      new Promise((resolve) => this.server.close(resolve)),
    ]);
  }
}

async function startCrossOriginServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/cross-frame") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><body><strong>CROSS_ORIGIN_PRIVATE_MARKER</strong></body>");
      return;
    }
    response.writeHead(404).end("not found");
  });
  const baseUrl = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function verifySingleUseTicket(baseUrl, relay) {
  const ticketResponse = await fetch(`${baseUrl}/ticket?role=viewer&session=${SESSION_ID}`);
  const { ticket } = await ticketResponse.json();
  const wsUrl = baseUrl.replace("http:", "ws:") + `/ws?role=viewer&session=${SESSION_ID}&ticket=${ticket}`;
  const first = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    first.once("open", resolve);
    first.once("error", reject);
  });
  first.close();
  await new Promise((resolve) => first.once("close", resolve));

  const rejectedBefore = relay.metrics.ticketRejections;
  const second = new WebSocket(wsUrl);
  await new Promise((resolve) => {
    second.once("error", resolve);
    second.once("close", resolve);
  });
  await sleep(25);
  return relay.metrics.ticketRejections === rejectedBefore + 1;
}

function metricValue(metrics, name) {
  return metrics.metrics.find((metric) => metric.name === name)?.value ?? null;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function check(checks, name, condition, detail) {
  checks.push({ name, passed: Boolean(condition), detail });
}

async function run() {
  const stage = (message) => console.error(`[cobrowse-f0] ${message}`);
  const bundles = await bundleBrowserEntries();
  stage("browser bundles built");
  const crossOrigin = await startCrossOriginServer();
  const relay = new SpikeRelay(bundles);
  relay.crossOriginBaseUrl = crossOrigin.baseUrl;
  const baseUrl = await relay.listen();
  let browser;
  const checks = [];
  const browserErrors = [];

  try {
    const ticketIsSingleUse = await verifySingleUseTicket(baseUrl, relay);
    stage("single-use ticket verified");
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const customer = await browser.newPage();
    await customer.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    const customerCdp = await customer.createCDPSession();
    await customerCdp.send("Performance.enable");
    await customerCdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    customer.on("pageerror", (error) => browserErrors.push(`customer: ${error.message}`));
    customer.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`customer console: ${message.text()}`);
    });

    await customer.goto(`${baseUrl}/customer?session=${SESSION_ID}`, { waitUntil: "networkidle0" });
    await customer.waitForFunction(() => window.__cobrowseSpike?.stats.ready === true, { timeout: 10_000 });
    stage("publisher capture started");
    await sleep(500);
    const firstSnapshot = relay.metrics.captures.find((capture) => capture.fullSnapshotBytes.length);
    assert.ok(firstSnapshot, "publisher did not produce an initial full snapshot");

    const canaryCountBeforeReplay = relay.metrics.canaryRequests.length;
    const agent = await browser.newPage();
    agent.on("pageerror", (error) => browserErrors.push(`agent: ${error.message}`));
    agent.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`agent console: ${message.text()}`);
    });
    await agent.goto(`${baseUrl}/agent`, { waitUntil: "domcontentloaded" });
    try {
      await agent.waitForFunction(
        () => window.__agentMetrics?.replayStatus?.bodyText?.includes("PUBLIC_FIXTURE_MARKER"),
        { timeout: 15_000, polling: 100 },
      );
    } catch (error) {
      console.error(
        "Replay bootstrap diagnostics:",
        JSON.stringify(
          {
            agentMetrics: await agent.evaluate(() => window.__agentMetrics),
            relayCaptures: relay.metrics.captures,
            browserErrors,
          },
          null,
          2,
        ),
      );
      throw error;
    }
    const initialAgentMetrics = await agent.evaluate(() => window.__agentMetrics);
    const initialPayload = relay.metrics.capturePayloads.join("\n");
    const replayStatus = initialAgentMetrics.replayStatus;
    stage("late-viewer replay bootstrapped");

    check(checks, "WebSocket tickets are single-use", ticketIsSingleUse, `rejections=${relay.metrics.ticketRejections}`);
    check(
      checks,
      "Late viewer receives a fresh epoch/full snapshot",
      initialAgentMetrics.epochChanges >= 1 && replayStatus.eventsApplied >= 2,
      `epochs=${initialAgentMetrics.epochChanges}, events=${replayStatus.eventsApplied}`,
    );
    check(
      checks,
      "Sensitive fixture values never enter relay payloads",
      SECRETS.every((secret) => !initialPayload.includes(secret)),
      `searched=${SECRETS.length} unique sentinels`,
    );
    check(
      checks,
      "Replay keeps masked input values masked",
      replayStatus.inputValues.every((value) => !SECRETS.includes(value)),
      JSON.stringify(replayStatus.inputValues),
    );
    check(
      checks,
      "Open shadow DOM is replayed",
      replayStatus.shadowText.some((text) => text.includes("SHADOW_DOM_MARKER")),
      JSON.stringify(replayStatus.shadowText),
    );
    check(
      checks,
      "Same-origin iframe content is replayed",
      replayStatus.iframeText.some((text) => text.includes("SAME_ORIGIN_IFRAME_MARKER")),
      JSON.stringify(replayStatus.iframeText),
    );
    check(
      checks,
      "Cross-origin iframe is represented as a blocked placeholder",
      replayStatus.crossOriginPlaceholder && !initialPayload.includes("CROSS_ORIGIN_PRIVATE_MARKER"),
      `placeholder=${replayStatus.crossOriginPlaceholder}`,
    );
    check(
      checks,
      "rrweb replay target allows same-origin access but disables scripts",
      replayStatus.innerSandbox === "allow-same-origin",
      replayStatus.innerSandbox,
    );
    check(checks, "Captured scripts do not execute during replay", !replayStatus.hostileExecuted, String(replayStatus.hostileExecuted));
    await sleep(300);
    const canaryCountAfterInitialReplay = relay.metrics.canaryRequests.length;
    check(
      checks,
      "Replay produces no canary network requests",
      canaryCountAfterInitialReplay === canaryCountBeforeReplay,
      `before=${canaryCountBeforeReplay}, after=${canaryCountAfterInitialReplay}`,
    );

    await customer.evaluate(() => window.__cobrowseSpike.navigateSpa());
    try {
      await agent.waitForFunction(
        () => window.__agentMetrics?.replayStatus?.bodyText?.includes("SPA checkout review route"),
        { timeout: 10_000 },
      );
    } catch (error) {
      console.error(
        "SPA replay diagnostics:",
        JSON.stringify(
          {
            agentMetrics: await agent.evaluate(() => window.__agentMetrics),
            latestCaptures: relay.metrics.captures.slice(-5),
            latestPayloads: relay.metrics.capturePayloads.slice(-3).map((payload) => JSON.parse(payload)),
            browserErrors,
          },
          null,
          2,
        ),
      );
      throw error;
    }
    check(checks, "SPA DOM navigation reaches replay", true, "route marker observed");
    stage("SPA mutation replayed");

    relay.dropNextPublisherFrame = true;
    await customer.evaluate(() => window.__cobrowseSpike.mutate(15));
    await sleep(250);
    await customer.evaluate(() => window.__cobrowseSpike.mutate(15));
    await agent.waitForFunction(
      () => window.__agentMetrics?.gapsDetected >= 1 && window.__agentMetrics?.resyncResolved >= 1,
      { timeout: 15_000 },
    );
    const afterGap = await agent.evaluate(() => window.__agentMetrics);
    check(
      checks,
      "Sequence gap triggers a full-snapshot resync",
      relay.metrics.droppedFrames === 1 && afterGap.gapsDetected >= 1 && afterGap.resyncResolved >= 1,
      `dropped=${relay.metrics.droppedFrames}, gaps=${afterGap.gapsDetected}, resolved=${afterGap.resyncResolved}`,
    );
    stage("sequence-gap resync verified");

    const publisherReconnectsBefore = await customer.evaluate(() => window.__cobrowseSpike.stats.reconnects);
    const viewerReconnectsBefore = afterGap.reconnects;
    relay.forceDisconnect();
    try {
      await customer.waitForFunction(
        (previous) => window.__cobrowseSpike?.stats.ready && window.__cobrowseSpike.stats.reconnects > previous,
        { timeout: 15_000, polling: 100 },
        publisherReconnectsBefore,
      );
    } catch (error) {
      console.error(
        "Publisher reconnect diagnostics:",
        JSON.stringify(
          {
            publisherStats: await customer.evaluate(() => window.__cobrowseSpike.stats),
            openClients: relay.clients.size,
            ticketsIssued: relay.metrics.ticketsIssued,
            ticketRejections: relay.metrics.ticketRejections,
            browserErrors,
          },
          null,
          2,
        ),
      );
      throw error;
    }
    await agent.waitForFunction(
      (previous) => window.__agentMetrics?.connected && window.__agentMetrics.reconnects > previous,
      { timeout: 15_000 },
      viewerReconnectsBefore,
    );
    await agent.waitForFunction(
      () => window.__agentMetrics?.replayStatus?.bodyText?.includes("PUBLIC_FIXTURE_MARKER"),
      { timeout: 15_000 },
    );
    const afterReconnect = await agent.evaluate(() => window.__agentMetrics);
    check(
      checks,
      "Publisher and viewer reconnect with newly issued tickets",
      afterReconnect.reconnects > viewerReconnectsBefore,
      `viewerReconnects=${afterReconnect.reconnects}`,
    );
    stage("publisher/viewer reconnect verified");

    const epochsBeforeReload = afterReconnect.epochChanges;
    await customer.reload({ waitUntil: "domcontentloaded" });
    await customer.waitForFunction(() => window.__cobrowseSpike?.stats.ready === true, {
      timeout: 15_000,
      polling: 100,
    });
    await agent.waitForFunction(
      (previous) =>
        window.__agentMetrics?.epochChanges > previous &&
        window.__agentMetrics?.replayStatus?.bodyText?.includes("PUBLIC_FIXTURE_MARKER"),
      { timeout: 15_000, polling: 100 },
      epochsBeforeReload,
    );
    check(checks, "Same-origin full-page reload creates a new replay epoch", true, "fresh fixture observed");
    stage("same-origin reload replayed");

    const beforePerformance = await customerCdp.send("Performance.getMetrics");
    const captureCountBeforeBurst = relay.metrics.captures.length;
    const mutationDurationMs = await customer.evaluate(() => window.__cobrowseSpike.mutate(500));
    await sleep(500);
    stage("CPU-throttled mutation burst captured");
    const afterPerformance = await customerCdp.send("Performance.getMetrics");
    const burstCaptures = relay.metrics.captures.slice(captureCountBeforeBurst);

    const snapshotCountBeforeStress = relay.metrics.captures.reduce(
      (count, capture) => count + capture.fullSnapshotBytes.length,
      0,
    );
    await customer.evaluate(() => window.__cobrowseSpike.addLargeDom(2_500));
    stage("stress DOM constructed");
    await customer.evaluate(() => window.__cobrowseSpike.forceResync());
    const stressDeadline = Date.now() + 15_000;
    while (
      relay.metrics.captures.reduce((count, capture) => count + capture.fullSnapshotBytes.length, 0) <=
        snapshotCountBeforeStress &&
      Date.now() < stressDeadline
    ) {
      await sleep(100);
    }
    stage("stress full snapshot captured");

    const snapshotRaw = relay.metrics.captures.flatMap((capture) => capture.fullSnapshotBytes);
    const snapshotGzip = relay.metrics.captures.flatMap((capture) => capture.fullSnapshotGzipBytes);
    const steadyCaptures = relay.metrics.captures.filter((capture) => !capture.fullSnapshotBytes.length);
    const finalPayload = relay.metrics.capturePayloads.join("\n");
    const heapBefore = metricValue(beforePerformance, "JSHeapUsedSize");
    const heapAfter = metricValue(afterPerformance, "JSHeapUsedSize");
    const agentFinal = await agent.evaluate(() => window.__agentMetrics);
    const publisherFinal = await customer.evaluate(() => window.__cobrowseSpike.stats);

    check(
      checks,
      "Secrets remain absent after SPA, reconnect, mutation and stress paths",
      SECRETS.every((secret) => !finalPayload.includes(secret)),
      `payloadBytes=${Buffer.byteLength(finalPayload)}`,
    );
    check(
      checks,
      "Stress DOM produces a measurable full snapshot",
      snapshotRaw.length > snapshotCountBeforeStress && Math.max(...snapshotRaw) > snapshotRaw[0],
      `snapshots=${snapshotRaw.length}, maxRawBytes=${Math.max(...snapshotRaw)}`,
    );
    check(
      checks,
      "Capture remains error-free under 4x CPU throttling",
      publisherFinal.recordErrors.length === 0,
      JSON.stringify(publisherFinal.recordErrors),
    );

    const result = {
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        chromium: await browser.version(),
        cpuThrottleRate: 4,
        viewport: "390x844@2x",
        rrwebRecord: "2.1.6",
        rrwebReplay: "2.1.6",
      },
      checks,
      metrics: {
        ticketRejections: relay.metrics.ticketRejections,
        websocketConnections: relay.metrics.connections,
        droppedFrames: relay.metrics.droppedFrames,
        resyncRequests: relay.metrics.resyncRequests,
        resyncDurationsMs: agentFinal.resyncDurationsMs,
        snapshotRawBytes: snapshotRaw,
        snapshotGzipBytes: snapshotGzip,
        steadyFrameCount: steadyCaptures.length,
        steadyFrameRawBytesP50: percentile(steadyCaptures.map((capture) => capture.rawBytes), 0.5),
        steadyFrameRawBytesP95: percentile(steadyCaptures.map((capture) => capture.rawBytes), 0.95),
        steadyFrameGzipBytesP50: percentile(steadyCaptures.map((capture) => capture.gzipBytes), 0.5),
        steadyFrameGzipBytesP95: percentile(steadyCaptures.map((capture) => capture.gzipBytes), 0.95),
        mutationBurst: {
          nodes: 500,
          durationMs: mutationDurationMs,
          relayFrames: burstCaptures.length,
          rawBytes: burstCaptures.reduce((sum, capture) => sum + capture.rawBytes, 0),
          gzipBytes: burstCaptures.reduce((sum, capture) => sum + capture.gzipBytes, 0),
        },
        heapUsedBytesBeforeBurst: heapBefore,
        heapUsedBytesAfterBurst: heapAfter,
        heapUsedDeltaBytes: heapBefore == null || heapAfter == null ? null : heapAfter - heapBefore,
        canaryRequestsAtAgentStart: canaryCountBeforeReplay,
        canaryRequestsAfterInitialReplay: canaryCountAfterInitialReplay,
        customerOriginCanaryRequestsTotal: relay.metrics.canaryRequests.length,
        browserErrors,
      },
      passed: checks.every((entry) => entry.passed) && browserErrors.length === 0,
    };

    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await browser?.close();
    await relay.close();
    await crossOrigin.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

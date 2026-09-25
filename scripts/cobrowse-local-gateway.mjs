#!/usr/bin/env node
// Local-only ingress for one public test tunnel. It does not start or restart
// the Contact Center app, streaming sidecar, or tunnel process.
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

function validPort(value, label, allowZero = false) {
  const port = Number(value);
  if (!Number.isInteger(port) || (port < 1024 && !(allowZero && port === 0)) || port > 65535)
    throw new Error(`${label} must be an integer from 1024 to 65535`);
  return port;
}

export function cobrowseGatewayTarget(requestUrl, appPort, sidecarPort) {
  const url = String(requestUrl || "/");
  if (url === "/ws" || url.startsWith("/ws/"))
    return { port: sidecarPort, path: url.slice(3) || "/" };
  return { port: appPort, path: url };
}

export async function startCobrowseLocalGateway({ port = 3080, appPort = 3000, sidecarPort = 3001 } = {}) {
  port = validPort(port, "Gateway port", true);
  appPort = validPort(appPort, "Application port");
  sidecarPort = validPort(sidecarPort, "Sidecar port");
  if (new Set([port, appPort, sidecarPort]).size !== 3)
    throw new Error("Gateway, application and sidecar ports must be distinct");
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const target = cobrowseGatewayTarget(request.url, appPort, sidecarPort);
    const upstream = http.request({ host: "127.0.0.1", port: target.port, method: request.method,
      path: target.path, headers: request.headers }, (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.on("aborted", () => response.destroy());
      incoming.on("error", () => response.destroy());
      incoming.on("close", () => { if (!incoming.complete) response.destroy(); });
      incoming.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" });
      response.end("Local co-browsing upstream unavailable");
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const target = cobrowseGatewayTarget(request.url, appPort, sidecarPort);
    const upstream = net.connect(target.port, "127.0.0.1", () => {
      const headerLines = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2)
        headerLines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      upstream.write(`${request.method} ${target.path} HTTP/${request.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveReady);
  });
  return { port: server.address().port, appPort, sidecarPort, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClosed) => server.close(resolveClosed));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const gateway = await startCobrowseLocalGateway({
    port: process.env.COBROWSE_GATEWAY_PORT || 3080,
    appPort: process.env.COBROWSE_APP_PORT || 3000,
    sidecarPort: process.env.STREAMING_WS_PORT || 3001,
  });
  console.log(`Co-browsing test gateway on http://127.0.0.1:${gateway.port}: /ws/* -> ${gateway.sidecarPort}, other paths -> ${gateway.appPort}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => { void gateway.close().finally(() => process.exit()); });
}

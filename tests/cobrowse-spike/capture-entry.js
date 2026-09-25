import { record } from "@rrweb/record";

const SESSION_ID = new URL(location.href).searchParams.get("session") || "f0-session";
const MASK = "*";
const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 256 * 1024;
const FLUSH_MS = 100;

let socket;
let stopRecorder;
let reconnectTimer;
let flushTimer;
let pending = [];
let epoch = "";
let sequence = 0;
let generation = 0;

const stats = {
  ready: false,
  generations: 0,
  reconnects: 0,
  framesSent: 0,
  eventsSent: 0,
  sanitizedUrls: 0,
  strippedAttributes: 0,
  recordErrors: [],
};

function scrubUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = new URL(value, location.href);
    if (!["http:", "https:"].includes(parsed.protocol)) return value;
    const wasSensitive = parsed.search || parsed.hash || parsed.username || parsed.password;
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    if (wasSensitive) stats.sanitizedUrls += 1;
    return parsed.href;
  } catch {
    return value;
  }
}

function scrubCss(value) {
  if (typeof value !== "string") return value;
  return value.replace(/url\(\s*(['"]?)(?!data:|blob:)[^)]+\1\s*\)/gi, "url(\"\")");
}

function sanitizeEvent(event) {
  const clone = structuredClone(event);

  function visit(value, key = "") {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry));
      return;
    }

    if (value.attributes && typeof value.attributes === "object") {
      const tagName = typeof value.tagName === "string" ? value.tagName.toLowerCase() : "";
      for (const [attribute, attributeValue] of Object.entries(value.attributes)) {
        const lower = attribute.toLowerCase();
        if (
          lower.startsWith("on") ||
          lower === "srcdoc" ||
          lower === "nonce" ||
          lower === "integrity" ||
          lower === "data-sensitive-value"
        ) {
          delete value.attributes[attribute];
          stats.strippedAttributes += 1;
          continue;
        }
        if (["href", "src", "action", "poster", "xlink:href"].includes(lower)) {
          if (
            ["src", "poster", "xlink:href"].includes(lower) &&
            ["img", "video", "audio", "source", "object", "embed", "link"].includes(tagName)
          ) {
            delete value.attributes[attribute];
            stats.strippedAttributes += 1;
          } else {
            value.attributes[attribute] = scrubUrl(attributeValue);
          }
        } else if (lower === "style") {
          value.attributes[attribute] = scrubCss(attributeValue);
        }
      }
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      if (typeof childValue === "string") {
        if (["href", "src", "action", "poster", "base"].includes(childKey.toLowerCase())) {
          value[childKey] = scrubUrl(childValue);
        } else if (childKey.toLowerCase().includes("csstext")) {
          value[childKey] = scrubCss(childValue);
        }
      } else {
        visit(childValue, childKey);
      }
    }
  }

  visit(clone);
  return clone;
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!pending.length || socket?.readyState !== WebSocket.OPEN) return;

  const events = [];
  let estimatedBytes = 0;
  while (pending.length && events.length < MAX_BATCH_EVENTS) {
    const candidate = pending[0];
    const candidateBytes = JSON.stringify(candidate).length;
    if (events.length && estimatedBytes + candidateBytes > MAX_BATCH_BYTES) break;
    pending.shift();
    events.push(candidate);
    estimatedBytes += candidateBytes;
  }

  sequence += 1;
  socket.send(
    JSON.stringify({
      type: "capture",
      sessionId: SESSION_ID,
      epoch,
      fromSeq: sequence,
      toSeq: sequence,
      events,
    }),
  );
  stats.framesSent += 1;
  stats.eventsSent += events.length;
  if (pending.length) scheduleFlush();
}

function enqueue(event) {
  pending.push(sanitizeEvent(event));
  scheduleFlush();
}

function startNewEpoch(reason) {
  stopRecorder?.();
  pending = [];
  epoch = crypto.randomUUID();
  sequence = 0;
  generation += 1;
  stats.generations = generation;
  stopRecorder = record({
    emit: enqueue,
    blockSelector:
      "[data-cobrowse-block], input[type='password'], [autocomplete*='cc-'], iframe[data-cobrowse-cross-origin], #embedded-widget",
    maskTextSelector: "[data-cobrowse-mask]",
    maskAllInputs: true,
    inlineStylesheet: true,
    recordCanvas: false,
    inlineImages: false,
    collectFonts: false,
    recordCrossOriginIframes: false,
    keepIframeSrcFn: () => false,
    slimDOMOptions: {
      script: true,
      comment: true,
      headFavicon: true,
      headWhitespace: true,
      headMetaDescKeywords: true,
      headMetaSocial: true,
      headMetaRobots: true,
      headMetaHttpEquiv: true,
      headMetaAuthorship: true,
      headMetaVerification: true,
    },
    sampling: {
      mousemove: 100,
      mouseInteraction: true,
      scroll: 150,
      input: "last",
    },
    errorHandler(error) {
      stats.recordErrors.push(String(error));
    },
  });
  window.dispatchEvent(new CustomEvent("cobrowse-epoch", { detail: { epoch, reason } }));
}

async function getTicket() {
  const response = await fetch(`/ticket?role=publisher&session=${encodeURIComponent(SESSION_ID)}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
  return (await response.json()).ticket;
}

async function connect() {
  clearTimeout(reconnectTimer);
  try {
    const ticket = await getTicket();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(
      `${protocol}//${location.host}/ws?role=publisher&session=${encodeURIComponent(SESSION_ID)}&ticket=${encodeURIComponent(ticket)}`,
    );
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", role: "publisher", sessionId: SESSION_ID }));
    });
    socket.addEventListener("message", (message) => {
      const data = JSON.parse(message.data);
      if (data.type === "hello-ack") {
        startNewEpoch(generation ? "reconnect" : "initial");
        stats.ready = true;
      } else if (data.type === "resync-request") {
        startNewEpoch(data.reason || "viewer-request");
      }
    });
    socket.addEventListener("close", () => {
      stats.ready = false;
      stopRecorder?.();
      stopRecorder = undefined;
      pending = [];
      stats.reconnects += 1;
      reconnectTimer = setTimeout(connect, 150);
    });
  } catch (error) {
    stats.recordErrors.push(String(error));
    reconnectTimer = setTimeout(connect, 250);
  }
}

async function nextPaint() {
  // Headless Chromium pauses requestAnimationFrame in the background customer
  // tab once the agent tab is open. A macrotask still lets MutationObserver
  // drain without making the fixture depend on tab visibility.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

window.__cobrowseSpike = {
  stats,
  async mutate(count = 100) {
    const target = document.querySelector("#mutation-target");
    const start = performance.now();
    for (let index = 0; index < count; index += 1) {
      const row = document.createElement("div");
      row.className = "dynamic-row";
      row.textContent = `Mutation row ${index}`;
      target.append(row);
      if (target.childElementCount > 350) target.firstElementChild.remove();
    }
    await nextPaint();
    return performance.now() - start;
  },
  async addLargeDom(count = 5000) {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
      const row = document.createElement("div");
      row.className = "stress-row";
      row.textContent = `Stress node ${index}`;
      fragment.append(row);
    }
    document.querySelector("#stress-target").replaceChildren(fragment);
    await nextPaint();
    return count;
  },
  navigateSpa() {
    history.pushState({ source: "f0" }, "", "/checkout/review?auth=ROUTE_QUERY_SECRET#private");
    document.querySelector("#route-state").textContent = "SPA checkout review route";
  },
  forceResync() {
    startNewEpoch("manual-stress-snapshot");
  },
};

connect();

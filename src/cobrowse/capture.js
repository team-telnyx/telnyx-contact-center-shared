import { record } from "@rrweb/record";
import { applyAssistCommand, assistFieldAt, fillAssistField } from "./assist-control.js";

const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

function stripUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = new URL(value, location.href);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch { return ""; }
}

function stripCss(value) {
  return typeof value === "string"
    ? value.replace(/url\(\s*(['"]?)(?!data:|blob:)[^)]+\1\s*\)/gi, "url(\"\")") : value;
}

export function sanitizeCaptureEvent(event) {
  const copy = structuredClone(event);
  if (copy?.type === 4 && copy.data) copy.data.title = "";
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.attributes && typeof value.attributes === "object") {
      const tag = String(value.tagName || "").toLowerCase();
      for (const [name, content] of Object.entries(value.attributes)) {
        const key = name.toLowerCase();
        if (key.startsWith("on") || ["srcdoc", "nonce", "integrity", "value", "data-sensitive-value"].includes(key) ||
          (["src", "poster", "xlink:href"].includes(key) &&
            ["img", "video", "audio", "source", "object", "embed", "link", "iframe"].includes(tag))) {
          delete value.attributes[name];
        } else if (["href", "src", "action", "poster", "xlink:href"].includes(key)) {
          value.attributes[name] = stripUrl(content);
        } else if (key === "style") value.attributes[name] = stripCss(content);
      }
    }
    for (const [key, content] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (typeof content === "string") {
        if (["href", "src", "action", "poster", "base"].includes(lower)) value[key] = stripUrl(content);
        else if (lower.includes("csstext")) value[key] = stripCss(content);
      } else visit(content);
    }
  };
  visit(copy);
  return copy;
}

function start({ baseUrl, sessionId, browserCredential, privacy, onStopped, onStatus, onCredential, onControlAction }) {
  let credential = browserCredential;
  let socket = null;
  let stopRecorder = null;
  let reconnectTimer = null;
  let flushTimer = null;
  let reauthTimer = null;
  let running = true;
  let pending = [];
  let pendingBytes = 0;
  let awaitingSnapshot = true;
  let epoch = "";
  let sequence = 0;
  let controlAllowed = false;
  let selectedField = null;
  let selectedFieldCommandId = null;
  let nodeMirror = null;

  function resetCapture() {
    stopRecorder?.();
    stopRecorder = null;
    nodeMirror = null;
    pending = [];
    pendingBytes = 0;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function sendFrame(type, events) {
    if (socket?.readyState !== WebSocket.OPEN || !events.length) return;
    sequence += 1;
    const frame = JSON.stringify({ v: 1, type, epoch, seq: sequence, events });
    if (frame.length > 4 * 1024 * 1024) {
      resetCapture();
      onStatus?.("page_too_large");
      return;
    }
    socket.send(frame);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending.length || awaitingSnapshot || socket?.readyState !== WebSocket.OPEN) return;
    const events = [];
    let bytes = 0;
    while (pending.length && events.length < MAX_BATCH_EVENTS) {
      const next = pending[0];
      if (events.length && bytes + next.bytes > MAX_BATCH_BYTES) break;
      pending.shift();
      pendingBytes -= next.bytes;
      events.push(next.event);
      bytes += next.bytes;
    }
    sendFrame("events", events);
    if (pending.length) flushTimer = setTimeout(flush, 100);
  }

  function enqueue(event) {
    const sanitized = sanitizeCaptureEvent(event);
    const bytes = JSON.stringify(sanitized).length;
    if (awaitingSnapshot) {
      if (event.type === 4) { pending.push({ event: sanitized, bytes }); pendingBytes += bytes; return; }
      if (event.type === 2) {
        sendFrame("snapshot", [...pending.map((item) => item.event), sanitized]);
        pending = [];
        pendingBytes = 0;
        awaitingSnapshot = false;
      }
      return;
    }
    if (bytes > MAX_BATCH_BYTES || pendingBytes + bytes > MAX_PENDING_BYTES) {
      startEpoch();
      return;
    }
    pending.push({ event: sanitized, bytes });
    pendingBytes += bytes;
    if (!flushTimer) flushTimer = setTimeout(flush, 100);
  }

  function startEpoch() {
    resetCapture();
    selectedField = null;
    selectedFieldCommandId = null;
    if (!running || socket?.readyState !== WebSocket.OPEN) return;
    epoch = crypto.randomUUID();
    sequence = 0;
    awaitingSnapshot = true;
    const blocks = ["title", "[data-cobrowse-block]", "[data-sensitive]", "input[type='password']", "[autocomplete*='cc-']", "iframe[data-cobrowse-cross-origin]", "[id^='telnyx-widget-']", ...(privacy.blockSelectors || [])];
    const masks = ["[data-cobrowse-mask]", ...(privacy.maskSelectors || [])];
    try {
      stopRecorder = record({
        emit: enqueue,
        plugins: [{ name: "cobrowse-control-mirror", options: {},
          getMirror: ({ nodeMirror: mirror }) => { nodeMirror = mirror; } }],
        blockSelector: blocks.join(","),
        maskTextSelector: masks.join(","),
        maskAllText: privacy.preset === "strict",
        maskAllInputs: true,
        inlineStylesheet: true,
        recordCanvas: false,
        inlineImages: false,
        collectFonts: false,
        recordCrossOriginIframes: false,
        keepIframeSrcFn: () => false,
        slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true,
          headMetaDescKeywords: true, headMetaSocial: true, headMetaRobots: true,
          headMetaHttpEquiv: true, headMetaAuthorship: true, headMetaVerification: true },
        sampling: { mousemove: 100, mouseInteraction: true, scroll: 150, input: "last" },
        errorHandler: () => onStatus?.("capture_error"),
      });
    } catch { onStatus?.("capture_error"); }
  }

  async function ticket() {
    const response = await fetch(`${baseUrl}/api/widget-cobrowse/sessions/${sessionId}/token`, {
      method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${credential}` },
    });
    if (!response.ok) throw new Error([401, 403, 404, 409].includes(response.status) ? "session_revoked" : "ticket_unavailable");
    const result = await response.json();
    credential = result.browserCredential;
    onCredential?.(credential);
    sessionStorage.setItem(`telnyx-cobrowse:${sessionId}`, JSON.stringify({ sessionId, browserCredential: credential }));
    return result;
  }

  async function connect() {
    if (!running) return;
    try {
      const next = await ticket();
      if (!running) return;
      socket = new WebSocket(next.wsUrl);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ v: 1, type: "hello", ticket: next.ticket })));
      socket.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === "ready") {
          onStatus?.("connected");
          startEpoch();
          clearInterval(reauthTimer);
          reauthTimer = setInterval(async () => {
            try { const renewed = await ticket(); socket.send(JSON.stringify({ v: 1, type: "reauth", ticket: renewed.ticket })); }
            catch { socket?.close(); }
          }, 75_000);
        } else if (message.type === "resync") startEpoch();
        else if (message.type === "control") {
          let accepted = false;
          let fieldSelected = false;
          if (controlAllowed && !awaitingSnapshot && message.epoch === epoch) {
            try {
              if (message.action === "fill") {
                accepted = message.selectionId === selectedFieldCommandId &&
                  fillAssistField(selectedField, message.value, privacy);
              } else {
                if (message.action === "click") { selectedField = null; selectedFieldCommandId = null; }
                const target = message.action === "click" ? nodeMirror?.getNode(message.nodeId) : null;
                accepted = applyAssistCommand(message, target, privacy);
                if (accepted && message.action === "click") {
                  selectedField = assistFieldAt(target, privacy);
                  if (selectedField) { selectedFieldCommandId = message.commandId; fieldSelected = true; }
                }
              }
            } catch { /* Fail closed on customer-page errors. */ }
            try { onControlAction?.(message.action, accepted); } catch { /* Site callback must not interrupt capture. */ }
          }
          if (socket?.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ v: 1, type: "control_result", commandId: message.commandId, accepted, fieldSelected }));
        }
      });
      socket.addEventListener("close", () => {
        resetCapture();
        clearInterval(reauthTimer);
        onStatus?.("reconnecting");
        if (running) reconnectTimer = setTimeout(connect, 1000);
      });
    } catch (error) {
      if (error.message === "session_revoked") {
        halt();
        sessionStorage.removeItem(`telnyx-cobrowse:${sessionId}`);
        onStopped?.();
        return;
      }
      onStatus?.("reconnecting");
      if (running) reconnectTimer = setTimeout(connect, 2000);
    }
  }

  function halt() {
    running = false;
    controlAllowed = false;
    selectedField = null;
    selectedFieldCommandId = null;
    clearTimeout(reconnectTimer);
    clearInterval(reauthTimer);
    resetCapture();
    socket?.close();
  }

  async function stop() {
    // Local revocation happens before any network operation.
    halt();
    sessionStorage.removeItem(`telnyx-cobrowse:${sessionId}`);
    onStopped?.();
    try {
      await fetch(`${baseUrl}/api/widget-cobrowse/sessions/${sessionId}/stop`, {
        method: "POST", mode: "cors", credentials: "omit", keepalive: true,
        headers: { Authorization: `Bearer ${credential}` },
      });
    } catch { /* The lease/reconciler still closes the remote session. */ }
  }

  void connect();
  return { stop, suspend: halt, getCredential: () => credential,
    setControlAllowed: (allowed) => {
      controlAllowed = allowed === true && running;
      if (!controlAllowed) { selectedField = null; selectedFieldCommandId = null; }
    } };
}

window.TelnyxCobrowseCapture = { start };

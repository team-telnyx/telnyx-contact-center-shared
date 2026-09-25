import { Replayer } from "@rrweb/replay";

let replayer;
let lastMeta;
let eventsApplied = 0;
let eventsCast = 0;
const replayWarnings = [];

function reset() {
  replayer?.destroy();
  replayer = undefined;
  lastMeta = undefined;
  document.querySelector("#replay-root").replaceChildren();
}

function ensureReplayer() {
  if (replayer) return replayer;
  replayer = new Replayer([], {
    root: document.querySelector("#replay-root"),
    liveMode: true,
    UNSAFE_replayCanvas: false,
    showWarning: false,
    showDebug: false,
    triggerFocus: false,
    mouseTail: false,
    useVirtualDom: false,
    logger: {
      warn: (...args) => replayWarnings.push(args.map(String).join(" ")),
      log: () => {},
    },
    insertStyleRules: [
      ".cobrowse-cross-origin-placeholder::after { content: 'Cross-origin content unavailable'; display: block; padding: 16px; color: #555; background: #eee; }",
    ],
  });
  replayer.on("event-cast", () => {
    eventsCast += 1;
    reportSoon();
  });
  // Co-browsing applies events as current state, not as a historical timeline.
  // A future baseline makes rrweb cast each arriving event synchronously.
  replayer.startLive(Date.now() + 86_400_000);
  return replayer;
}

function inspectReplay() {
  const frameDocument = replayer?.iframe?.contentDocument;
  const frameWindow = replayer?.iframe?.contentWindow;
  const bodyText = frameDocument?.body?.textContent || "";
  const inputValues = frameDocument
    ? Array.from(frameDocument.querySelectorAll("input, textarea")).map((element) => element.value)
    : [];
  const shadowText = frameDocument
    ? Array.from(frameDocument.querySelectorAll("*")).flatMap((element) =>
        element.shadowRoot ? [element.shadowRoot.textContent || ""] : [],
      )
    : [];
  const iframeText = frameDocument
    ? Array.from(frameDocument.querySelectorAll("iframe")).map((element) => {
        try {
          return element.contentDocument?.body?.textContent || "";
        } catch {
          return "cross-origin";
        }
      })
    : [];
  return {
    type: "replay-status",
    eventsApplied,
    eventsCast,
    bodyText,
    inputValues,
    shadowText,
    iframeText,
    crossOriginPlaceholder: Boolean(
      frameDocument?.querySelector("iframe[data-cobrowse-cross-origin], .cobrowse-cross-origin-placeholder"),
    ),
    innerSandbox: replayer?.iframe?.getAttribute("sandbox") || null,
    routeStateText: frameDocument?.querySelector("#route-state")?.textContent || null,
    replayWarnings: replayWarnings.slice(-10),
    hostileExecuted: Boolean(frameWindow?.__cobrowseHostileExecuted || window.__cobrowseHostileExecuted),
  };
}

function reportSoon() {
  setTimeout(() => parent.postMessage(inspectReplay(), "*"), 75);
}

addEventListener("message", (message) => {
  if (message.source !== parent || !message.data || typeof message.data !== "object") return;
  if (message.data.type === "reset") {
    reset();
    parent.postMessage({ type: "replay-reset" }, "*");
    return;
  }
  if (message.data.type !== "events" || !Array.isArray(message.data.events)) return;

  for (const event of message.data.events) {
    if (event.type === 4) {
      lastMeta = event;
      eventsApplied += 1;
      continue;
    }
    if (event.type === 2) {
      const meta = lastMeta;
      if (replayer) reset();
      lastMeta = meta;
      if (lastMeta) ensureReplayer().addEvent(lastMeta);
      ensureReplayer().addEvent(event);
      eventsApplied += 1;
      continue;
    }
    if (replayer) ensureReplayer().addEvent(event);
    eventsApplied += 1;
  }
  reportSoon();
});

parent.postMessage({ type: "replay-ready" }, "*");

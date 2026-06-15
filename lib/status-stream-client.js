"use client";

/**
 * Shared singleton client for the /api/user/status-stream SSE endpoint.
 *
 * WHY THIS EXISTS
 * Multiple components (site-header, nav-user, AgentDesktop,
 * CampaignActivationSelector, QueueActivationPanel, GlobalWrapupSheet) all need
 * the same real-time status/queue/campaign events. Previously each one opened
 * its OWN `new EventSource("/api/user/status-stream")`. With React StrictMode
 * (dev double-mount) and re-mounts this produced 12-17 concurrent SSE
 * connections to the same endpoint. Browsers cap HTTP/1.1 at 6 connections per
 * origin, and SSE holds each connection open indefinitely, so the cap was
 * exhausted: extra streams were left (canceled)/pending and ordinary fetches
 * (e.g. /api/user/profile) could not get a socket — which in turn made the
 * header's SSE-down fallback poll fire constantly.
 *
 * This module collapses all of that into ONE shared EventSource. Components
 * subscribe to named events and to connection-state changes; the underlying
 * connection is opened on the first subscriber and closed when the last one
 * unsubscribes. Reconnection is handled centrally with backoff.
 */

const ENDPOINT = "/api/user/status-stream";
const EVENT_NAMES = [
  "connected",
  "status_changed",
  "queue_changed",
  "campaign_changed",
  "ping",
];

let eventSource = null;
let refCount = 0;
let reconnectTimer = null;
let reconnectDelay = 1000; // grows with backoff up to MAX
const MAX_RECONNECT_DELAY = 15000;
let connected = false;

// subscribers: Map<eventName, Set<handler>>
const subscribers = new Map();
// connection-state subscribers: Set<handler(boolean)>
const stateSubscribers = new Set();

function emit(eventName, payload) {
  const set = subscribers.get(eventName);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch (_) {
      // a misbehaving subscriber must not break the fan-out
    }
  }
}

function emitState(next) {
  if (connected === next) return;
  connected = next;
  for (const handler of stateSubscribers) {
    try {
      handler(connected);
    } catch (_) {}
  }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnect();
  if (refCount <= 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openConnection();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function openConnection() {
  if (typeof window === "undefined" || !("EventSource" in window)) return;
  if (eventSource) return; // already open or opening

  try {
    eventSource = new EventSource(ENDPOINT);

    eventSource.addEventListener("connected", (event) => {
      reconnectDelay = 1000; // healthy stream resets backoff
      emitState(true);
      emit("connected", safeParse(event?.data));
    });

    for (const name of EVENT_NAMES) {
      if (name === "connected") continue;
      eventSource.addEventListener(name, (event) => {
        emit(name, safeParse(event?.data));
      });
    }

    eventSource.onerror = () => {
      // The stream dropped. Tear it down and reconnect with backoff so we do
      // not leak half-dead connections (which would re-exhaust the socket cap).
      emitState(false);
      if (eventSource) {
        try {
          eventSource.close();
        } catch (_) {}
        eventSource = null;
      }
      scheduleReconnect();
    };
  } catch (_) {
    eventSource = null;
    emitState(false);
    scheduleReconnect();
  }
}

function closeConnection() {
  clearReconnect();
  reconnectDelay = 1000;
  if (eventSource) {
    try {
      eventSource.close();
    } catch (_) {}
    eventSource = null;
  }
  emitState(false);
}

function safeParse(data) {
  if (data == null) return null;
  try {
    return JSON.parse(data);
  } catch (_) {
    return data;
  }
}

/**
 * Subscribe to a named SSE event from the shared status stream.
 * Returns an unsubscribe function. The shared connection is opened on the
 * first subscriber and closed when the last one leaves.
 *
 * @param {string} eventName one of EVENT_NAMES
 * @param {(payload:any)=>void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribeStatusStream(eventName, handler) {
  if (typeof handler !== "function") return () => {};

  let set = subscribers.get(eventName);
  if (!set) {
    set = new Set();
    subscribers.set(eventName, set);
  }
  set.add(handler);

  refCount += 1;
  if (refCount === 1) {
    openConnection();
  }

  let active = true;
  return function unsubscribe() {
    if (!active) return;
    active = false;
    const s = subscribers.get(eventName);
    if (s) {
      s.delete(handler);
      if (s.size === 0) subscribers.delete(eventName);
    }
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      closeConnection();
    }
  };
}

/**
 * Subscribe to connection-state changes (true = SSE healthy, false = down).
 * Fires immediately with the current state. Returns an unsubscribe function.
 * Like event subscriptions, this counts toward keeping the shared stream open.
 *
 * @param {(connected:boolean)=>void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribeStatusStreamState(handler) {
  if (typeof handler !== "function") return () => {};

  stateSubscribers.add(handler);

  refCount += 1;
  if (refCount === 1) {
    openConnection();
  }

  // Report current state immediately so late subscribers are not left guessing.
  try {
    handler(connected);
  } catch (_) {}

  let active = true;
  return function unsubscribe() {
    if (!active) return;
    active = false;
    stateSubscribers.delete(handler);
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      closeConnection();
    }
  };
}

/** Current connection state. Mostly for tests/diagnostics. */
export function isStatusStreamConnected() {
  return connected;
}

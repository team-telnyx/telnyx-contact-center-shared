"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Focus, Hand, MonitorX, MousePointer2, MousePointerClick, Scan, TextCursorInput, ZoomIn, ZoomOut } from "lucide-react";
import { InteractionActionButton, InteractionActionGroup } from "./InteractionActionGroup";

const streamingStates = new Set(["connecting", "active", "reconnecting"]);
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

function capturedViewport(events) {
  const meta = events?.find((event) => event?.type === 4)?.data;
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 240 || width > 8192 || height > 8192) return null;
  return { width, height };
}

export default function CobrowseAgentViewer({ interaction, session, onChanged }) {
  const [streamStatus, setStreamStatus] = useState("Waiting for visitor consent");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceViewport, setSourceViewport] = useState(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [zoomMode, setZoomMode] = useState("fit");
  const [manualZoom, setManualZoom] = useState(1);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const [controlMode, setControlMode] = useState(false);
  const [controlText, setControlText] = useState("");
  const [controlFeedback, setControlFeedback] = useState("");
  const [selectedFieldId, setSelectedFieldId] = useState(null);
  const frame = useRef(null);
  const socket = useRef(null);
  const viewerReady = useRef(false);
  const viewport = useRef(null);
  const drag = useRef(null);
  const controlPosition = useRef(null);
  const nextCommandId = useRef(0);
  const pendingCommands = useRef(new Map());
  const nextHitRequestId = useRef(0);
  const pendingHitTests = useRef(new Map());
  const sessionId = streamingStates.has(session?.state) ? session.id : null;
  const controlActive = session?.controlLevel === "assist" && session?.state === "active" && session?.canControl === true;
  const controlActiveRef = useRef(controlActive);
  controlActiveRef.current = controlActive;
  const currentSourceViewport = sourceViewport?.sessionId === sessionId ? sourceViewport : null;
  const sourceWidth = currentSourceViewport?.width || 1280;
  const sourceHeight = currentSourceViewport?.height || 800;
  const fitZoom = availableWidth ? Math.min(1, availableWidth / sourceWidth) : 1;
  const zoom = zoomMode === "fit" ? fitZoom : manualZoom;

  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const measure = () => setAvailableWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sessionId]);

  function changeZoom(next) {
    const element = viewport.current;
    const bounded = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    const center = element ? {
      x: (element.scrollLeft + element.clientWidth / 2) / zoom,
      y: (element.scrollTop + element.clientHeight / 2) / zoom,
    } : null;
    setManualZoom(bounded);
    setZoomMode("manual");
    if (element && center) requestAnimationFrame(() => {
      element.scrollLeft = center.x * bounded - element.clientWidth / 2;
      element.scrollTop = center.y * bounded - element.clientHeight / 2;
    });
  }

  function beginPan(event) {
    if (event.pointerType === "touch" || event.button !== 0 || event.target === event.currentTarget) return;
    if (controlActive && controlMode && !event.shiftKey) return;
    const element = viewport.current;
    if (!element) return;
    drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    element.setPointerCapture(event.pointerId);
  }

  function movePan(event) {
    const element = viewport.current;
    if (!element || !drag.current) return;
    element.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
    element.scrollTop = drag.current.top - (event.clientY - drag.current.y);
  }

  function sendControl(action, details, expectedPosition) {
    const position = controlPosition.current;
    if (!controlActiveRef.current || socket.current?.readyState !== WebSocket.OPEN || !position ||
      (expectedPosition && (expectedPosition.epoch !== position.epoch || expectedPosition.seq !== position.seq))) {
      setControlFeedback("Control connection is not ready");
      return;
    }
    const commandId = ++nextCommandId.current;
    pendingCommands.current.set(commandId, action);
    socket.current.send(JSON.stringify({ v: 1, type: "control", commandId,
      epoch: position.epoch, seq: position.seq, action, ...details }));
    setControlFeedback("Applying action…");
  }

  function controlClick(event) {
    if (!controlActive || !controlMode || event.shiftKey || drag.current || event.target === event.currentTarget) return;
    const bounds = frame.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = Math.floor((event.clientX - bounds.left) / zoom);
    const y = Math.floor((event.clientY - bounds.top) / zoom);
    if (x < 0 || y < 0 || x >= sourceWidth || y >= sourceHeight) return;
    const position = controlPosition.current;
    if (!position) return;
    setSelectedFieldId(null);
    const requestId = ++nextHitRequestId.current;
    const timeout = setTimeout(() => {
      pendingHitTests.current.delete(requestId);
      setControlFeedback("Could not identify the page element; try again");
    }, 1500);
    pendingHitTests.current.set(requestId, { position, timeout });
    frame.current?.contentWindow?.postMessage({ type: "cobrowse-hit-test", requestId, x, y }, location.origin);
  }

  async function requestControl() {
    if (controlBusy) return;
    setControlBusy(true);
    setControlError("");
    try {
      const response = await fetch(`/api/contact-center/cobrowse/${interaction.id}/control`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not request control");
      setControlFeedback("Waiting for visitor approval");
      window.dispatchEvent(new CustomEvent("contact-center:cobrowse-changed", { detail: { workItemId: interaction.id } }));
    } catch (reason) { setControlError(reason.message); }
    finally { setControlBusy(false); }
  }

  useEffect(() => {
    const hitTests = pendingHitTests.current;
    const onMessage = (event) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "cobrowse-replay-ready") {
        viewerReady.current = true;
        if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ v: 1, type: "resync" }));
      } else if (event.data?.type === "cobrowse-hit-test-result") {
        const pending = hitTests.get(event.data.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        hitTests.delete(event.data.requestId);
        if (Number.isSafeInteger(event.data.nodeId) && event.data.nodeId > 0)
          sendControl("click", { nodeId: event.data.nodeId }, pending.position);
        else setControlFeedback("This page element cannot be controlled");
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const pending of hitTests.values()) clearTimeout(pending.timeout);
      hitTests.clear();
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    let reconnectTimer;
    let reauthTimer;
    viewerReady.current = false;
    pendingCommands.current.clear();
    async function ticket() {
      const response = await fetch(`/api/contact-center/cobrowse/sessions/${sessionId}/token`, { method: "POST", cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Viewer authorization failed");
      return data;
    }
    async function connect() {
      if (cancelled) return;
      try {
        const issued = await ticket();
        if (cancelled) return;
        const ws = new WebSocket(issued.wsUrl);
        socket.current = ws;
        ws.addEventListener("open", () => ws.send(JSON.stringify({ v: 1, type: "hello", ticket: issued.ticket })));
        ws.addEventListener("message", (event) => {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === "ready") {
            setStreamStatus("Waiting for a fresh page snapshot");
            if (viewerReady.current) ws.send(JSON.stringify({ v: 1, type: "resync" }));
            clearInterval(reauthTimer);
            reauthTimer = setInterval(async () => {
              try { const next = await ticket(); ws.send(JSON.stringify({ v: 1, type: "reauth", ticket: next.ticket })); }
              catch { ws.close(); }
            }, 75_000);
          } else if (["snapshot", "events"].includes(message.type)) {
            if (message.type === "snapshot") {
              setStreamStatus("Viewing live page"); setSelectedFieldId(null); pendingCommands.current.clear();
              for (const pending of pendingHitTests.current.values()) clearTimeout(pending.timeout);
              pendingHitTests.current.clear();
            }
            if (typeof message.epoch === "string" && Number.isSafeInteger(message.seq))
              controlPosition.current = { epoch: message.epoch, seq: message.seq };
            const dimensions = capturedViewport(message.events);
            if (dimensions) setSourceViewport({ ...dimensions, sessionId });
            if (viewerReady.current) frame.current?.contentWindow?.postMessage({ type: "cobrowse-events", events: message.events }, location.origin);
          } else if (message.type === "waiting_snapshot") setStreamStatus("Waiting for a fresh page snapshot");
          else if (message.type === "reconnecting") setStreamStatus("Visitor is reconnecting");
          else if (message.type === "control_result") {
            const action = pendingCommands.current.get(message.commandId);
            pendingCommands.current.delete(message.commandId);
            if (action === "click") setSelectedFieldId(message.accepted && message.fieldSelected ? message.commandId : null);
            if (action === "fill" && message.accepted) setControlText("");
            setControlFeedback(message.accepted ? message.fieldSelected ? "Allowed field selected" : "Action applied"
              : "This element cannot be controlled");
          }
          else if (message.type === "control_denied") {
            pendingCommands.current.delete(message.commandId);
            setControlFeedback("Control unavailable or page changed; refresh the view");
          }
        });
        ws.addEventListener("close", () => {
          clearInterval(reauthTimer);
          setStreamStatus("Connection interrupted");
          if (!cancelled) reconnectTimer = setTimeout(connect, 1500);
        });
        ws.addEventListener("error", () => setStreamStatus("Connection interrupted"));
      } catch (reason) {
        setStreamStatus(reason.message);
        if (!cancelled) reconnectTimer = setTimeout(connect, 2500);
      }
    }
    void connect();
    return () => {
      cancelled = true;
      controlPosition.current = null;
      clearTimeout(reconnectTimer);
      clearInterval(reauthTimer);
      socket.current?.close();
      socket.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!controlActive) { setControlMode(false); setSelectedFieldId(null); }
  }, [controlActive]);

  async function endSharing() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/contact-center/cobrowse/${interaction.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "end" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not end co-browsing");
      onChanged?.();
      window.dispatchEvent(new CustomEvent("contact-center:cobrowse-changed", { detail: { workItemId: interaction.id } }));
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }

  return <div className="flex min-h-0 flex-1 flex-col gap-3 bg-muted/20 p-3" data-testid="cobrowse-interaction-viewer">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background px-4 py-3 text-sm">
      <div><p className="font-semibold">Live page view</p><p className="text-xs text-muted-foreground">{controlActive ? "Visitor-approved assistance · no recording" : "View only · no recording"}</p></div>
      <InteractionActionGroup label="Co-browsing session actions">
        <InteractionActionButton label="End sharing" description="Stop sharing the visitor's page and end this co-browsing session." icon={MonitorX} tone="negative" disabled={busy} busy={busy} onClick={() => void endSharing()} />
      </InteractionActionGroup>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {controlError && <p role="alert" className="text-sm text-destructive">{controlError}</p>}
    {sessionId && session?.controlAvailable && <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs">
      {controlActive ? <>
        <span className="font-medium text-emerald-700">Visitor allowed control</span>
        <InteractionActionGroup label="Visitor-approved page controls" className="ml-0">
          <InteractionActionButton label={controlMode ? "Return to pan" : "Control page"} description={controlMode ? "Stop sending clicks to the visitor's page and drag the local view instead." : "Send clicks only to site-approved elements on the visitor's page. Shift-drag still pans your view."} icon={controlMode ? Hand : MousePointer2} aria-pressed={controlMode} onClick={() => { setSelectedFieldId(null); setControlMode((current) => !current); }} />
          {controlMode && <>
            <InteractionActionButton label="Scroll visitor page up" description="Move the visitor's page up by one step; your local zoom does not change." icon={ArrowUp} onClick={() => sendControl("scroll", { deltaX: 0, deltaY: -400 })} />
            <InteractionActionButton label="Scroll visitor page down" description="Move the visitor's page down by one step; your local zoom does not change." icon={ArrowDown} onClick={() => sendControl("scroll", { deltaX: 0, deltaY: 400 })} />
            <InteractionActionButton label="Fill selected field" description="Send the typed text to the site-approved field you selected. Sensitive fields stay blocked." icon={TextCursorInput} disabled={!selectedFieldId} onClick={() => selectedFieldId && sendControl("fill", { selectionId: selectedFieldId, value: controlText })} />
          </>}
        </InteractionActionGroup>
        {controlMode && <input type="text" autoComplete="off" maxLength={500} aria-label="Text for an allowed customer field" placeholder="Text for selected field" value={controlText} onChange={(event) => setControlText(event.target.value)} className="min-w-40 rounded-md border bg-background px-2.5 py-1.5" />}
      </> : session?.controlRequestedAt ? <span>Waiting for visitor to approve control</span>
        : session?.canControl ? <InteractionActionGroup label="Request page control" className="ml-0">
          <InteractionActionButton label="Request control" description="Ask the visitor for separate permission to navigate and fill allowed fields." icon={MousePointerClick} disabled={controlBusy || session.state !== "active"} busy={controlBusy} onClick={() => void requestControl()} />
        </InteractionActionGroup>
          : <span>Assisted control requires the co-browsing control permission</span>}
      {controlFeedback && <span role="status" className="text-muted-foreground">{controlFeedback}</span>}
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p role="status" className="text-muted-foreground">{session.state === "pending_consent" ? "Waiting for visitor consent" : streamStatus}</p>
      {sessionId && <p className="text-xs text-muted-foreground">{controlActive && controlMode ? "Click to assist · Shift-drag to pan" : "Drag to pan · scroll to explore"}</p>}
      {sessionId && <div className="flex items-center gap-2">
        <span aria-live="polite" aria-label="Current zoom" className="min-w-12 text-center text-xs font-medium tabular-nums text-foreground">{Math.round(zoom * 100)}%</span>
        <InteractionActionGroup label="Co-browsing view controls" className="ml-0">
          <InteractionActionButton label="Fit width" description="Fit the visitor's full page width into this panel." icon={Scan} aria-pressed={zoomMode === "fit"} onClick={() => setZoomMode("fit")} />
          <InteractionActionButton label="Zoom out" description="Make the page smaller in your view only; the visitor's page is unchanged." icon={ZoomOut} disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - 0.25)} />
          <InteractionActionButton label="Zoom in" description="Make the page larger in your view only; the visitor's page is unchanged." icon={ZoomIn} disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + 0.25)} />
          <InteractionActionButton label="Actual size" description="Show the visitor's page at 100% in your view." icon={Focus} aria-pressed={zoomMode === "manual" && zoom === 1} onClick={() => changeZoom(1)} />
        </InteractionActionGroup>
      </div>}
    </div>
    {sessionId ? <div ref={viewport} role="region" aria-label="Scrollable co-browsing page view" tabIndex={0} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onClick={controlClick}
        className={`min-h-0 w-full flex-1 overflow-auto rounded-lg border bg-white ${controlActive && controlMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}>
        <div className="relative" style={{ width: sourceWidth * zoom, height: sourceHeight * zoom }}>
          <iframe key={sessionId} ref={frame} title="Isolated co-browsing replay" src="/cobrowse/replay" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
            className="pointer-events-none absolute left-0 top-0 border-0 bg-white" style={{ width: sourceWidth, height: sourceHeight, transform: `scale(${zoom})`, transformOrigin: "top left" }} />
        </div>
      </div>
      : <div className="grid min-h-0 flex-1 place-items-center rounded-lg border bg-background p-6 text-center text-sm text-muted-foreground">The visitor has not shared their page yet.</div>}
  </div>;
}

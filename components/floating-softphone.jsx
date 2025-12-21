"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Softphone } from "@/components/softphone";
import { usePhoneUi } from "@/components/phone-ui-provider";
import { X as IconClose, Phone as IconPhone } from "lucide-react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import clsx from "clsx";
import { getStatusDisplay } from "@/lib/call-status-utils";

export default function FloatingSoftphone() {
  const { visible, toggle } = usePhoneUi();
  const boxRef = useRef(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const PAD = 12;
  const PANEL_W = 280;

  const defaultPos = useMemo(() => {
    const w =
      viewport.w || (typeof window !== "undefined" ? window.innerWidth : 1280);
    const h =
      viewport.h || (typeof window !== "undefined" ? window.innerHeight : 800);
    const panelH = 460; // estimated; will be clamped after first render
    return {
      x: Math.max(PAD, w - PANEL_W - PAD),
      y: Math.max(PAD, h - panelH - PAD),
    };
  }, [viewport]);

  const [pos, setPos] = useState(defaultPos);
  const dragRef = useRef({ dragging: false, dx: 0, dy: 0 });

  // Track viewport size
  useEffect(() => {
    const updateViewport = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  // Re-clamp position when viewport changes (e.g., orientation, resize)
  useEffect(() => {
    setPos((p) => clampPos(p.x, p.y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.w, viewport.h]);

  // Clamp a position so the panel stays fully visible
  const clampPos = (rawX, rawY) => {
    const w = viewport.w || window.innerWidth;
    const h = viewport.h || window.innerHeight;
    const rect = boxRef.current?.getBoundingClientRect();
    const width = rect?.width || PANEL_W;
    const height = rect?.height || 460;
    const minX = PAD;
    const minY = PAD;
    const maxX = Math.max(PAD, w - width - PAD);
    const maxY = Math.max(PAD, h - height - PAD);
    return {
      x: Math.min(Math.max(rawX, minX), maxX),
      y: Math.min(Math.max(rawY, minY), maxY),
    };
  };

  // Initialize position from saved or default when becoming visible
  useEffect(() => {
    if (!visible) return;
    let start = defaultPos;
    try {
      const saved = localStorage.getItem("softphone.pos");
      const parsed = saved ? JSON.parse(saved) : null;
      if (
        parsed &&
        typeof parsed.x === "number" &&
        typeof parsed.y === "number"
      ) {
        start = clampPos(parsed.x, parsed.y);
      }
    } catch (_) {}
    setPos(clampPos(start.x, start.y));
  }, [visible, defaultPos]);

  // Drag handlers
  useEffect(() => {
    if (!visible) return;
    const box = boxRef.current;
    if (!box) return;

    function onMouseDown(e) {
      if (!e.target.closest("[data-drag-handle]")) return;
      dragRef.current.dragging = true;
      dragRef.current.dx = e.clientX - pos.x;
      dragRef.current.dy = e.clientY - pos.y;
      e.preventDefault();
    }
    function onMouseMove(e) {
      if (!dragRef.current.dragging) return;
      const next = clampPos(
        e.clientX - dragRef.current.dx,
        e.clientY - dragRef.current.dy
      );
      setPos(next);
    }
    function onMouseUp() {
      if (dragRef.current.dragging) {
        try {
          const clamped = clampPos(pos.x, pos.y);
          localStorage.setItem("softphone.pos", JSON.stringify(clamped));
        } catch (_) {}
      }
      dragRef.current.dragging = false;
    }

    box.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      box.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [visible, pos.x, pos.y]);

  // Keep position within bounds when content height changes (e.g., DTMF expand/collapse)
  useEffect(() => {
    if (!visible) return;
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setPos((p) => clampPos(p.x, p.y));
      });
    });
    try {
      ro.observe(el);
    } catch (_) {}
    return () => {
      try {
        ro.disconnect();
      } catch (_) {}
      cancelAnimationFrame(raf);
    };
  }, [visible]);

  // Get current call state for transcription

  if (!visible) return null;

  return (
    <div
      ref={boxRef}
      className="fixed z-[1000] left-0 top-0 select-none"
      style={{
        width: PANEL_W,
        transform: `translate(${pos.x}px, ${pos.y}px)`,
      }}
    >
      <div className="flex">
        {/* Phone Panel */}
        <div className="relative" style={{ width: PANEL_W }}>
          <div className="relative cursor-move" data-drag-handle>
            <div className="rounded-t-xl bg-zinc-700 text-background/80 dark:text-foreground/80 border border-border border-b-0 px-3 py-2 text-xs flex items-center justify-between">
              <div className="flex items-center gap-2">
                <IconPhone className="w-4 h-4" />
                <PhoneStatus />
              </div>
              <div className="flex items-center gap-1">
                {/* Close button */}
                <button
                  type="button"
                  aria-label="Hide phone"
                  className="rounded p-1 text-background/80 hover:text-foreground transition-colors"
                  onClick={() => {
                    try {
                      const clamped = { x: pos.x, y: pos.y };
                      localStorage.setItem(
                        "softphone.pos",
                        JSON.stringify(clamped)
                      );
                    } catch (_) {}
                    toggle();
                  }}
                >
                  <IconClose className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          <div className="overflow-hidden bg-muted text-foreground border border-border border-t-0 rounded-b-xl">
            <div className="bg-transparent">
              <Softphone />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Phone Status Component
// Optimized to prevent unnecessary re-renders when answering calls
// Uses ref to track last displayed value and only updates state when it changes
function PhoneStatus() {
  // Subscribe to store values
  const status = useActiveCallStore((state) => state.status);
  const call = useActiveCallStore((state) => state.call);
  const isHeld = useActiveCallStore((state) => state.ui.isHeld);

  // Compute the current displayed value
  const statusDisplay = useMemo(
    () => getStatusDisplay(status, !!call),
    [status, call]
  );
  const currentText = isHeld ? "On Hold" : statusDisplay.text;
  const currentColor = isHeld
    ? "border-orange-600 bg-orange-600/20 text-orange-400"
    : statusDisplay.color;

  // Use ref to track the last rendered value (initialized once)
  const lastRenderedRef = useRef(null);

  // Local state that only updates when the displayed value actually changes
  const [displayValue, setDisplayValue] = useState(() => ({
    text: currentText,
    color: currentColor,
  }));

  // Initialize ref on first render
  if (lastRenderedRef.current === null) {
    lastRenderedRef.current = { text: currentText, color: currentColor };
  }

  // Update state only when the displayed value actually changes
  // This prevents rapid re-renders when status changes rapidly (answered -> connected -> active)
  useEffect(() => {
    if (
      lastRenderedRef.current === null ||
      lastRenderedRef.current.text !== currentText ||
      lastRenderedRef.current.color !== currentColor
    ) {
      lastRenderedRef.current = { text: currentText, color: currentColor };
      setDisplayValue({ text: currentText, color: currentColor });
    }
  }, [currentText, currentColor]);

  return (
    <div
      className={clsx(
        "flex items-center gap-1.5 border px-2 py-0.5 rounded-md text-xs font-medium",
        displayValue.color
      )}
    >
      {displayValue.text}
    </div>
  );
}

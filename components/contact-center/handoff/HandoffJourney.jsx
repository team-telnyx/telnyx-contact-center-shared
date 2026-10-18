"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, HelpCircle, Monitor, Phone, Smartphone, User, X } from "lucide-react";
import { arcPoint, deviceName, handoffTiles, journeyLayout } from "@/lib/telephony/handoff-scene.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";
import { cn } from "@/lib/utils";

const TILE = 72;
const BUBBLE = 44;
const HEIGHT = TILE + BUBBLE + 112;

/** The move's colour: Telnyx green while it goes well, amber when it stops short, red when it fails. */
export const TONE_TEXT = {
  idle: "text-telnyx-green",
  moving: "text-telnyx-green",
  success: "text-telnyx-green",
  warning: "text-amber-500",
  failure: "text-destructive",
};

/** The icon component for a device kind: the computer, a phone, or a device the move does not know. */
export const DEVICE_ICONS = { web: Monitor, phone: Smartphone, unknown: HelpCircle };
export const deviceIconKey = (kind) => (kind === "web" ? "web" : kind ? "phone" : "unknown");
/** Set state after the effect, as the lint asks: a layout read or a tween step is not a render-time update. */
export const defer = (fn) => { Promise.resolve().then(fn); };

/**
 * The handoff's hero: the two devices as tiles, the arc between them, and the
 * caller riding it — at the source while nothing moves, travelling with the
 * call's progress, landing on the target when it arrives, back home when the
 * move stops. Dots run along the arc while the call travels. With reduced
 * motion the frame is still: no dots, no pulse, the caller sits where the call is.
 */
export function HandoffJourney({ scene, caller }) {
  const tUi = useUiText();
  const box = useRef(null);
  const width = useWidth(box);
  const reduced = useReducedMotion();
  const position = useTweened(scene.position, reduced);
  const arcId = useId().replace(/:/g, "");
  const layout = journeyLayout(width || 360, HEIGHT, TILE, BUBBLE);
  const tiles = handoffTiles(scene, tUi);
  const bubble = arcPoint(layout, position);
  const path = `M ${layout.start.x} ${layout.start.y} Q ${layout.control.x} ${layout.control.y} ${layout.end.x} ${layout.end.y}`;
  const tone = TONE_TEXT[scene.tone];

  return (
    <div ref={box} className="relative w-full select-none" style={{ height: HEIGHT }} role="img" data-testid="handoff-journey"
      aria-label={tUi("Call with {value0}. Source device: {value1}. Target device: {value2}. {value3}", { value0: caller.name, value1: deviceName(scene.source, tUi), value2: deviceName(scene.target, tUi), value3: scene.headline })}>
      {width > 0 && <>
        <svg className="absolute inset-0 overflow-visible" width={width} height={HEIGHT} aria-hidden="true">
          <path id={arcId} d={path} fill="none" className="stroke-muted-foreground/35" strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray="1 8" />
          {scene.tone !== "idle" && scene.position > 0 && (
            <path d={path} fill="none" pathLength="1" strokeWidth="3" strokeLinecap="round"
              className={cn("stroke-current", tone, !reduced && "transition-[stroke-dashoffset] duration-700 ease-out")}
              strokeDasharray="1 1" strokeDashoffset={1 - scene.position} />
          )}
          {scene.flowing && !reduced && (
            <g className={cn("fill-current motion-reduce:hidden", tone)}>
              {[0, 1, 2, 3, 4].map((index) => (
                <circle key={`${scene.reversed}-${index}`} r="3">
                  <animateMotion dur="1.8s" repeatCount="indefinite" begin={`-${index * 0.36}s`} calcMode="linear"
                    keyPoints={scene.reversed ? "1;0" : "0;1"} keyTimes="0;1">
                    <mpath href={`#${arcId}`} />
                  </animateMotion>
                  <animate attributeName="opacity" values="0.25;1;0.25" dur="1.8s" begin={`-${index * 0.36}s`} repeatCount="indefinite" />
                  <animate attributeName="r" values="2.5;4;2.5" dur="1.8s" begin={`-${index * 0.36}s`} repeatCount="indefinite" />
                </circle>
              ))}
            </g>
          )}
        </svg>
        <DeviceTile device={scene.source} state={tiles.source.state} at={layout.sourceTile} reduced={reduced} />
        <DeviceTile device={scene.target} state={tiles.target.state} at={layout.targetTile} reduced={reduced} />
        <Caption device={scene.source} role={tiles.source.role} x={layout.sourceTile.x} y={layout.sourceTile.y + TILE / 2 + 22} />
        <Caption device={scene.target} role={tiles.target.role} x={layout.targetTile.x} y={layout.targetTile.y + TILE / 2 + 22} />
        <CallerBubble caller={caller} tone={tone} x={bubble.x} y={bubble.y} />
      </>}
    </div>
  );
}

const HIGHLIGHTED = ["holding", "ringing", "arrived"];
const FADED = ["left", "unknown", "unavailable"];

/** One device on the journey: a glass tile with its icon and a badge for how it stands in the move. */
function DeviceTile({ device, state, at, reduced }) {
  const Icon = DEVICE_ICONS[deviceIconKey(device.kind)];
  const ink = HIGHLIGHTED.includes(state) ? "text-telnyx-green" : state === "failed" ? "text-destructive"
    : FADED.includes(state) ? "text-muted-foreground" : "text-foreground";
  return (
    <div className="absolute transition-opacity duration-300" data-testid={`handoff-tile-${state}`}
      style={{ left: at.x - TILE / 2, top: at.y - TILE / 2, width: TILE, height: TILE, opacity: FADED.includes(state) ? 0.6 : 1 }}>
      {state === "ringing" && !reduced && [0, 1].map((index) => (
        <span key={index} aria-hidden="true" style={{ animationDelay: `-${index * 0.8}s` }}
          className="absolute inset-0 rounded-[22px] border-[1.5px] border-telnyx-green motion-safe:animate-[handoff-halo_1.6s_ease-out_infinite] motion-reduce:hidden" />
      ))}
      <div className={cn("relative grid size-full place-items-center rounded-[22px] border-[1.5px] shadow-sm backdrop-blur-xl transition-colors duration-300",
        HIGHLIGHTED.includes(state) ? "border-telnyx-green/90 bg-telnyx-green/10" : "border-border bg-background/70 dark:bg-white/5")}>
        <Icon aria-hidden="true" strokeWidth={1.6}
          className={cn("size-8 transition-colors duration-300", ink, state === "ringing" && "motion-safe:animate-[handoff-wiggle_1.4s_ease-in-out_infinite]")} />
      </div>
      {state === "arrived" && (
        <span aria-hidden="true" className="absolute -bottom-2 -right-2 grid size-6 place-items-center rounded-full border-2 border-background bg-telnyx-green text-black animate-in zoom-in-50 fade-in">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
      {state === "failed" && (
        <span aria-hidden="true" className="absolute -bottom-2 -right-2 grid size-6 place-items-center rounded-full border-2 border-background bg-destructive text-white animate-in zoom-in-50 fade-in">
          <X className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

function Caption({ device, role, x, y }) {
  const tUi = useUiText();
  return (
    <div className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center" style={{ left: x, top: y, width: TILE + 44 }}>
      <span className="w-full truncate text-[13px] font-semibold text-foreground">{deviceName(device, tUi)}</span>
      <span className="h-4 w-full truncate text-[11px] text-muted-foreground">{role}</span>
    </div>
  );
}

/** The caller, riding the arc: their initials in a ring of the move's colour, with a phone badge. */
function CallerBubble({ caller, tone, x, y }) {
  const initials = callerInitials(caller.name);
  return (
    <div className={cn("pointer-events-none absolute", tone)} style={{ left: x - BUBBLE / 2, top: y - BUBBLE / 2, width: BUBBLE, height: BUBBLE }}>
      <div className="grid size-full place-items-center rounded-full border-[2.5px] border-current bg-background p-[3px] shadow-[0_6px_16px_rgba(0,0,0,0.18)] transition-colors duration-300">
        <div className="grid size-full place-items-center rounded-full bg-telnyx-green/15 text-[13px] font-semibold text-foreground">
          {initials || <User className="size-4 text-muted-foreground" aria-hidden="true" />}
        </div>
      </div>
      <span className="absolute -bottom-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full border-2 border-background bg-current">
        <Phone className="size-2.5 fill-background text-background" aria-hidden="true" />
      </span>
    </div>
  );
}

/** Up to two initials of a name; none for a number. */
export function callerInitials(name) {
  const words = String(name || "").trim().split(/\s+/).filter((word) => /\p{L}/u.test(word[0] || ""));
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    defer(() => setWidth(element.clientWidth));
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** `target`, eased there along the arc with a little overshoot, as the iOS journey's spring. */
function useTweened(target, reduced) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (reduced) { current.current = target; defer(() => setValue(target)); return undefined; }
    const from = current.current, started = performance.now(), duration = 900;
    let frame = 0;
    const step = (now) => {
      const t = Math.min((now - started) / duration, 1);
      const eased = 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2); // ease-out-back
      current.current = from + (target - from) * eased;
      setValue(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, reduced]);
  return value;
}

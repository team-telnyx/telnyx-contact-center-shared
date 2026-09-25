"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Columns2, LayoutPanelLeft, MonitorUp, PictureInPicture2, User, VideoOff, Volume2, VolumeX } from "lucide-react";
import { useTrackElement } from "@/hooks/use-video-room";
import { VIDEO_SCENES, planScene } from "@/lib/video/scenes.mjs";

// Shared video scene for the visitor widget, the agent desktop and the
// supervisor panel. The arrangement comes from lib/video/scenes.mjs: the
// stage measures its box, plans the scene (remote / split / pip / spotlight)
// for the visible tiles and positions every tile absolutely. Framed scenes
// keep 4:3 frames and fit the box on both axes (top-aligned, centered);
// `fill` stretches the arrangement to the box (the agent desktop).
function useBoxSize(ref) {
  const [size, setSize] = useState(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function Tile({ track, label, cameraOff, cameraOffLabel, mirror = false, muted = false, fit = "cover", style, className = "" }) {
  const ref = useRef(null);
  useTrackElement(ref, cameraOff ? null : track, { muted });
  return (
    <div className={`overflow-hidden bg-black ${className}`} style={style}>
      <video ref={ref} autoPlay playsInline muted={muted} className={`h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"}`} style={mirror ? { transform: "scaleX(-1)" } : undefined} />
      {(cameraOff || !track) && (
        <div className="absolute inset-0 grid place-items-center text-white/80" aria-label={cameraOffLabel}>
          <div className="grid place-items-center gap-2">
            <span className="grid size-14 place-items-center rounded-full bg-white/10">{cameraOff ? <VideoOff className="size-6" /> : <User className="size-6" />}</span>
            {cameraOffLabel && <span className="text-xs opacity-80">{cameraOffLabel}</span>}
          </div>
        </div>
      )}
      {label && <span className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">{label}</span>}
    </div>
  );
}

/**
 * tiles: [{ id, role, kind: "camera" | "screen", self, track, label, cameraOff, cameraOffLabel, mirror, muted }]
 */
function RemoteAudio({ track, muted }) {
  const ref = useRef(null);
  useTrackElement(ref, track, { muted });
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

export function VideoStage({
  scene = "pip",
  tiles = [],
  viewerRole = "customer",
  orientation = "row",
  fill = false,
  frameAspect = 4 / 3,
  mixedAudioTrack = null,
  audioTracks = [],
  audioMuted = false,
  radius = 12,
  gap = 8,
  thumbShare = 0.3,
  corner = null,
  bottom = null,
  notice = null,
  hiddenLabel = null,
  className = "",
  style,
  overlay = null,
}) {
  const audioRef = useRef(null);
  const boxRef = useRef(null);
  useTrackElement(audioRef, mixedAudioTrack, { muted: audioMuted });
  const box = useBoxSize(boxRef);
  const plan = useMemo(() => planScene({ scene, tiles, viewerRole, box, orientation, aspect: frameAspect, gap, fill, thumbShare }), [box, fill, frameAspect, gap, orientation, scene, thumbShare, tiles, viewerRole]);
  const byId = useMemo(() => new Map(tiles.map((tile) => [tile.id, tile])), [tiles]);
  const frame = { borderRadius: radius };
  // Before the first measurement the scene takes the width at a frame's aspect.
  const sceneStyle = plan.width ? { width: plan.width, height: plan.height } : { width: "100%", aspectRatio: String(frameAspect) };
  const hidden = plan.hidden.map((id) => byId.get(id)).filter(Boolean);
  return (
    <div ref={boxRef} className={`relative min-h-0 w-full flex-1 ${className}`} style={style} data-video-stage={plan.scene} data-video-tiles={plan.rects.length}>
      <div className="relative mx-auto max-w-full overflow-hidden" style={{ ...sceneStyle, ...(fill ? {} : frame) }} data-video-scene="">
        {plan.rects.map((rect) => {
          const tile = byId.get(rect.id);
          if (!tile) return null;
          const thumb = rect.kind === "thumb";
          return (
            <Tile key={rect.id} track={tile.track} label={tile.label} cameraOff={tile.cameraOff} cameraOffLabel={tile.cameraOffLabel}
              mirror={tile.mirror ?? (tile.self && tile.kind === "camera")} muted={tile.muted ?? tile.self} fit={tile.kind === "screen" ? "contain" : "cover"}
              className={`absolute ${thumb ? "z-10 border border-white/30 shadow-lg" : ""}`}
              style={{ ...frame, left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
          );
        })}
        {hidden.length > 0 && hiddenLabel && (
          <span className="absolute bottom-3 left-3 z-10 rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">{hiddenLabel(hidden)}</span>
        )}
        {overlay && <div className="absolute inset-0 z-20 flex flex-col overflow-hidden" style={frame}>{overlay}</div>}
        {notice && <div className="pointer-events-none absolute inset-x-3 top-11 z-20 flex justify-center">{notice}</div>}
        {bottom && (() => {
          // Floating controls sit on the viewer's own frame when it is a
          // full-size tile (an equal split frame); a strip tile or a thumbnail
          // is too narrow for them, so spotlight, pip and remote keep the
          // panel along the bottom of the scene.
          const own = plan.rects.find((rect) => rect.id === "self" && (rect.kind === "grid" || rect.kind === "main"));
          const anchor = own ? { left: own.x, top: own.y, width: own.w, height: own.h } : { left: 0, top: 0, width: "100%", height: "100%" };
          return <div className="pointer-events-none absolute z-30 flex items-end justify-center p-3" style={anchor}><div className="pointer-events-auto">{bottom}</div></div>;
        })()}
        {corner && <div className="absolute right-2 top-2 z-30">{corner}</div>}
        <audio ref={audioRef} autoPlay playsInline className="hidden" />
      {audioTracks.map(({ id, track }) => <RemoteAudio key={id} track={track} muted={audioMuted} />)}
      </div>
    </div>
  );
}

const SCENE_OPTIONS = {
  remote: { Icon: User, key: "layoutRemote", fallback: "Remote only" },
  split: { Icon: Columns2, key: "layoutSplit", fallback: "Side by side" },
  pip: { Icon: PictureInPicture2, key: "layoutPip", fallback: "Picture in picture" },
  spotlight: { Icon: LayoutPanelLeft, key: "layoutSpotlight", fallback: "Spotlight" },
};

export function VideoLayoutSwitch({ layout, onChange, scenes = VIDEO_SCENES, labels = {}, buttonStyle, activeStyle, size = 34, iconSize = 16, className = "" }) {
  const options = VIDEO_SCENES.filter((id) => scenes.includes(id)).map((id) => ({ id, Icon: SCENE_OPTIONS[id].Icon, label: labels[SCENE_OPTIONS[id].key] || SCENE_OPTIONS[id].fallback }));
  if (options.length < 2) return null;
  return (
    <div role="group" aria-label={labels.layout || "Layout"} className={`inline-flex items-center gap-1 ${className}`}>
      {options.map(({ id, Icon, label }) => (
        <button key={id} type="button" title={label} aria-label={label} aria-pressed={layout === id} onClick={() => onChange(id)}
          className="grid place-items-center border transition hover:opacity-90"
          style={{ width: size, height: size, ...(buttonStyle || {}), ...(layout === id ? (activeStyle || {}) : {}) }}>
          <Icon style={{ width: iconSize, height: iconSize }} />
        </button>
      ))}
    </div>
  );
}

export { MonitorUp as ScreenShareIcon };

// Playlist shown while the visitor waits for an agent: one file in a loop,
// or the list in order starting over at the end (`rotate`). With sound
// requested the video tries to play audibly; if the browser refuses (the
// Start call gesture has expired, or autoplay is not delegated), it falls
// back to muted playback and offers a speaker button, whose click is a
// fresh gesture. Previews stay muted.
export function WaitingPlaylist({ items = [], mode = "rotate", muted = true, labels = {}, className = "", onEmpty = null }) {
  const ref = useRef(null);
  const indexRef = useRef(0);
  const [mutedNow, setMutedNow] = useState(muted);
  const [blocked, setBlocked] = useState(false);
  const playable = items.filter((item) => item?.url);
  const first = playable[0]?.url || "";
  useEffect(() => {
    const element = ref.current;
    if (!element || !first) return undefined;
    let cancelled = false;
    element.muted = muted;
    element.play?.().catch(() => {
      if (cancelled || muted) return;
      element.muted = true;
      setMutedNow(true);
      setBlocked(true);
      element.play?.().catch(() => undefined);
    });
    return () => { cancelled = true; };
  }, [first, muted]);
  if (!playable.length) return onEmpty;
  const loopOne = mode === "loop" || playable.length === 1;
  const next = () => {
    indexRef.current = (indexRef.current + 1) % playable.length;
    const element = ref.current;
    if (!element) return;
    element.src = playable[indexRef.current].url;
    element.play?.().catch(() => undefined);
  };
  const toggleSound = () => {
    const element = ref.current;
    if (!element) return;
    const nextMuted = !mutedNow;
    element.muted = nextMuted;
    setMutedNow(nextMuted);
    setBlocked(false);
    if (!nextMuted) element.play?.().catch(() => { element.muted = true; setMutedNow(true); setBlocked(true); });
  };
  return (
    <>
      <video ref={ref} className={className} src={first} autoPlay muted={mutedNow} playsInline loop={loopOne} preload="auto"
        onEnded={loopOne ? undefined : next} onError={playable.length > 1 ? next : undefined} aria-label={playable[0].label || undefined} />
      {!muted && (
        <button type="button" onClick={toggleSound} aria-label={mutedNow ? (labels.unmute || "Turn sound on") : (labels.mute || "Turn sound off")} title={mutedNow ? (labels.unmute || "Turn sound on") : (labels.mute || "Turn sound off")}
          className={`absolute left-3 top-3 z-10 grid size-8 place-items-center rounded-lg border border-white/25 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/60 ${blocked ? "bg-black/60 ring-2 ring-white/60" : "bg-black/35"}`}>
          {mutedNow ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      )}
    </>
  );
}

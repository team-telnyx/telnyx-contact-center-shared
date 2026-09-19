"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, EyeOff, GitBranch, Monitor, Smartphone, Tablet, Timer } from "lucide-react";
import WidgetFrame from "@/components/widget/WidgetFrame";
import WidgetIcon from "@/components/widget/WidgetIcon";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  getPreviewDevice,
  PREVIEW_DEVICES,
  previewBackground as getPreviewBackground,
  previewViewport,
} from "@/lib/widgets/preview-devices";

function fontStack(fontFamily) {
  return `"${fontFamily}", ui-sans-serif, system-ui, sans-serif`;
}

function readableForeground(backgroundColor) {
  if (typeof backgroundColor !== "string") return "#111827";
  const color = backgroundColor.trim();
  let channels = null;

  if (/^#[\da-f]{3}$/i.test(color)) {
    channels = color.slice(1).split("").map((value) => Number.parseInt(`${value}${value}`, 16));
  } else if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) {
    channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  } else {
    const match = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (match) channels = match.slice(1, 4).map(Number);
  }

  if (!channels?.every(Number.isFinite)) return "#111827";
  const [red, green, blue] = channels.map((value) => {
    const channel = Math.min(255, Math.max(0, value)) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.42 ? "#111827" : "#ffffff";
}

function usePreviewImageState(source) {
  const [result, setResult] = useState({ source: "", state: "empty" });

  useEffect(() => {
    if (!source) return undefined;
    let active = true;
    const image = new Image();
    image.onload = () => { if (active) setResult({ source, state: "ready" }); };
    image.onerror = () => { if (active) setResult({ source, state: "error" }); };
    image.src = source;
    return () => { active = false; };
  }, [source]);

  if (!source) return "empty";
  return result.source === source ? result.state : "loading";
}

function resolvedPreviewBackground(preview, imageState) {
  const requestedImage = preview?.backgroundMode === "image";
  const useImage = requestedImage && Boolean(preview.backgroundImageUrl) && imageState === "ready";
  return {
    requestedImage,
    useImage,
    style: useImage ? {
      backgroundColor: "#f7f8f8",
      backgroundImage: `url(${JSON.stringify(preview.backgroundImageUrl)})`,
      backgroundPosition: `center ${preview.backgroundPosition}`,
      backgroundRepeat: "no-repeat",
      backgroundSize: preview.backgroundFit,
    } : undefined,
    overlayOpacity: useImage ? preview.overlayPercent / 100 : 0,
  };
}

function previewHostname(preview) {
  if (preview?.backgroundMode !== "image" || !/^https:\/\//i.test(preview.backgroundImageUrl)) return "customer.example.com";
  try {
    return new URL(preview.backgroundImageUrl).hostname;
  } catch {
    return "customer.example.com";
  }
}

function Launcher({ config, onOpen }) {
  const launcher = config.components.launcher;
  const dimensions = config.dimensions;
  const radius = launcher.shape === "round" ? 999 : launcher.shape === "rounded" ? 16 : 2;
  const animation = launcher.animation === "pulse"
    ? "animate-pulse"
    : launcher.animation === "bounce"
      ? "animate-bounce"
      : launcher.animation === "fade"
        ? "animate-[pulse_2.8s_ease-in-out_infinite]"
        : "";

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative flex items-center justify-center gap-2 px-0 shadow-[0_14px_38px_rgba(0,0,0,.24)] ${animation}`}
      style={{
        width: launcher.style === "icon-label" ? "auto" : dimensions.fabSize,
        minWidth: dimensions.fabSize,
        height: dimensions.fabSize,
        paddingInline: launcher.style === "icon-label" ? Math.max(16, dimensions.fabSize / 3) : 0,
        borderRadius: radius,
        backgroundColor: launcher.backgroundColor,
        color: launcher.textColor,
      }}
      aria-label={launcher.label}
    >
      <WidgetIcon name={launcher.icon} size={Math.max(20, Math.round(dimensions.fabSize * 0.42))} />
      {launcher.style === "icon-label" && <span className="whitespace-nowrap text-sm font-semibold">{launcher.label}</span>}
      {launcher.showUnreadBadge && (
        <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-red-600 text-[10px] font-bold text-white">1</span>
      )}
    </button>
  );
}

function HeadsUp({ config }) {
  const headsUp = config.engagement.headsUp;
  if (!headsUp.enabled) return null;
  return (
    <div
      className="w-64 rounded-2xl border p-4 shadow-xl"
      style={{
        backgroundColor: config.theme.colors.surface,
        borderColor: config.theme.colors.border,
        color: config.theme.colors.text,
        borderRadius: config.theme.shape.panelRadius,
      }}
    >
      <div className="flex gap-3">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-full"
          style={{ backgroundColor: config.theme.colors.primary, color: config.theme.colors.onPrimary }}
        >
          <WidgetIcon name={config.components.header.icon} fallback="bot" size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold">{headsUp.headline}</p>
          <p className="mt-1 text-sm opacity-70">{headsUp.body}</p>
        </div>
      </div>
    </div>
  );
}

function HomePreview({ config, onSurfaceChange, edgeToEdge = false, edgeInsets = null }) {
  const { colors, typography } = config.theme;
  const { header, launcher } = config.components;
  const insets = edgeToEdge && edgeInsets ? edgeInsets : { top: 0, right: 0, bottom: 0, left: 0 };
  return (
    <div
      className="flex h-full flex-col overflow-hidden border"
      style={{
        borderColor: colors.border,
        borderRadius: edgeToEdge ? 0 : config.theme.shape.panelRadius,
        borderWidth: edgeToEdge ? 0 : undefined,
        backgroundColor: colors.surface,
        color: colors.text,
        fontFamily: fontStack(typography.fontFamily),
        fontSize: typography.baseSize,
      }}
    >
      <header
        className={`flex items-center gap-3 ${header.alignment === "center" ? "text-center" : "text-left"}`}
        style={{
          minHeight: config.dimensions.headerHeight + insets.top,
          paddingTop: insets.top,
          paddingLeft: config.dimensions.headerPaddingX + insets.left,
          paddingRight: config.dimensions.headerPaddingX + insets.right,
          backgroundColor: colors.headerBackground,
          color: colors.headerText,
        }}
      >
        {header.showIcon && (
          <span className="grid shrink-0 place-items-center rounded-full bg-black/10" style={{ width: header.iconSize, height: header.iconSize }}>
            <WidgetIcon name={header.icon} fallback="bot" size={Math.max(16, header.iconSize * 0.55)} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold" style={{ fontSize: typography.titleSize }}>{config.content.title}</h2>
          {header.showDescription && <p className="truncate opacity-70" style={{ fontSize: typography.descriptionSize }}>{config.content.messagingSubtitle}</p>}
        </div>
        {header.showClose && (
          <button type="button" onClick={() => onSurfaceChange("launcher")} className="rounded-full p-2 hover:bg-black/5" aria-label="Close">
            <WidgetIcon name={header.closeIcon} fallback="x" size={19} />
          </button>
        )}
      </header>
      <div
        className="flex-1 space-y-3 overflow-y-auto p-4"
        style={{ paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right, paddingBottom: 16 + insets.bottom }}
      >
        {config.channels.messaging.enabled && (
          <button
            type="button"
            onClick={() => onSurfaceChange("chat")}
            className="flex w-full items-center gap-3 border p-4 text-left"
            style={{ borderColor: colors.border, borderRadius: config.theme.shape.buttonRadius, backgroundColor: colors.surfaceMuted }}
          >
            <span className="grid size-10 place-items-center rounded-full" style={{ backgroundColor: colors.primary, color: colors.onPrimary }}><WidgetIcon name="message-circle" size={19} /></span>
            <span><strong className="block">{config.content.chatLabel}</strong><small className="opacity-65">{config.content.messagingSubtitle}</small></span>
          </button>
        )}
        {config.channels.voice.enabled && (
          <button
            type="button"
            onClick={() => onSurfaceChange("voice")}
            className="flex w-full items-center gap-3 border p-4 text-left"
            style={{ borderColor: colors.border, borderRadius: config.theme.shape.buttonRadius, backgroundColor: colors.surfaceMuted }}
          >
            <span className="grid size-10 place-items-center rounded-full" style={{ backgroundColor: launcher.backgroundColor, color: launcher.textColor }}><WidgetIcon name="phone" size={19} /></span>
            <span><strong className="block">{config.content.callLabel}</strong><small className="opacity-65">{config.content.voiceSubtitle}</small></span>
          </button>
        )}
        {config.callbacks.enabled && (
          <button
            type="button"
            onClick={() => onSurfaceChange("callbacks")}
            className="flex w-full items-center gap-3 border p-4 text-left"
            style={{ borderColor: colors.border, borderRadius: config.theme.shape.buttonRadius, backgroundColor: colors.surfaceMuted }}
          >
            <span className="grid size-10 place-items-center rounded-full" style={{ backgroundColor: colors.primary, color: colors.onPrimary }}><WidgetIcon name="calendar-clock" fallback="calendar" size={19} /></span>
            <span><strong className="block">{config.callbacks.copy.buttonLabel}</strong><small className="opacity-65">Choose an available callback time</small></span>
          </button>
        )}
      </div>
    </div>
  );
}

function availablePreviewSurfaces(config) {
  const choices = Number(config.channels.messaging.enabled) + Number(config.channels.voice.enabled) + Number(config.callbacks.enabled);
  return [
    "launcher",
    ...(choices > 1 ? ["home"] : []),
    ...(config.channels.messaging.enabled ? ["chat"] : []),
    ...(config.channels.voice.enabled ? ["voice"] : []),
    ...(config.channels.video?.enabled ? ["video"] : []),
    ...(config.callbacks.enabled ? ["callbacks"] : []),
  ];
}

function OrientationSwitchIcon({ orientation }) {
  const landscape = orientation === "landscape";
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={landscape ? 5 : 8} y={landscape ? 8 : 5} width={landscape ? 14 : 8} height={landscape ? 8 : 14} rx="2" />
      <path d="M5.3 6.7A8.5 8.5 0 0 1 17.2 4" />
      <path d="m16.2 2.2 1.3 2.1-2.3.8" />
      <path d="M18.7 17.3A8.5 8.5 0 0 1 6.8 20" />
      <path d="m7.8 21.8-1.3-2.1 2.3-.8" />
    </svg>
  );
}

export function WidgetStudioPreviewToolbar({
  config,
  surface,
  onSurfaceChange,
  onDeviceChange,
  onOrientationChange,
}) {
  const availableSurfaces = availablePreviewSurfaces(config);
  const device = getPreviewDevice(config.preview.activeDeviceId);
  const viewport = previewViewport(device, config.preview.orientation);
  const DeviceIcon = device.type === "desktop" ? Monitor : device.type === "tablet" ? Tablet : Smartphone;

  return (
    <div className="shrink-0 space-y-2 border-b bg-background p-3">
      <div className="w-full">
        <Select value={device.id} onValueChange={onDeviceChange}>
          <SelectTrigger className="h-14 w-full min-w-0 py-1.5" aria-label="Preview device">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
              <DeviceIcon className="size-5 shrink-0" />
              <div className="min-w-0 leading-tight">
                <span className="block truncate font-medium">{device.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{device.detail}</span>
              </div>
            </div>
          </SelectTrigger>
          <SelectContent>
            {PREVIEW_DEVICES.map((item) => {
              const Icon = item.type === "desktop" ? Monitor : item.type === "tablet" ? Tablet : Smartphone;
              return <SelectItem key={item.id} value={item.id}>
                <span className="flex items-center gap-2"><Icon className="size-4" /><span><span className="block">{item.name}</span><span className="block text-[10px] text-muted-foreground">{item.detail}</span></span></span>
              </SelectItem>;
            })}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="capitalize">{viewport.orientation}</span>
        <span className="tabular-nums">{viewport.width} × {viewport.height} CSS px · DPR {device.dpr}</span>
        {device.orientations.length > 1 && (
          <button
            type="button"
            className="grid size-8 shrink-0 place-items-center rounded-md border bg-background hover:bg-muted"
            onClick={() => onOrientationChange(viewport.orientation === "portrait" ? "landscape" : "portrait")}
            aria-label={`Switch to ${viewport.orientation === "portrait" ? "landscape" : "portrait"}`}
            title={`Switch to ${viewport.orientation === "portrait" ? "landscape" : "portrait"}`}
          ><OrientationSwitchIcon orientation={viewport.orientation} /></button>
        )}
      </div>
      <div className="grid auto-cols-fr grid-flow-col rounded-lg border bg-muted/40 p-1 text-xs">
        {availableSurfaces.map((item) => (
          <button key={item} type="button" className={`rounded-md px-1.5 py-1.5 capitalize ${surface === item ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={() => onSurfaceChange(item)}>{item}</button>
        ))}
      </div>
    </div>
  );
}

function useMeasuredSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

function SignalBars() {
  return (
    <svg viewBox="0 0 17 12" className="h-3 w-[17px]" fill="currentColor" aria-hidden="true">
      <rect x="0" y="8" width="2.5" height="4" rx=".7" />
      <rect x="4.5" y="6" width="2.5" height="6" rx=".7" />
      <rect x="9" y="3" width="2.5" height="9" rx=".7" />
      <rect x="13.5" y="0" width="2.5" height="12" rx=".7" />
    </svg>
  );
}

function BatteryStatus() {
  return (
    <svg viewBox="0 0 22 11" className="h-3 w-[22px]" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="1" y="1" width="17" height="9" rx="2.2" />
      <path d="M20 4v3" />
      <rect x="3" y="3" width="12" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function previewSafeArea(device, orientation) {
  if (device.type === "desktop") return { top: 0, right: 0, bottom: 0, left: 0 };
  if (device.type === "tablet") return { top: 26, right: 0, bottom: 14, left: 0 };
  if (orientation === "landscape") {
    return device.frame === "iphone-island"
      ? { top: 20, right: 20, bottom: 14, left: 48 }
      : { top: 20, right: 18, bottom: 12, left: 18 };
  }
  if (device.frame === "iphone-island") return { top: 44, right: 0, bottom: 22, left: 0 };
  if (device.frame === "iphone-home") return { top: 30, right: 0, bottom: 18, left: 0 };
  return { top: 30, right: 0, bottom: 16, left: 0 };
}

function DeviceStatus({ device, orientation, textColor }) {
  const landscape = orientation === "landscape";
  const statusInset = landscape && device.frame === "iphone-island" ? 52 : 20;
  return <>
    <div
      className="pointer-events-none absolute z-40 flex h-7 items-center justify-between text-[13px] font-semibold leading-none"
      style={{ left: statusInset, right: 20, top: 8, color: textColor }}
      aria-hidden="true"
    >
      <span className="tabular-nums">9:41</span>
      <span className="flex items-center gap-1.5"><SignalBars /><span>5G</span><BatteryStatus /></span>
    </div>
    {device.type === "tablet" && <span className="pointer-events-none absolute left-1/2 top-[8px] z-50 size-2 -translate-x-1/2 rounded-full bg-black/90 ring-1 ring-white/20" aria-hidden="true" />}
    {device.frame === "iphone-island" && (landscape
      ? <span className="pointer-events-none absolute left-[9px] top-1/2 z-50 h-24 w-7 -translate-y-1/2 rounded-full bg-black shadow-inner" aria-hidden="true" />
      : <span className="pointer-events-none absolute left-1/2 top-[8px] z-50 h-7 w-[106px] -translate-x-1/2 rounded-full bg-black shadow-inner" aria-hidden="true" />)}
    {device.frame === "iphone-home" && !landscape && <span className="pointer-events-none absolute left-1/2 top-[13px] z-50 h-1.5 w-14 -translate-x-1/2 rounded-full bg-black/80" aria-hidden="true" />}
    {device.frame === "android-punch" && (landscape
      ? <span className="pointer-events-none absolute left-[10px] top-1/2 z-50 size-3 -translate-y-1/2 rounded-full bg-black ring-1 ring-white/20" aria-hidden="true" />
      : <span className="pointer-events-none absolute left-1/2 top-[9px] z-50 size-3 -translate-x-1/2 rounded-full bg-black ring-1 ring-white/20" aria-hidden="true" />)}
  </>;
}

function DeviceFrame({ device, viewport, statusTextColor, homeIndicatorColor, children }) {
  const [stageRef, stage] = useMeasuredSize();
  const phone = device.type === "phone";
  const framePadding = device.type === "tablet" ? 12 : 10;
  const frameWidth = viewport.width + framePadding * 2;
  const frameHeight = viewport.height + framePadding * 2;
  const scale = stage.width && stage.height
    ? Math.min(1, Math.max(0.2, (stage.width - 28) / frameWidth), Math.max(0.2, (stage.height - 28) / frameHeight))
    : 0.65;
  const outerRadius = phone ? (viewport.orientation === "portrait" ? 58 : 44) : 34;
  const innerRadius = phone ? (viewport.orientation === "portrait" ? 48 : 36) : 24;

  return (
    <div ref={stageRef} className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-[radial-gradient(circle_at_50%_45%,rgba(15,23,42,.08),transparent_58%)] p-3">
      <div style={{ width: frameWidth * scale, height: frameHeight * scale }}>
        <div
          className="relative bg-gradient-to-br from-[#777b86] via-[#17191d] to-[#565b65] shadow-[0_35px_90px_rgba(15,23,42,.30),inset_0_0_0_1px_rgba(255,255,255,.35)]"
          style={{ width: frameWidth, height: frameHeight, padding: framePadding, borderRadius: outerRadius, transform: `scale(${scale})`, transformOrigin: "top left" }}
          aria-label={`${device.name} ${viewport.orientation} device preview`}
        >
          <div
            className="relative h-full w-full overflow-hidden bg-white ring-1 ring-black/60"
            style={{ borderRadius: innerRadius }}
          >
            <DeviceStatus device={device} orientation={viewport.orientation} textColor={statusTextColor} />
            {children}
            {phone && viewport.orientation === "portrait" && (
              <span
                className="pointer-events-none absolute bottom-[7px] left-1/2 z-50 h-[5px] w-28 -translate-x-1/2 rounded-full"
                style={{ backgroundColor: homeIndicatorColor }}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DecisionPreviewState({ result, waiting = false }) {
  const hidden = result?.visible === false;
  return (
    <div className="relative z-30 w-full max-w-[320px] overflow-hidden rounded-2xl border bg-white/95 text-slate-950 shadow-[0_20px_60px_rgba(15,23,42,.18)] backdrop-blur">
      <div className="flex items-center gap-3 p-4">
        <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${hidden ? "bg-red-50 text-red-600" : waiting ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
          {hidden ? <EyeOff className="size-5" /> : waiting ? <Timer className="size-5" /> : <CheckCircle2 className="size-5" />}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Decision simulation</p>
          <p className="mt-0.5 truncate text-sm font-semibold">{result?.matchedRule?.name || "Default behavior"}</p>
        </div>
      </div>
      <div className="border-t bg-slate-50/80 px-4 py-3 text-xs leading-relaxed text-slate-600">
        {hidden
          ? "This context hides the launcher and widget panel."
          : waiting
            ? `Waiting ${result?.launcherDelaySeconds || 0}s before showing the widget (compressed in preview).`
            : "The selected rule is active in the preview."}
      </div>
    </div>
  );
}

export default function WidgetStudioPreview({
  widget,
  config,
  surface,
  onSurfaceChange,
  previewScenario = null,
  previewUser = null,
  decisionResult = null,
  showDecisionOverlay = false,
  simulationRun = 0,
}) {
  const [completedSimulationRun, setCompletedSimulationRun] = useState(0);
  useEffect(() => {
    if (!simulationRun || !decisionResult?.visible || decisionResult.launcherDelaySeconds <= 0) return undefined;
    const timer = window.setTimeout(
      () => setCompletedSimulationRun(simulationRun),
      Math.min(decisionResult.launcherDelaySeconds, 3) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [decisionResult?.launcherDelaySeconds, decisionResult?.visible, simulationRun]);
  const simulationWaiting = Boolean(
    simulationRun &&
    decisionResult?.visible &&
    decisionResult.launcherDelaySeconds > 0 &&
    completedSimulationRun !== simulationRun
  );

  const device = getPreviewDevice(config.preview.activeDeviceId);
  const viewport = previewViewport(device, config.preview.orientation);
  const launcherSurface = surface === "launcher";
  const activePosition = launcherSurface ? config.dimensions.launcherPosition : config.dimensions.panelPosition;
  const activeOffsetX = launcherSurface ? config.dimensions.launcherOffsetX : config.dimensions.panelOffsetX;
  const activeOffsetY = launcherSurface ? config.dimensions.launcherOffsetY : config.dimensions.panelOffsetY;
  const leftAligned = activePosition === "bottom-left";
  const position = leftAligned ? "items-start" : "items-end";
  const fullscreenPhone = device.type === "phone" && config.behavior.mobileFullscreen && !launcherSurface;
  const safeArea = previewSafeArea(device, viewport.orientation);
  const availableWidth = Math.max(240, viewport.width - activeOffsetX - safeArea.left - safeArea.right - 16);
  const availableHeight = Math.max(280, viewport.height - activeOffsetY - safeArea.top - safeArea.bottom - 16);
  // The video surface may carry its own panel size (Video → Panel size → Dynamic),
  // exactly as the loader resizes the panel on the customer's page.
  // The loader ignores the size on pages up to 600 px wide (phones keep the
  // responsive panel), so the preview does the same.
  const videoSizing = surface === "video" && config.channels.video?.sizing?.mode === "video" && viewport.width > 600 ? config.channels.video.sizing : null;
  const configuredWidth = videoSizing?.width || config.dimensions.panelWidth;
  const configuredHeight = videoSizing?.height || config.dimensions.panelHeight;
  const panelWidth = device.type === "desktop" ? configuredWidth : fullscreenPhone ? viewport.width : Math.min(configuredWidth, availableWidth);
  const panelHeight = device.type === "desktop" ? configuredHeight : fullscreenPhone ? viewport.height : Math.min(configuredHeight, availableHeight);
  const preview = getPreviewBackground(config, device.id, viewport.orientation);
  const imageState = usePreviewImageState(preview.backgroundMode === "image" ? preview.backgroundImageUrl : "");
  const background = resolvedPreviewBackground(preview, imageState);
  const statusTextColor = fullscreenPhone
    ? readableForeground(config.theme.colors.headerBackground)
    : background.useImage ? "#ffffff" : "#111827";
  const homeIndicatorColor = fullscreenPhone
    ? readableForeground(config.theme.colors.footerBackground)
    : background.useImage ? "#ffffff" : "#111827";
  const choiceCount = Number(config.channels.messaging.enabled) + Number(config.channels.voice.enabled) + Number(Boolean(config.channels.video?.enabled)) + Number(config.callbacks.enabled);
  const openDefaultSurface = () => onSurfaceChange(choiceCount > 1 ? "home" : config.callbacks.enabled ? "callbacks" : config.channels.voice.enabled ? "voice" : config.channels.video?.enabled ? "video" : "chat");
  const previewElement = surface === "launcher" ? (
    <div className={`relative z-10 flex flex-col gap-3 ${leftAligned ? "items-start" : "items-end"}`}>
      <HeadsUp config={config} />
      <Launcher config={config} onOpen={openDefaultSurface} />
    </div>
  ) : (
    <div
      className={`relative z-10 max-w-full shrink-0 overflow-hidden shadow-[0_24px_64px_rgba(15,23,42,.20)] ${fullscreenPhone ? "" : "border"}`}
      style={{
        width: panelWidth,
        height: panelHeight,
        borderRadius: fullscreenPhone ? 0 : config.theme.shape.panelRadius,
        borderColor: fullscreenPhone ? "transparent" : config.theme.colors.border,
      }}
    >
      {surface === "home" ? (
        <HomePreview config={config} onSurfaceChange={onSurfaceChange} edgeToEdge={fullscreenPhone} edgeInsets={safeArea} />
      ) : (
        <WidgetFrame
          key={`${surface}-${previewScenario || "default"}`}
          previewWidget={{ id: widget.publicId, name: widget.name, config, callbacks: config.callbacks, previewAgent: previewUser, edgeToEdge: fullscreenPhone, edgeInsets: safeArea }}
          previewMode={surface === "voice" ? "voice" : surface === "video" ? "video" : "messaging"}
          previewScenario={surface === "callbacks" ? "callbacks" : previewScenario}
          onPreviewClose={() => onSurfaceChange("launcher")}
          onPreviewHome={() => onSurfaceChange("home")}
        />
      )}
    </div>
  );
  const simulatedPreviewElement = showDecisionOverlay && (!decisionResult?.visible || simulationWaiting)
    ? <DecisionPreviewState result={decisionResult} waiting={simulationWaiting} />
    : previewElement;
  const decisionSummary = showDecisionOverlay && decisionResult && decisionResult.visible && !simulationWaiting ? (
    <div className="pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-emerald-200 bg-white/95 px-3 py-1.5 text-[11px] text-emerald-800 shadow-sm backdrop-blur">
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate font-medium">{decisionResult.matchedRule?.name || "Default behavior"}</span>
      <span className="text-emerald-600">· {decisionResult.channels.join(" + ") || "hidden"}</span>
    </div>
  ) : null;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/20">
      {device.type === "desktop" ? (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#e9eaec]"
          aria-label="Safari browser preview"
        >
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-black/10 bg-[#f3f3f4] px-4 shadow-sm">
            <div className="flex shrink-0 gap-1.5" aria-hidden="true">
              <span className="size-3 rounded-full bg-[#ff5f57]" />
              <span className="size-3 rounded-full bg-[#febc2e]" />
              <span className="size-3 rounded-full bg-[#28c840]" />
            </div>
            <div className="hidden shrink-0 items-center gap-2 text-lg text-black/35 sm:flex" aria-hidden="true"><span>‹</span><span>›</span></div>
            <div className="mx-auto flex h-7 w-full max-w-xl items-center justify-center rounded-lg border border-black/10 bg-white/80 px-4 text-[11px] text-black/45 shadow-sm">
              {previewHostname(preview)}
            </div>
            <div className="hidden w-12 shrink-0 justify-end text-black/35 sm:flex" aria-hidden="true">↗</div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-[#f7f8f8]">
            <div
              className={`relative flex w-full flex-col justify-end ${position}`}
              style={{
                height: "100%",
                minWidth: Math.max(640, panelWidth + activeOffsetX + 64),
                minHeight: Math.max(680, panelHeight + activeOffsetY + 56),
                boxSizing: "border-box",
                paddingTop: 32,
                paddingBottom: activeOffsetY,
                paddingLeft: leftAligned ? activeOffsetX : 24,
                paddingRight: leftAligned ? 24 : activeOffsetX,
                ...background.style,
              }}
            >
              {!background.useImage && <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
                <div className="flex h-16 items-center border-b border-black/5 bg-white/70 px-8">
                  <div className="h-6 w-28 rounded bg-black/10" />
                  <div className="ml-auto flex gap-5"><span className="h-3 w-14 rounded bg-black/5" /><span className="h-3 w-14 rounded bg-black/5" /><span className="h-3 w-14 rounded bg-black/5" /></div>
                </div>
                <div className="mx-auto grid max-w-5xl gap-6 px-8 py-10">
                  <div className="h-8 w-2/5 rounded-lg bg-black/[.06]" />
                  <div className="h-4 w-3/5 rounded bg-black/[.04]" />
                  <div className="mt-4 grid grid-cols-3 gap-5">
                    <span className="h-36 rounded-2xl border border-black/5 bg-white/65" />
                    <span className="h-36 rounded-2xl border border-black/5 bg-white/65" />
                    <span className="h-36 rounded-2xl border border-black/5 bg-white/65" />
                  </div>
                </div>
              </div>}
              {background.overlayOpacity > 0 && <div className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: background.overlayOpacity }} aria-hidden="true" />}
              {background.requestedImage && imageState !== "ready" && (
                <div className="pointer-events-none absolute left-1/2 top-5 z-20 -translate-x-1/2 rounded-lg border bg-white/95 px-3 py-2 text-center text-xs text-black/60 shadow-sm">
                  {imageState === "empty" ? "No screenshot uploaded for this preview." : imageState === "error" ? "Screenshot could not be loaded. Upload an image or use a direct image URL, not a webpage URL." : "Loading screenshot…"}
                </div>
              )}
              {decisionSummary}
              {simulatedPreviewElement}
            </div>
          </div>
        </div>
      ) : (
        <DeviceFrame
          device={device}
          viewport={viewport}
          statusTextColor={statusTextColor}
          homeIndicatorColor={homeIndicatorColor}
        >
          <div
            className={`relative flex h-full w-full flex-col justify-end overflow-hidden bg-[#f6f8f7] ${position}`}
            style={{
              boxSizing: "border-box",
              paddingTop: fullscreenPhone ? 0 : Math.max(40, safeArea.top),
              paddingBottom: fullscreenPhone ? 0 : Math.max(activeOffsetY, safeArea.bottom),
              paddingLeft: fullscreenPhone ? 0 : leftAligned ? Math.max(activeOffsetX, safeArea.left) : Math.max(8, safeArea.left),
              paddingRight: fullscreenPhone ? 0 : leftAligned ? Math.max(8, safeArea.right) : Math.max(activeOffsetX, safeArea.right),
              ...(background.useImage ? background.style : { backgroundImage: "radial-gradient(circle at 20% 20%, rgba(0,227,170,.08), transparent 28%), radial-gradient(circle at 80% 75%, rgba(15,23,42,.06), transparent 32%)" }),
            }}
          >
            {!background.useImage && <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-70" aria-hidden="true">
              <div className="h-14 border-b border-black/5 bg-white/70" />
              <div className="space-y-4 p-6"><div className="h-6 w-2/3 rounded bg-black/[.06]" /><div className="h-3 w-4/5 rounded bg-black/[.04]" /><div className="grid grid-cols-2 gap-3 pt-4"><span className="h-24 rounded-xl border border-black/5 bg-white/65" /><span className="h-24 rounded-xl border border-black/5 bg-white/65" /></div></div>
            </div>}
            {background.overlayOpacity > 0 && <div className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: background.overlayOpacity }} aria-hidden="true" />}
            {background.requestedImage && imageState !== "ready" && <div className="pointer-events-none absolute inset-x-4 top-12 z-20 rounded-lg border bg-white/95 px-3 py-2 text-center text-xs text-black/60 shadow-sm">{imageState === "empty" ? "No screenshot uploaded for this device and orientation." : imageState === "error" ? "Screenshot could not be loaded for this device and orientation." : "Loading screenshot…"}</div>}
            {decisionSummary}
            {simulatedPreviewElement}
          </div>
        </DeviceFrame>
      )}
    </section>
  );
}

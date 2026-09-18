"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3 as IconBarChart,
  Mic as IconMic,
  MicOff as IconMicOff,
  Phone as IconPhone,
  PhoneOff as IconPhoneOff,
  Volume2 as IconVolume2,
  VolumeX as IconVolumeX,
  X as IconClose,
} from "lucide-react";
import {
  TelnyxAIAgentProvider,
  useClient,
  useConversation,
  useSetTranscript,
} from "@telnyx/ai-agent-lib";
import { AudioVisualizer } from "@/components/audio-visualizer";
import { AIWidgetMessages } from "@/components/ai-widget-messages";
import { AIWidgetConnectionAlert, AIWidgetStatus } from "@/components/ai-widget-status";
import { AIWidgetUIProvider, useAIWidgetUI } from "@/components/ai-widget-ui-provider";
import { Button } from "@/components/ui/button";

const PAD = 12;
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 690;

function AIPhoneControls({ assistantId, assistantName, user, customHeaders = [] }) {
  const client = useClient();
  const conversation = useConversation();
  const setTranscript = useSetTranscript();
  const {
    canStartConversation,
    endConversation,
    hasActiveConversation,
    isReconnecting,
    isStartingConversation,
    reportError,
    startConversation,
  } = useAIWidgetUI();
  const [isMuted, setIsMuted] = useState(false);
  const [isHeld, setIsHeld] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    if (conversation?.call?.remoteStream && audioRef.current) {
      audioRef.current.srcObject = conversation.call.remoteStream;
    }
  }, [conversation]);

  async function handleCall() {
    if (!client) return;
    try {
      if (hasActiveConversation) {
        setTranscript([]);
        await endConversation();
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        reportError(
          "Microphone access is required. Allow microphone access in your browser and try again."
        );
        return;
      }

      const callOptions = { customHeaders: [] };
      const callerNumber = user?.mobile || user?.voiceNumber || user?.voice_number;
      const firstName = user?.firstName || user?.first_name || "";
      const lastName = user?.lastName || user?.last_name || "";
      const callerName = `${firstName} ${lastName}`.trim() || user?.name || "";
      if (callerNumber) callOptions.callerNumber = callerNumber;
      if (callerName) callOptions.callerName = callerName;
      if (assistantId) callOptions.customHeaders.push({ name: "X-Assistant-Id", value: assistantId });
      if (assistantName) callOptions.customHeaders.push({ name: "X-Assistant-Name", value: assistantName });
      if (Array.isArray(customHeaders)) callOptions.customHeaders.push(...customHeaders);
      await startConversation(callOptions);
    } catch (error) {
      reportError(error);
    }
  }

  const isConnecting =
    isStartingConversation ||
    isReconnecting ||
    (!canStartConversation && !hasActiveConversation);

  function handleMute() {
    if (!hasActiveConversation) return;
    const nextMuted = !isMuted;
    conversation?.call?.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }

  function handleHold() {
    if (!hasActiveConversation) return;
    const nextHeld = !isHeld;
    if (audioRef.current) audioRef.current.muted = nextHeld;
    setIsHeld(nextHeld);
  }

  return (
    <div className="space-y-3 p-4">
      <AIWidgetConnectionAlert />
      <div className="flex items-center justify-center gap-4">
        <Button type="button" onClick={handleMute} variant="outline" size="sm" className={`h-12 w-12 rounded-full ${isMuted ? "border-red-500 bg-red-500 text-white" : ""}`} disabled={!hasActiveConversation} aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}>
          {isMuted ? <IconMicOff className="h-5 w-5" /> : <IconMic className="h-5 w-5" />}
        </Button>
        <Button type="button" onClick={handleCall} disabled={isConnecting} className={`h-16 w-16 rounded-full ${hasActiveConversation ? "bg-red-500 hover:bg-red-600" : isConnecting ? "bg-yellow-500 hover:bg-yellow-600" : "bg-green-500 hover:bg-green-600"}`} aria-label={hasActiveConversation ? "End call" : "Start call"}>
          {isConnecting ? <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" /> : hasActiveConversation ? <IconPhoneOff className="h-6 w-6" /> : <IconPhone className="h-6 w-6" />}
        </Button>
        <Button type="button" onClick={handleHold} variant="outline" size="sm" className={`h-12 w-12 rounded-full ${isHeld ? "border-yellow-500 bg-yellow-500 text-white" : ""}`} disabled={!hasActiveConversation} aria-label={isHeld ? "Resume speaker" : "Mute speaker"}>
          {isHeld ? <IconVolumeX className="h-5 w-5" /> : <IconVolume2 className="h-5 w-5" />}
        </Button>
      </div>
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
    </div>
  );
}

function AudioVisualizerSection() {
  const conversation = useConversation();
  const hasActiveConversation = conversation?.call?.state === "active";
  return (
    <div className="p-4">
      <div className="flex min-h-[60px] items-center justify-center">
        {hasActiveConversation && conversation?.call?.remoteStream ? (
          <AudioVisualizer stream={conversation.call.remoteStream} className="h-[72px] w-full" backgroundColor="transparent" />
        ) : (
          <div className="text-center text-muted-foreground">
            <IconBarChart className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p className="text-xs">Audio visualizer will appear during calls</p>
          </div>
        )}
      </div>
    </div>
  );
}

function AIFloatingSoftphone({ assistantId, assistantName, onClose, user, customHeaders }) {
  const client = useClient();
  const { hasActiveConversation } = useAIWidgetUI();
  const boxRef = useRef(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const dragRef = useRef({ dragging: false, dx: 0, dy: 0 });
  const defaultPosition = useMemo(() => {
    const width = viewport.width || (typeof window !== "undefined" ? window.innerWidth : 1280);
    const height = viewport.height || (typeof window !== "undefined" ? window.innerHeight : 800);
    return { x: Math.max(PAD, width - PANEL_WIDTH - PAD), y: Math.max(PAD, height - PANEL_HEIGHT - PAD) };
  }, [viewport]);
  const [position, setPosition] = useState(defaultPosition);

  const clampPosition = useCallback((x, y) => {
    const width = viewport.width || window.innerWidth;
    const height = viewport.height || window.innerHeight;
    const rect = boxRef.current?.getBoundingClientRect();
    const panelWidth = rect?.width || PANEL_WIDTH;
    const panelHeight = rect?.height || PANEL_HEIGHT;
    return {
      x: Math.min(Math.max(x, PAD), Math.max(PAD, width - panelWidth - PAD)),
      y: Math.min(Math.max(y, PAD), Math.max(PAD, height - panelHeight - PAD)),
    };
  }, [viewport]);

  useEffect(() => {
    const updateViewport = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      setViewport({ width, height });
      setPosition({ x: Math.max(PAD, width - PANEL_WIDTH - PAD), y: Math.max(PAD, height - PANEL_HEIGHT - PAD) });
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    function onMouseDown(event) {
      if (!event.target.closest("[data-drag-handle]")) return;
      dragRef.current = { dragging: true, dx: event.clientX - position.x, dy: event.clientY - position.y };
      event.preventDefault();
    }
    function onMouseMove(event) {
      if (!dragRef.current.dragging) return;
      setPosition(clampPosition(event.clientX - dragRef.current.dx, event.clientY - dragRef.current.dy));
    }
    function onMouseUp() { dragRef.current.dragging = false; }
    box.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      box.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [clampPosition, position.x, position.y]);

  async function handleClose() {
    try {
      if (hasActiveConversation) await client?.endConversation();
      await client?.disconnect();
    } catch (error) {
      console.error("Error closing AI assistant:", error);
    }
    onClose();
  }

  return (
    <div ref={boxRef} className="fixed z-50 select-none" style={{ left: position.x, top: position.y, width: PANEL_WIDTH, height: PANEL_HEIGHT }}>
      <div className="flex h-full flex-col">
        <div className="relative cursor-move" data-drag-handle>
          <div className="flex items-center justify-between rounded-t-xl border border-b-0 border-border bg-zinc-700 px-3 py-2 text-xs text-background/80 dark:text-foreground/80">
            <div className="flex items-center gap-2"><IconPhone className="h-4 w-4" /><AIWidgetStatus compact /></div>
            <button type="button" aria-label="Close AI Assistant" className="rounded p-1 text-background/80 transition-colors hover:text-foreground" onClick={handleClose}><IconClose className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden rounded-b-xl border border-t-0 border-border bg-muted text-foreground">
          <div className="flex h-full flex-col">
            <div className="shrink-0"><AIPhoneControls assistantId={assistantId} assistantName={assistantName} user={user} customHeaders={customHeaders} /></div>
            <div className="shrink-0 border-t border-border bg-muted"><AudioVisualizerSection /></div>
            <div className="min-h-0 flex-1 border-t border-border bg-muted"><AIWidgetMessages compact /></div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AssistantPhoneWidget({ assistantId, assistantName, open, onClose, customHeaders }) {
  const [user, setUser] = useState(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => { if (!cancelled && data?.isAuth && data?.user) setUser(data.user); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  if (!open || !assistantId) return null;
  return (
    <TelnyxAIAgentProvider agentId={assistantId} widgetVersion="contact-center-ai-widget/1.0">
      <AIWidgetUIProvider>
        <AIFloatingSoftphone assistantId={assistantId} assistantName={assistantName} onClose={onClose} user={user} customHeaders={customHeaders} />
      </AIWidgetUIProvider>
    </TelnyxAIAgentProvider>
  );
}

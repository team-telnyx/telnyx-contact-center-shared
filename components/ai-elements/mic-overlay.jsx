"use client";

/**
 * MicOverlay — self-contained mic transcription overlay.
 *
 * All STT state is managed INLINE in this single component.
 * This mirrors the working floating-chat.jsx pattern exactly:
 *   - mediaStream stored in React STATE (useState), not a ref
 *   - doStopRecording() is NOT useCallback — redefined every render,
 *     always closes over the current mediaStream value
 *   - doStopRef.current always points to the latest doStopRecording
 *   - No separate TelnyxSttTranscriber component, no useTelnyxSttStream hook
 *
 * Props:
 *   onAppend(delta)  — append-only text callback for each final transcript
 *   onSet(value)     — legacy compat, accepted but unused
 *   children         — the wrapped Input / Textarea
 */

import { cloneElement, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";
import { notify } from "@/components/ToastNotify";

export default function MicOverlay({
  children,
  onAppend,
  onSet,          // accepted but unused — kept so existing callers don't break
  padClassName = "pr-10",
  className,
  buttonClassName,
}) {
  // ── Overlay open / close ───────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const didFirstRef = useRef(false);          // first segment separator flag

  // ── STT state — exact same shape as floating-chat.jsx ─────────────────────
  const [sttState, setSttState] = useState("idle"); // idle | connecting | recording
  const [mediaStream, setMediaStream] = useState(null); // ← React STATE (not ref)

  const audioCtxRef     = useRef(null);
  const analyserRef     = useRef(null);
  const wsRef           = useRef(null);
  const sendIntervalRef = useRef(null);
  const streamRef       = useRef(null);   // mirrors mediaStream — safety for stale closures
  const cancelledRef    = useRef(false);

  // Waveform canvas
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);

  // Capability caches
  const capCacheRef = useRef(null);
  const vsCacheRef  = useRef(null);

  // ── Always-fresh stop ref ─────────────────────────────────────────────────
  // Updated synchronously on every render so event handlers always get the
  // latest doStopRecording() regardless of when they were memoized.
  const doStopRef = useRef(null);

  // ── Capability fetchers ───────────────────────────────────────────────────
  const getCapabilities = useCallback(async () => {
    if (capCacheRef.current) return capCacheRef.current;
    const res  = await fetch("/api/stt/capabilities");
    const data = await res.json();
    capCacheRef.current = data;
    return data;
  }, []);

  const getVoiceSettings = useCallback(async () => {
    if (vsCacheRef.current) return vsCacheRef.current;
    try {
      const res  = await fetch("/api/user/voice-settings");
      const data = await res.json();
      if (data?.ok && data.data) { vsCacheRef.current = data.data; return data.data; }
    } catch (_) {}
    return null;
  }, []);

  // ── doStopRecording ───────────────────────────────────────────────────────
  // NOT useCallback — redefined every render so it always closes over the
  // current `mediaStream` state value. This is the same pattern as
  // floating-chat.jsx's doStopRecording().
  const doStopRecording = () => {
    cancelledRef.current = true;

    clearInterval(sendIntervalRef.current);
    sendIntervalRef.current = null;

    // Close AudioContext BEFORE stopping tracks (browser mic indicator)
    try { audioCtxRef.current?.close(); } catch (_) {}
    audioCtxRef.current = null;
    analyserRef.current = null;

    // Close WebSocket
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      }
    } catch (_) {}
    try { wsRef.current?.close(); } catch (_) {}
    wsRef.current = null;

    // Stop mic tracks — uses BOTH state (fresh from render closure) and ref
    // (fallback for the unmount cleanup that captured the initial closure).
    const s = mediaStream || streamRef.current;
    try { s?.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} }); } catch (_) {}
    setMediaStream(null);
    streamRef.current = null;

    setSttState("idle");
  };

  // Keep doStopRef always pointing to the latest doStopRecording
  // (synchronous assignment during render — safe for refs)
  doStopRef.current = doStopRecording;

  // ── startRecording ────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    cancelledRef.current = false;
    setSttState("connecting");

    try {
      const [capData, vs] = await Promise.all([getCapabilities(), getVoiceSettings()]);
      if (cancelledRef.current) return;

      if (!capData.wsPort && !capData.wsUrl) throw new Error("STT WebSocket not available");

      const engine   = vs?.stt_engine   || "Telnyx";
      const model    = vs?.stt_model    || "";
      const language = vs?.stt_language || "en";
      const params   = new URLSearchParams({ engine });
      if (model    && model    !== "default") params.set("model",    model);
      if (language && language !== "auto")    params.set("language", language);

      let wsUrl;
      if (capData.wsUrl) {
        const sep = capData.wsUrl.includes("?") ? "&" : "?";
        wsUrl = `${capData.wsUrl}${sep}${params}`;
      } else {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${proto}//${window.location.hostname}:${capData.wsPort}/?${params}`;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });

      if (cancelledRef.current) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        return;
      }

      // Store in React STATE immediately (like floating-chat does setMediaStream)
      setMediaStream(stream);
      streamRef.current = stream;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "connected") {
            if (cancelledRef.current) {
              try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
              return;
            }

            // Start AudioWorklet capture
            const audioCtx = new AudioContext();
            audioCtx.audioWorklet.addModule("/audio-worklet-processor.js")
              .then(() => {
                if (cancelledRef.current) {
                  try { audioCtx.close(); } catch (_) {}
                  return;
                }

                const source  = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 512;
                source.connect(analyser);
                analyserRef.current = analyser;

                const workletNode = new AudioWorkletNode(audioCtx, "pcm-processor");
                let pcmBuffer = [];
                workletNode.port.onmessage = (ev) => {
                  pcmBuffer.push(new Int16Array(ev.data));
                };
                source.connect(workletNode);

                const silentGain = audioCtx.createGain();
                silentGain.gain.value = 0;
                workletNode.connect(silentGain);
                silentGain.connect(audioCtx.destination);

                sendIntervalRef.current = setInterval(() => {
                  if (pcmBuffer.length === 0 || ws.readyState !== WebSocket.OPEN) return;
                  const totalLen = pcmBuffer.reduce((s, a) => s + a.length, 0);
                  const merged  = new Int16Array(totalLen);
                  let offset = 0;
                  for (const chunk of pcmBuffer) { merged.set(chunk, offset); offset += chunk.length; }
                  pcmBuffer = [];
                  ws.send(merged.buffer);
                }, 250);

                audioCtxRef.current = audioCtx;
                setSttState("recording");
              })
              .catch(() => {
                notify({ title: "Voice transcription error",
                  description: "Failed to initialise audio processor",
                  variant: "error",
                });
                doStopRef.current?.();
                setOpen(false);
              });

          } else if (msg.transcript !== undefined) {
            if (msg.is_final && msg.transcript) {
              handleFinalTranscript(msg.transcript);
            }
          } else if (msg.type === "done") {
            ws.close();
          } else if (msg.type === "error") {
            console.error("[MicOverlay] STT WS error:", msg.message);
            notify({ title: "Voice transcription error",
              description: msg.message || "STT error",
              variant: "error",
            });
            doStopRef.current?.();
            setOpen(false);
          }
        } catch (_) {}
      };

      ws.onerror = () => {
        console.error("[MicOverlay] WS connection failed");
        notify({ title: "Voice transcription error",
          description: "STT WebSocket connection failed",
          variant: "error",
        });
        doStopRef.current?.();
        setOpen(false);
      };

      ws.onclose = () => {
        console.log("[MicOverlay] WS closed");
      };

    } catch (err) {
      console.error("[MicOverlay] startRecording error:", err);
      doStopRef.current?.();
      setOpen(false);
    }
  }, [getCapabilities, getVoiceSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  // Uses doStopRef.current so it always calls the latest doStopRecording.
  useEffect(() => {
    return () => {
      doStopRef.current?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Text appending ────────────────────────────────────────────────────────
  const handleFinalTranscript = useCallback((text) => {
    if (typeof text !== "string" || !text.trim()) return;
    const field = rootRef.current?.querySelector?.("textarea, input");
    const isTextarea = field && String(field.tagName || "").toUpperCase() === "TEXTAREA";

    const delta = !didFirstRef.current
      ? (isTextarea ? `\n${text}` : ` ${text}`)
      : ` ${text}`;
    didFirstRef.current = true;
    onAppend?.(delta);
  }, [onAppend]);

  // ── Waveform ──────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const an     = analyserRef.current;
    if (!canvas || !an) return;
    const ctx = canvas.getContext("2d");
    const buf = new Uint8Array(an.frequencyBinCount);
    an.getByteTimeDomainData(buf);
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth    = 2;
    ctx.strokeStyle  = "#FFA500";
    ctx.beginPath();
    const sliceW = w / buf.length;
    const amp    = h * 0.8;
    let x = 0;
    for (let i = 0; i < buf.length; i++) {
      const y = h / 2 + ((buf[i] - 128) / 128) * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      x += sliceW;
    }
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    rafRef.current = requestAnimationFrame(draw);
  }, []);

  const isRecording  = sttState === "recording";
  const isConnecting = sttState === "connecting";

  useEffect(() => {
    if (isRecording) {
      rafRef.current = requestAnimationFrame(draw);
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    }
  }, [isRecording, draw]);

  // ── Toggle button handler ─────────────────────────────────────────────────
  const handleToggle = useCallback(() => {
    if (open) {
      // Stop recording using the ALWAYS-FRESH ref — never stale
      doStopRef.current?.();
      setOpen(false);
      didFirstRef.current = false;
    } else {
      didFirstRef.current = false;
      setOpen(true);
      startRecording();
    }
  }, [open, startRecording]);

  // ── In-overlay Stop button ────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    doStopRef.current?.();
    setOpen(false);
    didFirstRef.current = false;
  }, []); // no deps — always uses doStopRef.current (latest)

  // ── Wrap child with padding class ─────────────────────────────────────────
  const child = (() => {
    try {
      if (!children) return null;
      if (typeof children === "string" || typeof children === "number") return children;
      if (Array.isArray(children)) return children;
      const prev = children.props?.className || "";
      return cloneElement(children, { className: cn(prev, padClassName) });
    } catch (_) {
      return children;
    }
  })();

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {child}

      {/* Mic toggle button */}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={cn(
          "absolute right-2 top-1 h-7 w-7 rounded-full",
          open ? "bg-red-600 text-white" : "bg-muted/40",
          buttonClassName
        )}
        onClick={handleToggle}
        aria-label={open ? "Stop transcription" : "Start transcription"}
      >
        <MicIcon className="size-3.5" />
      </Button>

      {/* Recording bar — fixed at bottom, shown while open */}
      {open && (
        <div className={cn(
          "pointer-events-auto fixed bottom-4 left-1/2 z-40 -translate-x-1/2",
          "rounded-2xl border border-telnyx-green bg-muted/80 backdrop-blur shadow-lg",
          "flex items-center gap-2 px-3 py-2"
        )}>
          {isConnecting && (
            <div className="flex items-center gap-1.5 px-1">
              <Loader2Icon className="h-4 w-4 animate-spin text-telnyx-green" />
              <span className="text-xs text-muted-foreground">Connecting…</span>
            </div>
          )}

          {isRecording && (
            <canvas
              ref={canvasRef}
              width={160}
              height={34}
              className="rounded-md bg-muted/60 dark:bg-black/0"
            />
          )}

          {(isConnecting || isRecording) && (
            <Button
              type="button"
              size="icon"
              variant="default"
              className="rounded-full bg-red-600 text-white hover:bg-red-700 shrink-0"
              onClick={handleStop}
            >
              <SquareIcon className="size-4" />
              <span className="sr-only">Stop recording</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

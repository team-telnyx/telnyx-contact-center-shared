"use client";

import { useEffect, useRef } from "react";

function prepareContext(context, glow, primaryColor) {
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowBlur = glow ? 12 : 0;
  context.shadowColor = glow ? primaryColor : "transparent";
}

function drawBars(context, width, height, levels, options) {
  const gap = Math.max(2, width / (levels.length * 7));
  const barWidth = Math.max(1, (width - gap * (levels.length - 1)) / levels.length);
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, options.primaryColor);
  gradient.addColorStop(1, options.secondaryColor);
  context.fillStyle = gradient;
  levels.forEach((level, index) => {
    const barHeight = Math.max(4, Math.min(height * 0.94, level * height * 0.88 * options.amplitude));
    const x = index * (barWidth + gap);
    const y = (height - barHeight) / 2;
    context.beginPath();
    context.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 3));
    context.fill();
  });
}

function drawLine(context, width, height, levels, options, mirrored = false) {
  const center = height / 2;
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, options.primaryColor);
  gradient.addColorStop(1, options.secondaryColor);
  context.strokeStyle = gradient;
  context.lineWidth = mirrored ? 3 : 4;
  const render = (direction) => {
    context.beginPath();
    levels.forEach((level, index) => {
      const x = levels.length === 1 ? 0 : (index / (levels.length - 1)) * width;
      const oscillation = Math.sin(index * 1.7) * level * height * 0.38 * options.amplitude;
      const y = center + oscillation * direction;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  };
  render(1);
  if (mirrored) render(-1);
}

function drawRadial(context, width, height, levels, options) {
  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.max(12, Math.min(width, height) * 0.18);
  const gradient = context.createRadialGradient(centerX, centerY, baseRadius, centerX, centerY, Math.min(width, height) * 0.48);
  gradient.addColorStop(0, options.primaryColor);
  gradient.addColorStop(1, options.secondaryColor);
  context.strokeStyle = gradient;
  context.lineWidth = 3;
  context.beginPath();
  levels.forEach((level, index) => {
    const angle = (index / levels.length) * Math.PI * 2 - Math.PI / 2;
    const radius = baseRadius + level * Math.min(width, height) * 0.25 * options.amplitude;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.closePath();
  context.stroke();
  context.globalAlpha = 0.12;
  context.fillStyle = options.primaryColor;
  context.fill();
  context.globalAlpha = 1;
}

function waveformGradient(context, width, options) {
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, options.primaryColor);
  gradient.addColorStop(1, options.secondaryColor);
  return gradient;
}

function drawRibbon(context, width, height, levels, options) {
  const center = height / 2;
  const points = levels.map((level, index) => ({
    x: levels.length === 1 ? 0 : (index / (levels.length - 1)) * width,
    offset: Math.max(3, level * height * 0.42 * options.amplitude),
  }));
  context.fillStyle = waveformGradient(context, width, options);
  context.globalAlpha = 0.72;
  context.beginPath();
  points.forEach(({ x, offset }, index) => {
    const y = center - offset;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  [...points].reverse().forEach(({ x, offset }) => context.lineTo(x, center + offset));
  context.closePath();
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = waveformGradient(context, width, options);
  context.lineWidth = 2;
  context.stroke();
}

function drawDots(context, width, height, levels, options) {
  const center = height / 2;
  const gradient = waveformGradient(context, width, options);
  context.fillStyle = gradient;
  levels.forEach((level, index) => {
    const x = ((index + 0.5) / levels.length) * width;
    const offset = level * height * 0.38 * options.amplitude;
    const radius = Math.max(1.8, Math.min(6, 1.8 + level * 5));
    for (const direction of [-1, 1]) {
      context.beginPath();
      context.arc(x, center + offset * direction, radius, 0, Math.PI * 2);
      context.fill();
    }
  });
}

function drawRings(context, width, height, levels, options) {
  const centerX = width / 2;
  const centerY = height / 2;
  const energy = levels.reduce((sum, level) => sum + level, 0) / Math.max(1, levels.length);
  const maximum = Math.min(width, height) * 0.46;
  context.strokeStyle = waveformGradient(context, width, options);
  for (let index = 0; index < 5; index += 1) {
    const progress = (index + 1) / 5;
    const radius = maximum * progress * (0.82 + energy * 0.22 * options.amplitude);
    context.globalAlpha = 0.95 - progress * 0.68;
    context.lineWidth = Math.max(1.5, 5 - index * 0.7);
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = 1;
  context.fillStyle = options.primaryColor;
  context.beginPath();
  context.arc(centerX, centerY, Math.max(4, energy * 14), 0, Math.PI * 2);
  context.fill();
}

function drawVisualization(context, width, height, levels, options) {
  context.clearRect(0, 0, width, height);
  prepareContext(context, options.glow, options.primaryColor);
  if (options.style === "mirrored") return drawLine(context, width, height, levels, options, true);
  if (options.style === "line") return drawLine(context, width, height, levels, options, false);
  if (options.style === "radial") return drawRadial(context, width, height, levels, options);
  if (options.style === "ribbon") return drawRibbon(context, width, height, levels, options);
  if (options.style === "dots") return drawDots(context, width, height, levels, options);
  if (options.style === "rings") return drawRings(context, width, height, levels, options);
  return drawBars(context, width, height, levels, options);
}

export default function AudioWaveform({
  stream,
  bars = 32,
  primaryColor = "#00e3aa",
  secondaryColor = "#007f63",
  style = "bars",
  smoothing = 0.78,
  amplitude = 1,
  glow = false,
  height = 96,
  active = false,
  preview = false,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let audioContext;
    let analyser;
    let source;
    let animationFrame;
    let disposed = false;
    const frequencyData = new Uint8Array(128);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const fallbackLevels = () => {
      const count = Math.max(8, Math.min(96, bars));
      return Array.from({ length: count }, (_, index) =>
        0.2 + Math.abs(Math.sin(index * 0.72)) * 0.42
      );
    };
    const drawFallback = () => {
      drawVisualization(
        context,
        canvas.clientWidth,
        canvas.clientHeight,
        fallbackLevels(),
        { style, primaryColor, secondaryColor, amplitude, glow }
      );
    };

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const observer = new ResizeObserver(() => {
      resize();
      drawFallback();
    });
    observer.observe(canvas);
    resize();
    drawFallback();

    if (stream?.getAudioTracks?.().some((track) => track.readyState === "live")) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = smoothing;
        source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        void audioContext.resume().catch(() => undefined);
      }
    }

    const render = (time = 0) => {
      if (disposed) return;
      const count = Math.max(8, Math.min(96, bars));
      if (analyser) analyser.getByteFrequencyData(frequencyData);
      const levels = Array.from({ length: count }, (_, index) => {
        if (analyser) return frequencyData[Math.floor((index / count) * frequencyData.length)] / 255;
        if ((active || preview) && !reducedMotion) return 0.18 + Math.abs(Math.sin(time / 420 + index * 0.72)) * 0.48;
        return 0.12 + ((index * 17) % 9) / 100;
      });
      drawVisualization(context, canvas.clientWidth, canvas.clientHeight, levels, { style, primaryColor, secondaryColor, amplitude, glow });
      animationFrame = window.requestAnimationFrame(render);
    };
    render(window.performance.now());

    return () => {
      disposed = true;
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
      source?.disconnect();
      analyser?.disconnect();
      void audioContext?.close().catch(() => undefined);
    };
  }, [active, amplitude, bars, glow, preview, primaryColor, secondaryColor, smoothing, stream, style]);

  return <canvas ref={canvasRef} className="w-full" style={{ height }} role="img" aria-label={`${style} audio waveform`} />;
}

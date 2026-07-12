"use client";

import { useEffect, useRef } from "react";

export function AudioVisualizer({ stream, className = "", backgroundColor = "rgb(0, 0, 0)" }) {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);

  useEffect(() => {
    if (!stream || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const resizeObserver = new ResizeObserver(() => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    });
    resizeObserver.observe(canvas);

    function draw() {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;

      if (backgroundColor === "transparent") {
        context.clearRect(0, 0, width, height);
      } else {
        context.fillStyle = backgroundColor;
        context.fillRect(0, 0, width, height);
      }

      const barCount = 42;
      const gap = 3;
      const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
      const centerY = height / 2;
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#00e3aa");
      gradient.addColorStop(0.5, "#20d9ff");
      gradient.addColorStop(1, "#7c6cff");

      context.save();
      context.shadowColor = "rgba(0, 227, 170, 0.35)";
      context.shadowBlur = 8;
      context.fillStyle = gradient;

      for (let index = 0; index < barCount; index += 1) {
        const dataIndex = Math.floor((index / barCount) * Math.min(data.length, 72));
        const level = Math.pow(data[dataIndex] / 255, 0.72);
        const waveEnvelope = 0.55 + 0.45 * Math.sin((index / (barCount - 1)) * Math.PI);
        const barHeight = Math.max(4, level * (height - 10) * waveEnvelope);
        const x = index * (barWidth + gap);
        const y = centerY - barHeight / 2;
        const radius = Math.min(barWidth / 2, 3);
        context.beginPath();
        context.roundRect(x, y, barWidth, barHeight, radius);
        context.fill();
      }
      context.restore();

      context.strokeStyle = "rgba(255, 255, 255, 0.07)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, centerY + 0.5);
      context.lineTo(width, centerY + 0.5);
      context.stroke();
    }

    draw();
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      resizeObserver.disconnect();
      source.disconnect();
      void audioContext.close();
    };
  }, [backgroundColor, stream]);

  return <canvas ref={canvasRef} className={className} />;
}

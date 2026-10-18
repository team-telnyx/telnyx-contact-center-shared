"use client";
import { useEffect, useState } from "react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { createQualityAccumulator } from "@/lib/telephony/quality.mjs";

export function useVoiceQuality() {
  const call = useActiveCallStore((s) => s.call);
  const status = useActiveCallStore((s) => s.status);
  const [history, setHistory] = useState({ callID: null, samples: [] });
  const active =
    !!call &&
    !["idle", "ended", "hangup", "destroy", "purge", "failed"].includes(status);
  useEffect(() => {
    if (!active || !call) return;
    let cancelled = false,
      timer;
    const sample = createQualityAccumulator();
    async function tick() {
      try {
        // The SDK exposes its RTCPeerConnection; collect locally, without enabling
        // debug reports or uploading SDP, IP addresses or device identifiers.
        const pc = call.peer?.instance;
        if (pc && pc.connectionState !== "closed") {
          const report = await pc.getStats();
          if (cancelled) return;
          const point = sample(report);
          setHistory((old) => ({
            callID: call.id,
            samples: [...(old.callID === call.id ? old.samples : []), point]
              .filter((s) => point.timestamp - s.timestamp <= 300000)
              .slice(-300),
          }));
        }
      } catch {
        /* Missing stats stay missing; old samples become stale. */
      }
      if (!cancelled) timer = setTimeout(tick, 1000);
    }
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [call, active]);
  return {
    ...history,
    samples: active && history.callID !== call?.id ? [] : history.samples,
    active,
  };
}

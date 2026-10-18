"use client";

import { useEffect, useRef, useState } from "react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useDeviceHandoffStore from "@/lib/stores/device-handoff-store";
import { subscribeVoiceEndpoints, voiceFetch } from "@/lib/telephony/endpoint-client";
import { decodeVoiceEndpointResponse as decode } from "@/lib/telephony/endpoint-response.mjs";
import { subscribeAgentStream } from "@/lib/telephony/agent-stream.mjs";
import { coalesceRefresh } from "@/lib/telephony/refresh-queue.mjs";
import { voiceInteractions } from "@/lib/telephony/handoff-caller.mjs";
import { DeviceHandoffDialog } from "./DeviceHandoffDialog";

const IDLE = ["idle", "ended", "hangup", "destroy", "terminated", "purge"];

/**
 * Mounted once in the Contact Center: reads this user's voice calls in progress for
 * every "Move call" entry point (every five seconds and at once on the agent
 * stream's notices), opens the dialog by itself when a call starts moving to
 * this browser — as the iOS app brings up its handoff when a call moves to the
 * iPhone — and renders the one dialog.
 */
export function DeviceHandoffHost() {
  const [registered, setRegistered] = useState(false);
  const setInteractions = useDeviceHandoffStore((s) => s.setInteractions);
  /** Sagas the dialog already opened for: closing it does not bring it back for the same move. */
  const opened = useRef(new Set());

  useEffect(() => subscribeVoiceEndpoints((state) => setRegistered(Boolean(state))), []);
  useEffect(() => {
    if (!registered) { setInteractions(null); return undefined; }
    let stopped = false;
    const watch = async (interactionId) => {
      try {
        const value = await decode(await voiceFetch(`/api/contact-center/interactions/${encodeURIComponent(interactionId)}/device-handoff`, { cache: "no-store" }));
        if (stopped) return;
        const handoff = value?.handoff;
        const store = useDeviceHandoffStore.getState();
        store.setTakeOver(interactionId, { canTakeOver: Boolean(value?.canTakeOver), ownerLabel: value?.ownerLabel || null });
        if (!handoff?.isTarget || !["running", "compensating"].includes(handoff.state)) return;
        if (store.interactionId || opened.current.has(handoff.id)) return;
        opened.current.add(handoff.id);
        store.openHandoff(String(interactionId));
      } catch (_) {
        // The dialog and "Calls on" report read problems; this only looks for a move.
      }
    };
    const read = coalesceRefresh(async () => {
      if (stopped) return;
      try {
        const value = await decode(await voiceFetch("/api/contact-center/agent/interactions", { cache: "no-store" }));
        if (stopped) return;
        const voice = voiceInteractions(value.interactions);
        setInteractions(voice);
        // A call can move here only while this browser has none: look for a move to it, and whether
        // the call can be taken over here (the softphone's banner).
        if (IDLE.includes(useActiveCallStore.getState().status || "idle")) await Promise.all(voice.map((i) => watch(i.id)));
        else for (const i of voice) useDeviceHandoffStore.getState().setTakeOver(i.id, { canTakeOver: false, ownerLabel: null });
      } catch (_) {
        // Kept from the last read; the next one tries again.
      }
    });
    read();
    const timer = setInterval(read, 5000);
    const unsubscribe = subscribeAgentStream((event) => {
      if (["connected", "voice_endpoints_changed"].includes(event.type)) read();
      if (event.type === "device_handoff_changed") {
        read();
        if (event.interactionId) watch(event.interactionId);
      }
    });
    return () => { stopped = true; clearInterval(timer); unsubscribe(); };
  }, [registered, setInteractions]);

  return <DeviceHandoffDialog />;
}

export default DeviceHandoffHost;

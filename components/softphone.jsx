"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useTelnyx } from "@/components/telephony-provider";
import { playDtmfBeep } from "@/lib/dtmf";
import useActiveCallStore, {
  useActiveCall,
  useIsRinging,
  useCallUI,
} from "@/lib/stores/active-call-store";
import useDialStore from "@/lib/stores/dial-store";
import {
  Phone as IconPhone,
  PhoneOff as IconPhoneOff,
  Volume2 as IconSpeaker,
  Mic as IconMic,
  MicOff as IconMicOff,
  Hash as IconHash,
  ChevronDown as IconChevronDown,
  Pause as IconPause,
  Play as IconPlay,
  UserCircle as IconContact,
  PhoneForwarded as IconPhoneForwarded,
} from "lucide-react";
import { NumberSelectionModal } from "@/components/contact-center/NumberSelectionModal";
import { TransferModal } from "@/components/contact-center/TransferModal";

function CircleButton({ children, onClick, disabled, className, title }) {
  return (
    <button
      type="button"
      title={title}
      className={clsx(
        "h-12 w-12 rounded-full flex items-center justify-center text-white",
        "shadow-md active:scale-[0.98] transition-transform",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function isValidE164(number) {
  return /^\+?[1-9]\d{6,14}$/.test(String(number || "").trim());
}
function isValidSipUri(input) {
  return /^sip:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(input || "").trim());
}
function isValidDialTo(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  return isValidE164(v) || isValidSipUri(v);
}

export function Softphone() {
  const { client } = useTelnyx();

  // Zustand stores - call state (shared with mini phone)
  const activeCall = useActiveCall();
  const isRinging = useIsRinging();
  const callUI = useCallUI();
  const callStatus = useActiveCallStore((state) => state.status);

  // Zustand stores - dial state
  const {
    toNumber,
    fromNumber,
    setToNumber: setDialToNumber,
    setFromNumber: setDialFromNumber,
  } = useDialStore();

  // Active call store actions
  const {
    setActiveCall,
    updateStatus,
    setMuted: storeSetMuted,
    setHeld: storeSetHeld,
    clearActiveCall,
    isContactCenterCall,
    getCallDuration,
  } = useActiveCallStore();

  // Check if call is connected/answered (CTI buttons should only show when connected)
  // Check both store status and call object state to handle all cases (inbound/outbound, direct/contact center)
  // Memoized to prevent rapid re-computation when status changes rapidly during answer
  const isCallConnected = useMemo(() => {
    if (!activeCall) return false;

    const callObjectState = activeCall?.state
      ? String(activeCall.state).toLowerCase()
      : null;
    const storeStatus = callStatus ? String(callStatus).toLowerCase() : null;
    const connectedStates = ["active", "connected", "answered", "held"];

    return (
      (storeStatus && connectedStates.includes(storeStatus)) ||
      (callObjectState && connectedStates.includes(callObjectState))
    );
  }, [activeCall, callStatus]);

  // Local UI state
  const [dtmfBuffer, setDtmfBuffer] = useState("");
  const [audioInputs, setAudioInputs] = useState([]);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [selectedMicId, setSelectedMicId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [showMicList, setShowMicList] = useState(false);
  const [showSpkList, setShowSpkList] = useState(false);
  const [showDtmf, setShowDtmf] = useState(false);
  const [showNumberModal, setShowNumberModal] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [interaction, setInteraction] = useState(null);

  const remoteAudioRef = useRef(null);
  const lastFetchedInteractionIdRef = useRef(null);
  const applyContactCenterMetadata = (interaction) => {
    if (!interaction?.id) return;
    useActiveCallStore.getState().setContactCenterMetadata({
      interactionId: interaction.id,
      queueName: interaction.queue_name || interaction.queueName || null,
      queuedAt: interaction.enqueued_at || interaction.queuedAt || null,
      assignedAt: interaction.assigned_at || interaction.assignedAt || null,
      customerId: interaction.customer_id || interaction.customerId || null,
      customerData:
        interaction.customer_data || interaction.customerData || null,
    });
  };

  const hydrateRemoteAudio = useCallback(() => {
    try {
      const call = activeCall;
      const audioEl = remoteAudioRef.current;
      if (!call || !audioEl) return;
      const possibleStream =
        call.remoteStream || call.remoteMediaStream || call.stream;
      if (possibleStream && audioEl.srcObject !== possibleStream) {
        audioEl.srcObject = possibleStream;
        try {
          audioEl.play?.();
        } catch (_) {}
      }
      if (typeof call.setAudioElement === "function" && audioEl) {
        try {
          call.setAudioElement(audioEl);
          try {
            audioEl.play?.();
          } catch (_) {}
        } catch (_) {}
      }
    } catch (_) {}
  }, [activeCall]);

  // Re-attach audio whenever the call object changes
  useEffect(() => {
    if (activeCall) {
      hydrateRemoteAudio();
    } else {
      try {
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      } catch (_) {}
    }
  }, [activeCall, hydrateRemoteAudio]);

  // Fetch interaction when call is active (same as mini phone)
  useEffect(() => {
    if (activeCall) {
      const storeState = useActiveCallStore.getState();
      let interactionId = storeState.contactCenter?.interactionId;

      if (!interactionId) {
        const callControlId =
          activeCall.callControlId ||
          activeCall.call_control_id ||
          activeCall.id;

        (async () => {
          try {
            const { getIncomingCallData } = await import(
              "@/lib/incoming-call-store"
            );
            let callData = getIncomingCallData(callControlId);

            if (!callData?.interactionId) {
              const latestData = getIncomingCallData("__latest_incoming__");
              if (
                latestData?.timestamp &&
                Date.now() - latestData.timestamp < 10000
              ) {
                callData = latestData;
              }
            }

            if (!callData?.interactionId) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              callData = getIncomingCallData(callControlId);
              if (!callData?.interactionId) {
                const latestData = getIncomingCallData("__latest_incoming__");
                if (
                  latestData?.timestamp &&
                  Date.now() - latestData.timestamp < 10000
                ) {
                  callData = latestData;
                }
              }
            }

            if (callData?.interactionId) {
              interactionId = callData.interactionId;

              if (
                interactionId &&
                interactionId !== lastFetchedInteractionIdRef.current
              ) {
                lastFetchedInteractionIdRef.current = interactionId;
                const res = await fetch(
                  `/api/contact-center/interactions/${interactionId}`
                );
                const data = await res.json();
                if (data.ok && data.interaction) {
                  setInteraction(data.interaction);
                  applyContactCenterMetadata(data.interaction);
                } else {
                  setInteraction(null);
                }
              }
              return;
            }
          } catch (err) {
            console.warn(
              "[Softphone] Error checking incoming call store:",
              err
            );
          }

          if (
            callControlId &&
            callControlId !== lastFetchedInteractionIdRef.current
          ) {
            lastFetchedInteractionIdRef.current = callControlId;
            try {
              const res = await fetch(
                `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                  callControlId
                )}`
              );
              const data = await res.json();
              if (data.ok && data.interaction) {
                setInteraction(data.interaction);
                applyContactCenterMetadata(data.interaction);
              } else {
                setInteraction(null);
              }
            } catch (err) {
              console.error(
                "[Softphone] Failed to fetch interaction by call_control_id:",
                err
              );
              setInteraction(null);
            }
          }
        })();
        return;
      }

      if (
        interactionId &&
        interactionId !== lastFetchedInteractionIdRef.current
      ) {
        lastFetchedInteractionIdRef.current = interactionId;
        const fetchInteraction = async () => {
          try {
            const res = await fetch(
              `/api/contact-center/interactions/${interactionId}`
            );
            const data = await res.json();
            if (data.ok && data.interaction) {
              setInteraction(data.interaction);
              applyContactCenterMetadata(data.interaction);
            } else {
              setInteraction(null);
            }
          } catch (err) {
            console.error("[Softphone] Failed to fetch interaction:", err);
            setInteraction(null);
          }
        };
        fetchInteraction();
      }
    } else {
      lastFetchedInteractionIdRef.current = null;
      setInteraction(null);
    }
  }, [activeCall]);

  // Listen for incoming calls (notifications from WebRTC SDK)
  // NOTE: softphone-mini.jsx is the PRIMARY handler for incoming calls
  // This component should NOT set active call to avoid race conditions
  useEffect(() => {
    if (!client) return;

    const onNotification = (notification) => {
      try {
        if (notification.type === "callUpdate" || notification?.call) {
          const call = notification?.call || null;
          const callState = call?.state || notification?.call?.state || "";

          // Detect call end states
          if (
            !call ||
            [
              "done",
              "hangup",
              "ended",
              "destroy",
              "purge",
              "idle",
              "terminated",
              "failed",
            ].includes(callState.toLowerCase())
          ) {
            if (activeCall) {
              handleCallEnd();
            }
            return;
          }

          // For active calls, update status and attach audio
          if (activeCall && call && callState) {
            const lowerState = callState.toLowerCase();
            updateStatus(lowerState);
            hydrateRemoteAudio();
          }
        }
      } catch (err) {
        console.error("[Softphone] Notification handler error:", err);
      }
    };

    try {
      client.on?.("telnyx.notification", onNotification);
    } catch (_) {}

    return () => {
      try {
        client.off?.("telnyx.notification", onNotification);
      } catch (_) {}
    };
  }, [client, activeCall, hydrateRemoteAudio]);

  async function handleCallEnd() {
    try {
      const storeState = useActiveCallStore.getState();

      // Ensure hold/transfer metrics are synced before clearing
      try {
        await useActiveCallStore.getState().syncCallMetricsToDb();
      } catch (err) {
        console.error("[Softphone] Failed to sync metrics:", err);
      }

      // Metrics are synced via /api/contact-center/interactions/:id/metrics

      clearActiveCall();
    } catch (err) {
      console.error("[Softphone] Error in handleCallEnd:", err);
      clearActiveCall();
    }
  }

  function startCall() {
    const to = (toNumber || "").trim();
    const from = (fromNumber || "").trim();
    if (!client || !to || activeCall) return;

    try {
      try {
        client.enableMicrophone?.();
      } catch (_) {}

      const call = client.newCall({
        destinationNumber: to,
        callerNumber: from || undefined,
        audio: true,
        video: false,
      });

      // Set active call in store (outbound call)
      setActiveCall(call, {
        direction: "outbound",
        fromNumber: from,
        toNumber: to,
      });

      // Immediately update status to ensure UI reflects dialing state
      const initialState = call.state || "trying";
      if (initialState) {
        updateStatus(initialState);
      }

      wireCall(call);
      call.invite?.();

      // Proactively try to attach audio with retries
      const retryDelays = [500, 1000, 2000, 3000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            hydrateRemoteAudio();
          }
        }, delay);
      });
    } catch (err) {
      console.error("[Softphone] Failed to start call:", err);
      clearActiveCall();
    }
  }

  function wireCall(call) {
    try {
      hydrateRemoteAudio();

      const syncCallState = () => {
        try {
          const s = String(call.state || "").toLowerCase();
          if (s) {
            updateStatus(s);
          }

          try {
            const muted = call.muted !== undefined ? call.muted : call.isMuted;
            if (muted !== undefined) {
              storeSetMuted(muted);
            }
          } catch (_) {}

          try {
            const held = call.held !== undefined ? call.held : call.isHeld;
            if (held !== undefined) {
              storeSetHeld(held);
            }
          } catch (_) {}

          hydrateRemoteAudio();
        } catch (_) {}
      };

      if (typeof call.on === "function") {
        call.on("ringing", () => {
          updateStatus("ringing");
          syncCallState();
        });

        call.on("active", () => {
          updateStatus("active");
          syncCallState();
          hydrateRemoteAudio();
        });

        call.on("connected", () => {
          updateStatus("connected");
          syncCallState();
          hydrateRemoteAudio();
        });

        call.on("answered", () => {
          updateStatus("answered");
          syncCallState();
          hydrateRemoteAudio();
        });

        call.on("held", () => {
          storeSetHeld(true);
        });

        call.on("hangup", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("destroy", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("ended", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("purge", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("stateChanged", (newState) => {
          if (newState) {
            const lowerState = String(newState).toLowerCase();
            updateStatus(lowerState);

            if (
              [
                "hangup",
                "ended",
                "destroy",
                "purge",
                "idle",
                "terminated",
                "done",
                "failed",
              ].includes(lowerState)
            ) {
              setTimeout(() => handleCallEnd(), 100);
            }

            if (["active", "connected", "answered"].includes(lowerState)) {
              hydrateRemoteAudio();
            }
          }
          syncCallState();
        });
      }

      syncCallState();
    } catch (err) {
      console.error("[Softphone] wireCall error:", err);
    }
  }

  async function toggleMute() {
    try {
      if (!activeCall) return;

      const isMuted = callUI.isMuted;

      if (!isMuted) {
        activeCall.muteAudio?.() || activeCall.mute?.();
        storeSetMuted(true);
      } else {
        activeCall.unmuteAudio?.() || activeCall.unmute?.();
        storeSetMuted(false);
      }
    } catch (err) {
      console.error("[Softphone] Toggle mute error:", err);
    }
  }

  async function toggleHold() {
    try {
      if (!activeCall) return;

      const isHeld = callUI.isHeld;

      if (isHeld) {
        activeCall.unhold?.() || activeCall.resume?.();
        // Update status to 'active' to track hold resume
        updateStatus("active");
      } else {
        activeCall.hold?.() || activeCall.pause?.();
        // Update status to 'held' to track hold start
        updateStatus("held");
      }
    } catch (err) {
      console.error("[Softphone] Toggle hold error:", err);
    }
  }

  function handleAnswerCall() {
    try {
      if (!activeCall) {
        console.error("[Softphone] No call to answer");
        return;
      }

      hydrateRemoteAudio();
      activeCall.answer?.();
      updateStatus("answered");

      const retryDelays = [100, 300, 500, 1000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            hydrateRemoteAudio();
          }
        }, delay);
      });
    } catch (err) {
      console.error("[Softphone] Error answering call:", err);
    }
  }

  async function handleRejectCall() {
    try {
      if (!activeCall) {
        console.error("[Softphone] No call to reject");
        return;
      }

      // Get the original call control ID from the active call store
      // This was extracted from X-Original-Call-Control-Id header when the call was set
      const originalCallControlId =
        useActiveCallStore.getState().originalCallControlId;

      // If we have the original call control ID, use it for hangup
      if (originalCallControlId) {
        console.log(
          "[Softphone] Using originalCallControlId from store:",
          originalCallControlId
        );
        try {
          // Hangup the original call leg using Telnyx API
          const response = await fetch(`/api/voice/call-action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "hangup",
              callControlId: originalCallControlId,
            }),
          });

          const result = await response.json();
          if (!response.ok) {
            console.error(
              "[Softphone] Failed to hangup original call leg:",
              result
            );
          } else {
            console.log(
              "[Softphone] Successfully hung up original call leg via custom header"
            );
          }
        } catch (err) {
          console.error("[Softphone] Error calling hangup API:", err);
        }
      } else if (interaction?.id) {
        // Fallback: If we have an interaction, hangup via API
        try {
          const response = await fetch(
            `/api/contact-center/interactions/${interaction.id}/hangup`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            }
          );

          const result = await response.json();
          if (!response.ok) {
            console.error(
              "[Softphone] Failed to hangup original call leg:",
              result
            );
          }
        } catch (err) {
          console.error("[Softphone] Error calling hangup API:", err);
        }
      }

      activeCall.hangup?.();
    } catch (err) {
      console.error("[Softphone] Error rejecting call:", err);
    }
  }

  function hangup() {
    try {
      if (!activeCall) {
        clearActiveCall();
        return;
      }

      const storeState = useActiveCallStore.getState();
      const status = storeState.status;
      if (
        ["hangup", "ended", "destroy", "idle", "terminated"].includes(status)
      ) {
        clearActiveCall();
        return;
      }

      if (typeof activeCall.hangup === "function") {
        activeCall.hangup();

        setTimeout(() => {
          const currentState = useActiveCallStore.getState();
          if (currentState.call) {
            handleCallEnd();
          }
        }, 2000);
      } else {
        handleCallEnd();
      }
    } catch (err) {
      console.error("[Softphone] Hangup error:", err);
      try {
        clearActiveCall();
      } catch (_) {}
    }
  }

  // Initialize default To/From from user profile
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();
        const mobile = data?.user?.mobile || "";
        const voice = data?.user?.voiceNumber || "";

        if (!toNumber && mobile) {
          setDialToNumber(mobile);
        }

        if (voice) setDialFromNumber(voice);
      } catch (_) {}
    })();
  }, []);

  const canCall = useMemo(() => {
    return !activeCall && isValidDialTo(toNumber);
  }, [activeCall, toNumber]);

  // Active call helper
  const isCallActive = useMemo(() => {
    const s = String(callStatus || "").toLowerCase();
    return ["connected", "active", "answered"].includes(s);
  }, [callStatus]);

  // DTMF handler
  const audioCtxRef = useRef(null);

  const handleKeypadDigit = useCallback(
    (digit) => {
      if (!isCallActive) return;
      playDtmfBeep(digit, audioCtxRef);
      setDtmfBuffer((prev) => (prev + String(digit)).slice(-32));
      const call = activeCall;
      try {
        if (typeof call?.dtmf === "function") {
          call.dtmf(String(digit));
          return;
        }
      } catch (_) {}
      try {
        if (typeof call?.sendDTMF === "function") {
          call.sendDTMF(String(digit));
          return;
        }
      } catch (_) {}
    },
    [isCallActive, activeCall]
  );

  const keypadDigits = useMemo(
    () => [
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["7", "8", "9"],
      ["*", "0", "#"],
    ],
    []
  );

  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator?.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const ins = devices.filter((d) => d.kind === "audioinput");
      const outs = devices.filter((d) => d.kind === "audiooutput");
      setAudioInputs(ins);
      setAudioOutputs(outs);
      if (!selectedMicId && ins[0]?.deviceId) setSelectedMicId(ins[0].deviceId);
      if (!selectedSpeakerId && outs[0]?.deviceId)
        setSelectedSpeakerId(outs[0].deviceId);
    } catch (_) {}
  }, [selectedMicId, selectedSpeakerId]);

  useEffect(() => {
    refreshDevices();
    const onDeviceChange = () => refreshDevices();
    try {
      navigator.mediaDevices?.addEventListener?.(
        "devicechange",
        onDeviceChange
      );
    } catch (_) {}
    return () => {
      try {
        navigator.mediaDevices?.removeEventListener?.(
          "devicechange",
          onDeviceChange
        );
      } catch (_) {}
    };
  }, [refreshDevices]);

  const applyMicSelection = useCallback(
    async (deviceId) => {
      if (!deviceId || !client) return;
      try {
        if (typeof client.updateAudioConstraints === "function") {
          await client.updateAudioConstraints({ deviceId });
          return;
        }
      } catch (_) {}
      try {
        if (typeof client.setMicrophoneDevice === "function") {
          await client.setMicrophoneDevice(deviceId);
          return;
        }
      } catch (_) {}
      try {
        if (typeof client.setInputDevice === "function") {
          await client.setInputDevice(deviceId);
          return;
        }
      } catch (_) {}
      try {
        if (typeof client.enableMicrophone === "function") {
          await client.enableMicrophone({ deviceId });
          return;
        }
      } catch (_) {}
    },
    [client]
  );

  const applySpeakerSelection = useCallback(async (deviceId) => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl || !deviceId) return;
    try {
      if (typeof audioEl.setSinkId === "function") {
        await audioEl.setSinkId(deviceId);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (selectedMicId) applyMicSelection(selectedMicId);
  }, [selectedMicId, applyMicSelection]);

  useEffect(() => {
    if (selectedSpeakerId) applySpeakerSelection(selectedSpeakerId);
  }, [selectedSpeakerId, applySpeakerSelection]);

  return (
    <div className="mx-auto w-full max-w-[280px] py-1 bg-zinc-900">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      <div className="relative flex flex-col items-center gap-4 rounded-2xl bg-zinc-900 p-4 text-white shadow-xl">
        {/* Device selectors */}
        <div className="absolute right-3 top-3 flex items-center gap-2">
          <div className="relative">
            <button
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-xs hover:bg-zinc-800"
              onClick={() => {
                setShowMicList((v) => !v);
                setShowSpkList(false);
              }}
              title="Select microphone"
            >
              <IconMic className="h-4 w-4" />
              <IconChevronDown className="h-3 w-3" />
            </button>
            {showMicList && (
              <div className="absolute right-0 z-10 mt-2 w-50 rounded-md border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-xl">
                <div className="px-2 py-1 text-[11px] text-zinc-400">
                  Microphones
                </div>
                <div className="max-h-64 overflow-auto">
                  {audioInputs.map((d) => (
                    <button
                      key={d.deviceId}
                      onClick={() => {
                        setSelectedMicId(d.deviceId);
                        setShowMicList(false);
                      }}
                      className={clsx(
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800 text-[10px]",
                        selectedMicId === d.deviceId && "bg-zinc-800"
                      )}
                    >
                      <span className="truncate">
                        {d.label || "Default microphone"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="relative">
            <button
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-xs hover:bg-zinc-800"
              onClick={() => {
                setShowSpkList((v) => !v);
                setShowMicList(false);
              }}
              title="Select speaker"
            >
              <IconSpeaker className="h-4 w-4" />
              <IconChevronDown className="h-3 w-3" />
            </button>
            {showSpkList && (
              <div className="absolute right-0 z-10 mt-2 w-50 rounded-md border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-xl">
                <div className="px-2 py-1 text-zinc-400">Speakers</div>
                <div className="max-h-64 overflow-auto text-[6px]">
                  {audioOutputs.map((d) => (
                    <button
                      key={d.deviceId}
                      onClick={() => {
                        setSelectedSpeakerId(d.deviceId);
                        setShowSpkList(false);
                      }}
                      className={clsx(
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800 text-[10px]",
                        selectedSpeakerId === d.deviceId && "bg-zinc-800"
                      )}
                    >
                      <span className="truncate">
                        {d.label || "Default speakers"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="w-full mt-5">
          <label className="mb-1 block text-[11px] text-zinc-300">To</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-8 w-8 rounded-lg border border-zinc-700 bg-zinc-900/60 text-white hover:bg-zinc-800 flex items-center justify-center"
              title="Select number from contacts"
              onClick={() => setShowNumberModal(true)}
            >
              <IconContact className="h-4 w-4" />
            </button>
            <input
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/60 px-2.5 py-1.5 text-[10px] text-white outline-none focus:border-zinc-500 cursor-pointer"
              placeholder="Phone number or SIP URI"
              value={toNumber}
              readOnly
              onClick={() => setShowNumberModal(true)}
              title="Click to select number"
              inputMode="text"
            />
          </div>
        </div>

        <div className="w-full">
          <label className="mb-1 block text-[11px] text-zinc-300">From</label>
          <input
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-2.5 py-1.5 text-[10px] text-white outline-none focus:border-zinc-500 cursor-not-allowed"
            placeholder="Phone number or SIP URI"
            value={fromNumber}
            readOnly
            title="Voice number from your profile"
            inputMode="text"
          />
        </div>

        {/* Show answer/reject buttons for incoming ringing calls */}
        {isRinging ? (
          <div className="mt-1 grid w-full grid-cols-2 place-items-center gap-4">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title="Reject"
                className="bg-red-600"
                onClick={() => handleRejectCall()}
              >
                <IconPhoneOff className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">Reject</div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title="Answer"
                className="bg-emerald-600"
                onClick={() => handleAnswerCall()}
              >
                <IconPhone className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">Answer</div>
            </div>
          </div>
        ) : activeCall && !isCallConnected ? (
          /* Show only disconnect button for outbound calls in progress (dialing/ringing) */
          <div className="mt-1 flex w-full justify-center">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title="Disconnect"
                className="bg-red-600"
                onClick={hangup}
              >
                <IconPhoneOff className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">Disconnect</div>
            </div>
          </div>
        ) : isCallConnected ? (
          /* Show CTI controls when call is connected/answered */
          <div className="mt-1 grid w-full grid-cols-4 place-items-center gap-2">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={callUI.isMuted ? "Unmute" : "Mute"}
                className="bg-zinc-700/70"
                onClick={toggleMute}
              >
                {callUI.isMuted ? (
                  <IconMicOff className="h-5 w-5" />
                ) : (
                  <IconMic className="h-5 w-5" />
                )}
              </CircleButton>
              <div className="text-[11px] text-zinc-300">
                {callUI.isMuted ? "Unmute" : "Mute"}
              </div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <CircleButton title="End" className="bg-red-600" onClick={hangup}>
                <IconPhoneOff className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">End</div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={callUI.isHeld ? "Unhold" : "Hold"}
                className="bg-zinc-700/70"
                onClick={toggleHold}
              >
                {callUI.isHeld ? (
                  <IconPlay className="h-5 w-5" />
                ) : (
                  <IconPause className="h-5 w-5" />
                )}
              </CircleButton>
              <div className="text-[11px] text-zinc-300">
                {callUI.isHeld ? "Unhold" : "Hold"}
              </div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title="Transfer"
                className="bg-zinc-700/70"
                onClick={() => setShowTransfer(true)}
              >
                <IconPhoneForwarded className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">Transfer</div>
            </div>
          </div>
        ) : (
          /* Show only dial button when idle */
          <div className="mt-1 flex w-full justify-center">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title="Call"
                className={clsx("bg-emerald-600", !canCall && "opacity-50")}
                onClick={startCall}
                disabled={!canCall}
              >
                <IconPhone className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">Call</div>
            </div>
          </div>
        )}
        <div className="w-full h-px bg-zinc-700/50"></div>

        <button
          type="button"
          className="w-full flex items-center justify-between px-1 py-1 text-[11px] text-zinc-300 hover:text-white"
          onClick={() => setShowDtmf((v) => !v)}
          title="DTMF"
        >
          <span className="flex items-center gap-1">
            <IconHash className="h-3 w-3" />
            <span>DTMF</span>
          </span>
          <IconChevronDown
            className={clsx(
              "h-3 w-3 transition-transform duration-200",
              showDtmf && "rotate-180"
            )}
          />
        </button>

        {showDtmf && (
          <div className="w-full rounded-2xl bg-zinc-900/60 p-0">
            <div className="mb-1 min-h-[22px] min-w-[22px] break-all text-center text-[11px] text-zinc-200 bg-zinc-700/30 rounded-md px-5 py-1">
              {dtmfBuffer}
            </div>
            <div className="grid grid-cols-3 gap-3 mx-12 mt-3">
              {keypadDigits.flat().map((digit) => (
                <button
                  key={digit}
                  onClick={() => handleKeypadDigit(digit)}
                  disabled={!isCallActive}
                  aria-disabled={!isCallActive}
                  className={clsx(
                    "h-10 w-10 rounded-full text-base text-white shadow active:scale-95",
                    isCallActive
                      ? "bg-zinc-800"
                      : "bg-zinc-800/50 cursor-not-allowed"
                  )}
                >
                  {digit}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Number Selection Modal */}
      <NumberSelectionModal
        open={showNumberModal}
        onOpenChange={setShowNumberModal}
        mode="dial"
        onSelect={(number) => {
          setDialToNumber(number);
          setShowNumberModal(false);
        }}
      />

      {/* Transfer Modal */}
      {activeCall && (
        <TransferModal
          open={showTransfer}
          onOpenChange={setShowTransfer}
          interaction={interaction}
          onTransfer={() => {
            setShowTransfer(false);
            console.log("[Softphone] Transfer successful");
          }}
        />
      )}
    </div>
  );
}

export default Softphone;

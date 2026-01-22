"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTelnyx } from "@/components/telephony-provider";
import { usePhoneUi } from "@/components/phone-ui-provider";
import useActiveCallStore, {
  useActiveCall,
  useIsRinging,
  useCallerInfo,
  useCallUI,
} from "@/lib/stores/active-call-store";
import useDialStore from "@/lib/stores/dial-store";
import useCallsStore from "@/lib/stores/calls-store";
import {
  lookupCallMetadata,
  lookupCustomerName,
  getStoredCallerInfo,
} from "@/lib/helpers/lookup-call-info";
import {
  Phone as IconPhone,
  Mic as IconMic,
  MicOff as IconMicOff,
  Pause as IconPause,
  Play as IconPlay,
  ChevronDown as IconChevronDown,
  PhoneOff as IconPhoneOff,
  PhoneForwarded as IconPhoneForwarded,
  UserCircle as IconContact,
} from "lucide-react";
import { TransferModal } from "@/components/contact-center/TransferModal";
import { NumberSelectionModal } from "@/components/contact-center/NumberSelectionModal";

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

export default function SoftphoneMini() {
  const { client } = useTelnyx();
  const { toggle } = usePhoneUi();

  // Zustand stores - call state
  const activeCall = useActiveCall();
  const isRinging = useIsRinging();
  const callerInfo = useCallerInfo();
  const callUI = useCallUI();
  const callStatus = useActiveCallStore((state) => state.status);
  const activeCallsCount = useCallsStore(
    (state) => state.getActiveCalls().length
  );

  // Zustand stores - dial state
  const { toNumber, setToNumber: setDialToNumber } = useDialStore();

  // Active call store actions
  const {
    setActiveCall,
    updateStatus,
    setMuted: storeSetMuted,
    setHeld: storeSetHeld,
    setCallerName,
    clearActiveCall,
    isContactCenterCall,
    getCallDuration,
  } = useActiveCallStore();

  // Check if call is connected/answered (CTI buttons should only show when connected)
  // Check both store status and call object state to handle all cases (inbound/outbound, direct/contact center)
  // Use useMemo to ensure this recalculates when status changes
  const isCallConnected = useMemo(() => {
    if (!activeCall) return false;

    const callObjectState = activeCall?.state
      ? String(activeCall.state).toLowerCase()
      : null;
    const storeStatus = callStatus ? String(callStatus).toLowerCase() : null;
    const connectedStates = ["active", "connected", "answered", "held"];

    // Prioritize store status (most reliable), fallback to call object state
    return (
      (storeStatus && connectedStates.includes(storeStatus)) ||
      (callObjectState && connectedStates.includes(callObjectState))
    );
  }, [activeCall, callStatus]);

  // Local UI state
  const [toInput, setToInput] = useState(toNumber || "");
  const [showTransfer, setShowTransfer] = useState(false);
  const [showNumberModal, setShowNumberModal] = useState(false);
  const [interaction, setInteraction] = useState(null);
  const fromRef = useRef("");
  const audioRef = useRef(null);
  const autoStatusRef = useRef({
    lastSent: null,
    forcedBusy: false,
  });

  const updateUserStatus = async (nextStatus) => {
    if (autoStatusRef.current.lastSent === nextStatus) return;
    autoStatusRef.current.lastSent = nextStatus;
    try {
      await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (_) {}
    try {
      localStorage.setItem("user.status", nextStatus);
    } catch (_) {}
  };

  // Auto-set agent status based on call activity
  useEffect(() => {
    const hasActiveCall = Boolean(activeCall) || activeCallsCount > 0;
    if (hasActiveCall) {
      autoStatusRef.current.forcedBusy = true;
      updateUserStatus("Busy");
      return;
    }
    if (autoStatusRef.current.forcedBusy) {
      autoStatusRef.current.forcedBusy = false;
      updateUserStatus("Available");
    }
  }, [activeCall, activeCallsCount]);

  // Fetch interaction when call is active
  // This works for BOTH contact center calls AND by looking up any incoming call
  // Track the last interaction we fetched to prevent repeated API calls
  const lastFetchedInteractionIdRef = useRef(null);

  useEffect(() => {
    // Fetch full interaction data for any call that might have an interaction
    if (activeCall) {
      const storeState = useActiveCallStore.getState();

      // For contact center calls, we have the interactionId from metadata
      let interactionId = storeState.contactCenter?.interactionId;

      // For incoming calls, check the incoming call store first (fastest method)
      // The SSE event from webrtc-bridge includes the interaction ID
      if (!interactionId) {
        const callControlId =
          activeCall.callControlId ||
          activeCall.call_control_id ||
          activeCall.id;

        // Try to get interaction ID from incoming call store first
        // The SSE event should have populated this with the interaction ID
        (async () => {
          try {
            const { getIncomingCallData } = await import(
              "@/lib/incoming-call-store"
            );

            // Try immediate lookup first
            let callData = getIncomingCallData(callControlId);

            // If not found by call_control_id, try the "latest" key
            // This handles the case where the WebRTC SDK uses a different call_control_id
            if (!callData?.interactionId) {
              const latestData = getIncomingCallData("__latest_incoming__");

              // Only use latest data if it's fresh (within last 10 seconds)
              if (
                latestData?.timestamp &&
                Date.now() - latestData.timestamp < 10000
              ) {
                callData = latestData;
              }
            }

            // If still not found, wait a bit for SSE event to arrive and try again
            if (!callData?.interactionId) {
              await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 500ms

              callData = getIncomingCallData(callControlId);
              if (!callData?.interactionId) {
                // Try latest again after waiting
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

              // Fetch the full interaction by ID
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
                } else {
                  setInteraction(null);
                }
              }
              return;
            }
          } catch (err) {
            console.warn(
              "[Mini Phone] Error checking incoming call store:",
              err
            );
          }

          // Fallback: Fetch interaction by looking up this call in the database
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
              } else {
                setInteraction(null);
              }
            } catch (err) {
              console.error(
                "[Mini Phone] Failed to fetch interaction by call_control_id:",
                err
              );
              setInteraction(null);
            }
          }
        })();
        return;
      }

      // Fetch by interactionId if we have one (from contact center metadata)
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
            } else {
              setInteraction(null);
            }
          } catch (err) {
            console.error("[Mini Phone] Failed to fetch interaction:", err);
            setInteraction(null);
          }
        };
        fetchInteraction();
      }
    } else {
      // Call ended, clear interaction
      lastFetchedInteractionIdRef.current = null;
      setInteraction(null);
    }
  }, [activeCall]);

  // Sync toInput with store toNumber
  useEffect(() => {
    if (toNumber !== toInput) {
      setToInput(toNumber || "");
    }
  }, [toNumber]);

  // Listen for incoming calls
  useEffect(() => {
    if (!client) return;

    const onNotification = (notification) => {
      try {
        console.log("[Mini Phone] Received notification:", notification);
        if (notification.type === "callUpdate" || notification?.call) {
          const call = notification?.call || null;
          const callState = call?.state || notification?.call?.state || "";

          // Detect call end states - when call object is missing or in end state
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
            // If we have an active call and it just ended
            if (activeCall) {
              handleCallEnd();
            }
            return;
          }

          if (call) {
            const callDirection =
              call.direction || notification?.call?.direction || "";
            const fromNumber =
              call.from || call.callerId || call.caller_id || "";

            // Determine if this is an incoming call
            // Priority:
            // 1. If direction is explicitly "outbound" -> NOT incoming
            // 2. If direction is explicitly "inbound" or "incoming" -> incoming
            // 3. If we already have an active call -> NOT incoming (it's a notification for our outbound call)
            // 4. If no active call AND state is new/ringing -> incoming (default assumption for notifications without direction)
            const isIncoming =
              callDirection === "outbound"
                ? false
                : callDirection === "inbound" || callDirection === "incoming"
                ? true
                : activeCall
                ? false // We have an active call, so this is our outbound call
                : callState === "new" || callState === "ringing"; // No active call + ringing = incoming

            // Detect incoming call - can be in "new" or "ringing" state
            // Only show answer UI for truly incoming calls
            const isIncomingCall =
              isIncoming && (callState === "new" || callState === "ringing");

            // For outbound calls, attach audio when call becomes active
            if (callDirection === "outbound" && activeCall) {
              // Attach audio when call is active, connected, or answered
              if (
                ["active", "connected", "answered"].includes(
                  callState.toLowerCase()
                )
              ) {
                attachAudio(call);

                // Retry multiple times to catch the remote stream
                const retryDelays = [100, 300, 500, 1000, 2000];
                retryDelays.forEach((delay) => {
                  setTimeout(() => {
                    attachAudio(call);
                  }, delay);
                });
              }
            }

            if (isIncomingCall && !activeCall) {
              const callControlId =
                call.callControlId || call.call_control_id || call.id;

              // Lookup call metadata and set active call
              (async () => {
                try {
                  // Check again if we have an active call - might have been set by startCall()
                  const currentState = useActiveCallStore.getState();
                  if (currentState.call) {
                    return;
                  }

                  // Lookup if this is a contact center call or direct call
                  const metadata = await lookupCallMetadata(callControlId);
                  metadata.direction = "inbound";
                  metadata.fromNumber = fromNumber;

                  // Try to get caller name from SSE store first
                  const storedInfo = await getStoredCallerInfo(fromNumber);
                  if (storedInfo?.fromName) {
                    metadata.fromName = storedInfo.fromName;
                  }
                  if (storedInfo?.originalCallControlId) {
                    metadata.originalCallControlId =
                      storedInfo.originalCallControlId;
                  }
                  if (storedInfo?.callSessionId) {
                    metadata.originalCallSessionId = storedInfo.callSessionId;
                  }
                  if (storedInfo?.interactionId && !metadata.interactionId) {
                    metadata.interactionId = storedInfo.interactionId;
                  }

                  // Populate contact center metadata from SSE if available
                  if (storedInfo?.contactCenter) {
                    metadata.interactionId =
                      storedInfo.contactCenter.interactionId;
                    metadata.queueName = storedInfo.contactCenter.queueName;
                    metadata.queuedAt = storedInfo.contactCenter.queuedAt;
                    metadata.assignedAt = storedInfo.contactCenter.assignedAt;
                    metadata.customerId = storedInfo.contactCenter.customerId;
                    metadata.customerData =
                      storedInfo.contactCenter.customerData;
                    metadata.isContactCenter =
                      !!storedInfo.contactCenter.interactionId;
                    console.log(
                      "[Mini Phone] Populated contact center metadata from SSE:",
                      metadata
                    );
                  }

                  // Double-check before setting - avoid race condition
                  const stateBeforeSet = useActiveCallStore.getState();
                  if (stateBeforeSet.call) {
                    console.log(
                      "[Mini Phone] Active call set during async operation, aborting"
                    );
                    return;
                  }

                  // Set active call in store
                  setActiveCall(call, metadata);

                  // Also add to calls store for multi-call management
                  useCallsStore.getState().addCall({
                    callControlId,
                    callSessionId: call.callSessionId || call.call_session_id,
                    originalCallControlId: metadata.originalCallControlId,
                    originalCallSessionId: metadata.originalCallSessionId,
                    rtcCallId: metadata.rtcCallId,
                    interactionId: metadata.interactionId,
                    callerName: metadata.fromName,
                    callerNumber: metadata.fromNumber || fromNumber,
                    queueName: metadata.queueName,
                    queueId: metadata.queueId,
                    direction: metadata.direction || "inbound",
                    status: "ringing",
                    fromName: metadata.fromName,
                    fromNumber: metadata.fromNumber || fromNumber,
                    toNumber: metadata.toNumber,
                    queuedAt: metadata.queuedAt,
                    assignedAt: metadata.assignedAt || Date.now(),
                    customerId: metadata.customerId,
                    customerData: metadata.customerData,
                  });

                  // Wire up call events
                  wireCall(call);

                  // If no name yet, lookup customer name asynchronously
                  if (!metadata.fromName && fromNumber) {
                    const customerName = await lookupCustomerName(fromNumber);
                    if (customerName) {
                      setCallerName(customerName);
                    }
                  }
                } catch (err) {
                  console.error(
                    "[Mini Phone] Error setting up incoming call:",
                    err
                  );
                }
              })();
            } else if (activeCall && callDirection === "outbound") {
              // If we have an active call and get an outbound notification,
              // this is likely a notification for our own outbound call
              // Sync the call state to ensure UI updates correctly
              const callControlId =
                call.callControlId || call.call_control_id || call.id;
              const activeCallControlId =
                activeCall.callControlId ||
                activeCall.call_control_id ||
                activeCall.id;

              // Only sync if this notification is for our active call
              if (callControlId === activeCallControlId) {
                // Sync call state - this ensures UI updates when call connects
                const syncCallState = () => {
                  try {
                    const s = String(call.state || "").toLowerCase();
                    if (s) {
                      updateStatus(s);
                    }

                    // Sync mute/hold status from call object
                    try {
                      const muted =
                        call.muted !== undefined ? call.muted : call.isMuted;
                      if (muted !== undefined) {
                        storeSetMuted(muted);
                      }
                    } catch (_) {}

                    try {
                      const held =
                        call.held !== undefined ? call.held : call.isHeld;
                      if (held !== undefined) {
                        storeSetHeld(held);
                      }
                    } catch (_) {}
                  } catch (_) {}
                };

                syncCallState();

                // Attach audio when call becomes active/connected/answered
                if (
                  ["active", "connected", "answered"].includes(
                    callState.toLowerCase()
                  )
                ) {
                  attachAudio(call);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error("[Mini Phone] Notification handler error:", err);
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
  }, [client, activeCall, setActiveCall, setCallerName]);

  useEffect(() => {
    // Ensure audio element is configured and unlock audio context
    const el = audioRef.current;
    if (el) {
      try {
        el.muted = false;
        el.autoplay = true;
        el.playsInline = true;
        el.volume = 1.0;

        // Unlock audio context by playing silent audio on mount
        // This allows the WebRTC SDK to play ringtones later
        const unlockAudio = async () => {
          try {
            // Create a silent audio buffer and play it to unlock the audio context
            // eslint-disable-next-line
            const AudioContextClass =
              window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;

            const audioContext = new AudioContextClass();
            const buffer = audioContext.createBuffer(1, 1, 22050);
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            source.start(0);
            await audioContext.close();
          } catch (err) {
            // Audio unlock failed, will retry on user interaction
          }
        };

        // Try to unlock immediately
        unlockAudio();

        // Also unlock on first user click anywhere on the document
        const handleFirstClick = () => {
          unlockAudio();
          document.removeEventListener("click", handleFirstClick);
        };
        document.addEventListener("click", handleFirstClick, { once: true });

        return () => {
          document.removeEventListener("click", handleFirstClick);
        };
      } catch (_) {}
    }
  }, []);

  useEffect(() => {
    // Initialize To/From from user profile
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();
        const mobile = data?.user?.mobile || "";
        const voice = data?.user?.voiceNumber || "";

        // Only set mobile as toNumber if there's no existing toNumber in the store
        if (!toNumber && mobile) {
          setDialToNumber(mobile);
          setToInput(mobile);
        }

        fromRef.current = voice || "";
      } catch (_) {}
    })();
  }, []);

  const canCall = useMemo(() => {
    return !activeCall && isValidDialTo(toNumber);
  }, [activeCall, toNumber]);

  function attachAudio(call) {
    try {
      const el = audioRef.current;
      if (!el || !call) return;

      // Ensure audio element is properly configured
      el.muted = false;
      el.autoplay = true;
      el.playsInline = true;
      el.volume = 1.0;

      if (typeof call.setAudioElement === "function") {
        call.setAudioElement(el);
        // Explicitly play audio after attaching
        try {
          el.play?.()?.catch((err) => {
            console.warn("[Mini Phone] Audio playback failed:", err);
          });
        } catch (_) {}
        return;
      }

      const stream = call.remoteStream || call.remoteMediaStream || call.stream;

      if (stream) {
        if (el.srcObject !== stream) {
          el.srcObject = stream;
        }
        // Explicitly play audio after setting stream
        try {
          el.play?.()?.catch((err) => {
            console.warn("[Mini Phone] Audio playback failed:", err);
          });
        } catch (_) {}
      }
    } catch (err) {
      console.error("[Mini Phone] attachAudio error:", err);
    }
  }

  // Re-attach audio whenever the call object changes
  useEffect(() => {
    if (activeCall) {
      attachAudio(activeCall);
    } else {
      try {
        if (audioRef.current) audioRef.current.srcObject = null;
      } catch (_) {}
    }
  }, [activeCall]);

  function wireCall(call) {
    try {
      attachAudio(call);

      // Update call state and sync mute/hold status
      const syncCallState = () => {
        try {
          const s = String(call.state || "").toLowerCase();
          if (s) {
            updateStatus(s);
          }

          // Sync mute status from call object
          try {
            const muted = call.muted !== undefined ? call.muted : call.isMuted;
            if (muted !== undefined) {
              storeSetMuted(muted);
            }
          } catch (_) {}

          // Sync hold status from call object
          try {
            const held = call.held !== undefined ? call.held : call.isHeld;
            if (held !== undefined) {
              storeSetHeld(held);
            }
          } catch (_) {}

          // Sync to calls store
          try {
            const callControlId =
              call.callControlId || call.call_control_id || call.id;
            const callsStore = useCallsStore.getState();
            const callData = callsStore.getCall(callControlId);

            if (callData) {
              const updates = {
                status: s,
                isMuted: call.muted !== undefined ? call.muted : call.isMuted,
                isHeld: call.held !== undefined ? call.held : call.isHeld,
              };

              // Set answerTime when call becomes active/connected/answered
              if (
                (s === "active" || s === "connected" || s === "answered") &&
                !callData.answerTime
              ) {
                updates.answerTime = Date.now();
                updates.connectedTime = Date.now();
                updates.isRinging = false;
              }

              // Update duration if call is active
              if (callData.answerTime && !callData.disconnectedTime) {
                updates.duration = Math.floor(
                  (Date.now() - callData.answerTime) / 1000
                );
              }

              callsStore.updateCall(callControlId, updates);
            }
          } catch (_) {}

          attachAudio(call);
        } catch (_) {}
      };

      // Wire up all call events for immediate status updates
      const registeredEvents = [];

      if (typeof call.on === "function") {
        call.on("ringing", () => {
          updateStatus("ringing");
          syncCallState();
        });
        registeredEvents.push("ringing");
      }

      if (typeof call.on === "function") {
        call.on("active", () => {
          updateStatus("active");
          syncCallState();
          attachAudio(call);

          // Retry audio attachment - stream may take time to be available
          setTimeout(() => {
            attachAudio(call);
          }, 500);
        });
        registeredEvents.push("active");

        call.on("connected", () => {
          updateStatus("connected");
          syncCallState();
          attachAudio(call);

          // Retry audio attachment - stream may take time to be available
          setTimeout(() => {
            attachAudio(call);
          }, 500);
        });
        registeredEvents.push("connected");

        call.on("answered", () => {
          updateStatus("answered");
          syncCallState();
          attachAudio(call);

          // For outbound calls, retry audio attachment multiple times
          // The remote stream may not be immediately available
          const retryDelays = [100, 300, 500, 1000];
          retryDelays.forEach((delay) => {
            setTimeout(() => {
              attachAudio(call);
            }, delay);
          });
        });
        registeredEvents.push("answered");

        call.on("trying", () => {
          updateStatus("trying");
        });
        registeredEvents.push("trying");

        call.on("requesting", () => {
          updateStatus("requesting");
        });
        registeredEvents.push("requesting");

        call.on("early", () => {
          updateStatus("early");
        });
        registeredEvents.push("early");

        call.on("busy", () => {
          updateStatus("busy");
        });
        registeredEvents.push("busy");

        call.on("held", () => {
          storeSetHeld(true);
        });
        registeredEvents.push("held");
      }

      // Register hangup handlers - try both with and without optional chaining
      // Some versions of the SDK might need direct .on() calls
      const onHangup = () => {
        updateStatus("ended");
        setTimeout(() => {
          handleCallEnd();
        }, 100);
      };

      const onDestroy = () => {
        updateStatus("ended");
        setTimeout(() => {
          handleCallEnd();
        }, 100);
      };

      const onEnded = () => {
        updateStatus("ended");
        setTimeout(() => {
          handleCallEnd();
        }, 100);
      };

      const onPurge = () => {
        updateStatus("ended");
        setTimeout(() => {
          handleCallEnd();
        }, 100);
      };

      // Try registering with both methods
      if (typeof call.on === "function") {
        call.on("hangup", onHangup);
        call.on("destroy", onDestroy);
        call.on("ended", onEnded);
        call.on("purge", onPurge);
      } else {
        console.warn(
          "[Mini Phone] call.on is not a function, cannot register hangup listeners"
        );
      }

      // Listen to stateChanged for all state transitions
      call.on?.("stateChanged", (newState) => {
        if (newState) {
          const lowerState = String(newState).toLowerCase();
          updateStatus(lowerState);

          // Check if call ended via state change
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
            setTimeout(() => {
              handleCallEnd();
            }, 100);
          }

          // Re-attach audio when call becomes active
          if (["active", "connected", "answered"].includes(lowerState)) {
            attachAudio(call);
          }
        }
        syncCallState();
      });

      // Also listen to RTCPeerConnection events if available
      // The WebRTC SDK might expose lower-level events
      if (call._peer) {
        const peer = call._peer;

        const checkConnectionState = () => {
          const state = peer.connectionState;

          if (
            state === "disconnected" ||
            state === "closed" ||
            state === "failed"
          ) {
            setTimeout(() => {
              handleCallEnd();
            }, 100);
          }
        };

        peer.addEventListener?.("connectionstatechange", checkConnectionState);
        peer.addEventListener?.(
          "iceconnectionstatechange",
          checkConnectionState
        );
      }

      // Initial state sync
      syncCallState();
    } catch (err) {
      console.error(
        "[Mini Phone] wireCall: Error setting up event listeners:",
        err
      );
    }
  }

  async function handleCallEnd() {
    try {
      const storeState = useActiveCallStore.getState();

      // Get callControlId for calls store
      const callControlId =
        storeState.callControlId ||
        storeState.call?.callControlId ||
        storeState.call?.call_control_id ||
        storeState.call?.id;

      // Update calls store before clearing
      if (callControlId) {
        const callsStore = useCallsStore.getState();
        const callData = callsStore.getCall(callControlId);

        if (callData) {
          // Update final status and disconnected time
          callsStore.updateCall(callControlId, {
            status: "ended",
            disconnectedTime: Date.now(),
            isRinging: false,
          });
        }
      }

      // Sync call data to database before clearing store
      // Only for inbound contact center calls (not outbound calls)
      // This captures answered_at, hold metrics, timestamps, and state history
      const interactionId = storeState.contactCenter?.interactionId;
      const isInboundCall =
        storeState.direction === "inbound" ||
        storeState.direction === "incoming";

      if (interactionId && isInboundCall) {
        try {
          await fetch("/api/contact-center/interactions/sync-call-data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              interactionId,
              originalCallSessionId: storeState.originalCallSessionId,
              originalCallControlId: storeState.originalCallControlId,
              answerTime: storeState.answerTime,
              connectedTime: storeState.connectedTime,
              disconnectedTime: storeState.disconnectedTime || Date.now(),
              holdCount: storeState.holdCount,
              totalHoldDuration: storeState.totalHoldDuration,
              stateHistory: storeState.stateHistory || [],
            }),
          });
          console.log("[Mini Phone] Synced call data to database");
        } catch (err) {
          console.error("[Mini Phone] Failed to sync call data:", err);
          // Don't throw - call already ended, just log failure
        }
      } else {
        console.log(
          "[Mini Phone] Skipping sync-call-data (not an inbound contact center call)"
        );
      }

      // If this is a contact center call, finalize the interaction
      if (isContactCenterCall()) {
        const interactionId = storeState.contactCenter?.interactionId;
        const duration = getCallDuration();

        if (interactionId) {
          try {
            await fetch(
              `/api/contact-center/interactions/${interactionId}/finalize`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  completedAt: new Date().toISOString(),
                  handleTimeSeconds: duration,
                }),
              }
            );
          } catch (err) {
            console.error("[Mini Phone] Failed to finalize interaction:", err);
            // Don't throw - call already ended, just log failure
          }
        }
      }

      // Clear active call from store
      clearActiveCall();
    } catch (err) {
      console.error("[Mini Phone] Error in handleCallEnd:", err);
      // Always clear call even if finalization fails
      clearActiveCall();
    }
  }

  function startCall() {
    const to = (toNumber || "").trim();
    const from = fromRef.current || "";
    if (!client || !to || activeCall) return;

    try {
      // Ensure mic is available
      try {
        client.enableMicrophone?.();
      } catch (_) {}

      const call = client.newCall({
        destinationNumber: to,
        callerNumber: from || undefined,
        audio: true,
        video: false,
      });

      // Set active call in store (outbound call, no contact center metadata)
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
      // This helps ensure audio works when the other party answers
      const retryDelays = [500, 1000, 2000, 3000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            attachAudio(call);
          }
        }, delay);
      });
    } catch (err) {
      console.error("[Mini Phone] Failed to start call:", err);
      clearActiveCall();
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
      console.error("[Mini Phone] Toggle mute error:", err);
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
      console.error("[Mini Phone] Toggle hold error:", err);
    }
  }

  function handleAnswerCall() {
    try {
      if (!activeCall) {
        console.error("[Mini Phone] No call to answer");
        return;
      }

      // Ensure audio is properly attached before answering
      attachAudio(activeCall);

      // Answer the call
      activeCall.answer?.();

      // Update status
      updateStatus("answered");

      // Force audio attachment with multiple retries
      // This ensures the remote stream is available after the answer
      const retryDelays = [100, 300, 500, 1000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            attachAudio(activeCall);
          }
        }, delay);
      });
    } catch (err) {
      console.error("[Mini Phone] Error answering call:", err);
    }
  }

  async function handleRejectCall() {
    try {
      if (!activeCall) {
        console.error("[Mini Phone] No call to reject");
        return;
      }

      // Get the original call control ID from the active call store
      // This was extracted from X-Original-Call-Control-Id header when the call was set
      const originalCallControlId =
        useActiveCallStore.getState().originalCallControlId;

      // If we have the original call control ID, use it for hangup
      if (originalCallControlId) {
        console.log(
          "[Mini Phone] Using originalCallControlId from store:",
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
              "[Mini Phone] Failed to hangup original call leg:",
              result
            );
          } else {
            console.log("[Mini Phone] Successfully hung up original call leg");
          }
        } catch (err) {
          console.error("[Mini Phone] Error calling hangup API:", err);
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
              "[Mini Phone] Failed to hangup original call leg:",
              result
            );
          }
        } catch (err) {
          console.error("[Mini Phone] Error calling hangup API:", err);
        }
      }

      // Hangup the WebRTC leg
      activeCall.hangup?.();

      // handleCallEnd will be called by the hangup event
    } catch (err) {
      console.error("[Mini Phone] Error rejecting call:", err);
    }
  }

  function hangup() {
    try {
      if (!activeCall) {
        clearActiveCall();
        return;
      }

      // Check if call is already ended
      const storeState = useActiveCallStore.getState();
      const status = storeState.status;
      if (
        ["hangup", "ended", "destroy", "idle", "terminated"].includes(status)
      ) {
        clearActiveCall();
        return;
      }

      // Try to hangup
      try {
        if (typeof activeCall.hangup === "function") {
          activeCall.hangup();

          // The telnyx.notification handler will receive the call end notification
          // and call handleCallEnd(). Add a fallback timeout just in case.
          setTimeout(() => {
            const currentState = useActiveCallStore.getState();
            if (currentState.call) {
              handleCallEnd();
            }
          }, 2000);
        } else {
          console.warn("[Mini Phone] No hangup method on call object");
          handleCallEnd();
          return;
        }
      } catch (err) {
        console.warn(
          "[Mini Phone] Hangup error (call may already be ended):",
          err
        );
        // Clear state even if hangup fails
        handleCallEnd();
      }
    } catch (err) {
      console.error("[Mini Phone] Hangup error:", err);
      // Clear state on any error
      try {
        clearActiveCall();
      } catch (_) {}
    }
  }

  return (
    <div
      className={`hidden sm:flex items-center gap-2 rounded-md bg-muted text-foreground border px-2 py-1 transition-all ${
        isRinging
          ? "border-telnyx-green shadow-[0_0_0_2px_rgba(34,211,110,0.3)] animate-pulse"
          : "border-border"
      }`}
    >
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      <button
        className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white hover:bg-zinc-700"
        title="Select number from contacts"
        onClick={() => setShowNumberModal(true)}
      >
        <IconContact className="h-4 w-4" />
      </button>
      <input
        value={toInput}
        readOnly
        placeholder="Phone number or SIP URI"
        className="w-40 rounded border border-border bg-background px-2 py-1 text-xs outline-none cursor-pointer"
        onClick={() => setShowNumberModal(true)}
        title="Click to select number"
      />
      {/* Show answer/reject buttons for incoming ringing calls */}
      {isRinging ? (
        <>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-red-600 text-white"
            title="Reject"
            onClick={() => handleRejectCall()}
          >
            <IconPhoneOff className="h-4 w-4" />
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-emerald-600 text-white"
            title="Answer"
            onClick={() => handleAnswerCall()}
          >
            <IconPhone className="h-4 w-4" />
          </button>
        </>
      ) : activeCall && !isCallConnected ? (
        <>
          {/* Show only disconnect button for outbound calls in progress (dialing/ringing) */}
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-red-600 text-white"
            title="Disconnect"
            onClick={hangup}
          >
            <IconPhoneOff className="h-4 w-4" />
          </button>
        </>
      ) : isCallConnected ? (
        <>
          {/* Show CTI buttons when call is connected/answered */}
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white"
            title={callUI.isMuted ? "Unmute" : "Mute"}
            onClick={toggleMute}
          >
            {callUI.isMuted ? (
              <IconMicOff className="h-4 w-4" />
            ) : (
              <IconMic className="h-4 w-4" />
            )}
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-red-600 text-white"
            title="Hang up"
            onClick={hangup}
          >
            <IconPhoneOff className="h-4 w-4" />
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white"
            title={callUI.isHeld ? "Unhold" : "Hold"}
            onClick={toggleHold}
          >
            {callUI.isHeld ? (
              <IconPlay className="h-4 w-4" />
            ) : (
              <IconPause className="h-4 w-4" />
            )}
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white"
            title="Transfer"
            onClick={() => setShowTransfer(true)}
          >
            <IconPhoneForwarded className="h-4 w-4" />
          </button>
        </>
      ) : (
        <>
          {/* Show only dial button when idle */}
          <button
            className={`h-7 w-7 rounded-full grid place-items-center ${
              canCall
                ? "bg-emerald-600 text-white"
                : "bg-zinc-700/70 text-white/70"
            }`}
            title="Call"
            onClick={startCall}
            disabled={!canCall}
          >
            <IconPhone className="h-4 w-4" />
          </button>
        </>
      )}
      <button
        className="ml-1 h-7 w-7 rounded-full bg-zinc-700/70 text-white grid place-items-center"
        title="Show phone"
        onClick={toggle}
      >
        <IconChevronDown className="h-4 w-4" />
      </button>
      {activeCall && (
        <TransferModal
          open={showTransfer}
          onOpenChange={setShowTransfer}
          interaction={interaction}
          onTransfer={() => {
            setShowTransfer(false);
            console.log("[SoftphoneMini] Transfer successful");
          }}
        />
      )}
      <NumberSelectionModal
        open={showNumberModal}
        onOpenChange={setShowNumberModal}
        mode="dial"
        onSelect={(number) => {
          setToInput(number);
          setDialToNumber(number);
          setShowNumberModal(false);
        }}
      />
    </div>
  );
}

"use client";

import { supervisionCustomerIdentity } from "@/lib/contact-center/customer-identity";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  IconEye,
  IconHeadphones,
  IconMicrophone,
  IconCheck,
  IconLoader,
  IconPhone,
  IconPhoneOff,
  IconMicrophoneOff,
  IconX,
} from "@tabler/icons-react";
import { Pause as IconPause, Play as IconPlay } from "lucide-react";
import { notify } from "@/components/ToastNotify";
import { TelephonyAddress } from "@/components/contact-center/TelephonyAddress";
import { cn } from "@/lib/utils";
import { useTelnyx } from "@/components/telephony-provider";
import useActiveCallStore, {
  useActiveCall,
  useIsRinging,
  useCallUI,
} from "@/lib/stores/active-call-store";
import { useAuth } from "@/components/auth-provider";

const SUPERVISOR_ROLES = {
  monitor: {
    label: "Monitor",
    icon: IconEye,
    color: "blue",
    description: "Listen to the call without being heard",
    audioFlow: {
      supervisor: { canHear: ["caller", "agent"], canSpeak: [] },
      caller: { canHear: ["agent"], canSpeak: ["agent"] },
      agent: { canHear: ["caller"], canSpeak: ["caller"] },
    },
  },
  whisper: {
    label: "Whisper",
    icon: IconHeadphones,
    color: "purple",
    description: "Listen and speak to the agent only",
    audioFlow: {
      supervisor: { canHear: ["caller", "agent"], canSpeak: ["agent"] },
      caller: { canHear: ["agent"], canSpeak: ["agent"] },
      agent: {
        canHear: ["caller", "supervisor"],
        canSpeak: ["caller", "supervisor"],
      },
    },
  },
  barge: {
    label: "Barge",
    icon: IconMicrophone,
    color: "green",
    description: "Join the call and speak to both parties",
    audioFlow: {
      supervisor: {
        canHear: ["caller", "agent"],
        canSpeak: ["caller", "agent"],
      },
      caller: {
        canHear: ["agent", "supervisor"],
        canSpeak: ["agent", "supervisor"],
      },
      agent: {
        canHear: ["caller", "supervisor"],
        canSpeak: ["caller", "supervisor"],
      },
    },
  },
};

const PARTICIPANT_TONES = {
  violet: {
    border: "border-violet-500",
    icon: "bg-violet-500/20 text-violet-500",
    eyebrow: "text-violet-500",
    badge: "border-violet-500 text-violet-500",
  },
  blue: {
    border: "border-blue-500",
    icon: "bg-blue-500/20 text-blue-500",
    eyebrow: "text-blue-500",
    badge: "border-blue-500 text-blue-500",
  },
  green: {
    border: "border-green-500",
    icon: "bg-green-500/20 text-green-500",
    eyebrow: "text-green-500",
    badge: "border-green-500 text-green-500",
  },
};

function SupervisionParticipantCard({
  testId,
  role,
  label,
  detail,
  status,
  tone,
  icon: Icon,
  dashed = false,
  className,
}) {
  const colors = PARTICIPANT_TONES[tone];
  return (
    <div
      data-testid={testId}
      className={cn(
        "relative z-10 flex min-h-[76px] min-w-0 items-center gap-3 rounded-xl border-2 bg-background/95 p-3 text-left shadow-sm",
        colors.border,
        dashed && "border-dashed",
        className,
      )}
    >
      <div
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-full",
          colors.icon,
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider",
            colors.eyebrow,
          )}
        >
          {role}
        </div>
        <div className="truncate text-sm font-semibold" title={label}>
          {label}
        </div>
        <TelephonyAddress
          value={detail}
          className="block max-w-[190px] truncate text-xs text-muted-foreground"
        />
      </div>
      <Badge
        variant="outline"
        className={cn("shrink-0 text-[10px] uppercase", colors.badge)}
      >
        {status}
      </Badge>
    </div>
  );
}

// Each supervision mode needs its own calls:supervise.* grant (RBAC Phase 3).
const SUPERVISION_PERMISSION = { monitor: "calls:supervise.listen", whisper: "calls:supervise.whisper", barge: "calls:supervise.barge" };

export function SupervisionModal({ open, onOpenChange, call }) {
  const { can } = useAuth();
  const { client } = useTelnyx();
  const [loading, setLoading] = useState(false);

  // Persist activeRole in localStorage keyed by call ID
  const getStoredRole = () => {
    if (!call) return null;
    const callId = call?.id || call?.interactionId || call?.callControlId;
    if (!callId) return null;
    try {
      const stored = localStorage.getItem(`supervisor_role_${callId}`);
      return stored || null;
    } catch {
      return null;
    }
  };
  const [activeRole, setActiveRole] = useState(getStoredRole());
  const [supervisorCallControlId, setSupervisorCallControlId] = useState(null);
  const [supervisedCallControlId, setSupervisedCallControlId] = useState(null); // Original call being supervised
  const [user, setUser] = useState(null);
  const [supervisorNumber, setSupervisorNumber] = useState(""); // Default fallback

  // Use refs to track current values for immediate access (avoid stale closures)
  const activeRoleRef = useRef(activeRole);
  const supervisorCallControlIdRef = useRef(supervisorCallControlId);
  // Flag to prevent checkSupervisorCall from resetting state after user action
  const userInitiatedSupervisionRef = useRef(false);
  // Flag to track if we've already attempted to auto-answer the supervisor call
  const autoAnswerAttemptedRef = useRef(false);
  // `clearActiveCall` deliberately collapses the terminal SDK state to `idle`.
  // Remember that this supervision leg was observed first so `idle` can be
  // treated as terminal without cancelling a call that is still arriving.
  const supervisorCallObservedRef = useRef(false);
  const supervisorRemoteAudioRef = useRef(null);

  // Update refs when state changes
  useEffect(() => {
    activeRoleRef.current = activeRole;
  }, [activeRole]);

  useEffect(() => {
    supervisorCallControlIdRef.current = supervisorCallControlId;
  }, [supervisorCallControlId]);

  // Save activeRole to localStorage when it changes
  useEffect(() => {
    if (!call || !activeRole) return;
    const callId = call?.id || call?.interactionId || call?.callControlId;
    if (!callId) return;
    try {
      localStorage.setItem(`supervisor_role_${callId}`, activeRole);
    } catch {
      // Ignore localStorage errors
    }
  }, [activeRole, call]);

  // Debug: Track state changes to see if something is resetting it
  useEffect(() => {
    console.log("[SupervisionModal] activeRole state changed:", {
      activeRole,
      supervisorCallControlId,
      activeRoleRef: activeRoleRef.current,
      supervisorCallControlIdRef: supervisorCallControlIdRef.current,
      stackTrace: new Error().stack,
    });
  }, [activeRole, supervisorCallControlId]);

  // Use the same store as mini phone for synced state - EXACT same hooks
  const activeCall = useActiveCall();
  const isRinging = useIsRinging();
  const callUI = useCallUI();
  const callStatus = useActiveCallStore((state) => state.status);
  const {
    setActiveCall,
    updateStatus,
    setMuted: storeSetMuted,
    clearActiveCall,
  } = useActiveCallStore();

  // Check if call is connected - EXACT same logic as mini phone
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

  // Supervisor call is the active call from store - mini phone already manages it
  // We just need to detect if the active call is a supervisor call
  const supervisorWebRTCCall = useMemo(() => {
    // If we have an active call, check if it's a supervisor call
    // Supervisor calls come from supervisorNumber or have "Supervisor Call" as fromName
    if (activeCall) {
      const fromNumber = useActiveCallStore.getState().fromNumber;
      const fromName = useActiveCallStore.getState().fromName;
      if (fromNumber === supervisorNumber || fromName === "Supervisor Call") {
        return activeCall;
      }
    }
    return null;
  }, [activeCall, supervisorNumber]);

  // Determine if supervisor call is active - if supervisorCallControlId is set, we're supervising
  // OR if there's an active call that's a supervisor call (from supervisorNumber)
  const isSupervisorCallActive = useMemo(() => {
    // If supervisorCallControlId is set, supervision has been initiated
    if (supervisorCallControlId) return true;

    // OR if active call is a supervisor call (check fromNumber)
    if (activeCall) {
      const fromNumber = useActiveCallStore.getState().fromNumber;
      const fromName = useActiveCallStore.getState().fromName;
      if (fromNumber === supervisorNumber || fromName === "Supervisor Call") {
        return true;
      }
    }

    return false;
  }, [supervisorCallControlId, activeCall, supervisorNumber]);

  const hydrateSupervisorAudio = useCallback((supervisorCall) => {
    const audioEl = supervisorRemoteAudioRef.current;
    if (!supervisorCall || !audioEl) return;

    try {
      if (typeof supervisorCall.setAudioElement === "function") {
        supervisorCall.setAudioElement(audioEl);
      }
      if (typeof supervisorCall.attachAudio === "function") {
        supervisorCall.attachAudio(audioEl);
      }

      const remoteStream =
        supervisorCall.remoteStream || supervisorCall.remoteMediaStream || supervisorCall.stream;
      if (remoteStream && audioEl.srcObject !== remoteStream) {
        audioEl.srcObject = remoteStream;
      }

      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = false;
      const playResult = audioEl.play?.();
      if (playResult?.catch) {
        playResult.catch((error) => {
          console.warn("[SupervisionModal] Supervisor audio autoplay blocked:", error);
        });
      }
    } catch (error) {
      console.error("[SupervisionModal] Failed to hydrate supervisor audio:", error);
    }
  }, []);

  // Determine supervisor call state from store or call object
  const supervisorCallState = useMemo(() => {
    if (!supervisorWebRTCCall) return null;

    // Use store status if available, otherwise use call object state
    const state =
      callStatus || supervisorWebRTCCall.state || supervisorWebRTCCall.status;
    const lowerState = String(state || "").toLowerCase();

    if (["active", "connected", "answered"].includes(lowerState)) {
      return "answered";
    } else if (["ringing", "early"].includes(lowerState) || isRinging) {
      return "ringing";
    } else if (
      ["hangup", "ended", "destroy", "purge", "idle"].includes(lowerState)
    ) {
      return "hangup";
    }

    return lowerState || "ringing";
  }, [supervisorWebRTCCall, callStatus, isRinging]);

  // Determine if call is answered (has an agent)
  const isCallAnswered =
    call?.answeredAt || call?.agentName || call?.agentUsername;
  // Determine if call is in queue (not answered yet)
  const isCallInQueue =
    !isCallAnswered &&
    (call?.state === "enqueued" ||
      call?.state === "queued" ||
      call?.state === "ringing" ||
      !call?.state);

  // Fetch supervisor number from config API
  useEffect(() => {
    const fetchSupervisorNumber = async () => {
      try {
        const res = await fetch("/api/config/supervisor-number");
        if (res.ok) {
          const data = await res.json();
          if (data.supervisorNumber) {
            setSupervisorNumber(data.supervisorNumber);
          }
        }
      } catch (err) {
        console.error(
          "[SupervisionModal] Failed to fetch supervisor number:",
          err,
        );
        // Keep default fallback
      }
    };
    fetchSupervisorNumber();
  }, []);

  useEffect(() => {
    if (open && call) {
      loadUserInfo();
      // Check if supervisor call already exists (but don't reset activeRole if already set)
      // Use a small delay to ensure state from previous actions is preserved
      const timer = setTimeout(() => {
        console.log(
          "[SupervisionModal] checkSupervisorCall called from useEffect:",
          {
            userInitiated: userInitiatedSupervisionRef.current,
            activeRoleRef: activeRoleRef.current,
            supervisorCallControlIdRef: supervisorCallControlIdRef.current,
          },
        );
        checkSupervisorCall();
      }, 100);
      return () => clearTimeout(timer);
    }
    // Don't reset state when modal closes - keep state for next open
  }, [open, call]); // Removed activeCall from deps to prevent resetting state when call arrives

  // Listen for incoming supervisor calls - same as mini phone
  // When supervisorCallControlId is set, any incoming call must be the supervisor call
  useEffect(() => {
    if (!client || !supervisorCallControlId) return;

    const onNotification = (notification) => {
      try {
        if (notification.type === "callUpdate" || notification?.call) {
          const call = notification?.call || null;
          const callState = call?.state || notification?.call?.state || "";

          // If we have supervisorCallControlId set, any incoming call is the supervisor call
          if (call && !activeCall) {
            const callDirection =
              call.direction || notification?.call?.direction || "";
            const isIncoming =
              callDirection === "inbound" ||
              callDirection === "incoming" ||
              callState === "new" ||
              callState === "ringing";

            // If it's an incoming call in ringing state and we're waiting for supervisor call
            if (
              isIncoming &&
              (callState === "new" || callState === "ringing")
            ) {
              console.log(
                "[SupervisionModal] Detected incoming call, setting as supervisor call:",
                {
                  callControlId:
                    call.callControlId || call.call_control_id || call.id,
                  supervisorCallControlId,
                  state: callState,
                },
              );

              // Set it in the store so it's synced with mini phone
              setActiveCall(call, {
                direction: "inbound",
                fromNumber: supervisorNumber,
                fromName: "Supervisor Call",
              });
            }
          }
        }
      } catch (err) {
        console.error("[SupervisionModal] Notification handler error:", err);
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
  }, [client, supervisorCallControlId, activeCall, setActiveCall]);

  // Auto-answer supervisor call when it arrives after clicking a role tile
  useEffect(() => {
    // Only auto-answer if:
    // 1. We have a supervisorCallControlId (supervision was started)
    // 2. We have an active call (the supervisor call has arrived)
    // 3. The call is ringing (not yet answered)
    // 4. The call is a supervisor call (from supervisorNumber or "Supervisor Call")
    // 5. We haven't already attempted to auto-answer
    if (
      !supervisorCallControlId ||
      !activeCall ||
      autoAnswerAttemptedRef.current
    )
      return;

    const fromNumber = useActiveCallStore.getState().fromNumber;
    const fromName = useActiveCallStore.getState().fromName;
    const isSupervisorCall =
      fromNumber === supervisorNumber || fromName === "Supervisor Call";

    if (!isSupervisorCall) return;

    const callState = activeCall?.state || callStatus || "";
    const lowerState = String(callState).toLowerCase();
    const isRingingState =
      isRinging ||
      lowerState === "ringing" ||
      lowerState === "new" ||
      lowerState === "early";

    // Only auto-answer if call is ringing and not already answered
    if (isRingingState && !isCallConnected) {
      // Mark as attempted to prevent multiple attempts
      autoAnswerAttemptedRef.current = true;

      console.log("[SupervisionModal] Auto-answering supervisor call:", {
        supervisorCallControlId,
        callState: lowerState,
        isRinging,
        isCallConnected,
      });

      // Small delay to ensure call object is fully ready
      const autoAnswerTimer = setTimeout(() => {
        const currentCall = useActiveCallStore.getState().call;
        if (currentCall && currentCall.answer) {
          try {
            Promise.resolve(currentCall.answer?.())
              .then(() => {
                updateStatus("answered");

                // Force audio attachment with multiple retries after Telnyx answer resolves.
                const retryDelays = [0, 100, 300, 500, 1000];
                retryDelays.forEach((delay) => {
                  setTimeout(() => {
                    const callForAudio = useActiveCallStore.getState().call;
                    hydrateSupervisorAudio(callForAudio);
                  }, delay);
                });
              })
              .catch((err) => {
                console.error("[SupervisionModal] Error auto-answering call:", err);
                // Reset flag on error so we can retry if needed
                autoAnswerAttemptedRef.current = false;
              });
          } catch (err) {
            console.error("[SupervisionModal] Error auto-answering call:", err);
            // Reset flag on error so we can retry if needed
            autoAnswerAttemptedRef.current = false;
          }
        }
      }, 200);

      return () => clearTimeout(autoAnswerTimer);
    }
  }, [
    supervisorCallControlId,
    activeCall,
    isRinging,
    isCallConnected,
    callStatus,
    updateStatus,
    supervisorNumber,
    hydrateSupervisorAudio,
  ]);

  // Reset auto-answer flag when supervisor call ends or supervision is cleared
  useEffect(() => {
    if (!supervisorCallControlId) {
      autoAnswerAttemptedRef.current = false;
    }
  }, [supervisorCallControlId]);

  const loadUserInfo = async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json();
      if (data.isAuth && data.user) {
        setUser(data.user);
      }
    } catch (err) {
      console.error("[SupervisionModal] Failed to load user info:", err);
    }
  };

  // Helper to check if custom headers contain X-Supervisor-Call
  const hasSupervisorCallHeader = (call) => {
    if (!call) return false;

    // Check if custom_headers is an array (from webhooks)
    if (Array.isArray(call.custom_headers)) {
      return call.custom_headers.some(
        (h) => h?.name === "X-Supervisor-Call" && h?.value === "true",
      );
    }

    // Check if customHeaders is an object (converted format)
    if (call.customHeaders && typeof call.customHeaders === "object") {
      return call.customHeaders["X-Supervisor-Call"] === "true";
    }

    // Check headers object
    if (call.headers && typeof call.headers === "object") {
      return call.headers["X-Supervisor-Call"] === "true";
    }

    return false;
  };

  // Check if there's an active supervisor call when modal opens
  const checkSupervisorCall = async () => {
    // Use refs to check current state (avoid stale closures)
    const currentActiveRole = activeRoleRef.current;
    const currentSupervisorCallControlId = supervisorCallControlIdRef.current;
    const userInitiated = userInitiatedSupervisionRef.current;

    // Don't reset activeRole if it's already set (user might have just clicked a tile)
    // OR if user just initiated supervision (state might not be set yet but refs are)
    if (
      userInitiated ||
      (currentActiveRole && currentSupervisorCallControlId)
    ) {
      console.log(
        "[SupervisionModal] Skipping checkSupervisorCall - user initiated or already have state:",
        {
          userInitiated,
          activeRole: currentActiveRole,
          supervisorCallControlId: currentSupervisorCallControlId,
        },
      );
      return;
    }

    // Check if call has supervisor metadata
    if (call?.supervisorCallControlId) {
      setSupervisorCallControlId(call.supervisorCallControlId);
      supervisorCallControlIdRef.current = call.supervisorCallControlId;
      const roleToSet =
        call.supervisorRole ||
        getStoredRole() ||
        currentActiveRole ||
        "monitor";
      if (roleToSet && roleToSet !== currentActiveRole) {
        setActiveRole(roleToSet);
        activeRoleRef.current = roleToSet;
      }
      return;
    }

    // Check if active call in store is a supervisor call
    // Check by fromNumber OR by custom header X-Supervisor-Call
    const currentActiveCall = useActiveCallStore.getState().call;
    const fromNumber = useActiveCallStore.getState().fromNumber;
    const fromName = useActiveCallStore.getState().fromName;

    // Check if it's a supervisor call by fromNumber or custom headers
    const isSupervisorCall =
      currentActiveCall &&
      (fromNumber === supervisorNumber ||
        fromName === "Supervisor Call" ||
        hasSupervisorCallHeader(currentActiveCall));

    if (isSupervisorCall) {
      // This is a supervisor call - extract the call control ID
      const callControlId =
        currentActiveCall.callControlId ||
        currentActiveCall.call_control_id ||
        currentActiveCall.id ||
        currentActiveCall.callId;
      if (callControlId) {
        setSupervisorCallControlId(callControlId);
        supervisorCallControlIdRef.current = callControlId;
        // Restore role from localStorage, but don't overwrite if already set
        const storedRole = getStoredRole();
        if (!currentActiveRole) {
          if (storedRole) {
            setActiveRole(storedRole);
            activeRoleRef.current = storedRole;
          } else {
            setActiveRole("monitor");
            activeRoleRef.current = "monitor";
          }
        }
        console.log("[SupervisionModal] Detected active supervisor call:", {
          callControlId,
          activeRole: currentActiveRole || storedRole || "monitor",
        });
      }
    }
  };

  const handleStartSupervision = async (role) => {
    // Get the call control ID for supervision
    // Prefer agent's call leg ID when call is answered (for whispering/monitoring agent leg)
    // Fallback to original call leg ID for queued calls
    // Use supervisionCallControlId if provided (already computed by API with correct preference)
    const callControlId =
      call?.supervisionCallControlId || // Pre-computed by API (prefers agent leg when available)
      call?.agentCallControlId || // Agent's call leg (WebRTC leg) - preferred when call is answered
      call?.originalCallControlId || // Original inbound call leg - fallback for queued calls
      call?.callControlId ||
      call?.id ||
      call?.call_control_id;

    if (!callControlId) {
      notify({
        title: "Error",
        description: "Call information is missing",
        variant: "error",
      });
      return;
    }

    console.log("[SupervisionModal] Starting supervision with:", {
      role,
      callControlId,
      supervisionCallControlId: call?.supervisionCallControlId,
      agentCallControlId: call?.agentCallControlId,
      originalCallControlId: call?.originalCallControlId,
      interactionCallControlId: call?.callControlId,
      callId: call?.id,
      isCallAnswered: isCallAnswered,
    });

    // Note: telephony_user_name validation is handled by the backend
    // The backend has access to the full user object from the database
    setLoading(true);
    try {
      const res = await fetch("/api/contact-center/calls/supervise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supervise_call_control_id: callControlId,
          supervisor_role: role,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error("[SupervisionModal] API request failed:", {
          status: res.status,
          statusText: res.statusText,
          errorText,
        });
        throw new Error(`API request failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      console.log("[SupervisionModal] API response:", {
        ok: data.ok,
        supervisorCallControlId: data.supervisorCallControlId,
        error: data.error,
        fullData: data,
        hasSupervisorCallControlId: !!data.supervisorCallControlId,
      });

      if (data.ok && data.supervisorCallControlId) {
        // Set state immediately and save to localStorage
        const callId = call?.id || call?.interactionId || call?.callControlId;
        if (callId) {
          try {
            localStorage.setItem(`supervisor_role_${callId}`, role);
            console.log("[SupervisionModal] Saved to localStorage:", role);
          } catch (err) {
            console.error("[SupervisionModal] localStorage error:", err);
          }
        }

        // Set state and update refs immediately
        console.log("[SupervisionModal] BEFORE setState - current state:", {
          role,
          supervisorCallControlId: data.supervisorCallControlId,
          callId,
          activeRoleRef: activeRoleRef.current,
          supervisorCallControlIdRef: supervisorCallControlIdRef.current,
          stateActiveRole: activeRole,
          stateSupervisorCallControlId: supervisorCallControlId,
        });

        // Mark as user-initiated to prevent checkSupervisorCall from resetting
        userInitiatedSupervisionRef.current = true;
        supervisorCallObservedRef.current = false;

        // Update refs FIRST (immediate, synchronous)
        activeRoleRef.current = role;
        supervisorCallControlIdRef.current = data.supervisorCallControlId;

        // Then update state (async, triggers re-render)
        setActiveRole(role);
        setSupervisorCallControlId(data.supervisorCallControlId);
        // Store the supervised call control ID (the call leg being supervised - agent leg when available)
        // This is what we'll use for switch_supervisor_role
        setSupervisedCallControlId(callControlId);

        console.log("[SupervisionModal] AFTER setState - refs updated:", {
          role,
          supervisorCallControlId: data.supervisorCallControlId,
          callId,
          activeRoleRef: activeRoleRef.current,
          supervisorCallControlIdRef: supervisorCallControlIdRef.current,
          userInitiated: userInitiatedSupervisionRef.current,
        });

        notify({
          title: "Supervision Started",
          description: `Supervising call in ${role} mode`,
          variant: "success",
        });
      } else {
        const errorMsg =
          data.error ||
          "Failed to start supervision - missing supervisorCallControlId";
        console.error("[SupervisionModal] API error:", errorMsg, data);
        throw new Error(errorMsg);
      }
    } catch (err) {
      console.error("[SupervisionModal] Error starting supervision:", err);
      notify({
        title: "Error",
        description: err.message || "Failed to start supervision",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchRole = async (newRole) => {
    // Use ref to get current value (avoid stale closure)
    const currentActiveRole = activeRoleRef.current;
    const currentSupervisorCallControlId = supervisorCallControlIdRef.current;

    if (currentActiveRole === newRole) {
      console.log(
        "[SupervisionModal] Already in role",
        newRole,
        "skipping switch",
      );
      return; // Already in this role
    }

    console.log("[SupervisionModal] handleSwitchRole called:", {
      newRole,
      currentActiveRole,
      currentSupervisorCallControlId,
      hasActiveCall: !!activeCall,
      isCallConnected,
      callStatus,
    });

    // Check if supervisor call is answered - switch_supervisor_role requires the call to be answered
    if (!isCallConnected) {
      notify({
        title: "Call Not Answered",
        description:
          "Please answer the supervisor call before switching roles.",
        variant: "warning",
      });
      return;
    }

    // The role belongs to the supervisor leg created by /calls, not the
    // agent leg supplied as supervise_call_control_id during origination.
    const callControlIdToUse = currentSupervisorCallControlId;
    if (!callControlIdToUse) {
      notify({ title: "Supervision unavailable", description: "The supervisor call is no longer available. Start supervision again.", variant: "warning" });
      return;
    }

    console.log("[SupervisionModal] Switching supervisor role:", {
      supervisedCallControlId, // Agent leg remains the monitoring target.
      supervisorCallControlId: callControlIdToUse, // Role changes address this leg.
      currentRole: activeRole,
      newRole,
      agentCallControlId: call?.agentCallControlId,
      originalCallControlId: call?.originalCallControlId,
    });

    setLoading(true);
    try {
      const res = await fetch(
        `/api/contact-center/calls/${callControlIdToUse}/switch-supervisor-role`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: newRole, // Telnyx API expects 'role', not 'supervisor_role'
          }),
        },
      );

      const data = await res.json();
      if (data.ok) {
        // Set state immediately and save to localStorage
        const callId = call?.id || call?.interactionId || call?.callControlId;
        if (callId) {
          try {
            localStorage.setItem(`supervisor_role_${callId}`, newRole);
          } catch {
            // Ignore localStorage errors
          }
        }
        setActiveRole(newRole);
        // Update ref immediately so it's available for next click
        activeRoleRef.current = newRole;
        console.log("[SupervisionModal] Role switched:", {
          newRole,
          callControlIdToUse,
        });
        notify({
          title: "Role Switched",
          description: `Switched to ${newRole} mode`,
          variant: "success",
        });
      } else {
        throw new Error(data.error || "Failed to switch role");
      }
    } catch (err) {
      console.error("[SupervisionModal] Error switching role:", err);
      notify({
        title: "Error",
        description: err.message || "Failed to switch role",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  // Monitor call state changes - the store handles this automatically
  // We just need to reset supervision state when call ends
  useEffect(() => {
    if (!supervisorCallControlId || !open) return;

    const store = useActiveCallStore.getState();
    const storeStatus = String(callStatus || "").toLowerCase();
    const sdkStatus = String(activeCall?.state || activeCall?.status || "").toLowerCase();
    const terminalStates = [
      "done",
      "hangup",
      "ended",
      "destroy",
      "purge",
      "terminated",
      "failed",
    ];
    const liveStates = [
      "new",
      "ringing",
      "early",
      "active",
      "connected",
      "answered",
      "held",
    ];
    const activeCallIsSupervisor = Boolean(
      activeCall &&
        (store.fromName === "Supervisor Call" ||
          (supervisorNumber && store.fromNumber === supervisorNumber)),
    );

    if (
      activeCallIsSupervisor &&
      (liveStates.includes(storeStatus) || liveStates.includes(sdkStatus))
    ) {
      supervisorCallObservedRef.current = true;
    }

    const isCallEnded =
      terminalStates.includes(storeStatus) ||
      (activeCallIsSupervisor && terminalStates.includes(sdkStatus)) ||
      (supervisorCallObservedRef.current && !activeCall && storeStatus === "idle");

    if (isCallEnded) {
      console.log("[SupervisionModal] Call ended, clearing state:", {
        callStatus,
        sdkStatus,
        supervisorCallControlId,
        activeRole,
        hasActiveCall: !!activeCall,
      });
      setSupervisorCallControlId(null);
      setSupervisedCallControlId(null);
      setActiveRole(null);
      // Clear refs too
      activeRoleRef.current = null;
      supervisorCallControlIdRef.current = null;
      // Clear user-initiated flag
      userInitiatedSupervisionRef.current = false;
      autoAnswerAttemptedRef.current = false;
      supervisorCallObservedRef.current = false;
      const callId = call?.id || call?.interactionId || call?.callControlId;
      if (callId) {
        try {
          localStorage.removeItem(`supervisor_role_${callId}`);
        } catch {
          // Ignore localStorage errors
        }
      }
      onOpenChange(false);
    }
  }, [
    callStatus,
    supervisorCallControlId,
    open,
    activeRole,
    activeCall,
    supervisorNumber,
    call,
    onOpenChange,
  ]);

  // Debug logging for button state - helps diagnose why buttons aren't activating
  useEffect(() => {
    if (supervisorCallControlId && open) {
      console.log("[SupervisionModal] Button state debug:", {
        supervisorCallControlId,
        isSupervisorCallActive,
        isRinging,
        hasActiveCall: !!activeCall,
        callStatus,
        activeCallState: activeCall?.state,
        callUIisRinging: callUI.isRinging,
        isCallConnected,
      });
    }
  }, [
    supervisorCallControlId,
    isSupervisorCallActive,
    isRinging,
    activeCall,
    callStatus,
    callUI,
    isCallConnected,
    open,
  ]);

  const handleDisconnectCall = () => {
    // EXACT same logic as mini phone - use activeCall from store
    if (!activeCall) {
      clearActiveCall();
      setSupervisorCallControlId(null);
      setActiveRole(null);
      // Clear localStorage
      if (call) {
        const callId = call?.id || call?.interactionId || call?.callControlId;
        if (callId) {
          try {
            localStorage.removeItem(`supervisor_role_${callId}`);
          } catch {
            // Ignore localStorage errors
          }
        }
      }
      return;
    }
    try {
      activeCall.hangup?.();
      clearActiveCall();
      setSupervisorCallControlId(null);
      setActiveRole(null);
      // Clear localStorage
      if (call) {
        const callId = call?.id || call?.interactionId || call?.callControlId;
        if (callId) {
          try {
            localStorage.removeItem(`supervisor_role_${callId}`);
          } catch {
            // Ignore localStorage errors
          }
        }
      }
    } catch (err) {
      console.error("[SupervisionModal] Error disconnecting call:", err);
      clearActiveCall();
      setSupervisorCallControlId(null);
      setActiveRole(null);
      // Clear localStorage
      if (call) {
        const callId = call?.id || call?.interactionId || call?.callControlId;
        if (callId) {
          try {
            localStorage.removeItem(`supervisor_role_${callId}`);
          } catch {
            // Ignore localStorage errors
          }
        }
      }
    }
  };

  // EXACT same logic as mini phone - use activeCall from store
  const handleAnswerCall = () => {
    if (!activeCall) {
      console.error("[SupervisionModal] No call to answer");
      return;
    }
    try {
      Promise.resolve(activeCall.answer?.())
        .then(() => {
          // Update status (same as mini phone)
          updateStatus("answered");

          // Force audio attachment with multiple retries (same as mini phone)
          const retryDelays = [0, 100, 300, 500, 1000];
          retryDelays.forEach((delay) => {
            setTimeout(() => {
              const currentCall = activeCall || supervisorWebRTCCall;
              hydrateSupervisorAudio(currentCall);
            }, delay);
          });
        })
        .catch((err) => {
          console.error("[SupervisionModal] Error answering call:", err);
        });
    } catch (err) {
      console.error("[SupervisionModal] Error answering call:", err);
    }
  };

  const handleRejectCall = () => {
    // EXACT same logic as mini phone - use activeCall from store
    if (!activeCall) {
      console.error("[SupervisionModal] No call to reject");
      return;
    }
    try {
      activeCall.reject?.();
      clearActiveCall();
      setSupervisorCallControlId(null);
      setActiveRole(null);
      // Clear localStorage
      if (call) {
        const callId = call?.id || call?.interactionId || call?.callControlId;
        if (callId) {
          try {
            localStorage.removeItem(`supervisor_role_${callId}`);
          } catch {
            // Ignore localStorage errors
          }
        }
      }
    } catch (err) {
      console.error("[SupervisionModal] Error rejecting call:", err);
    }
  };

  const handleToggleMute = () => {
    // EXACT same logic as mini phone - use activeCall from store
    if (!activeCall) return;
    try {
      if (callUI.isMuted) {
        activeCall.unmuteAudio?.() || activeCall.unmute?.();
        storeSetMuted(false);
      } else {
        activeCall.muteAudio?.() || activeCall.mute?.();
        storeSetMuted(true);
      }
    } catch (err) {
      console.error("[SupervisionModal] Toggle mute error:", err);
    }
  };

  const handleToggleHold = () => {
    // EXACT same logic as mini phone - use activeCall from store
    if (!activeCall) return;
    try {
      const { setHeld, updateStatus } = useActiveCallStore.getState();
      if (callUI.isHeld) {
        activeCall.unhold?.() || activeCall.resume?.();
        updateStatus("active");
      } else {
        activeCall.hold?.() || activeCall.pause?.();
        updateStatus("held");
      }
    } catch (err) {
      console.error("[SupervisionModal] Toggle hold error:", err);
    }
  };

  const renderAudioFlow = (role) => {
    const flow = role ? SUPERVISOR_ROLES[role].audioFlow : null;
    const supervisorLabel =
      [
        user?.first_name || user?.firstName,
        user?.last_name || user?.lastName,
      ]
        .filter(Boolean)
        .join(" ") ||
      user?.name ||
      user?.username ||
      "You";
    const supervisorDetail =
      supervisorNumber || user?.username || "Supervisor WebRTC";
    const {label: callerLabel, detail: callerDetail} = supervisionCustomerIdentity(call);
    const agentIdentity =
      call?.agentUsername ||
      call?.metadata?.agent_username ||
      call?.metadata?.assigned_agent ||
      null;
    const agentLabel =
      call?.agentName || call?.metadata?.agent_name || agentIdentity || "Agent";
    const agentDetail =
      call?.agentNumber ||
      call?.agentPhone ||
      call?.agentAddress ||
      (agentIdentity && agentIdentity !== agentLabel ? agentIdentity : null) ||
      (isCallInQueue ? "Waiting for assignment" : "Connected via WebRTC");
    const SupervisorIcon = role ? SUPERVISOR_ROLES[role].icon : IconEye;

    const getLineStyle = (fromParty, toParty) => {
      if (!flow) return null;
      const fromFlow = flow[fromParty];
      const toFlow = flow[toParty];
      const canHearEachOther =
        fromFlow.canHear.includes(toParty) &&
        toFlow.canHear.includes(fromParty);
      const canSpeakToEachOther =
        fromFlow.canSpeak.includes(toParty) &&
        toFlow.canSpeak.includes(fromParty);

      if (canHearEachOther && canSpeakToEachOther) {
        return { stroke: "#10b981", strokeWidth: 4 };
      }
      if (
        canHearEachOther ||
        fromFlow.canHear.includes(toParty) ||
        toFlow.canHear.includes(fromParty)
      ) {
        return {
          stroke: "#f97316",
          strokeWidth: 4,
          strokeDasharray: "8 5",
        };
      }
      return null;
    };

    const connector = (testId, fromParty, toParty, path) => {
      const style = getLineStyle(fromParty, toParty);
      if (!style) return null;
      return (
        <path
          data-testid={testId}
          d={path}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          {...style}
        />
      );
    };

    return (
      <div
        data-testid="supervision-topology"
        className="relative h-[300px] overflow-hidden rounded-xl border bg-muted/20"
      >
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          viewBox="0 0 600 300"
        >
          {connector(
            "supervision-connector-caller",
            "supervisor",
            "caller",
            "M 284 92 V 140 H 150 V 208",
          )}
          {!isCallInQueue &&
            connector(
              "supervision-connector-agent",
              "supervisor",
              "agent",
              "M 316 92 V 140 H 450 V 208",
            )}
          {!isCallInQueue &&
            connector(
              "supervision-connector-parties",
              "caller",
              "agent",
              "M 284 246 H 316",
            )}
        </svg>

        <div className="absolute left-1/2 top-4 w-[calc(50%_-_0.375rem)] min-w-[220px] -translate-x-1/2">
          <SupervisionParticipantCard
            testId="supervision-party-supervisor"
            role="Supervisor"
            label={supervisorLabel}
            detail={supervisorDetail}
            status={role || "ready"}
            tone="violet"
            icon={SupervisorIcon}
          />
        </div>

        <div className="absolute inset-x-4 bottom-4 grid grid-cols-2 gap-8">
          <SupervisionParticipantCard
            testId="supervision-party-caller"
            role="Customer"
            label={callerLabel}
            detail={callerDetail}
            status={isCallInQueue ? "queued" : "live"}
            tone="blue"
            icon={IconPhone}
          />
          <SupervisionParticipantCard
            testId="supervision-party-agent"
            role="Agent"
            label={agentLabel}
            detail={agentDetail}
            status={isCallInQueue ? "waiting" : "connected"}
            tone="green"
            icon={IconHeadphones}
            dashed={isCallInQueue}
          />
        </div>
      </div>
    );
  };

  if (!call) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(newOpen) => {
        // Prevent closing modal when supervision is active
        if (!newOpen && supervisorCallControlId) {
          // If supervision is active, don't allow closing
          return;
        }
        onOpenChange(newOpen);
      }}
    >
      <audio data-testid="supervisor-remote-audio" ref={supervisorRemoteAudioRef} autoPlay playsInline className="hidden" />
      <DialogContent
        data-testid="supervision-dialog" data-active-role={activeRole || ""} data-supervisor-call-id={supervisorCallControlId || ""}
        className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto"
        onInteractOutside={(e) => {
          // Prevent closing when clicking outside if supervision is active
          if (supervisorCallControlId) {
            e.preventDefault();
          }
        }}
        onEscapeKeyDown={(e) => {
          // Prevent closing when pressing escape if supervision is active
          if (supervisorCallControlId) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Supervise Call</DialogTitle>
          <DialogDescription>
            {isCallInQueue
              ? "Monitor this call while it's waiting in the queue."
              : "Monitor, whisper, or barge into this call. Select a mode to start supervision."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Mode Selection Cards */}
          <div className="grid gap-4 grid-cols-3">
            {Object.entries(SUPERVISOR_ROLES).filter(([role]) => can(SUPERVISION_PERMISSION[role] || "calls:supervise.listen")).map(([role, config]) => {
              const Icon = config.icon;
              // Tile is truly active only if activeRole matches (supervision is actually started)
              const isActive = activeRole === role;
              // For unanswered calls, only monitor is available (whisper and barge are disabled)
              const isDisabled = isCallInQueue && role !== "monitor";
              // Only show as active if supervision has actually started (has activeRole and supervisorCallControlId)
              // Don't show as active just because call is in queue - user needs to click to start
              const showAsActive = isActive && supervisorCallControlId;
              const accentClasses = {
                blue: {
                  icon: "text-blue-500",
                  selected: "border-blue-500 ring-blue-500/40",
                },
                purple: {
                  icon: "text-purple-500",
                  selected: "border-purple-500 ring-purple-500/40",
                },
                green: {
                  icon: "text-green-500",
                  selected: "border-green-500 ring-green-500/40",
                },
              }[config.color];

              return (
                <Card
                  data-testid={`supervision-role-${role}`} data-active={showAsActive ? "true" : "false"}
                  key={role}
                  className={cn(
                    "relative border-2 bg-background text-foreground transition-all",
                    showAsActive
                      ? cn("ring-1", accentClasses.selected)
                      : "border-border hover:bg-muted/60",
                    loading && "opacity-50 cursor-not-allowed",
                    isDisabled
                      ? "cursor-not-allowed opacity-50 hover:bg-background"
                      : "cursor-pointer",
                  )}
                  onClick={async () => {
                    if (loading || isDisabled) return;
                    // Only prevent clicking if truly active (supervision already started)
                    if (isActive) {
                      // Already active, do nothing
                      return;
                    }

                    // Use refs to get current state immediately (avoid stale closure)
                    const currentActiveRole = activeRoleRef.current;
                    const currentSupervisorCallControlId =
                      supervisorCallControlIdRef.current;

                    console.log("[SupervisionModal] Tile clicked:", {
                      role,
                      currentActiveRole,
                      currentSupervisorCallControlId,
                      isActive,
                      stateActiveRole: activeRole,
                      stateSupervisorCallControlId: supervisorCallControlId,
                      isCallConnected,
                    });

                    // If we have an active role OR supervisorCallControlId, switch role
                    // Otherwise, start new supervision
                    if (currentActiveRole || currentSupervisorCallControlId) {
                      console.log(
                        "[SupervisionModal] Switching role from",
                        currentActiveRole,
                        "to",
                        role,
                      );
                      await handleSwitchRole(role);
                    } else {
                      console.log(
                        "[SupervisionModal] Starting new supervision with role",
                        role,
                      );
                      await handleStartSupervision(role);
                    }
                  }}
                >
                  <CardContent className="p-4 flex flex-col items-center gap-3">
                    <div className="relative">
                      <Icon className={cn("h-8 w-8", accentClasses.icon)} />
                      {/* Status indicator in top right corner */}
                      <div className="absolute -top-1 -right-1">
                        {showAsActive ? (
                          <div className="rounded-full bg-background p-0.5">
                            <IconCheck className="h-4 w-4 text-green-600" />
                          </div>
                        ) : isDisabled ? (
                          <div className="rounded-full bg-background p-0.5">
                            <IconX className="h-4 w-4 text-red-600" />
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="font-semibold text-sm">
                        {config.label}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {config.description}
                      </div>
                    </div>
                    {isActive && (
                      <Badge variant="outline" className="text-xs">
                        Active
                      </Badge>
                    )}
                    {loading && !showAsActive && (
                      <IconLoader className="h-4 w-4 animate-spin" />
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Audio Flow Visualization - Always visible, never dimmed */}
          <div className="space-y-3 pt-4 border-t">
            <div className="font-semibold text-sm">
              {activeRole ? `Current Audio Flow (${activeRole})` : "Audio Flow"}
            </div>
            {renderAudioFlow(activeRole)}
          </div>

          {/* Call Control Buttons - Mini Phone Interface - Always visible */}
          <div className="pt-4 border-t">
            {/* Mini Phone Interface - EXACT same logic as mini phone */}
            <div className="flex items-center justify-center gap-3 p-4 bg-muted/30 rounded-lg">
              {/* Check isRinging from store OR check call state directly for immediate activation */}
              {isRinging ||
              (activeCall &&
                (activeCall.state === "ringing" ||
                  activeCall.state === "early" ||
                  activeCall.state === "new")) ? (
                <>
                  {/* Answer and Reject buttons when ringing - EXACT same logic as mini phone */}
                  <button
                    onClick={handleRejectCall}
                    disabled={loading}
                    className="h-12 w-12 rounded-full grid place-items-center bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Reject"
                  >
                    <IconPhoneOff className="h-5 w-5" />
                  </button>
                  <button
                    onClick={handleAnswerCall}
                    disabled={loading}
                    className="h-12 w-12 rounded-full grid place-items-center bg-green-600 hover:bg-green-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Answer"
                  >
                    <IconPhone className="h-5 w-5" />
                  </button>
                </>
              ) : activeCall && !isCallConnected ? (
                <>
                  {/* Show only disconnect button for outbound calls in progress (dialing/ringing) - EXACT same logic as mini phone */}
                  <button
                    onClick={handleDisconnectCall}
                    disabled={loading}
                    className="h-12 w-12 rounded-full grid place-items-center bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Disconnect"
                  >
                    <IconPhoneOff className="h-5 w-5" />
                  </button>
                </>
              ) : isCallConnected ? (
                <>
                  {/* Mute, Disconnect, and Hold buttons when answered - EXACT same order as mini phone */}
                  <button
                    onClick={handleToggleMute}
                    disabled={loading}
                    className={cn(
                      "h-12 w-12 rounded-full grid place-items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                      callUI.isMuted
                        ? "bg-zinc-700 hover:bg-zinc-800 text-white"
                        : "bg-zinc-600 hover:bg-zinc-700 text-white",
                    )}
                    title={callUI.isMuted ? "Unmute" : "Mute"}
                  >
                    {callUI.isMuted ? (
                      <IconMicrophoneOff className="h-5 w-5" />
                    ) : (
                      <IconMicrophone className="h-5 w-5" />
                    )}
                  </button>
                  <button
                    onClick={handleDisconnectCall}
                    disabled={loading}
                    className="h-12 w-12 rounded-full grid place-items-center bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Disconnect"
                  >
                    <IconPhoneOff className="h-5 w-5" />
                  </button>
                  <button
                    onClick={handleToggleHold}
                    disabled={loading}
                    className="h-12 w-12 rounded-full grid place-items-center bg-zinc-600 hover:bg-zinc-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={callUI.isHeld ? "Unhold" : "Hold"}
                  >
                    {callUI.isHeld ? (
                      <IconPlay className="h-5 w-5" />
                    ) : (
                      <IconPause className="h-5 w-5" />
                    )}
                  </button>
                </>
              ) : (
                <>
                  {/* Disabled answer/reject buttons when no call yet - show what will be available */}
                  <button
                    disabled
                    className="h-12 w-12 rounded-full grid place-items-center bg-red-600/50 text-white opacity-50 cursor-not-allowed"
                    title="Reject (disabled - no call)"
                  >
                    <IconPhoneOff className="h-5 w-5" />
                  </button>
                  <button
                    disabled
                    className="h-12 w-12 rounded-full grid place-items-center bg-green-600/50 text-white opacity-50 cursor-not-allowed"
                    title="Answer (disabled - no call)"
                  >
                    <IconPhone className="h-5 w-5" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { InteractionsList } from "./InteractionsList";
import { InteractionDetail } from "./InteractionDetail";
import ChatInteractionDetail from "./ChatInteractionDetail";
import { createChatComposerStore } from "./chat-composer-store";
import EmailInteractionDetail from "./EmailInteractionDetail";
import VideoInteractionDetail from "./VideoInteractionDetail";
import { useChatInteractions } from "./useChatInteractions";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { Info, PhoneCall } from "lucide-react";
import { notify } from "@/components/ToastNotify";
import {
  IconAddressBook,
  IconBook,
  IconChecklist,
  IconDeviceDesktop,
  IconFileText,
  IconGauge,
  IconWorld,
} from "@tabler/icons-react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import {
  forgetDisconnectedInteraction,
  isRecentlyDisconnectedInteraction,
  rememberDisconnectedInteraction,
} from "@/lib/contact-center/disconnected-interaction-suppression";
import useCallsStore from "@/lib/stores/calls-store";
import { subscribeStatusStream } from "@/lib/status-stream-client";
import CampaignDispositionSheet from "./CampaignDispositionSheet";
import { AgentDashboard } from "./AgentDashboard";
import { AgentDataSources } from "./AgentDataSources";
import { isOwnedQueueTransferContinuation } from "@/lib/contact-center/queue-transfer-continuation";
import { channelDefinition, usesNativeLifecycle } from "@/lib/acd/channel-registry.mjs";

const AGENT_RAIL_ITEMS = [
  { id: "desktop", label: "Desktop", icon: IconDeviceDesktop, description: "Live interaction workspace" },
  { id: "dashboard", label: "Dashboard", icon: IconGauge, description: "Performance overview" },
  { id: "forms", label: "Forms", icon: IconFileText, description: "Queue forms" },
  { id: "web-pages", label: "Web Pages", icon: IconWorld, description: "External portals" },
  { id: "contacts", label: "Contacts", icon: IconAddressBook, description: "Search contacts" },
  { id: "tasks", label: "Tasks", icon: IconChecklist, description: "Manage tasks" },
  { id: "kb-articles", label: "KB Articles", icon: IconBook, description: "Knowledge base" },
];

const DATA_SOURCE_VIEW_LABELS = {
  contacts: "Contacts",
  tasks: "Tasks",
  forms: "Forms",
  "web-pages": "Web Pages",
  "kb-articles": "KB Articles",
};

const END_STATUSES = new Set(["ended", "hangup", "completed", "terminated", "destroy", "failed", "idle"]);

async function updateAgentStatus(nextStatus) {
  try {
    const res = await fetch("/api/contact-center/agent/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to update agent status");
    }
  } catch (_) {}
}

function OutboundCampaignRecord({ assignment, countdownSeconds, dialing, onDial }) {
  if (!assignment) return null;
  const record = assignment.contact_record || {};
  const previewFields = Object.entries(record).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "").slice(0, 12);
  const isProgressive = assignment.campaign_mode === "progressive";
  return (
    <details data-testid="campaign-record" data-attempt-id={assignment.id} className="group rounded-xl border border-border bg-card text-card-foreground shadow-sm dark:border-zinc-800 dark:bg-black dark:text-zinc-100" open={false}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-4 py-3 transition hover:bg-muted/60 dark:hover:bg-zinc-900 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground dark:text-zinc-400">Outbound Campaign Record</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="truncate text-base font-semibold text-foreground dark:text-zinc-50">{assignment.campaign_name || "Campaign"}</h3>
            <span className="font-mono text-sm text-muted-foreground dark:text-zinc-300">{assignment.to_number || "No phone number"}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold uppercase text-muted-foreground dark:border-zinc-700 dark:text-zinc-400">{assignment.campaign_mode}</span>
            {isProgressive ? <span className="font-mono text-sm font-semibold text-foreground dark:text-zinc-200">Auto dial in {Math.max(0, countdownSeconds ?? 0)}s</span> : null}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="campaign-dial"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDial?.();
          }}
          disabled={dialing || !assignment.to_number}
        >
          {dialing ? "Starting outbound call..." : "Start outbound call"}
        </button>
      </summary>
      <div className="border-t border-border px-4 pb-4 pt-3 dark:border-zinc-800">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {previewFields.map(([key, value]) => (
            <div key={key} className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950/70">
              <div className="text-[11px] uppercase text-muted-foreground dark:text-zinc-500">{key.replace(/_/g, " ")}</div>
              <div className="font-medium text-foreground dark:text-zinc-100">{String(value)}</div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function AgentDesktop() {
  const [chatComposerStore]=useState(createChatComposerStore);
  const [selectedInteraction, setSelectedInteraction] = useState(null);
  const [voiceInteractions, setInteractions] = useState([]);
  const chat = useChatInteractions();
  useEffect(()=>{
    chatComposerStore.retain(chat.interactions.filter(item=>channelDefinition(item.channel).viewer==="messages").map(item=>item.id));
  },[chat.interactions,chatComposerStore]);
  const interactions = useMemo(() => [...voiceInteractions, ...chat.interactions], [voiceInteractions, chat.interactions]);
  const [dbInteractions, setDbInteractions] = useState([]);
  const [currentUsername, setCurrentUsername] = useState(null);
  const [agentStatus, setAgentStatus] = useState(null); // Track agent's current status
  const [agentForms, setAgentForms] = useState([]);
  const [selectedAgentFormId, setSelectedAgentFormId] = useState("");
  const [campaignAssignment, setCampaignAssignment] = useState(null);
  const [campaignDispositionAssignment, setCampaignDispositionAssignment] = useState(null);
  const [campaignCountdownSeconds, setCampaignCountdownSeconds] = useState(null);
  const [campaignDialing, setCampaignDialing] = useState(false);
  const campaignDialedAttemptRef = useRef(null);
  const pendingCampaignDispositionRef = useRef(null);
  const campaignCallStartedRef = useRef(false);
  const lastRefreshAttemptRef = useRef(new Map()); // Track refresh attempts to avoid infinite loops
  const lastStatusRef = useRef(null);
  const lastDisconnectedTimeRef = useRef(null);
  const disconnectedInteractionKeysRef = useRef(new Map());
  const queueTransferContinuationsRef = useRef(new Map());
  const latestDbInteractionsRef = useRef([]);
  useEffect(() => { latestDbInteractionsRef.current = dbInteractions; }, [dbInteractions]);

  const isQueueTransferContinuation = useCallback((interaction = {}) => {
    const interactionId =
      interaction.id || interaction.interactionId || interaction.interaction_id;
    if (!interactionId) return false;
    const key = String(interactionId);
    const marker = queueTransferContinuationsRef.current.get(key);
    if (!marker || marker.expiresAt <= Date.now()) {
      queueTransferContinuationsRef.current.delete(key);
      return false;
    }
    const owned = isOwnedQueueTransferContinuation(interaction, currentUsername, marker);
    if (owned) forgetDisconnectedInteraction(disconnectedInteractionKeysRef.current, interaction);
    return owned;
  }, [currentUsername]);

  // Get WebRTC call state for real-time updates (hold, mute, status)
  // Use selectors to ensure re-renders when these specific values change
  const callStatus = useActiveCallStore((state) => state.status);
  const callInteractionId = useActiveCallStore(
    (state) => state?.contactCenter?.interactionId || null,
  );
  const disconnectedTime = useActiveCallStore(
    (state) => state.disconnectedTime,
  );

  // Get calls from calls store - subscribe to changes
  // Subscribe to calls object to avoid infinite loop (getActiveCalls returns new array each time)
  const calls = useCallsStore((state) => state.calls);
  const callsStore = useCallsStore();

  // Compute active calls from calls object with memoization
  const activeCalls = useMemo(() => {
    const allCalls = Object.values(calls);
    return allCalls.filter(
      (call) =>
        call.status !== "completed" &&
        call.status !== "abandoned" &&
        call.status !== "ended" &&
        call.status !== "hangup" &&
        call.status !== "idle" &&
        call.status !== "terminated" &&
        !call.disconnectedTime &&
        (call.interactionId || call.originalCallControlId || call.queueName),
    );
  }, [calls]);

  const buildInteractionsWithStore = useCallback(
    (dbInteractions = [], currentAgentStatus = null) => {
      const storeCallMap = new Map();
      activeCalls.forEach((call) => {
        if (call.interactionId) {
          storeCallMap.set(call.interactionId, call);
        }
        if (call.callControlId) {
          storeCallMap.set(call.callControlId, call);
        }
        if (call.originalCallControlId) {
          storeCallMap.set(call.originalCallControlId, call);
        }
        if (call.callSessionId) {
          storeCallMap.set(call.callSessionId, call);
        }
        if (call.originalCallSessionId) {
          storeCallMap.set(call.originalCallSessionId, call);
        }
        (call.callControlIds || []).forEach((id) => {
          if (id) storeCallMap.set(id, call);
        });
      });

      // Filter out timeout re-enqueued interactions from database interactions
      const filteredDbInteractions = dbInteractions.filter((interaction) => {
        if (
          !isQueueTransferContinuation(interaction) &&
          isRecentlyDisconnectedInteraction(
            disconnectedInteractionKeysRef.current,
            interaction,
          )
        ) {
          return false;
        }
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
        const isReEnqueued =
          interaction.state === "queued" &&
          !interaction.agent_username &&
          !interaction.agentUsername;

        // CRITICAL: If agent status is "Agent Not Answering", filter out any ringing interactions
        // This handles the case where the database hasn't updated yet but the agent status has changed
        if (
          currentAgentStatus === "Agent Not Answering" &&
          interaction.state === "ringing"
        ) {
          console.log(
            `[AgentDesktop] Filtering out ringing interaction ${interaction.id} in buildInteractionsWithStore - agent status is "Agent Not Answering"`,
          );
          return false;
        }

        return !wasTimeoutReEnqueued && !isReEnqueued;
      });

      const enhancedInteractions = filteredDbInteractions.map((interaction) => {
        const metadata = interaction.metadata || {};
        const storeCall =
          storeCallMap.get(interaction.id) ||
          storeCallMap.get(interaction.call_control_id) ||
          storeCallMap.get(interaction.call_session_id) ||
          storeCallMap.get(metadata.original_call_control_id) ||
          storeCallMap.get(metadata.agent_call_control_id);
        if (storeCall) {
          return {
            ...interaction,
            call_control_id:
              interaction.call_control_id || storeCall.callControlId || null,
            call_session_id:
              interaction.call_session_id ||
              storeCall.callSessionId ||
              storeCall.originalCallSessionId ||
              null,
            metadata: {
              ...(interaction.metadata || {}),
              ...(storeCall.metadata || {}),
              ...(storeCall.aiCallControlId
                ? { ai_call_control_id: storeCall.aiCallControlId }
                : {}),
            },
            ai_call_control_id:
              interaction.ai_call_control_id ||
              storeCall.aiCallControlId ||
              null,
            from_name:
              interaction.from_name ||
              storeCall.callerName ||
              storeCall.fromName,
            // Always prioritize database value for from_number - it's the source of truth
            from_number:
              interaction.from_number ||
              interaction.from ||
              (storeCall.callerNumber && storeCall.callerNumber.trim() !== ""
                ? storeCall.callerNumber
                : storeCall.fromNumber && storeCall.fromNumber.trim() !== ""
                  ? storeCall.fromNumber
                  : null),
            queue_name: storeCall.queueName || interaction.queue_name,
            state: storeCall.status || interaction.state,
          };
        }
        return interaction;
      });

      const storeOnlyInteractions = activeCalls
        .filter((call) => {
          if (
            !isQueueTransferContinuation(call) &&
            isRecentlyDisconnectedInteraction(
              disconnectedInteractionKeysRef.current,
              call,
            )
          ) {
            return false;
          }
          const matchKeys = new Set([
            call.interactionId,
            call.callControlId,
            call.originalCallControlId,
            call.callSessionId,
            call.originalCallSessionId,
            ...(call.callControlIds || []),
          ]);
          matchKeys.delete(undefined);
          matchKeys.delete(null);
          matchKeys.delete("");

          const hasDbMatch = filteredDbInteractions.some((interaction) => {
            const metadata = interaction.metadata || {};
            const interactionKeys = new Set([
              interaction.id,
              interaction.call_control_id,
              interaction.call_session_id,
              metadata.original_call_control_id,
              metadata.agent_call_control_id,
            ]);
            for (const key of interactionKeys) {
              if (key && matchKeys.has(key)) return true;
            }
            return false;
          });

          if (hasDbMatch) return false;

          // Store-only calls are allowed only during the short SSE -> DB race or
          // when they are the exact currently active WebRTC interaction. A Busy
          // status belongs to one call and must never resurrect every orphan
          // retained from earlier calls.
          const startedAt = call.callStartTime || call.createdAt || call.startedAt;
          const startedMs = startedAt ? new Date(startedAt).getTime() : 0;
          const isRecentlyCreated = startedMs && Date.now() - startedMs < 5000;
          const isCurrentWebRtcInteraction = Boolean(
            callInteractionId &&
              call.interactionId &&
              String(callInteractionId) === String(call.interactionId),
          );
          if (!isRecentlyCreated && !isCurrentWebRtcInteraction) {
            console.log(
              `[AgentDesktop] Suppressing stale store-only call ${
                call.callControlId || call.interactionId || call.callSessionId
              } because it has no active DB or WebRTC interaction`,
            );
            return false;
          }

          return true;
        })
        .map((call) => ({
          id: call.interactionId || `temp-${call.callControlId}`,
          call_control_id: call.callControlId,
          call_session_id: call.callSessionId,
          direction: call.direction || "inbound",
          state: call.status || "ringing",
          original_call_control_id: call.originalCallControlId || null,
          from_number: call.callerNumber || call.fromNumber || "",
          to_number: call.toNumber || "",
          from_name: call.callerName || call.fromName || null,
          queue_name: call.queueName || "",
          interaction_type: "voice",
          is_contact_center: true,
          created_at: new Date(call.callStartTime || Date.now()).toISOString(),
          assigned_at: call.assignedAt || null,
          queued_at: call.queuedAt || null,
          // Use full metadata from call (includes agent_assist_config from SSE)
          metadata: call.metadata || (call.aiCallControlId
            ? { ai_call_control_id: call.aiCallControlId }
            : {}),
          ai_call_control_id: call.aiCallControlId || null,
        }));

      const merged = [...enhancedInteractions, ...storeOnlyInteractions];
      const seen = new Set();
      return merged.filter((interaction) => {
        const key = interaction.call_control_id || interaction.id;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [activeCalls, callInteractionId, isQueueTransferContinuation],
  );

  // Initialize calls store on mount (ensures it's visible in dev tools)
  useEffect(() => {
    // Access the store to ensure it's initialized
    callsStore.getAllCalls();
  }, [callsStore]);

  const applyInteractions = useCallback(
    (mergedInteractions) => {
      // Filter out timeout re-enqueued interactions - these should not be shown to the agent
      const filteredInteractions = mergedInteractions.filter((interaction) => {
        if (usesNativeLifecycle(interaction.channel) || usesNativeLifecycle(interaction.interaction_type)) return false;
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;

        // Also filter out interactions that are in "queued" state and have no agent_username
        // (they were re-enqueued after timeout)
        const isReEnqueued =
          interaction.state === "queued" &&
          !interaction.agent_username &&
          !interaction.agentUsername;

        if (wasTimeoutReEnqueued || isReEnqueued) {
          console.log(
            `[AgentDesktop] Filtering out timeout re-enqueued interaction ${interaction.id}`,
          );
          return false;
        }

        return true;
      });

      setInteractions(filteredInteractions);

      // Auto-select first active if none selected
      setSelectedInteraction((current) => {
        if (usesNativeLifecycle(current?.channel)) return current;
        if (!current) {
          return filteredInteractions.length > 0
            ? filteredInteractions[0]
            : null;
        }
        // Update selected interaction if it exists in the new list
        // Also deselect if current interaction was timeout re-enqueued
        if (current) {
          const currentMetadata = current.metadata || {};
          const wasCurrentTimeoutReEnqueued =
            currentMetadata.timeout_re_enqueued === true;
          const isCurrentReEnqueued =
            current.state === "queued" &&
            !current.agent_username &&
            !current.agentUsername;

          if (wasCurrentTimeoutReEnqueued || isCurrentReEnqueued) {
            // Deselect if current interaction was timeout re-enqueued
            return filteredInteractions.length > 0
              ? filteredInteractions[0]
              : null;
          }

          const updated = filteredInteractions.find(
            (i) =>
              i.id === current.id ||
              i.call_control_id === current.call_control_id,
          );
          if (updated) {
            return updated;
          }
          if (mergedInteractions.length === 0) {
            return null;
          }
          // If not found in active list (e.g., completed) OR if from_number is missing/empty, try to refresh it from DB
          const needsRefresh =
            !current.from_number || current.from_number.trim() === "";
          const interactionId = current.id;
          const callControlId = current.call_control_id;
          const lastAttempt = lastRefreshAttemptRef.current.get(interactionId);
          const now = Date.now();

          // Only refresh if we haven't tried in the last 5 seconds (avoid infinite loops)
          if (
            needsRefresh &&
            callControlId &&
            (!lastAttempt || now - lastAttempt > 5000)
          ) {
            lastRefreshAttemptRef.current.set(interactionId, now);

            fetch(
              `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                callControlId,
              )}`,
            )
              .then((res) => res.json())
              .then((data) => {
                if (data.ok && data.interaction) {
                  // Only update if we got a better from_number or if it's the same interaction
                  if (
                    data.interaction.id === interactionId ||
                    data.interaction.call_control_id === callControlId
                  ) {
                    setSelectedInteraction(data.interaction);
                  }
                }
              })
              .catch((err) => {
                // Failed to refresh selected interaction
              });
          }
        }
        return null;
      });
    },
    [setInteractions, setSelectedInteraction],
  );

  // Load interactions from database on mount and via SSE-triggered refreshes
  // No polling - SSE handles all real-time updates
  useEffect(() => {
    const loadInteractions = async () => {
      try {
        const res = await fetch(
          "/api/contact-center/agent/interactions?limit=50&activeOnly=true",
          { cache: "no-store" },
        );
        const data = await res.json();
        if (data.ok && Array.isArray(data.interactions)) {
          // Filter out timeout re-enqueued interactions on the client side as well
          const filtered = data.interactions.filter((interaction) => {
            if (usesNativeLifecycle(interaction.channel) || usesNativeLifecycle(interaction.interaction_type)) return false;
            if (
              !isQueueTransferContinuation(interaction) &&
              isRecentlyDisconnectedInteraction(
                disconnectedInteractionKeysRef.current,
                interaction,
              )
            ) {
              return false;
            }
            const metadata = interaction.metadata || {};
            const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
            const isReEnqueued =
              interaction.state === "queued" &&
              !interaction.agent_username &&
              !interaction.agentUsername;

            // CRITICAL: If agent status is "Agent Not Answering", filter out any ringing interactions
            // This handles the case where the database hasn't updated yet but the agent status has changed
            if (
              agentStatus === "Agent Not Answering" &&
              interaction.state === "ringing"
            ) {
              console.log(
                `[AgentDesktop] Filtering out ringing interaction ${interaction.id} - agent status is "Agent Not Answering"`,
              );
              return false;
            }

            return !wasTimeoutReEnqueued && !isReEnqueued;
          });
          setDbInteractions(filtered);
        }
      } catch (err) {
        // Failed to load interactions
        console.error("[AgentDesktop] Failed to load interactions:", err);
      }
    };

    // Initial load on mount
    loadInteractions();

    // Listen to SSE events to trigger immediate refresh when interactions change
    const handleSSEEvent = () => {
      loadInteractions();
    };

    const handleQueueTransferAccepted = (event) => {
      const { interactionId } = event.detail || {};
      if (!interactionId) return;

      // A queue transfer keeps the durable work item and interaction ID. The
      // source WebRTC leg disconnects, but the same interaction can be offered
      // back to this browser immediately from the target queue. Mark it as a
      // continuation so the normal stale-disconnect tombstone cannot hide the
      // new ringing card and Agent Assist view.
      queueTransferContinuationsRef.current.set(
        String(interactionId),
        { expiresAt: Date.now() + 60_000, assignedAt: latestDbInteractionsRef.current.find(item => String(item.id) === String(interactionId))?.assigned_at || null },
      );
      loadInteractions();
    };

    // Listen for custom events from ContactCenterStreamProvider
    window.addEventListener(
      "contact-center:refresh-interactions",
      handleSSEEvent,
    );

    // Also listen for call disconnect events to IMMEDIATELY remove the interaction
    const handleCallDisconnected = (event) => {
      const {
        interactionId,
        callControlId,
        rejectedBeforeAnswer,
        wasAnswered,
      } = event.detail || {};

      // A delayed activeOnly read can still contain the just-ended call. Keep
      // a short client-side tombstone so that stale response cannot reinsert
      // and auto-select it between WebRTC disconnect and the Core wrap-up
      // snapshot. A pre-answer rejection may be immediately re-offered and
      // must not be suppressed this way.
      if (
        !rejectedBeforeAnswer &&
        wasAnswered !== false
      ) {
        rememberDisconnectedInteraction(
          disconnectedInteractionKeysRef.current,
          { interactionId, callControlId },
        );
      }

      // IMMEDIATELY remove the interaction from local state
      // This ensures the UI clears instantly, even before database refresh
      if (interactionId || callControlId) {
        setDbInteractions((current) => {
          const filtered = current.filter((interaction) => {
            const matchesId = interaction.id === interactionId;
            const matchesCallControlId =
              Boolean(callControlId && interaction.call_control_id === callControlId);
            if (matchesId || matchesCallControlId) {
              console.log(
                `[AgentDesktop] Immediately removing disconnected interaction: ${
                  interactionId || callControlId
                }`,
              );
              return false;
            }
            return true;
          });
          return filtered;
        });

        // Also remove from calls store immediately
        if (callControlId) {
          useCallsStore.getState().removeCall(callControlId);
        }
        if (interactionId) {
          useCallsStore.getState().removeCall(interactionId);
        }

        // Clear selected interaction if it's the one that disconnected
        setSelectedInteraction((current) => {
          if (
            current &&
            (current.id === interactionId ||
              Boolean(callControlId && current.call_control_id === callControlId))
          ) {
            return null;
          }
          return current;
        });
      }

      // Then refresh from database after a short delay to ensure consistency
      setTimeout(() => {
        loadInteractions();
      }, 300);
    };

    window.addEventListener(
      "contact-center:call-disconnected",
      handleCallDisconnected,
    );
    window.addEventListener(
      "contact-center:queue-transfer-accepted",
      handleQueueTransferAccepted,
    );

    return () => {
      window.removeEventListener(
        "contact-center:refresh-interactions",
        handleSSEEvent,
      );
      window.removeEventListener(
        "contact-center:call-disconnected",
        handleCallDisconnected,
      );
      window.removeEventListener(
        "contact-center:queue-transfer-accepted",
        handleQueueTransferAccepted,
      );
    };
  }, [isQueueTransferContinuation]);

  // Rebuild interactions from store updates without polling
  useEffect(() => {
    const mergedInteractions = buildInteractionsWithStore(
      dbInteractions,
      agentStatus,
    );
    applyInteractions(mergedInteractions);
  }, [
    applyInteractions,
    buildInteractionsWithStore,
    dbInteractions,
    agentStatus,
  ]);

  // Load current username and agent status
  useEffect(() => {
    const loadUserInfo = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data.isAuth && data.user?.email) {
          setCurrentUsername(data.user.email);
        }
        // Get agent status from user profile API
        try {
          const profileRes = await fetch("/api/user/profile");
          const profileData = await profileRes.json();
          if (profileData.ok && profileData.data?.status) {
            setAgentStatus(profileData.data.status);
          }
        } catch (profileErr) {
          // Failed to load status from profile
        }
      } catch (err) {
        // Silently handle errors
      }
    };
    loadUserInfo();

    // Listen for status changes via the shared SSE client (one connection for
    // the whole app, see lib/status-stream-client).
    const unsubscribeStatus = subscribeStatusStream("status_changed", (data) => {
      if (data?.status) {
            console.log(
              `[AgentDesktop] Updating agent status to "${data.status}"`,
            );
            setAgentStatus(data.status);

            // Persist status to localStorage so softphone can check it

            // CRITICAL: When status changes to "Agent Not Answering", clear active call stores immediately
            // This ensures the UI is cleared even if WebRTC client hasn't received hangup event yet
            if (data.status === "Agent Not Answering") {
              console.log(
                "[AgentDesktop] Agent Not Answering detected - clearing active call stores",
              );

              // Clear active call store
              const activeCallStore = useActiveCallStore.getState();
              if (activeCallStore.call || activeCallStore.status !== "idle") {
                console.log(
                  "[AgentDesktop] Clearing activeCallStore due to Agent Not Answering",
                );
                activeCallStore.clearActiveCall();
              }

              // Clear all calls from calls store that are in ringing state
              const callsStore = useCallsStore.getState();
              const allCalls = Object.values(callsStore.calls);
              allCalls.forEach((call) => {
                if (
                  call.status === "ringing" ||
                  call.status === "alerting" ||
                  call.status === "trying"
                ) {
                  console.log(
                    `[AgentDesktop] Removing ringing call ${
                      call.callControlId || call.interactionId
                    } from calls store`,
                  );
                  callsStore.removeCall(
                    call.callControlId || call.interactionId,
                  );
                }
              });

              // Clear selected interaction if it's in ringing state
              setSelectedInteraction((current) => {
                if (current && current.state === "ringing") {
                  console.log(
                    `[AgentDesktop] Clearing selected ringing interaction ${current.id} due to Agent Not Answering`,
                  );
                  return null;
                }
                return current;
              });

              // Clear all ringing interactions from dbInteractions state
              setDbInteractions((current) => {
                const filtered = current.filter((interaction) => {
                  if (interaction.state === "ringing") {
                    console.log(
                      `[AgentDesktop] Removing ringing interaction ${interaction.id} from dbInteractions due to Agent Not Answering`,
                    );
                    return false;
                  }
                  return true;
                });
                return filtered;
              });

              // Force immediate refresh of interactions
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent("contact-center:refresh-interactions"),
                );
              }, 100);
            }
      }
    });

    return () => {
      unsubscribeStatus();
    };
  }, []);

  // Auto-refresh selected interaction if from_number is missing
  useEffect(() => {
    if (!selectedInteraction) return;

    const needsRefresh =
      !selectedInteraction.from_number ||
      selectedInteraction.from_number.trim() === "";
    if (!needsRefresh) return;

    const interactionId = selectedInteraction.id;
    const callControlId = selectedInteraction.call_control_id;
    if (!callControlId) return;

    const lastAttempt = lastRefreshAttemptRef.current.get(interactionId);
    const now = Date.now();

    // Only refresh if we haven't tried in the last 5 seconds (avoid infinite loops)
    if (!lastAttempt || now - lastAttempt > 5000) {
      lastRefreshAttemptRef.current.set(interactionId, now);

      fetch(
        `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
          callControlId,
        )}`,
      )
        .then((res) => res.json())
        .then((data) => {
          if (data.ok && data.interaction) {
            if (
              data.interaction.id === interactionId ||
              data.interaction.call_control_id === callControlId
            ) {
              setSelectedInteraction(data.interaction);
            }
          }
        })
        .catch((err) => {
          // Failed to auto-refresh interaction
        });
    }
  }, [
    selectedInteraction?.id,
    selectedInteraction?.from_number,
    selectedInteraction?.call_control_id,
  ]);

  // Sync selected interaction with latest data from interactions list
  // This ensures metadata (like agent_assist_config) is updated after SSE refresh
  useEffect(() => {
    if (!selectedInteraction) return;
    const updatedInteraction = interactions.find(
      (interaction) =>
        interaction.id === selectedInteraction.id ||
        Boolean(interaction.call_control_id && interaction.call_control_id === selectedInteraction.call_control_id),
    );
    if (!updatedInteraction) {
      // Interaction no longer exists, clear selection
      setSelectedInteraction(null);
    } else if (updatedInteraction !== selectedInteraction) {
      // Update with latest data (including metadata with agent_assist_config)
      setSelectedInteraction(updatedInteraction);
    }
  }, [interactions, selectedInteraction]);

  useEffect(() => {
    const isEnded = END_STATUSES.has(callStatus);
    const wasActive = lastStatusRef.current && lastStatusRef.current !== "idle";
    const isCleared = callStatus === "idle" && wasActive;
    const wasDisconnected =
      disconnectedTime &&
      disconnectedTime > 0 &&
      disconnectedTime !== lastDisconnectedTimeRef.current;
    lastStatusRef.current = callStatus;
    if (wasDisconnected) {
      lastDisconnectedTimeRef.current = disconnectedTime;

      // When call disconnects, refresh interactions list to remove it
      // This ensures timeout re-enqueued calls are immediately removed
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("contact-center:refresh-interactions"),
        );
      }, 300);
    }

    // Trigger wrapup/disposition check if call ended, cleared, or disconnected
    if (!isEnded && !isCleared && !wasDisconnected) {
      return;
    }

    // Campaign disposition follows the same timing as wrap-up: only after WebRTC hangup/clear.
    if (pendingCampaignDispositionRef.current && campaignCallStartedRef.current) {
      setCampaignDispositionAssignment(pendingCampaignDispositionRef.current);
      pendingCampaignDispositionRef.current = null;
      campaignCallStartedRef.current = false;
    }

    // GlobalWrapupSheet is the sole owner of wrap-up presentation. AgentDesktop
    // only reacts to the disconnect for campaign disposition and list refresh.
  }, [callStatus, disconnectedTime]);

  const [activeView, setActiveView] = useState("desktop");
  const [isHydrated, setIsHydrated] = useState(false);
  const previousInteractionsRef = useRef([]);
  const hasRestoredStateRef = useRef(false);
  const savedSelectedInteractionIdRef = useRef(null);

  // Restore activeView from localStorage after hydration
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("agent-desktop.activeView");
        if (saved && ["desktop", "dashboard", "forms", "web-pages", "contacts", "tasks", "kb-articles"].includes(saved)) {
          setActiveView(saved);
        }
      } catch (_) {}
      setIsHydrated(true);
    }
  }, []);

  // Save state to localStorage when activeView changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("agent-desktop.activeView", activeView);
      } catch (_) {}
    }
  }, [activeView]);

  // Save selected interaction ID to localStorage when it changes
  useEffect(() => {
    if (typeof window !== "undefined" && selectedInteraction?.id) {
      try {
        localStorage.setItem("agent-desktop.selectedInteractionId", selectedInteraction.id);
        savedSelectedInteractionIdRef.current = selectedInteraction.id;
      } catch (_) {}
    } else if (!selectedInteraction && typeof window !== "undefined") {
      try {
        localStorage.removeItem("agent-desktop.selectedInteractionId");
        savedSelectedInteractionIdRef.current = null;
      } catch (_) {}
    }
  }, [selectedInteraction?.id]);

  // Restore selected interaction on mount if it still exists
  useEffect(() => {
    if (hasRestoredStateRef.current || interactions.length === 0) return;
    
    try {
      const savedInteractionId = localStorage.getItem("agent-desktop.selectedInteractionId");
      if (savedInteractionId) {
        const savedInteraction = interactions.find(
          (i) => i.id === savedInteractionId || i.call_control_id === savedInteractionId
        );
        if (savedInteraction) {
          // Set the ref FIRST before setting state, so the effect knows it's a restore
          savedSelectedInteractionIdRef.current = savedInteractionId;
          setSelectedInteraction(savedInteraction);
        } else {
          // Interaction no longer exists, clear saved state
          localStorage.removeItem("agent-desktop.selectedInteractionId");
          savedSelectedInteractionIdRef.current = null;
        }
      }
    } catch (_) {}
    
    hasRestoredStateRef.current = true;
  }, [interactions]);

  const {setDesktopVisible, requestedInteractionId, loading: interactionsLoading, clearRequestedInteraction} = chat;

  // The persistent portal provider owns notifications; report the actual rail view.
  useEffect(() => {
    setDesktopVisible(activeView === "desktop");
    return () => setDesktopVisible(false);
  }, [activeView, setDesktopVisible]);

  // Header navigation opens a specific offer without accepting it automatically.
  useEffect(() => {
    if (!isHydrated || !requestedInteractionId) return;
    setActiveView("desktop");
    const requested = interactions.find(item => String(item.id) === requestedInteractionId);
    if (requested) setSelectedInteraction(requested);
    if (requested || !interactionsLoading) clearRequestedInteraction();
  }, [isHydrated, interactions, requestedInteractionId, interactionsLoading, clearRequestedInteraction]);

  // Reset to interaction details when a call is selected, but only if it's a new incoming call
  // Don't override restored state for existing calls
  useEffect(() => {
    if (!selectedInteraction) return;
    
    // Only reset to interaction details if:
    // 1. This is a new incoming call (ringing, new, alerting, trying)
    // 2. OR the user manually selected a different interaction (not restored)
    const isNewIncomingCall =
      selectedInteraction.state === "ringing" ||
      selectedInteraction.state === "new" ||
      selectedInteraction.state === "alerting" ||
      selectedInteraction.state === "trying";
    
    const isRestoredSelection = 
      savedSelectedInteractionIdRef.current === selectedInteraction.id ||
      savedSelectedInteractionIdRef.current === selectedInteraction.call_control_id;
    
    // Only switch to interaction details if it's a new incoming call
    // OR if the user manually selected a different interaction (not the restored one)
    if (isNewIncomingCall || !isRestoredSelection) {
      setActiveView("desktop");
    }
  }, [selectedInteraction?.id, selectedInteraction?.state]);

  // Detect new incoming calls and switch to interaction details view
  useEffect(() => {
    if (interactions.length === 0) {
      previousInteractionsRef.current = [];
      return;
    }

    // Find new incoming calls (ringing, new, alerting, trying states)
    const newIncomingCalls = interactions.filter((interaction) => {
      const isIncomingState =
        interaction.state === "ringing" ||
        interaction.state === "new" ||
        interaction.state === "alerting" ||
        interaction.state === "trying";
      
      // Check if this interaction is new (not in previous list)
      const wasInPreviousList = previousInteractionsRef.current.some(
        (prev) =>
          prev.id === interaction.id ||
          Boolean(prev.call_control_id && prev.call_control_id === interaction.call_control_id),
      );

      return isIncomingState && !wasInPreviousList;
    });

    // If there's a new incoming call, switch to interaction details view
    if (newIncomingCalls.length > 0) {
      // Find the most recent incoming call (first in list is usually most recent)
      const newCall = newIncomingCalls[0];
      
      // Switch to interaction details view
      setActiveView("desktop");
      
      // Also auto-select the new call if no call is currently selected
      // or if the currently selected call is not an incoming call
      setSelectedInteraction((current) => {
        if (!current) {
          return newCall;
        }
        if (usesNativeLifecycle(current.channel)) return current;
        // If current selection is not an incoming call, switch to the new one
        const currentIsIncoming =
          current.state === "ringing" ||
          current.state === "new" ||
          current.state === "alerting" ||
          current.state === "trying";
        if (!currentIsIncoming) {
          return newCall;
        }
        return current;
      });
    }

    // Update previous interactions reference
    previousInteractionsRef.current = interactions;
  }, [interactions]);

  const refreshCampaignAssignment = useCallback(async () => {
    try {
      const res = await fetch("/api/contact-center/agent/campaigns/next", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setCampaignAssignment(data.assignment || null);
        if (data.assignment?.id) {
          campaignDialedAttemptRef.current = null;
        }
      }
    } catch (err) {
      // Agent may simply have no active campaign assignment.
    }
  }, []);

  const dialCampaignAssignment = useCallback(async (assignment = campaignAssignment) => {
    if (!assignment?.id || campaignDialing) return;
    setCampaignDialing(true);
    try {
      const res = await fetch("/api/contact-center/agent/campaigns/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId: assignment.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || data.execution?.reason || "Failed to prepare outbound call");
      campaignDialedAttemptRef.current = assignment.id;
      pendingCampaignDispositionRef.current = null;
      campaignCallStartedRef.current = false;
      // Core originates on the server and then delivers the agent leg through
      // the normal incoming-call UI. The browser never dials a second leg.
      notify({ title: "Outbound call scheduled", description: "The agent call will ring here when the contact answers." });
      setCampaignAssignment(null);
      setCampaignCountdownSeconds(null);
      setActiveView("desktop");
    } catch (err) {
      pendingCampaignDispositionRef.current = null;
      campaignCallStartedRef.current = false;
      notify({ title: "Outbound call failed", description: err.message || "Failed to start outbound call", variant: "error" });
    } finally {
      setCampaignDialing(false);
    }
  }, [campaignAssignment, campaignDialing]);

  useEffect(() => {
    refreshCampaignAssignment();
    const interval = setInterval(refreshCampaignAssignment, 10000);
    return () => clearInterval(interval);
  }, [refreshCampaignAssignment]);

  useEffect(() => {
    if (!campaignAssignment?.auto_dial_at) {
      setCampaignCountdownSeconds(null);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((new Date(campaignAssignment.auto_dial_at).getTime() - Date.now()) / 1000));
      setCampaignCountdownSeconds(remaining);
      // Display only: the durable worker enforces the progressive deadline.

    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [campaignAssignment]);

  const campaignPreviewInteraction = campaignAssignment ? {
    id: `campaign-preview-${campaignAssignment.id}`,
    direction: "outbound",
    state: "preview",
    interaction_type: "voice",
    is_contact_center: true,
    from_number: campaignAssignment.from_number || campaignAssignment.caller_id || "",
    to_number: campaignAssignment.to_number || "",
    from_name: campaignAssignment.campaign_name || "Campaign",
    metadata: {
      outbound_attempt_id: campaignAssignment.id,
      outbound_campaign_id: campaignAssignment.campaign_id,
      outbound_campaign_name: campaignAssignment.campaign_name,
      preview_only: true,
      agent_assist_config: campaignAssignment.agent_assist_config,
      contact_record: campaignAssignment.contact_record || {},
    },
  } : null;

  const detailTitle =
    activeView === "desktop"
      ? "Interaction Details"
      : activeView === "dashboard"
      ? "Dashboard"
      : DATA_SOURCE_VIEW_LABELS[activeView] || "Interaction Details";
  const DetailIcon =
    AGENT_RAIL_ITEMS.find((item) => item.id === activeView)?.icon || Info;

  return (
    <>
    <div
      className={SECTION_RAIL_PAGE_GRID_CLASS}
      style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} 320px minmax(0, 1fr)` }}
    >
      <SectionRail
        items={AGENT_RAIL_ITEMS}
        activeId={activeView}
        onSelect={setActiveView}
        ariaLabel="Agent workspace sections"
        screenGroup="agent.desktop"
      />

      <Card className="flex h-full min-h-0 flex-col overflow-hidden">
        {chat.error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{chat.error}</p>}
        <InteractionsList
          onChanged={chat.refresh}
          interactions={Array.isArray(interactions) ? interactions.filter(Boolean) : []}
          selectedId={selectedInteraction?.id}
          onSelect={(interaction) => {
            setSelectedInteraction(interaction);
            setActiveView("desktop");
            savedSelectedInteractionIdRef.current = null;
          }}
          webrtcCallState={useActiveCallStore()}
          currentUsername={currentUsername}
        />
      </Card>

      <Card className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${activeView === "dashboard" ? "bg-background" : ""}`}>
        <div className="px-4 py-3 bg-muted/50 border-b rounded-t-lg">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="p-1.5 rounded-md bg-primary/10">
                <DetailIcon className="h-4 w-4 text-primary" />
              </div>
              <h2 className="truncate text-base font-semibold text-foreground">{detailTitle}</h2>
              {activeView === "forms" && agentForms.length ? (
                <Select
                  value={selectedAgentFormId || undefined}
                  onValueChange={setSelectedAgentFormId}
                >
                  <SelectTrigger className="h-8 w-[240px]">
                    <SelectValue placeholder="Select form" />
                  </SelectTrigger>
                  <SelectContent>
                    {agentForms.map((form) => (
                      <SelectItem key={form.id} value={form.id}>
                        {form.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            <div id="interaction-detail-header-actions" className="shrink-0" />
          </div>
        </div>

        {activeView === "dashboard" ? (
          <div className="flex-1 overflow-y-auto">
            <AgentDashboard className="p-4 lg:p-5" refreshKey={interactions.map(item=>`${item.id}:${item.state}:${item.version||0}`).join("|")} onOpenInteraction={item=>{ const existing=interactions.find(row=>String(row.id)===String(item.id)); if(existing){setSelectedInteraction(existing);setActiveView("desktop");} }} />
          </div>
        ) : activeView === "desktop" ? (
          selectedInteraction ? (
            channelDefinition(selectedInteraction.channel).viewer === "messages"
              ? <ChatInteractionDetail key={selectedInteraction.id} interaction={selectedInteraction} onChanged={chat.refresh} composeStore={chatComposerStore} />
              : channelDefinition(selectedInteraction.channel).viewer === "email"
                ? <EmailInteractionDetail key={selectedInteraction.id} interaction={selectedInteraction} onChanged={chat.refresh} />
                : channelDefinition(selectedInteraction.channel).viewer === "video"
                  ? <VideoInteractionDetail key={selectedInteraction.id} interaction={selectedInteraction} onChanged={chat.refresh} />
                  : <InteractionDetail interaction={selectedInteraction} />
          ) : campaignAssignment ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <OutboundCampaignRecord
                assignment={campaignAssignment}
                countdownSeconds={campaignCountdownSeconds ?? campaignAssignment.auto_dial_seconds}
                dialing={campaignDialing}
                onDial={() => dialCampaignAssignment(campaignAssignment)}
              />
              {campaignPreviewInteraction ? <div className="min-h-[420px] overflow-hidden rounded-xl border bg-background"><InteractionDetail interaction={campaignPreviewInteraction} /></div> : null}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <PhoneCall className="h-10 w-10 text-gray-500" />
              <p>Waiting for an interaction...</p>
            </div>
          )
        ) : (
          <AgentDataSources
            view={activeView}
            selectedInteraction={selectedInteraction}
            selectedFormId={selectedAgentFormId}
            onSelectedFormIdChange={setSelectedAgentFormId}
            onFormsLoaded={setAgentForms}
            hideFormsHeader={activeView === "forms"}
            onBackToInteraction={() => {
              setActiveView("desktop");
              savedSelectedInteractionIdRef.current = null;
            }}
          />
        )}
      </Card>
    </div>
    <CampaignDispositionSheet
      assignment={campaignDispositionAssignment}
      open={Boolean(campaignDispositionAssignment)}
      onClose={() => setCampaignDispositionAssignment(null)}
      onSubmitted={() => {
        setCampaignDispositionAssignment(null);
        refreshCampaignAssignment();
      }}
    />
    </>
  );
}

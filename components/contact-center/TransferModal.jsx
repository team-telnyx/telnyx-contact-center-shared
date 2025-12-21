"use client";

import { useState } from "react";
import { NumberSelectionModal } from "@/components/contact-center/NumberSelectionModal";

export function TransferModal({ open, onOpenChange, interaction, onTransfer }) {
  const [loading, setLoading] = useState(false);

  const handleTransfer = async (number) => {
    // Allow transfer even without interaction (for direct WebRTC calls)
    let interactionId = interaction?.id;
    // For inbound calls transferred to agents, use metadata.original_call_control_id if available
    // Otherwise use interaction.call_control_id
    let callControlId =
      interaction?.metadata?.original_call_control_id ||
      interaction?.call_control_id;

    if (!interactionId && !callControlId) {
      // Get call control ID from stores - prioritize calls store, then active call store
      let storeState;
      let callsStoreState;

      try {
        const { default: useActiveCallStore } = await import(
          "@/lib/stores/active-call-store"
        );
        const { default: useCallsStore } = await import(
          "@/lib/stores/calls-store"
        );
        storeState = useActiveCallStore.getState();
        callsStoreState = useCallsStore.getState();
      } catch (importErr) {
        console.error("[TransferModal] Error importing stores:", importErr);
        alert("Failed to access call state. Please try again.");
        return;
      }

      if (!storeState.call) {
        alert("No active call to transfer");
        return;
      }

      // Priority 1: Check calls store for originalCallControlId
      const webrtcCallControlId = storeState.callControlId;
      if (webrtcCallControlId) {
        const callData = callsStoreState.getCall(webrtcCallControlId);
        if (callData?.originalCallControlId) {
          callControlId = callData.originalCallControlId;
        }
      }

      // Priority 2: Use originalCallControlId from active call store (for inbound calls)
      if (!callControlId && storeState.originalCallControlId) {
        callControlId = storeState.originalCallControlId;
      }

      // Priority 3: For outbound WebRTC calls, fetch PSTN leg's call_control_id
      if (!callControlId && (storeState.rtcCallId || webrtcCallControlId)) {
        try {
          const lookupId = storeState.rtcCallId || webrtcCallControlId;
          const res = await fetch(
            `/api/voice/call-leg/${encodeURIComponent(lookupId)}`
          );
          const data = await res.json();

          if (data.ok && data.call_control_id) {
            callControlId = data.call_control_id;
          }
        } catch (err) {
          // Silently handle error, will fall back to WebRTC ID
        }
      }

      // Last resort: Use WebRTC call control ID (should not happen for inbound calls)
      if (!callControlId) {
        callControlId = webrtcCallControlId;
      }

      if (!callControlId) {
        alert(
          "Cannot determine call control ID for transfer. Missing call information."
        );
        return;
      }
    }

    setLoading(true);
    try {
      const type = "external";
      const target = number.trim();

      if (!target) {
        alert("Please select a transfer destination");
        setLoading(false);
        return;
      }

      // Use interaction ID if available, otherwise use call_control_id
      let endpoint;
      let body;

      if (interactionId) {
        endpoint = `/api/contact-center/interactions/${interactionId}/transfer`;
        body = { type, target };
      } else if (callControlId) {
        endpoint = `/api/contact-center/interactions/by-call-control-id/transfer?callControlId=${encodeURIComponent(
          callControlId
        )}`;
        body = { type, target };
      } else {
        alert("Cannot determine call control ID for transfer");
        setLoading(false);
        return;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.ok) {
        // Record transfer in active call store
        try {
          const { default: useActiveCallStore } = await import(
            "@/lib/stores/active-call-store"
          );
          const store = useActiveCallStore.getState();
          store.recordTransfer({
            to: target,
            type: type,
            callControlId: callControlId,
          });
        } catch (storeErr) {
          console.error(
            "[TransferModal] Error recording transfer in store:",
            storeErr
          );
          // Don't fail the transfer if store update fails
        }

        // Close modal first
        onOpenChange(false);
        // Then call onTransfer callback (which may trigger reload if needed)
        // Wrap in try-catch to prevent errors from propagating
        try {
          onTransfer?.();
        } catch (callbackErr) {
          console.error(
            "[TransferModal] Error in onTransfer callback:",
            callbackErr
          );
          // Don't throw - transfer succeeded, just callback failed
        }
      } else {
        alert(data.error || "Transfer failed");
      }
    } catch (err) {
      console.error("[TransferModal] Transfer error:", err);
      alert("Transfer failed: " + (err.message || "Unknown error"));
      // Don't call onTransfer on error
    } finally {
      setLoading(false);
    }
  };

  return (
    <NumberSelectionModal
      open={open}
      onOpenChange={onOpenChange}
      mode="transfer"
      onSelect={async (number) => {
        try {
          await handleTransfer(number);
        } catch (err) {
          console.error("[TransferModal] Unhandled error in transfer:", err);
          // Error is already handled in handleTransfer, but catch any unexpected errors
        }
      }}
    />
  );
}

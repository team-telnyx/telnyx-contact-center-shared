"use client";

import { useState } from "react";
import { NumberSelectionModal } from "@/components/contact-center/NumberSelectionModal";

export function TransferModal({ open, onOpenChange, interaction, onTransfer }) {
  const [loading, setLoading] = useState(false);

  const handleTransfer = async (number) => {
    // Allow transfer even without interaction (for direct WebRTC calls)
    let interactionId = interaction?.id;
    let callControlId = interaction?.call_control_id;

    if (!interactionId && !callControlId) {
      // Get call control ID from active call store
      let storeState;
      try {
        const { default: useActiveCallStore } = await import("@/lib/stores/active-call-store");
        storeState = useActiveCallStore.getState();
      } catch (importErr) {
        console.error("[TransferModal] Error importing active-call-store:", importErr);
        alert("Failed to access call state. Please try again.");
        return;
      }

      if (!storeState.call) {
        alert("No active call to transfer");
        return;
      }

      // For outbound WebRTC calls, fetch PSTN leg's call_control_id
      // Try using rtcCallId first, then fall back to WebRTC call_control_id
      const webrtcCallControlId = storeState.callControlId;
      
      if (storeState.rtcCallId || webrtcCallControlId) {
        try {
          // Use rtcCallId if available, otherwise use WebRTC call_control_id
          const lookupId = storeState.rtcCallId || webrtcCallControlId;
          console.log("[TransferModal] 🔍 Fetching PSTN leg call_control_id for:", lookupId);
          const res = await fetch(`/api/voice/call-leg/${encodeURIComponent(lookupId)}`);
          const data = await res.json();
          
          if (data.ok && data.call_control_id) {
            callControlId = data.call_control_id;
            console.log("[TransferModal] ✅ Using PSTN leg call_control_id:", callControlId);
          } else {
            console.warn("[TransferModal] ⚠️ No mapping found, using originalCallControlId as fallback");
            callControlId = storeState.originalCallControlId;
          }
        } catch (err) {
          console.error("[TransferModal] ❌ Error fetching PSTN leg:", err);
          callControlId = storeState.originalCallControlId;
        }
      } else {
        // For incoming calls, use the original call control ID from custom headers
        // This is the PSTN incoming call leg's ID, which is what we need for transfer
        callControlId = storeState.originalCallControlId;

        if (!callControlId) {
          console.error(
            "[TransferModal] No originalCallControlId found in store. This should have been extracted from X-Original-Call-Control-Id header."
          );
          alert("Cannot determine call control ID for transfer. Missing X-Original-Call-Control-Id header.");
          return;
        }

        console.log("[TransferModal] Using originalCallControlId from store:", callControlId);
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
        // Close modal first
        onOpenChange(false);
        // Then call onTransfer callback (which may trigger reload if needed)
        // Wrap in try-catch to prevent errors from propagating
        try {
          onTransfer?.();
        } catch (callbackErr) {
          console.error("[TransferModal] Error in onTransfer callback:", callbackErr);
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

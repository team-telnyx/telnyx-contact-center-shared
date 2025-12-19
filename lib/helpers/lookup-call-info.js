/**
 * Helper functions for looking up call information
 */

/**
 * Determine if call is from contact center and fetch interaction metadata
 * @param {string} callControlId - Call control ID from WebRTC SDK
 * @returns {Promise<Object>} - Call metadata including interaction if found
 */
export async function lookupCallMetadata(callControlId) {
  const metadata = {
    isContactCenter: false,
    interactionId: null,
    queueName: null,
    fromName: null,
    customerId: null,
    customerData: null,
    queuedAt: null,
    assignedAt: null,
  };

  console.log("[LookupCallInfo] Looking up call metadata for:", callControlId);

  try {
    // Try to find interaction in database
    const res = await fetch(
      `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
        callControlId
      )}`
    );
    const data = await res.json();

    console.log("[LookupCallInfo] API response:", {
      ok: data.ok,
      hasInteraction: !!data.interaction,
      interactionId: data.interaction?.id,
      callControlId: data.interaction?.call_control_id,
    });

    if (data.ok && data.interaction) {
      // This is a contact center call
      const interaction = data.interaction;
      metadata.isContactCenter = true;
      metadata.interactionId = interaction.id;
      metadata.queueName = interaction.queue_name;
      metadata.fromName = interaction.from_name;
      metadata.customerId = interaction.customer_id;
      metadata.queuedAt = interaction.enqueued_at;
      metadata.assignedAt = interaction.assigned_at;

      console.log("[LookupCallInfo] Contact center call detected:", {
        interactionId: metadata.interactionId,
        queueName: metadata.queueName,
        fromName: metadata.fromName,
      });
    } else {
      console.log(
        "[LookupCallInfo] Direct call (no interaction found) for call_control_id:",
        callControlId
      );
    }
  } catch (err) {
    console.warn("[LookupCallInfo] Failed to lookup interaction:", err);
    // Not a contact center call, continue as direct call
  }

  return metadata;
}

/**
 * Lookup customer name by phone number
 * @param {string} phoneNumber - Phone number to lookup
 * @returns {Promise<string|null>} - Customer name or null
 */
export async function lookupCustomerName(phoneNumber) {
  if (!phoneNumber) return null;

  try {
    // Normalize phone number: remove spaces, dashes, etc., but keep +
    const normalizedPhone = String(phoneNumber)
      .replace(/[^\d+]/g, "")
      .replace(/^(\d{10,})$/, "+$1"); // Add + if it's a long number without +

    const res = await fetch(
      `/api/contact-center/customers/by-phone?phone=${encodeURIComponent(
        normalizedPhone
      )}`
    );
    const data = await res.json();

    if (data.ok && data.customer) {
      const name = `${data.customer.first_name || ""} ${
        data.customer.last_name || ""
      }`.trim();

      if (name) {
        console.log("[LookupCallInfo] Found customer name:", name);
        return name;
      }
    }
  } catch (err) {
    console.error("[LookupCallInfo] Customer lookup error:", err);
  }

  return null;
}

/**
 * Get caller info from incoming call store (SSE data)
 * @param {string} phoneNumber - Phone number to lookup
 * @returns {Promise<Object|null>} - Stored caller info or null
 */
export async function getStoredCallerInfo(phoneNumber) {
  if (!phoneNumber) return null;

  try {
    const { getIncomingCallDataByPhone } = await import(
      "@/lib/incoming-call-store"
    );

    const storedData = getIncomingCallDataByPhone(phoneNumber);
    if (storedData?.fromName) {
      console.log(
        "[LookupCallInfo] Found caller name from SSE store:",
        storedData.fromName
      );
      return storedData;
    }
  } catch (err) {
    console.error("[LookupCallInfo] Error accessing incoming call store:", err);
  }

  return null;
}

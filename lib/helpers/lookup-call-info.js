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

  if (!callControlId || callControlId.trim() === "") {
    return metadata;
  }

  try {
    // Try to find interaction in database
    const res = await fetch(
      `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
        callControlId
      )}`
    );
    const data = await res.json();

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
    }
  } catch (err) {
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
        return name;
      }
    }
  } catch (err) {
    // Customer lookup error
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
      return storedData;
    }
  } catch (err) {
    // Error accessing incoming call store
  }

  return null;
}

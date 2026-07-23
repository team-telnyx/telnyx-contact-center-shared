import { buildTelnyxV2Url } from "./telnyx.js";
import { telnyxErrorPayload, telnyxResourcePayload, telnyxVoiceAppsLogger } from "./telnyx-ai-logging.mjs";

/**
 * Get Telnyx API key from environment
 */
function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

/**
 * Create a Telnyx Call Control Application
 * @param {string} name - Application name
 * @param {string} webhookUrl - Webhook URL for events
 * @param {string} [flowId] - Optional flow ID to use as SIP subdomain
 * @returns {Promise<Object>} - Voice application object with id
 */
export async function createVoiceApplication(name, webhookUrl, flowId = null) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url("/call_control_applications");

  const payload = {
    application_name: name,
    webhook_event_url: webhookUrl,
    webhook_event_failover_url: null,
    webhook_api_version: "2",
    call_cost_in_webhooks: true,
  };

  // Pin inbound codecs to G711 (PCMA/PCMU) in priority order and never offer
  // G722. The live transcription / Agent Assist path streams Telnyx Standalone
  // STT with stream_codec=PCMU + input_format=mulaw, so a leg negotiated on
  // G722 delivers zero media on the STT track (no caller transcription, no
  // Agent Assist bubbles). Telnyx's own default codec list leads with G722
  // (["G722","G711U","G711A",...]), so we must override it explicitly on every
  // Voice Application we create. G711A first matches the EU/PL softphone offer.
  const inboundCodecs = ["G711A", "G711U"];
  payload.inbound = {
    codecs: inboundCodecs,
  };

  // Add inbound SIP subdomain if flowId is provided
  if (flowId) {
    payload.inbound.sip_subdomain = flowId;
    payload.inbound.sip_subdomain_receive_settings = "from_anyone";
    telnyxVoiceAppsLogger.info("voice_application_sip_subdomain_configured", { ...telnyxResourcePayload({ flowId }) });
  }

  telnyxVoiceAppsLogger.info("voice_application_inbound_codecs_pinned", { codecs: inboundCodecs });

  // Add outbound voice profile if configured
  const outboundVoiceProfileId =
    process.env.TELNYX_OUTBOUND_VOICE_PROFILE?.trim();
  if (outboundVoiceProfileId) {
    payload.outbound = {
      outbound_voice_profile_id: outboundVoiceProfileId,
    };
    telnyxVoiceAppsLogger.info("voice_application_outbound_profile_configured", { outboundVoiceProfileConfigured: true });
  } else {
    telnyxVoiceAppsLogger.warn("voice_application_outbound_profile_missing", { outboundVoiceProfileConfigured: false });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`
      );
    }

    if (!response.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to create voice application`;
      throw new Error(errorMsg);
    }

    const app = data?.data;

    if (!app || !app.id) {
      throw new Error("Invalid response from Telnyx: missing application data");
    }

    return {
      id: app.id,
      application_name: app.application_name,
      webhook_event_url: app.webhook_event_url,
      outbound_voice_profile_id:
        app.outbound?.outbound_voice_profile_id || null,
      created_at: app.created_at,
    };
  } catch (error) {
    telnyxVoiceAppsLogger.error("voice_application_create_failed", { applicationName: name, ...telnyxErrorPayload(error) });
    throw error;
  }
}

/**
 * Update a Telnyx Call Control Application
 * @param {string} appId - Application ID
 * @param {Object} updates - Updates to apply
 * @param {string} [updates.application_name] - New application name
 * @param {string} [updates.webhook_event_url] - New webhook URL
 * @param {string} [updates.outbound_voice_profile_id] - Outbound voice profile ID
 * @param {string} [updates.sip_subdomain] - SIP subdomain (flow ID)
 * @returns {Promise<Object>} - Updated application object
 */
export async function updateVoiceApplication(appId, updates) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(`/call_control_applications/${appId}`);

  const payload = {};
  if (updates.application_name !== undefined) {
    payload.application_name = updates.application_name;
  }
  if (updates.webhook_event_url !== undefined) {
    payload.webhook_event_url = updates.webhook_event_url;
  }

  // Handle inbound SIP subdomain updates
  if (updates.sip_subdomain !== undefined) {
    const sipSubdomain = updates.sip_subdomain;
    payload.inbound = {
      sip_subdomain: sipSubdomain,
      sip_subdomain_receive_settings: "from_anyone",
    };
    telnyxVoiceAppsLogger.info("voice_application_sip_subdomain_update_started", { ...telnyxResourcePayload({ appId, flowId: sipSubdomain }) });
  }

  if (updates.outbound_voice_profile_id !== undefined) {
    payload.outbound = {
      outbound_voice_profile_id: updates.outbound_voice_profile_id,
    };
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("No updates provided");
  }

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`
      );
    }

    if (!response.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to update voice application`;
      throw new Error(errorMsg);
    }

    const app = data?.data;

    if (!app || !app.id) {
      throw new Error("Invalid response from Telnyx: missing application data");
    }

    return {
      id: app.id,
      application_name: app.application_name,
      webhook_event_url: app.webhook_event_url,
      outbound_voice_profile_id:
        app.outbound?.outbound_voice_profile_id || null,
      updated_at: app.updated_at,
    };
  } catch (error) {
    telnyxVoiceAppsLogger.error("voice_application_update_failed", { ...telnyxResourcePayload({ appId }), ...telnyxErrorPayload(error) });
    throw error;
  }
}

/**
 * Delete a Telnyx Call Control Application
 * @param {string} appId - Application ID
 * @returns {Promise<boolean>} - True if deleted successfully
 */
export async function deleteVoiceApplication(appId) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(`/call_control_applications/${appId}`);

  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        data = {};
      }

      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to delete voice application`;
      throw new Error(errorMsg);
    }

    return true;
  } catch (error) {
    telnyxVoiceAppsLogger.error("voice_application_delete_failed", { ...telnyxResourcePayload({ appId }), ...telnyxErrorPayload(error) });
    throw error;
  }
}

/**
 * Get a Telnyx Call Control Application
 * @param {string} appId - Application ID
 * @returns {Promise<Object>} - Application object
 */
export async function getVoiceApplication(appId) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(`/call_control_applications/${appId}`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`
      );
    }

    if (!response.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to get voice application`;
      throw new Error(errorMsg);
    }

    const app = data?.data;

    if (!app || !app.id) {
      throw new Error("Invalid response from Telnyx: missing application data");
    }

    return {
      id: app.id,
      application_name: app.application_name,
      webhook_event_url: app.webhook_event_url,
      outbound_voice_profile_id:
        app.outbound?.outbound_voice_profile_id || null,
      created_at: app.created_at,
      updated_at: app.updated_at,
    };
  } catch (error) {
    telnyxVoiceAppsLogger.error("voice_application_get_failed", { ...telnyxResourcePayload({ appId }), ...telnyxErrorPayload(error) });
    throw error;
  }
}

/**
 * Assign a phone number to a Call Control Application
 * @param {string} phoneNumberId - Telnyx phone number ID
 * @param {string} appId - Call Control Application ID
 * @returns {Promise<Object>} - Updated phone number object
 */
export async function assignPhoneNumberToApp(phoneNumberId, appId) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(`/phone_numbers/${phoneNumberId}`);

  const payload = {
    connection_id: appId,
  };

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`
      );
    }

    if (!response.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to assign phone number to application`;
      throw new Error(errorMsg);
    }

    const phoneNumber = data?.data;

    if (!phoneNumber || !phoneNumber.id) {
      throw new Error(
        "Invalid response from Telnyx: missing phone number data"
      );
    }

    const connectionId =
      phoneNumber.connection_id ?? phoneNumber.voice?.connection_id ?? null;
    if (String(connectionId || "") !== String(appId)) {
      throw new Error(
        "Telnyx accepted the request but did not assign the phone number to the requested connection"
      );
    }

    return {
      id: phoneNumber.id,
      phone_number: phoneNumber.phone_number,
      connection_id: connectionId,
    };
  } catch (error) {
    telnyxVoiceAppsLogger.error("voice_application_phone_number_assign_failed", { ...telnyxResourcePayload({ appId }), phoneNumberId: phoneNumberId ? String(phoneNumberId) : undefined, ...telnyxErrorPayload(error) });
    throw error;
  }
}

/**
 * Unassign a phone number from its Call Control Application
 * @param {string} phoneNumberId - Telnyx phone number ID
 * @returns {Promise<Object>} - Updated phone number object
 */
export async function unassignPhoneNumberFromApp(phoneNumberId) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(`/phone_numbers/${phoneNumberId}`);

  const payload = {
    connection_id: null,
  };

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`
      );
    }

    if (!response.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to unassign phone number from application`;
      throw new Error(errorMsg);
    }

    const phoneNumber = data?.data;

    if (!phoneNumber || !phoneNumber.id) {
      throw new Error(
        "Invalid response from Telnyx: missing phone number data"
      );
    }


    const hasConnectionState =
      Object.prototype.hasOwnProperty.call(phoneNumber, "connection_id") ||
      Object.prototype.hasOwnProperty.call(phoneNumber.voice || {}, "connection_id");
    const connectionId =
      phoneNumber.connection_id ?? phoneNumber.voice?.connection_id ?? null;
    if (!hasConnectionState || connectionId) {
      throw new Error(
        "Telnyx accepted the request but did not unassign the phone number from its connection"
      );
    }

    return {
      id: phoneNumber.id,
      phone_number: phoneNumber.phone_number,
      connection_id: null,
    };
  } catch (error) {
    telnyxVoiceAppsLogger.error("voice_application_phone_number_unassign_failed", { phoneNumberId: phoneNumberId ? String(phoneNumberId) : undefined, ...telnyxErrorPayload(error) });
    throw error;
  }
}

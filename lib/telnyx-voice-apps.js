import { buildTelnyxV2Url } from "./telnyx.js";

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
  };

  // Add inbound SIP subdomain if flowId is provided
  if (flowId) {
    payload.inbound = {
      sip_subdomain: flowId,
      sip_subdomain_receive_settings: "from_anyone",
    };
    console.log(
      `[Telnyx] Creating voice application with SIP subdomain: ${flowId}`
    );
  }

  // Add outbound voice profile if configured
  const outboundVoiceProfileId =
    process.env.TELNYX_OUTBOUND_VOICE_PROFILE?.trim();
  if (outboundVoiceProfileId) {
    payload.outbound = {
      outbound_voice_profile_id: outboundVoiceProfileId,
    };
    console.log(
      `[Telnyx] Creating voice application with outbound voice profile: ${outboundVoiceProfileId}`
    );
  } else {
    console.warn(
      "[Telnyx] TELNYX_OUTBOUND_VOICE_PROFILE not set - voice application will be created without outbound voice profile"
    );
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
    console.error("[Telnyx] Failed to create voice application:", {
      error: error.message,
      name,
      webhookUrl,
    });
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
    payload.inbound = {
      sip_subdomain: updates.sip_subdomain,
      sip_subdomain_receive_settings: "from_anyone",
    };
    console.log(
      `[Telnyx] Updating voice application SIP subdomain: ${updates.sip_subdomain}`
    );
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
    console.error("[Telnyx] Failed to update voice application:", {
      error: error.message,
      appId,
      updates,
    });
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
    console.error("[Telnyx] Failed to delete voice application:", {
      error: error.message,
      appId,
    });
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
    console.error("[Telnyx] Failed to get voice application:", {
      error: error.message,
      appId,
    });
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
    call_control_application_id: appId,
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

    return {
      id: phoneNumber.id,
      phone_number: phoneNumber.phone_number,
      call_control_application_id: phoneNumber.call_control_application_id,
    };
  } catch (error) {
    console.error("[Telnyx] Failed to assign phone number to application:", {
      error: error.message,
      phoneNumberId,
      appId,
    });
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
    call_control_application_id: null,
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

    return {
      id: phoneNumber.id,
      phone_number: phoneNumber.phone_number,
      call_control_application_id: phoneNumber.call_control_application_id,
    };
  } catch (error) {
    console.error(
      "[Telnyx] Failed to unassign phone number from application:",
      {
        error: error.message,
        phoneNumberId,
      }
    );
    throw error;
  }
}

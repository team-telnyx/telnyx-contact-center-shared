import { NextResponse } from "next/server";
import { platformApiLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import {
  KB_CATEGORIES,
  TELNYX_API_ACTIONS,
  THIRD_PARTY_API_ACTIONS,
} from "@/config/demo-entities";
import {
  CONTACT_CENTER_DATA_SOURCES,
  getContactCenterDataSourceActions,
} from "@/config/contact-center-data-sources";

/**
 * Server-side API endpoint to generate webhook configurations
 * This allows us to use server-side environment variables (without NEXT_PUBLIC_ prefix)
 * which don't get embedded in the client bundle at build time
 */
export async function POST(request) {
  try {
    const { entityId, actionId, baseUrl } = await request.json();

    if (!entityId || !actionId) {
      return NextResponse.json(
        { error: "entityId and actionId are required" },
        { status: 400 }
      );
    }

    const config = generateWebhookConfigServer(entityId, actionId, baseUrl);

    if (!config) {
      return NextResponse.json(
        { error: "Invalid entity or action" },
        { status: 404 }
      );
    }

    return NextResponse.json(config);
  } catch (error) {
    platformApiLogger.error("webhook_config_generation_failed", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { error: "Failed to generate webhook config" },
      { status: 500 }
    );
  }
}

/**
 * Get available actions for an entity
 */
function getEntityActions(entityId) {
  if (entityId === "third_party_apis") {
    return THIRD_PARTY_API_ACTIONS;
  }
  return getContactCenterDataSourceActions(entityId);
}

/**
 * Server-side version of generateWebhookConfig that uses server env vars
 */
function generateWebhookConfigServer(entityId, actionId, baseUrl) {
  // Handle Telnyx APIs
  if (entityId === "telnyx_apis") {
    return generateTelnyxApiWebhookConfig(actionId);
  }

  // Handle Third Party APIs
  if (entityId === "third_party_apis") {
    return generateThirdPartyApiWebhookConfig(actionId, baseUrl);
  }

  const entity = CONTACT_CENTER_DATA_SOURCES.find((e) => e.id === entityId);
  const actions = getEntityActions(entityId);
  const action = actions.find((a) => a.id === actionId);

  if (!entity || !action) return null;

  // Use baseUrl from client or fallback to env var
  const finalBaseUrl =
    baseUrl || process.env.NEXT_PUBLIC_APP_BASE_URL || "http://localhost:3000";

  // Build URL
  let url = action.urlPattern
    .replace("{basePath}", entity.basePath)
    .replace("{id}", "{id}");
  url = `${finalBaseUrl}${url}`;

  // Generate name
  const namePrefix =
    action.method.toLowerCase() === "get" ? "get_" : action.id + "_";
  const name = namePrefix + entity.id;

  // Generate description
  const entitySingular = entity.label.toLowerCase().slice(0, -1); // Remove 's'
  const entityPlural = entity.label.toLowerCase();
  const description = action.description
    .replace("{entity}", entitySingular)
    .replace("{entities}", entityPlural);

  // Build headers with API key - USE SERVER-SIDE ENV VAR (no NEXT_PUBLIC_ prefix)
  const apiKeyRef = process.env.TELNYX_AI_API_KEY_REF || "telnyx-ai-api-key";
  const headers = [
    {
      name: "telnyx-ai-api-key",
      value: `{{#integration_secret}}${apiKeyRef}{{/integration_secret}}`,
    },
  ];

  // Build path parameters
  const path_parameters = {};
  if (action.pathParams.length > 0) {
    const properties = {};
    action.pathParams.forEach((param) => {
      properties[param] = {
        type: "string",
        description: `The ${param} of the ${entitySingular}`,
      };
    });
    path_parameters.type = "object";
    path_parameters.properties = properties;
    path_parameters.required = action.pathParams;
  }

  // Build query parameters
  const query_parameters = {};
  if (action.queryParams.length > 0) {
    const properties = {};

    // Check if we need to generate from schema (when queryParams contains "*")
    if (action.queryParams[0] === "*" && entity.schema) {
      // For search action, add all searchable fields from entity schema
      Object.entries(entity.schema).forEach(([fieldName, fieldDef]) => {
        // Skip fields that don't make sense as search parameters
        if (
          fieldName === "username" ||
          fieldName === "custom_data" ||
          fieldDef.autoGenerate
        ) {
          return;
        }

        // Use the field definition from the schema
        const propertyDef = {
          type: fieldDef.type === "object" ? "string" : fieldDef.type,
          description: fieldDef.description || `Filter by ${fieldName}`,
        };

        // Add enum values if present
        if (fieldDef.enum && Array.isArray(fieldDef.enum)) {
          propertyDef.enum = fieldDef.enum;
        }

        properties[fieldName] = propertyDef;
      });
    } else {
      // Use predefined query params
      action.queryParams.forEach((param) => {
        if (param === "q") {
          if (action.id === "semantic_search") {
            properties[param] = {
              type: "string",
              description:
                "Max 3-5 words search query based on the reported issue. Must be in English as we are using semantic search.",
            };
          } else {
            properties[param] = {
              type: "string",
              description: "Search query string",
            };
          }
        } else if (param === "status") {
          properties[param] = {
            type: "string",
            description: "Filter by status (Draft, Published, Archived)",
            enum: ["Draft", "Published", "Archived"],
          };
        } else if (param === "category") {
          properties[param] = {
            type: "string",
            description: "Filter by category",
            enum: KB_CATEGORIES,
          };
        } else {
          properties[param] = {
            type: "string",
            description: `${param} parameter`,
          };
        }
      });
    }

    query_parameters.type = "object";
    query_parameters.properties = properties;
    query_parameters.required = action.id === "semantic_search" ? ["q"] : [];
  }

  // Build body parameters using entity schema
  const body_parameters = {};
  if (
    action.bodyParams.length > 0 &&
    action.bodyParams[0] === "*" &&
    entity.schema
  ) {
    const properties = {};
    const required = [];

    // Add all fields from entity schema
    Object.entries(entity.schema).forEach(([fieldName, fieldDef]) => {
      // Skip auto-generated fields
      if (fieldDef.autoGenerate) {
        return;
      }

      // Special handling for object types
      if (fieldDef.type === "object") {
        properties[fieldName] = {
          type: "string",
          description: fieldDef.description,
        };
      } else {
        properties[fieldName] = {
          type: fieldDef.type,
          description: fieldDef.description,
        };

        // Add enum values if present
        if (fieldDef.enum && Array.isArray(fieldDef.enum)) {
          properties[fieldName].enum = fieldDef.enum;
        }
      }

      // Mark as required based on schema
      if (fieldDef.required) {
        required.push(fieldName);
      }
    });

    body_parameters.type = "object";
    body_parameters.properties = properties;
    body_parameters.required = required;
  }

  return {
    type: "webhook",
    webhook: {
      name,
      description,
      url,
      method: action.method,
      headers,
      path_parameters:
        Object.keys(path_parameters).length > 0 ? path_parameters : undefined,
      query_parameters:
        Object.keys(query_parameters).length > 0 ? query_parameters : undefined,
      body_parameters:
        Object.keys(body_parameters).length > 0 ? body_parameters : undefined,
      timeout_secs: 30,
    },
  };
}

/**
 * Generate webhook config for Telnyx API actions
 */
function generateTelnyxApiWebhookConfig(actionId) {
  // Get messaging profile ID from environment variable
  const messagingProfileId =
    process.env.TELNYX_MESSAGING_PROFILE_ID ||
    "400184c8-76a2-499f-b506-a18c0bea9a87"; // Fallback value if not set

  const configs = {
    send_sms: {
      name: "sms_send",
      description: "Send an SMS message via Telnyx Messaging API",
      url: "https://api.telnyx.com/v2/messages",
      method: "POST",
      headers: [
        {
          name: "Authorization",
          value:
            "Bearer {{#integration_secret}}telnyx_api_key{{/integration_secret}}",
        },
        {
          name: "Content-Type",
          value: "application/json",
        },
      ],
      body_parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            format: "address",
            description:
              "Destination phone number in E.164 format (e.g., '+351961621005'). Must be a string, not a number. Use {{telnyx_end_user_target}}",
            pattern: "^\\+[1-9]\\d{1,14}$",
            examples: ["+351961621005", "+15551234567"],
          },
          from: {
            type: "string",
            description: "Always use Telnyx",
          },
          messaging_profile_id: {
            type: "string",
            description: `Always use ${messagingProfileId}`,
            default: messagingProfileId,
          },
          text: {
            type: "string",
            description: "Body of the message",
          },
        },
        required: ["to", "from", "messaging_profile_id", "text"],
      },
    },
    recording_start: {
      name: "recording_start",
      description: "Start recording a call via Telnyx Voice API",
      url: "https://api.telnyx.com/v2/calls/{{call_control_id}}/actions/record_start",
      method: "POST",
      headers: [
        {
          name: "Authorization",
          value:
            "Bearer {{#integration_secret}}telnyx_api_key{{/integration_secret}}",
        },
      ],
      body_parameters: {
        type: "object",
        properties: {
          channels: {
            type: "string",
            description: "Recording channels: single or dual",
            enum: ["single", "dual"],
          },
          format: {
            type: "string",
            description: "Recording format: wav or mp3",
            enum: ["wav", "mp3"],
          },
        },
        required: ["channels", "format"],
      },
    },
  };

  const config = configs[actionId];
  if (!config) return null;

  return {
    type: "webhook",
    webhook: {
      ...config,
      timeout_secs: 30,
    },
  };
}

/**
 * Generate webhook config for Third Party API actions
 */
function generateThirdPartyApiWebhookConfig(actionId, baseUrl) {
  // Use baseUrl from client or fallback to env var
  const finalBaseUrl =
    baseUrl || process.env.NEXT_PUBLIC_APP_BASE_URL || "http://localhost:3000";

  // Build headers with API key - USE SERVER-SIDE ENV VAR (no NEXT_PUBLIC_ prefix)
  const apiKeyRef = process.env.TELNYX_AI_API_KEY_REF || "telnyx-ai-api-key";

  const configs = {
    google_address_validation: {
      name: "google_address_validation",
      description: "Validate an address using Google Address Validation API",
      url: `${finalBaseUrl}/api/address/validate`,
      method: "POST",
      headers: [
        {
          name: "telnyx-ai-api-key",
          value: `{{#integration_secret}}${apiKeyRef}{{/integration_secret}}`,
        },
        {
          name: "Content-Type",
          value: "application/json",
        },
      ],
      body_parameters: {
        type: "object",
        properties: {
          addressLine: {
            type: "string",
            description:
              "Street address line (required). Example: '1600 Amphitheatre Pkwy' or 'Łokietka 37E'",
          },
          regionCode: {
            type: "string",
            description:
              "ISO 3166-1 alpha-2 region code (e.g., 'US', 'CA', 'GB', 'PL')",
          },
          locality: {
            type: "string",
            description: "City or town name (e.g., 'Mountain View', 'Kobyłka')",
          },
          administrativeArea: {
            type: "string",
            description:
              "State or province code (e.g., 'CA' for California, 'Mazowieckie' for Polish voivodeship)",
          },
          postalCode: {
            type: "string",
            description: "Postal or ZIP code (e.g., '94043')",
          },
          recipients: {
            type: "array",
            description: "Array of recipient names",
            items: {
              type: "string",
            },
          },
          organization: {
            type: "string",
            description: "Organization name",
          },
          enableUspsCass: {
            type: "boolean",
            description:
              "Enable USPS CASS validation (US/PR only). Default: false",
          },
          minimal: {
            type: "boolean",
            description:
              "If true, returns only mapsUrl, formattedAddress, postalAddress, and validationStatus. Default: false",
          },
        },
        required: ["addressLine"],
      },
    },
    expo_push_notification: {
      name: "expo_push_notification",
      description:
        "Send push notifications to mobile devices using Expo Push Notifications",
      url: `${finalBaseUrl}/api/push-notifications/send`,
      method: "POST",
      headers: [
        {
          name: "telnyx-ai-api-key",
          value: `{{#integration_secret}}${apiKeyRef}{{/integration_secret}}`,
        },
        {
          name: "Content-Type",
          value: "application/json",
        },
      ],
      body_parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              "Username (email) of the user to send notification to, use {{username}}",
          },
          title: {
            type: "string",
            description: "Notification title",
          },
          body: {
            type: "string",
            description: "Notification body text",
          },
          sound: {
            type: "string",
            description:
              "Sound to play when notification is received. Accepted values: 'default' or custom sound file name",
            default: "default",
          },
          badge: {
            type: "number",
            description:
              "Badge number to display on app icon. Must be a non-negative number",
          },
          priority: {
            type: "string",
            description:
              "Priority level for the notification. Accepted values: 'default', 'normal', 'high'",
            enum: ["default", "normal", "high"],
            default: "default",
          },
          ttl: {
            type: "number",
            description:
              "Time to live in seconds. Notification will expire after this time if not delivered",
          },
          channelId: {
            type: "string",
            description:
              "Android notification channel ID. Used to route notification to specific channel",
          },
          subtitle: {
            type: "string",
            description:
              "iOS subtitle text displayed below the title. iOS only",
          },
          categoryId: {
            type: "string",
            description:
              "iOS category identifier for notification actions. iOS only",
          },
        },
        required: ["username", "title", "body"],
      },
    },
  };

  const config = configs[actionId];
  if (!config) return null;

  return {
    type: "webhook",
    webhook: {
      ...config,
      timeout_secs: 30,
    },
  };
}

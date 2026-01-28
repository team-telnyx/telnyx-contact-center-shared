import { buildTelnyxV2Url } from "@/lib/telnyx.js";
import { getNodeById } from "@/config/voice-flow-nodes.js";
import {
  addCommandEvent,
  addNodeExecutionEvent,
  addNodeActivation,
  addEdgeActivation,
} from "@/lib/call-monitor-store.js";
import {
  evaluateExpression,
  evaluateCondition,
} from "@/lib/expression-engine.js";
import { getValueByPath, setValueByPath } from "@/lib/variable-utils.js";
import { resolveSecretReferences } from "@/lib/secrets.js";

/**
 * Apply default values from node definition to config
 * @param {Object} config - The node's config object
 * @param {Object} nodeDef - The node definition
 * @returns {Object} Config with default values applied
 */
function applyDefaultValues(config, nodeDef) {
  if (!nodeDef.config) {
    return config;
  }

  const configWithDefaults = { ...config };

  // Apply default values for any missing parameters
  Object.entries(nodeDef.config).forEach(([paramKey, paramDef]) => {
    if (
      paramDef.default !== undefined &&
      (configWithDefaults[paramKey] === undefined ||
        configWithDefaults[paramKey] === null ||
        configWithDefaults[paramKey] === "")
    ) {
      configWithDefaults[paramKey] = paramDef.default;
    }
  });

  return configWithDefaults;
}

/**
 * Execute a flow node
 * @param {Object} node - The node to execute
 * @param {string} callControlId - The call control ID
 * @param {Object} event - The webhook event that triggered this execution
 * @param {Object} executionState - Current execution state
 * @returns {Promise<Object>} Result with { success, output, variables, error }
 */
export async function executeFlowNode(
  node,
  callControlId,
  event,
  executionState
) {
  try {
    // Check node.data?.nodeType FIRST as that's the actual node type (e.g. "speak")
    // node.type is often "customNode" (the React Flow component type)
    const nodeType = node.data?.nodeType || node.type;
    const nodeDef = getNodeById(nodeType);

    if (!nodeDef) {
      return {
        success: false,
        error: `Unknown node type: ${nodeType}`,
      };
    }

    // Emit node activation for real-time monitoring
    if (executionState.flowId && node.id) {
      addNodeActivation(executionState.flowId, node.id, callControlId);
    }

    const config = node.data?.config || {};

    // Apply default values from node definition
    const configWithDefaults = applyDefaultValues(config, nodeDef);

    // Merge global variables with execution variables
    const mergedVariables = mergeVariables(
      executionState.globalVariables || {},
      executionState.variables || {}
    );


    // Replace variables in config
    const processedConfig = replaceVariables(
      configWithDefaults,
      mergedVariables
    );


    // Validate assistant_id variable substitution
    if (nodeType === "ai_assistant_start" && processedConfig.assistant_id) {
      if (
        typeof processedConfig.assistant_id === "string" &&
        processedConfig.assistant_id.match(/\{\{[^}]+\}\}/)
      ) {
        // Unresolved variable detected
      }
    }

    // Handle logical nodes (don't make API calls)
    if (nodeType === "condition") {
      return executeConditionNode(node, mergedVariables, callControlId);
    }
    if (nodeType === "switch") {
      return executeSwitchNode(node, mergedVariables, callControlId);
    }
    if (nodeType === "set_variable") {
      return executeSetVariableNode(node, mergedVariables, callControlId);
    }
    if (nodeType === "logic_gate") {
      return executeLogicGateNode(node, mergedVariables, callControlId);
    }
    if (nodeType === "flow_end") {
      return executeFlowEndNode(node, callControlId);
    }
    if (nodeType === "http_request_action") {
      return await executeHttpRequestNode(node, mergedVariables, callControlId);
    }

    // Special handling for set_queue_options node: merge queue options into client_state
    if (nodeType === "set_queue_options") {
      // Get existing client_state from execution state or webhook
      let existingClientState = {};
      
      // Try to get from webhook payload if available
      if (event?.data?.payload?.client_state) {
        try {
          const decoded = Buffer.from(
            event.data.payload.client_state,
            "base64"
          ).toString();
          existingClientState = JSON.parse(decoded);
        } catch {
          // Ignore decode errors
        }
      }

      // Build new client_state with queue options
      const newClientState = { ...existingClientState };

      // Process queue_name (can be variable or static)
      if (processedConfig.queue_name) {
        const queueNameValue = processedConfig.queue_name;
        // If it's a variable, try to resolve it
        if (
          typeof queueNameValue === "string" &&
          queueNameValue.match(/\{\{[^}]+\}\}/)
        ) {
          // Extract variable name and resolve
          const varMatch = queueNameValue.match(/\{\{([^}]+)\}\}/);
          if (varMatch) {
            const varName = varMatch[1];
            const resolvedValue = mergedVariables[varName];
            if (resolvedValue !== undefined) {
              newClientState.queue_name = resolvedValue;
            }
          }
        } else {
          newClientState.queue_name = queueNameValue;
        }
      }

      // Process priority (can be variable or static)
      if (processedConfig.priority !== undefined) {
        let priorityValue = processedConfig.priority;
        // If it's a variable string, try to resolve it
        if (
          typeof priorityValue === "string" &&
          priorityValue.match(/\{\{[^}]+\}\}/)
        ) {
          const varMatch = priorityValue.match(/\{\{([^}]+)\}\}/);
          if (varMatch) {
            const varName = varMatch[1];
            const resolvedValue = mergedVariables[varName];
            if (resolvedValue !== undefined) {
              priorityValue = parseInt(resolvedValue, 10);
            }
          }
        }
        if (!isNaN(priorityValue) && priorityValue >= 1 && priorityValue <= 100) {
          newClientState.priority = priorityValue;
        }
      }

      // Process skills (can be variable or static array)
      if (processedConfig.skills !== undefined) {
        let skillsValue = processedConfig.skills;
        // If it's a variable string, try to resolve it
        if (
          typeof skillsValue === "string" &&
          skillsValue.match(/\{\{[^}]+\}\}/)
        ) {
          const varMatch = skillsValue.match(/\{\{([^}]+)\}\}/);
          if (varMatch) {
            const varName = varMatch[1];
            const resolvedValue = mergedVariables[varName];
            if (resolvedValue && typeof resolvedValue === "object") {
              skillsValue = resolvedValue;
            }
          }
        }
        // If skills is an array, convert to required_skills object
        if (Array.isArray(skillsValue) && skillsValue.length > 0) {
          const requiredSkills = {};
          skillsValue.forEach((skill) => {
            if (skill && skill.name && skill.proficiency) {
              requiredSkills[skill.name] = skill.proficiency;
            }
          });
          if (Object.keys(requiredSkills).length > 0) {
            newClientState.required_skills = requiredSkills;
          }
        } else if (typeof skillsValue === "object" && !Array.isArray(skillsValue)) {
          // Already in object format
          newClientState.required_skills = skillsValue;
        }
      }

      // Encode and update client_state
      const clientStateBase64 = Buffer.from(
        JSON.stringify(newClientState)
      ).toString("base64");

      const clientStateUpdateResult = await callTelnyxAction(
        executionState?.flowId || null,
        "client_state_update",
        callControlId,
        { client_state: clientStateBase64 }
      );

      if (clientStateUpdateResult.success) {
        return {
          success: true,
          output: 0,
          variables: mergedVariables,
          // Include updated client_state in result so it can be passed to next node
          client_state: clientStateBase64,
        };
      } else {
        return {
          success: false,
          error: clientStateUpdateResult.error || "Failed to update client state",
          variables: mergedVariables,
        };
      }
    }

    // Special handling for enqueue node
    if (nodeType === "enqueue") {
      // If use_queue_options is enabled, read queue options from call's client_state
      if (processedConfig.use_queue_options) {
        // Get client_state from the call (set by Set Queue Options node) or from node config (fallback)
        let clientStateSource = null;
        
        // First, try to get from webhook event (call's current client_state)
        if (event?.data?.payload?.client_state) {
          clientStateSource = event.data.payload.client_state;
        }
        // Fallback to node config if not in event (for backward compatibility)
        else if (processedConfig.client_state) {
          clientStateSource = processedConfig.client_state;
        }

        if (clientStateSource) {
          try {
            const decoded = Buffer.from(clientStateSource, "base64").toString();
            const clientStateObj = JSON.parse(decoded);

            console.log(
              "[FlowEngine] Enqueue with use_queue_options - client_state decoded:",
              clientStateObj
            );
            console.log(
              "[FlowEngine] Enqueue with use_queue_options - current queue_name:",
              processedConfig.queue_name
            );

            // Clear queue_name if it's null - we'll read it from client_state instead
            if (processedConfig.queue_name === null) {
              delete processedConfig.queue_name;
            }

            // Override queue_name from client_state
            if (clientStateObj.queue_name) {
              processedConfig.queue_name = clientStateObj.queue_name;
              console.log(
                "[FlowEngine] Enqueue with use_queue_options - updated queue_name to:",
                processedConfig.queue_name
              );
            } else {
              console.warn(
                "[FlowEngine] Enqueue with use_queue_options - queue_name not found in client_state"
              );
            }

            // Priority and required_skills should already be in client_state
            // Don't convert required_skills to routing_skills (Telnyx doesn't support routing_skills parameter)
            // Remove routing_skills if it exists (not supported by Telnyx API)
            delete processedConfig.routing_skills;
            delete processedConfig.routing_priority;

            // Remove client_state from config since we're using the call's client_state
            // The call's client_state will be sent automatically by Telnyx
            delete processedConfig.client_state;
          } catch (err) {
            console.warn(
              "[FlowEngine] Failed to decode client_state for use_queue_options:",
              err
            );
          }
        } else {
          console.warn(
            "[FlowEngine] Enqueue with use_queue_options - no client_state found in event or config"
          );
        }

        // Remove use_queue_options flag from request (it's only a config flag)
        delete processedConfig.use_queue_options;
      } else {
        // When NOT using queue options, update client_state BEFORE enqueuing
        // This ensures the call.enqueued webhook includes routing parameters
        if (processedConfig.client_state) {
          const clientStateUpdateResult = await callTelnyxAction(
            executionState?.flowId || null,
            "client_state_update",
            callControlId,
            { client_state: processedConfig.client_state }
          );
          if (!clientStateUpdateResult.success) {
            // Continue with enqueue anyway
          }
        }
      }
    }

    // Call the Telnyx API
    const result = await callTelnyxAction(
      executionState?.flowId || null,
      nodeDef.telnyxAction,
      callControlId,
      processedConfig
    );

    // Store ai_assistant_start node ID for later webhook routing
    if (nodeType === "ai_assistant_start" && result.success) {
      if (!result.variables) {
        result.variables = {};
      }
      result.variables.ai_assistant_start_node_id = node.id;
    }

    // Determine output based on result
    let output = 0; // Default to first output
    if (!result.success && nodeDef.outputs > 1) {
      output = 1; // Use failure output if available
    }

    // Special handling for record_start: output 0 = started (immediate), output 1 = saved (webhook)
    // When recording starts successfully, use output 0 to follow the "Started" edge immediately
    if (
      nodeType === "record_start" &&
      result.success &&
      result.responseData?.data
    ) {
      const responseResult = result.responseData.data.result;
      const recordingId = result.responseData.data.recording_id;

      // If result is "ok" and we have a recording_id, the recording started successfully
      if (responseResult === "ok" && recordingId) {
        output = 0; // Use "Started" output (immediate continuation)
      }
    }

    return {
      success: result.success,
      output,
      variables: result.variables || {},
      error: result.error,
      responseData: result.responseData, // Pass through for potential future use
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Determine the next node to execute based on current node and event
 * @param {Object} flow - The complete flow definition
 * @param {Object} currentNode - The current node
 * @param {Object} event - The webhook event
 * @param {Object} executionState - Current execution state
 * @returns {Object|null} Next node or null if flow should end
 */
export function determineNextNode(flow, currentNode, event, executionState) {
  const { edges = [] } = flow;
  const currentNodeId = currentNode.id;
  const outgoingEdges = edges.filter((edge) => edge.source === currentNodeId);

  if (outgoingEdges.length === 0) {
    return null;
  }

  if (outgoingEdges.length === 1) {
    const targetId = outgoingEdges[0].target;
    return flow.nodes.find((n) => n.id === targetId) || null;
  }

  const output = executionState.lastOutput || 0;

  let edge = outgoingEdges.find((e) => {
    const sourceHandle = e.sourceHandle || "output-0";
    const handleIndex = parseInt(sourceHandle.replace("output-", ""), 10);
    return handleIndex === output;
  });

  if (!edge) {
    edge = outgoingEdges[0];
  }

  const targetId = edge.target;
  return flow.nodes.find((n) => n.id === targetId) || null;
}

/**
 * Determine ALL next nodes to execute in parallel based on current node and event
 * Returns array of nodes when multiple edges connect from same output handle
 * @param {Object} flow - The complete flow definition
 * @param {Object} currentNode - The current node
 * @param {Object} event - The webhook event
 * @param {Object} executionState - Current execution state
 * @returns {Array<Object>} Array of next nodes (empty if flow should end)
 */
export function determineNextNodes(flow, currentNode, event, executionState) {
  const { edges = [] } = flow;
  const currentNodeId = currentNode.id;
  const outgoingEdges = edges.filter((edge) => edge.source === currentNodeId);

  if (outgoingEdges.length === 0) {
    return [];
  }

  const output = executionState.lastOutput || 0;

  const matchingEdges = outgoingEdges.filter((e) => {
    const sourceHandle = e.sourceHandle || "output-0";
    const handleIndex = parseInt(sourceHandle.replace("output-", ""), 10);
    return handleIndex === output;
  });

  const edgesToFollow =
    matchingEdges.length > 0 ? matchingEdges : outgoingEdges;

  // Process edge variable mappings
  const payload = event?.data?.payload || {};
  edgesToFollow.forEach((edge) => {
    if (
      edge.data?.variableMappings &&
      Array.isArray(edge.data.variableMappings)
    ) {
      const extractedVariables = extractVariablesFromWebhook(
        payload,
        edge.data.variableMappings
      );
      // Merge extracted variables into execution state
      Object.assign(executionState.variables, extractedVariables);
    }
  });

  // Emit edge activations for real-time monitoring
  if (executionState.flowId && executionState.callControlId) {
    edgesToFollow.forEach((edge) => {
      addEdgeActivation(
        executionState.flowId,
        edge.source,
        edge.target,
        executionState.callControlId
      );
    });
  }

  const nextNodes = edgesToFollow
    .map((edge) => flow.nodes.find((n) => n.id === edge.target))
    .filter(Boolean);

  return nextNodes;
}

/**
 * Transform transcription options from node config format to Telnyx API format
 * Node config has: transcription_engine, transcription_engine_config, transcription_tracks at top level
 * For Deepgram/Telnyx: transcription_model and language are also at top level
 * API expects: transcription: true, transcription_config: { transcription_engine, transcription_engine_config, transcription_tracks }
 * @param {Object} body - The request body to transform
 * @returns {Object} Transformed body with transcription options in correct format
 */
function transformTranscriptionOptions(body) {
  // Check if transcription is enabled (indicated by presence of transcription_engine)
  if (body.transcription_engine) {
    // Set transcription flag to true
    body.transcription = true;

    const engine = body.transcription_engine;
    const transcriptionConfig = {
      transcription_engine: engine,
    };

    // Handle different engine types
    if (engine === "Google" || engine === "Azure") {
      // For Google and Azure, use transcription_engine_config if present
      if (
        body.transcription_engine_config &&
        Object.keys(body.transcription_engine_config).length > 0
      ) {
        transcriptionConfig.transcription_engine_config =
          body.transcription_engine_config;
      }
    } else if (engine === "Deepgram" || engine === "Telnyx") {
      // For Deepgram and Telnyx, build transcription_engine_config from top-level fields
      const engineConfig = {
        transcription_engine: engine,
      };

      // transcription_model is required for Deepgram, should be included for Telnyx
      if (body.transcription_model) {
        engineConfig.transcription_model = body.transcription_model;
      } else {
        // Use defaults if missing
        if (engine === "Deepgram") {
          engineConfig.transcription_model = "deepgram/nova-2";
        } else if (engine === "Telnyx") {
          engineConfig.transcription_model = "openai/whisper-tiny";
        }
      }

      // Add language if present
      if (body.language) {
        engineConfig.language = body.language;
      }

      transcriptionConfig.transcription_engine_config = engineConfig;
    } else {
      // For other engines, use transcription_engine_config if present
      if (
        body.transcription_engine_config &&
        Object.keys(body.transcription_engine_config).length > 0
      ) {
        transcriptionConfig.transcription_engine_config =
          body.transcription_engine_config;
      }
    }

    // Add transcription_tracks if present
    if (body.transcription_tracks) {
      transcriptionConfig.transcription_tracks = body.transcription_tracks;
    }

    // Set transcription_config in body
    body.transcription_config = transcriptionConfig;

    // Remove top-level transcription fields (they're now in transcription_config)
    delete body.transcription_engine;
    delete body.transcription_engine_config;
    delete body.transcription_tracks;
    // Also remove transcription_model and language if they were at top level
    delete body.transcription_model;
    delete body.language;
  }

  return body;
}

/**
 * Clean up empty string values from recording options
 * Empty strings should be removed as they're not valid values
 * @param {Object} body - The request body to clean
 * @returns {Object} Cleaned body with empty strings removed
 */
function cleanupRecordingOptions(body) {
  // List of recording-related fields that should not be empty strings
  const recordingFields = [
    "record",
    "record_trim",
    "record_track",
    "record_format",
    "record_channels",
    "record_custom_file_name",
  ];

  recordingFields.forEach((field) => {
    if (body[field] === "") {
      delete body[field];
    }
  });

  return body;
}

/**
 * Call a Telnyx API action
 * @param {string} action - The action name
 * @param {string} callControlId - The call control ID
 * @param {Object} params - The parameters for the action
 * @returns {Promise<Object>} Result with { success, variables, error }
 */
export async function callTelnyxAction(flowId, action, callControlId, params) {
  // flowId is optional and used for monitoring
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      throw new Error("TELNYX_API_KEY not configured");
    }

    let url;
    let method = "POST";
    let body = { ...params };

    // Map actions to endpoints
    switch (action) {
      case "create_call":
        url = buildTelnyxV2Url("/calls");
        method = "POST";
        // callControlId is not needed for creating a new call
        // Filter out incomplete sip_headers (must have both name and value)
        if (body.sip_headers && Array.isArray(body.sip_headers)) {
          body.sip_headers = body.sip_headers.filter(
            (h) => h && h.name && h.value
          );
          if (body.sip_headers.length === 0) {
            delete body.sip_headers;
          }
        }
        // Filter out incomplete custom_headers (must have name or value)
        if (body.custom_headers && Array.isArray(body.custom_headers)) {
          body.custom_headers = body.custom_headers.filter(
            (h) => h && (h.name || h.value)
          );
          if (body.custom_headers.length === 0) {
            delete body.custom_headers;
          }
        }
        // Transform transcription options to correct API format
        body = transformTranscriptionOptions(body);
        // Clean up empty string values in recording options
        body = cleanupRecordingOptions(body);
        break;

      case "answer":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/answer`
        );
        method = "POST";
        // Filter out incomplete sip_headers (must have both name and value)
        if (body.sip_headers && Array.isArray(body.sip_headers)) {
          body.sip_headers = body.sip_headers.filter(
            (h) => h && h.name && h.value
          );
          if (body.sip_headers.length === 0) {
            delete body.sip_headers;
          }
        }
        // Filter out incomplete custom_headers (must have name or value)
        if (body.custom_headers && Array.isArray(body.custom_headers)) {
          body.custom_headers = body.custom_headers.filter(
            (h) => h && (h.name || h.value)
          );
          if (body.custom_headers.length === 0) {
            delete body.custom_headers;
          }
        }
        // Transform transcription options to correct API format
        body = transformTranscriptionOptions(body);
        // Clean up empty string values in recording options
        body = cleanupRecordingOptions(body);
        break;

      case "hangup":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/hangup`
        );
        method = "POST";
        break;

      case "reject":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/reject`
        );
        method = "POST";
        break;

      case "noise_suppression_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/suppression_start`
        );
        method = "POST";
        // Build noise_suppression_engine_config if attenuation_limit is provided
        if (body.attenuation_limit !== undefined) {
          body.noise_suppression_engine_config = {
            attenuation_limit: body.attenuation_limit,
          };
          delete body.attenuation_limit;
        }
        break;

      case "noise_suppression_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/suppression_stop`
        );
        method = "POST";
        break;

      case "switch_supervisor_role":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/switch_supervisor_role`
        );
        method = "POST";
        break;

      case "transfer":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/transfer`
        );
        method = "POST";
        break;

      case "bridge":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/bridge`
        );
        method = "POST";
        break;

      case "enqueue":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/enqueue`
        );
        method = "POST";
        // Remove unsupported parameters (routing_skills is not supported by Telnyx API)
        // use_queue_options is only a config flag, not an API parameter
        delete body.routing_skills;
        delete body.routing_priority;
        delete body.use_queue_options;
        break;

      case "leave_queue":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/leave_queue`
        );
        method = "POST";
        break;

      case "client_state_update":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/client_state_update`
        );
        method = "PUT";
        break;

      case "refer":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/refer`
        );
        method = "POST";
        // Filter out incomplete sip_headers (must have both name and value)
        if (body.sip_headers && Array.isArray(body.sip_headers)) {
          body.sip_headers = body.sip_headers.filter(
            (h) => h && h.name && h.value
          );
          if (body.sip_headers.length === 0) {
            delete body.sip_headers;
          }
        }
        // Filter out incomplete custom_headers (must have name or value)
        if (body.custom_headers && Array.isArray(body.custom_headers)) {
          body.custom_headers = body.custom_headers.filter(
            (h) => h && (h.name || h.value)
          );
          if (body.custom_headers.length === 0) {
            delete body.custom_headers;
          }
        }
        break;

      case "speak":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/speak`
        );
        method = "POST";
        // Transform voice_api_key_ref into voice_settings format for ElevenLabs
        if (body.voice_api_key_ref) {
          body.voice_settings = {
            ...body.voice_settings,
            api_key_ref: body.voice_api_key_ref,
          };
          delete body.voice_api_key_ref;
        }
        // Set default voice_speed if not present
        if (!body.voice_settings?.voice_speed) {
          body.voice_settings = {
            ...body.voice_settings,
            voice_speed: 1,
          };
        }
        break;

      case "playback_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/playback_start`
        );
        method = "POST";
        // Migrate old loop value "0" to "infinity" for backward compatibility
        if (body.loop === "0" || body.loop === 0) {
          body.loop = "infinity";
        }
        // Convert loop to correct type: "infinity" stays as string, numbers become integers
        if (body.loop && body.loop !== "infinity") {
          const loopNum = parseInt(body.loop, 10);
          if (!isNaN(loopNum)) {
            body.loop = loopNum; // Send as integer
          }
        }
        // Default to 1 (integer) if no loop specified
        if (!body.loop) {
          body.loop = 1;
        }

        // Check if audio_url is actually a media_name (from Media Library)
        // Media names don't start with http:// or https://
        if (body.audio_url) {
          const audioValue = String(body.audio_url).trim();
          const isUrl =
            audioValue.startsWith("http://") ||
            audioValue.startsWith("https://");

          if (!isUrl) {
            // It's a media_name, not a URL
            body.media_name = audioValue;
            delete body.audio_url;
          }
        }

        break;

      case "gather":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/gather`
        );
        method = "POST";
        break;

      case "gather_using_audio":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/gather_using_audio`
        );
        method = "POST";
        break;

      case "gather_using_speak":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/gather_using_speak`
        );
        method = "POST";
        // Transform voice_api_key_ref into voice_settings format for ElevenLabs
        if (body.voice_api_key_ref) {
          body.voice_settings = {
            ...body.voice_settings,
            api_key_ref: body.voice_api_key_ref,
          };
          delete body.voice_api_key_ref;
        }
        // Set default voice_speed if not present
        if (!body.voice_settings?.voice_speed) {
          body.voice_settings = {
            ...body.voice_settings,
            voice_speed: 1,
          };
        }
        break;

      case "ai_assistant_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/ai_assistant_start`
        );
        method = "POST";
        // Extract top-level parameters
        const {
          client_state,
          webhook_url,
          webhook_event_url,
          command_id,
          assistant_id,
          interruption_settings,
          transcription,
          voice,
          voice_settings,
          ...otherParams
        } = params;

        // Validate assistant_id - check if it still contains unresolved variable placeholders
        if (
          assistant_id &&
          typeof assistant_id === "string" &&
          assistant_id.match(/\{\{[^}]+\}\}/)
        ) {
          const availableVars = Object.keys(params)
            .filter((k) => k !== "assistant_id")
            .join(", ");
          throw new Error(
            `assistant_id variable not resolved: ${assistant_id}.\n\n` +
              `To fix this:\n` +
              `1. If using HTTP Request trigger: Add edge variable mapping from HTTP Request node to map a field from request body (e.g., "payload.assistant_id") to variable "assistant_id"\n` +
              `2. Add a "Set Variable" node before this node to set assistant_id = "your-assistant-id"\n` +
              `3. Or use a static assistant ID instead of {{assistant_id}}\n\n` +
              `Available variables in this node: ${availableVars || "none"}`
          );
        }

        // Build payload with exact structure required by Telnyx API
        body = {
          assistant: {
            id: assistant_id,
          },
          interruption_settings: interruption_settings || null,
          transcription: transcription || null,
          voice: voice || null,
          voice_settings: voice_settings || {},
        };

        // Add optional top-level parameters if they exist
        if (client_state) body.client_state = client_state;
        if (webhook_url) body.webhook_url = webhook_url;
        if (webhook_event_url) body.webhook_event_url = webhook_event_url;
        if (command_id) body.command_id = command_id;
        break;

      case "ai_assistant_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/ai_assistant_stop`
        );
        method = "POST";
        break;

      case "record_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_start`
        );
        method = "POST";
        break;

      case "record_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_stop`
        );
        method = "POST";
        break;

      case "record_pause":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_pause`
        );
        method = "POST";
        break;

      case "record_resume":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_resume`
        );
        method = "POST";
        break;

      case "transcription_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/transcription_start`
        );
        method = "POST";
        break;

      case "transcription_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId
          )}/actions/transcription_stop`
        );
        method = "POST";
        break;

      case "streaming_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`
        );
        method = "POST";

        // Handle AI streaming provider auto-configuration
        if (
          body.ai_streaming_provider &&
          body.ai_streaming_provider !== "custom"
        ) {
          // Import provider config
          const { getTelnyxStreamingConfig } = await import(
            "@/config/ai-streaming-providers"
          );
          const providerConfig = getTelnyxStreamingConfig(
            body.ai_streaming_provider
          );

          if (providerConfig) {
            // Determine WebSocket URL based on provider
            const wsProvider =
              body.ai_streaming_provider === "google-gemini"
                ? "google"
                : "openai";

            // Get base URL and strip any existing protocol
            let baseUrl =
              process.env.NEXT_PUBLIC_BASE_URL ||
              process.env.VERCEL_URL ||
              "localhost:3000";
            baseUrl = baseUrl.replace(/^https?:\/\//, ""); // Remove http:// or https://

            const protocol = baseUrl.startsWith("localhost") ? "ws" : "wss";

            // Override port for testing if NEXT_PUBLIC_STREAMING_PORT is set
            let finalUrl = baseUrl;
            if (process.env.NEXT_PUBLIC_STREAMING_PORT) {
              finalUrl =
                baseUrl.replace(/:\d+$/, "") +
                ":" +
                process.env.NEXT_PUBLIC_STREAMING_PORT;
            }

            body.stream_url = `${protocol}://${finalUrl}/api/voice/streaming/ws/${wsProvider}`;

            // Apply provider-specific Telnyx configuration
            Object.assign(body, providerConfig);
          }
        }

        // Remove ai_streaming_provider from body (not part of Telnyx API)
        delete body.ai_streaming_provider;

        // Convert sampling_rate to integer if it's a string
        if (
          body.stream_bidirectional_sampling_rate &&
          typeof body.stream_bidirectional_sampling_rate === "string"
        ) {
          body.stream_bidirectional_sampling_rate = parseInt(
            body.stream_bidirectional_sampling_rate,
            10
          );
        }
        break;

      case "streaming_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/streaming_stop`
        );
        method = "POST";
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }



    // Capture timestamp before making the API call for accurate monitoring
    const commandTimestamp = new Date().toISOString();

    // Make the API call
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Telnyx API error: ${response.status}`,
      };
    }

    const data = await response.json();

    // Log sent command to memory for monitoring (use captured timestamp)
    if (callControlId) {
      addCommandEvent(
        callControlId,
        action,
        body,
        data,
        commandTimestamp,
        flowId
      );
    }

    return {
      success: true,
      variables: extractVariablesFromResponse(data),
      responseData: data, // Include full response for output determination
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Replace variable placeholders in config with actual values
 * Supports {{variable_name}} and dot notation {{variable.path}} syntax
 */
/**
 * Replace variables in a JSON body string, using JSON.stringify for objects/arrays
 * This is used specifically for HTTP request JSON bodies where objects should be serialized
 * @param {string} jsonString - The JSON string with {{variable}} placeholders
 * @param {Object} variables - The variables object
 * @returns {string} The JSON string with variables replaced
 */
function replaceVariablesInJsonBody(jsonString, variables) {
  return jsonString.replace(/\{\{([^}]+)\}\}/g, (match, varPath) => {
    const trimmedPath = varPath.trim();

    // Handle global prefix
    if (trimmedPath.startsWith("global.")) {
      const path = trimmedPath.substring(7);
      const val = getValueByPath(variables.global || {}, path);
      if (val !== undefined && val !== null) {
        // Use JSON.stringify for objects/arrays, String for primitives
        const stringValue =
          typeof val === "string"
            ? val
            : typeof val === "object"
            ? JSON.stringify(val)
            : String(val);
        console.log(
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (global.${path})`
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found in global variables`
      );
      return match;
    }

    // Handle payload prefix
    if (trimmedPath.startsWith("payload.")) {
      const path = trimmedPath.substring(8);
      const val = getValueByPath(variables.payload || {}, path);
      if (val !== undefined && val !== null) {
        const stringValue =
          typeof val === "string"
            ? val
            : typeof val === "object"
            ? JSON.stringify(val)
            : String(val);
        console.log(
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (payload.${path})`
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found in payload variables`
      );
      return match;
    }

    // Handle response prefix
    if (trimmedPath.startsWith("response.")) {
      const path = trimmedPath.substring(9);
      const val = getValueByPath(variables.response || {}, path);
      if (val !== undefined && val !== null) {
        const stringValue =
          typeof val === "string"
            ? val
            : typeof val === "object"
            ? JSON.stringify(val)
            : String(val);
        console.log(
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (response.${path})`
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found in response variables`
      );
      return match;
    }

    // Handle dot notation
    if (trimmedPath.includes(".")) {
      const val = getValueByPath(variables, trimmedPath);
      if (val !== undefined && val !== null) {
        const stringValue =
          typeof val === "string"
            ? val
            : typeof val === "object"
            ? JSON.stringify(val)
            : String(val);
        console.log(
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (dot notation)`
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found (dot notation)`
      );
      return match;
    }

    // Direct variable access
    if (variables[trimmedPath] !== undefined) {
      const replacedValue = variables[trimmedPath];
      // Use JSON.stringify for objects/arrays, String for primitives
      const stringValue =
        typeof replacedValue === "string"
          ? replacedValue
          : typeof replacedValue === "object"
          ? JSON.stringify(replacedValue)
          : String(replacedValue);
      console.log(
        `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (direct)`
      );
      return stringValue;
    }
    console.warn(
      `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found. Available variables: ${Object.keys(
        variables
      ).join(", ")}`
    );
    return match;
  });
}

function replaceVariables(config, variables) {
  const processed = {};

  Object.entries(config).forEach(([key, value]) => {
    if (typeof value === "string") {
      // Replace {{variable}} or {{variable.path}} with actual value
      processed[key] = value.replace(/\{\{([^}]+)\}\}/g, (match, varPath) => {
        const trimmedPath = varPath.trim();

        // Handle global prefix
        if (trimmedPath.startsWith("global.")) {
          const path = trimmedPath.substring(7);
          const val = getValueByPath(variables.global || {}, path);
          if (val !== undefined && val !== null) {
            // Convert to string for proper substitution
            const stringValue = typeof val === "string" ? val : String(val);
            console.log(
              `[replaceVariables] Replaced {{${trimmedPath}}} with ${JSON.stringify(
                stringValue
              )} (global.${path})`
            );
            return stringValue;
          }
          console.warn(
            `[replaceVariables] Variable {{${trimmedPath}}} not found in global variables`
          );
          return match;
        }

        // Handle payload prefix
        if (trimmedPath.startsWith("payload.")) {
          const path = trimmedPath.substring(8);
          const val = getValueByPath(variables.payload || {}, path);
          if (val !== undefined && val !== null) {
            // Convert to string for proper substitution
            const stringValue = typeof val === "string" ? val : String(val);
            console.log(
              `[replaceVariables] Replaced {{${trimmedPath}}} with ${JSON.stringify(
                stringValue
              )} (payload.${path})`
            );
            return stringValue;
          }
          console.warn(
            `[replaceVariables] Variable {{${trimmedPath}}} not found in payload variables`
          );
          return match;
        }

        // Handle response prefix
        if (trimmedPath.startsWith("response.")) {
          const path = trimmedPath.substring(9);
          const val = getValueByPath(variables.response || {}, path);
          if (val !== undefined && val !== null) {
            // Convert to string for proper substitution
            const stringValue = typeof val === "string" ? val : String(val);
            console.log(
              `[replaceVariables] Replaced {{${trimmedPath}}} with ${JSON.stringify(
                stringValue
              )} (response.${path})`
            );
            return stringValue;
          }
          console.warn(
            `[replaceVariables] Variable {{${trimmedPath}}} not found in response variables`
          );
          return match;
        }

        // Handle dot notation
        if (trimmedPath.includes(".")) {
          const val = getValueByPath(variables, trimmedPath);
          if (val !== undefined && val !== null) {
            // Convert to string for proper substitution
            const stringValue = typeof val === "string" ? val : String(val);
            console.log(
              `[replaceVariables] Replaced {{${trimmedPath}}} with ${JSON.stringify(
                stringValue
              )} (dot notation)`
            );
            return stringValue;
          }
          console.warn(
            `[replaceVariables] Variable {{${trimmedPath}}} not found (dot notation)`
          );
          return match;
        }

        // Direct variable access
        if (variables[trimmedPath] !== undefined) {
          const replacedValue = variables[trimmedPath];
          // Convert to string if it's not already a string (for proper substitution)
          const stringValue =
            typeof replacedValue === "string"
              ? replacedValue
              : String(replacedValue);
          console.log(
            `[replaceVariables] Replaced {{${trimmedPath}}} with ${JSON.stringify(
              stringValue
            )} (direct)`
          );
          return stringValue;
        }
        console.warn(
          `[replaceVariables] Variable {{${trimmedPath}}} not found. Available variables: ${Object.keys(
            variables
          ).join(", ")}`
        );
        return match;
      });
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // Recursively process nested objects
      processed[key] = replaceVariables(value, variables);
    } else if (Array.isArray(value)) {
      // Process arrays
      processed[key] = value.map((item) =>
        typeof item === "object" ? replaceVariables(item, variables) : item
      );
    } else {
      processed[key] = value;
    }
  });

  return processed;
}

/**
 * Extract useful variables from Telnyx API response
 * Now extracts all data as nested objects for dot notation access
 */
function extractVariablesFromResponse(response) {
  const variables = {};

  if (response.data) {
    // Store the entire response.data for flexible access
    Object.assign(variables, response.data);
  }

  return variables;
}

/**
 * Extract variables from webhook payload based on edge mappings
 * @param {Object} payload - Webhook payload
 * @param {Array} variableMappings - Array of {variableName, sourcePath}
 * @returns {Object} Extracted variables
 */
export function extractVariablesFromWebhook(payload, variableMappings = []) {
  const variables = {};

  variableMappings.forEach((mapping) => {
    const { variableName, sourcePath } = mapping;
    if (!variableName || !sourcePath) return;

    let value;
    // If sourcePath starts with "payload.", use it directly on the payload object
    // Otherwise, wrap payload in { payload: ... } for backward compatibility
    if (sourcePath.startsWith("payload.")) {
      const path = sourcePath.substring(8); // Remove "payload." prefix
      value = getValueByPath(payload, path);
    } else {
      value = getValueByPath({ payload }, sourcePath);
    }

    if (value !== undefined) {
      variables[variableName] = value;
      console.log(
        `[extractVariablesFromWebhook] Extracted ${variableName} = ${JSON.stringify(
          value
        )} from ${sourcePath}`
      );
    } else {
      console.warn(
        `[extractVariablesFromWebhook] Failed to extract ${variableName} from ${sourcePath}`
      );
    }
  });

  return variables;
}

/**
 * Merge global and execution variables (execution takes precedence)
 * @param {Object} globalVars - Global variables
 * @param {Object} executionVars - Execution variables
 * @returns {Object} Merged variables
 */
function mergeVariables(globalVars, executionVars) {
  return {
    global: globalVars,
    payload: executionVars.payload || {},
    response: executionVars.response || {},
    ...executionVars,
  };
}

/**
 * Find the first entry node in a flow (answer or dial)
 */
export function findEntryNode(flow) {
  const { nodes = [] } = flow;
  return nodes.find((node) => {
    const nodeType = node.type || node.data?.nodeType;
    return nodeType === "answer" || nodeType === "dial";
  });
}

/**
 * Process webhook event and determine if flow should continue
 * @param {string} eventType - The webhook event type
 * @param {Object} currentNode - The current node being executed
 * @returns {boolean} Whether to continue to next node immediately
 */
export function shouldContinueImmediately(eventType, currentNode) {
  // Check data.nodeType first (the actual node type), then fall back to type (React Flow node type)
  const nodeType = currentNode.data?.nodeType || currentNode.type;

  console.log(
    `[shouldContinueImmediately] eventType: ${eventType}, nodeType: ${nodeType}`
  );
  console.log(
    `[shouldContinueImmediately] currentNode.type: ${currentNode.type}, currentNode.data?.nodeType: ${currentNode.data?.nodeType}`
  );

  // Some nodes trigger immediate continuation, others wait for webhooks
  const immediateNodes = [
    "answer",
    "hangup",
    "speak",
    "play_audio",
    "ai_assistant_start",
    "ai_assistant_stop",
    "record_stop",
    "record_pause",
    "record_resume",
    "transcription_start",
    "noise_suppression_start",
    "noise_suppression_stop",
    "switch_supervisor_role",
    "transcription_stop",
    // Logical/Integration nodes that execute immediately
    "http_request_action",
    "set_variable",
    "condition",
    "switch",
    "logic_gate",
    "flow_end",
  ];

  // Note: record_start is NOT in this list because it has dual behavior:
  // - Output 0 (Started) should trigger immediately based on API response
  // - Output 1 (Saved) should trigger on call.recording.saved webhook
  // It's handled specially in the webhook handler

  const result = immediateNodes.includes(nodeType);
  console.log(
    `[shouldContinueImmediately] result: ${result}, immediateNodes.includes("${nodeType}"): ${immediateNodes.includes(
      nodeType
    )}`
  );

  return result;
}

/**
 * Extract DTMF digits from gather webhook event
 */
export function extractGatherResult(event) {
  const payload = event.data?.payload || {};
  return {
    digits: payload.digits || "",
    result: payload.result || "",
  };
}

/**
 * Execute Condition Node
 * Evaluates a condition and routes to True (output 0) or False (output 1)
 */
function executeConditionNode(node, variables, callControlId) {
  try {
    const config = node.data?.config || {};
    const { leftOperand, operator, rightOperand, dataType } = config;

    if (!operator) {
      const error = "Condition node missing operator";
      addNodeExecutionEvent(
        callControlId,
        "condition",
        node.id,
        node.data?.label || "Condition",
        { error },
        false,
        1,
        executionState?.flowId || null
      );
      return {
        success: false,
        error,
      };
    }

    const result = evaluateCondition(
      leftOperand || "",
      operator,
      rightOperand || "",
      dataType || "string",
      variables
    );

    if (!result.success) {
      addNodeExecutionEvent(
        callControlId,
        "condition",
        node.id,
        node.data?.label || "Condition",
        {
          left_operand: leftOperand,
          operator,
          right_operand: rightOperand,
          data_type: dataType,
          error: result.error,
        },
        false,
        1,
        executionState?.flowId || null
      );
      return {
        success: false,
        error: result.error,
      };
    }

    // Output 0 = True, Output 1 = False
    const output = result.result ? 0 : 1;

    // Log successful execution
    addNodeExecutionEvent(
      callControlId,
      "condition",
      node.id,
      node.data?.label || "Condition",
      {
        left_operand: leftOperand,
        operator,
        right_operand: rightOperand,
        data_type: dataType,
        result: result.result,
        output_path: result.result ? "True (0)" : "False (1)",
      },
      true,
      output
    );

    return {
      success: true,
      output,
      variables: {},
    };
  } catch (error) {
    const errorMsg = error.message || "Condition evaluation failed";
    addNodeExecutionEvent(
      callControlId,
      "condition",
      node.id,
      node.data?.label || "Condition",
      { error: errorMsg },
      false,
      1
    );
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Execute Switch Node
 * Routes to different outputs based on variable value matching cases
 */
function executeSwitchNode(node, variables, callControlId) {
  try {
    const config = node.data?.config || {};
    const { variable, cases } = config;

    if (!variable) {
      const error = "Switch node missing variable to evaluate";
      addNodeExecutionEvent(
        callControlId,
        "switch",
        node.id,
        node.data?.label || "Switch",
        { error },
        false,
        0,
        executionState?.flowId || null
      );
      return {
        success: false,
        error,
      };
    }

    // Resolve the variable value
    let varValue = variable;
    if (variable.startsWith("{{") && variable.endsWith("}}")) {
      const varPath = variable.slice(2, -2).trim();
      varValue = getValueByPath(variables, varPath);
    }

    // Match against cases
    let outputIndex = cases ? cases.length : 0; // Default output is last
    let matchedCase = null;

    if (cases && Array.isArray(cases)) {
      for (let i = 0; i < cases.length; i++) {
        const caseItem = cases[i];
        if (String(varValue) === String(caseItem.value)) {
          outputIndex = i;
          matchedCase = caseItem;
          break;
        }
      }
    }

    // Log successful execution
    addNodeExecutionEvent(
      callControlId,
      "switch",
      node.id,
      node.data?.label || "Switch",
      {
        variable,
        variable_value: varValue,
        cases: cases || [],
        matched_case: matchedCase,
        output_index: outputIndex,
        output_path: matchedCase ? `Case: ${matchedCase.value}` : "Default",
      },
      true,
      outputIndex
    );

    return {
      success: true,
      output: outputIndex,
      variables: {},
    };
  } catch (error) {
    const errorMsg = error.message || "Switch evaluation failed";
    addNodeExecutionEvent(
      callControlId,
      "switch",
      node.id,
      node.data?.label || "Switch",
      { error: errorMsg },
      false,
      0,
      executionState?.flowId || null
    );
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Execute Set Variable Node
 * Evaluates an expression and stores result in a variable
 */
function executeSetVariableNode(node, variables, callControlId) {
  try {
    const config = node.data?.config || {};
    const { variableName, expression } = config;

    if (!variableName) {
      const error = "Set variable node missing variable name";
      addNodeExecutionEvent(
        callControlId,
        "set_variable",
        node.id,
        node.data?.label || "Set Variable",
        { error },
        false,
        0,
        executionState?.flowId || null
      );
      return {
        success: false,
        error,
      };
    }

    if (!expression) {
      const error = "Set variable node missing expression";
      addNodeExecutionEvent(
        callControlId,
        "set_variable",
        node.id,
        node.data?.label || "Set Variable",
        { error },
        false,
        0,
        executionState?.flowId || null
      );
      return {
        success: false,
        error,
      };
    }

    // Evaluate the expression
    const result = evaluateExpression(expression, variables);

    if (!result.success) {
      addNodeExecutionEvent(
        callControlId,
        "set_variable",
        node.id,
        node.data?.label || "Set Variable",
        {
          variable_name: variableName,
          expression,
          error: result.error,
        },
        false,
        0,
        executionState?.flowId || null
      );
      return {
        success: false,
        error: result.error,
      };
    }

    // Store the result in a new variable
    const newVariables = {
      [variableName]: result.result,
    };

    // Log successful execution
    addNodeExecutionEvent(
      callControlId,
      "set_variable",
      node.id,
      node.data?.label || "Set Variable",
      {
        variable_name: variableName,
        expression,
        result: result.result,
      },
      true,
      0
    );

    return {
      success: true,
      output: 0,
      variables: newVariables,
    };
  } catch (error) {
    console.error("[executeSetVariableNode] Error:", error);
    console.error("[executeSetVariableNode] Stack:", error.stack);
    addNodeExecutionEvent(
      callControlId,
      "set_variable",
      node.id,
      node.data?.label || "Set Variable",
      {
        error: error.message || "Set variable execution failed",
      },
      false,
      0,
      executionState?.flowId || null
    );
    return {
      success: false,
      error: error.message || "Set variable execution failed",
    };
  }
}

/**
 * Execute Logic Gate Node
 * Combines multiple conditions with AND/OR/NOT logic
 */
function executeLogicGateNode(node, variables, callControlId) {
  try {
    const config = node.data?.config || {};
    const { operator, conditions } = config;

    if (!operator) {
      const error = "Logic gate node missing operator";
      addNodeExecutionEvent(
        callControlId,
        "logic_gate",
        node.id,
        node.data?.label || "Logic Gate",
        { error },
        false,
        1,
        executionState?.flowId || null
      );
      return {
        success: false,
        error,
      };
    }

    let result = false;
    const conditionResults = [];

    if (operator === "NOT") {
      // NOT: invert single condition
      if (!conditions || conditions.length === 0) {
        const error = "NOT operator requires one condition";
        addNodeExecutionEvent(
          callControlId,
          "logic_gate",
          node.id,
          node.data?.label || "Logic Gate",
          { operator, error },
          false,
          1
        );
        return {
          success: false,
          error,
        };
      }
      const condition = conditions[0];
      const condResult = evaluateCondition(
        condition.leftOperand || "",
        condition.operator || "===",
        condition.rightOperand || "",
        condition.dataType || "string",
        variables
      );
      conditionResults.push({ condition, result: condResult.result });
      result = !condResult.result;
    } else if (operator === "AND") {
      // AND: all conditions must be true
      if (!conditions || conditions.length === 0) {
        const error = "AND operator requires at least one condition";
        addNodeExecutionEvent(
          callControlId,
          "logic_gate",
          node.id,
          node.data?.label || "Logic Gate",
          { operator, error },
          false,
          1
        );
        return {
          success: false,
          error,
        };
      }
      result = true;
      for (const condition of conditions) {
        const condResult = evaluateCondition(
          condition.leftOperand || "",
          condition.operator || "===",
          condition.rightOperand || "",
          condition.dataType || "string",
          variables
        );
        conditionResults.push({ condition, result: condResult.result });
        if (!condResult.result) {
          result = false;
          break;
        }
      }
    } else if (operator === "OR") {
      // OR: at least one condition must be true
      if (!conditions || conditions.length === 0) {
        const error = "OR operator requires at least one condition";
        addNodeExecutionEvent(
          callControlId,
          "logic_gate",
          node.id,
          node.data?.label || "Logic Gate",
          { operator, error },
          false,
          1
        );
        return {
          success: false,
          error,
        };
      }
      result = false;
      for (const condition of conditions) {
        const condResult = evaluateCondition(
          condition.leftOperand || "",
          condition.operator || "===",
          condition.rightOperand || "",
          condition.dataType || "string",
          variables
        );
        conditionResults.push({ condition, result: condResult.result });
        if (condResult.result) {
          result = true;
          break;
        }
      }
    }

    // Output 0 = True, Output 1 = False
    const output = result ? 0 : 1;

    // Log successful execution
    addNodeExecutionEvent(
      callControlId,
      "logic_gate",
      node.id,
      node.data?.label || "Logic Gate",
      {
        operator,
        conditions: conditionResults,
        final_result: result,
        output_path: result ? "True (0)" : "False (1)",
      },
      true,
      output
    );

    return {
      success: true,
      output,
      variables: {},
    };
  } catch (error) {
    const errorMsg = error.message || "Logic gate evaluation failed";
    addNodeExecutionEvent(
      callControlId,
      "logic_gate",
      node.id,
      node.data?.label || "Logic Gate",
      { error: errorMsg },
      false,
      1
    );
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Execute Flow End Node
 * Terminal node that does nothing - just marks end of flow
 */
function executeFlowEndNode(node, callControlId) {
  // Log flow end execution
  addNodeExecutionEvent(
    callControlId,
    "flow_end",
    node.id,
    node.data?.label || "Flow End",
    {
      message: "Flow execution completed",
    },
    true,
    0
  );

  return {
    success: true,
    output: 0,
    variables: {},
  };
}

/**
 * Execute HTTP Request Node
 * Makes an HTTP request and stores response in variables
 */
async function executeHttpRequestNode(node, variables, callControlId) {
  try {
    const config = node.data?.config || {};
    const {
      url,
      method = "GET",
      headers = {},
      pathParams = {},
      queryParams = {},
      bodyParams = {},
      bodyType = "json",
      body,
      timeout = 30000,
      responseVariable = "http_response",
    } = config;

    if (!url) {
      const error = "HTTP request node missing URL";
      console.log(
        "[executeHttpRequestNode] Error - Missing URL, logging to monitor"
      );
      addNodeExecutionEvent(
        callControlId,
        "http_request_action",
        node.id,
        node.data?.label || "HTTP Request",
        { error },
        false,
        1,
        executionState?.flowId || null
      );
      return {
        success: false,
        error,
      };
    }

    // Replace variables in path parameters and URL
    const processedPathParams = {};
    Object.entries(pathParams).forEach(([key, value]) => {
      processedPathParams[key] = replaceVariables({ value }, variables).value;
    });

    // Replace variables in URL
    let processedUrl = replaceVariables({ url }, variables).url;

    // Apply path parameters to URL (replace {param} placeholders)
    Object.entries(processedPathParams).forEach(([key, value]) => {
      const placeholder = `{${key}}`;
      if (processedUrl.includes(placeholder)) {
        processedUrl = processedUrl.replace(
          new RegExp(placeholder, "g"),
          encodeURIComponent(value)
        );
      }
    });

    // Replace variables in query parameters and build URL
    const processedQueryParams = {};
    Object.entries(queryParams).forEach(([key, value]) => {
      processedQueryParams[key] = replaceVariables({ value }, variables).value;
    });

    // Append query parameters to URL
    if (Object.keys(processedQueryParams).length > 0) {
      const urlObj = new URL(processedUrl);
      Object.entries(processedQueryParams).forEach(([key, value]) => {
        urlObj.searchParams.append(key, value);
      });
      processedUrl = urlObj.toString();
    }

    // Replace variables and resolve secret references in headers
    const processedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      let processedValue = replaceVariables({ value }, variables).value;
      // Resolve secret references
      processedValue = await resolveSecretReferences(processedValue);
      processedHeaders[key] = processedValue;
    }

    // Build request body based on bodyType
    let processedBody = body;
    let isJsonBody = false;
    if (
      method === "POST" ||
      method === "PUT" ||
      method === "PATCH" ||
      method === "DELETE"
    ) {
      if (bodyType === "params") {
        // Replace variables and resolve secret references in body parameters
        const processedBodyParams = {};
        for (const [key, value] of Object.entries(bodyParams)) {
          let processedValue = replaceVariables({ value }, variables).value;
          // Resolve secret references
          processedValue = await resolveSecretReferences(processedValue);
          processedBodyParams[key] = processedValue;
        }
        processedBody = JSON.stringify(processedBodyParams);
        isJsonBody = true;
      } else if (body && typeof body === "string") {
        // Check if body is just a single variable reference (e.g., "{{transcription_data}}")
        const singleVarMatch = body.trim().match(/^\{\{([^}]+)\}\}$/);
        if (singleVarMatch) {
          const varPath = singleVarMatch[1].trim();
          let varValue = null;

          // Try to get the variable value
          if (varPath.startsWith("global.")) {
            varValue = getValueByPath(
              variables.global || {},
              varPath.substring(7)
            );
          } else if (varPath.startsWith("payload.")) {
            varValue = getValueByPath(
              variables.payload || {},
              varPath.substring(8)
            );
          } else if (varPath.startsWith("response.")) {
            varValue = getValueByPath(
              variables.response || {},
              varPath.substring(9)
            );
          } else if (varPath.includes(".")) {
            varValue = getValueByPath(variables, varPath);
          } else {
            varValue = variables[varPath];
          }

          // If variable is an object/array, use it directly (will be JSON.stringified later)
          // If it's a string, treat it as a JSON string template
          if (varValue !== undefined && varValue !== null) {
            if (typeof varValue === "object") {
              // Variable is an object/array - use it directly
              processedBody = JSON.stringify(varValue);
              isJsonBody = true;
              console.log(
                `[executeHttpRequestNode] Single variable reference {{${varPath}}} resolved to object, using directly`
              );
            } else {
              // Variable is a primitive/string - treat body as JSON template
              let processedBodyValue = replaceVariablesInJsonBody(
                body,
                variables
              );
              processedBody = await resolveSecretReferences(processedBodyValue);
              // Try to parse as JSON to determine if it's JSON
              try {
                JSON.parse(processedBody);
                isJsonBody = true;
              } catch {
                isJsonBody = false;
              }
            }
          } else {
            // Variable not found - treat as JSON template
            let processedBodyValue = replaceVariablesInJsonBody(
              body,
              variables
            );
            processedBody = await resolveSecretReferences(processedBodyValue);
            // Try to parse as JSON to determine if it's JSON
            try {
              JSON.parse(processedBody);
              isJsonBody = true;
            } catch {
              isJsonBody = false;
            }
          }
        } else {
          // Body contains multiple variables or other content - treat as JSON template
          // Replace variables and resolve secret references in raw JSON body
          // Use specialized JSON body replacement that properly stringifies objects/arrays
          let processedBodyValue = replaceVariablesInJsonBody(body, variables);
          processedBody = await resolveSecretReferences(processedBodyValue);
          // Try to parse as JSON to determine if it's JSON
          try {
            JSON.parse(processedBody);
            isJsonBody = true;
          } catch {
            isJsonBody = false;
          }
        }
      }
    }

    // Set Content-Type header to application/json if sending JSON body
    // Only set if not already specified by user
    if (
      isJsonBody &&
      !processedHeaders["content-type"] &&
      !processedHeaders["Content-Type"]
    ) {
      processedHeaders["Content-Type"] = "application/json";
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions = {
        method,
        headers: processedHeaders,
        signal: controller.signal,
      };

      if (method !== "GET" && processedBody) {
        fetchOptions.body = processedBody;
      }

      const response = await fetch(processedUrl, fetchOptions);
      clearTimeout(timeoutId);

      const responseText = await response.text();
      let responseData;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      // Store the response body directly in the response variable
      // Determine output: 0 = success (2xx), 1 = error (4xx/5xx)
      const output = response.ok ? 0 : 1;

      // Log successful HTTP request execution
      addNodeExecutionEvent(
        callControlId,
        "http_request_action",
        node.id,
        node.data?.label || "HTTP Request",
        {
          request: {
            url: processedUrl,
            method,
            body: processedBody
              ? typeof processedBody === "string"
                ? processedBody
                : JSON.stringify(processedBody)
              : undefined,
          },
          response: {
            status: response.status,
            status_text: response.statusText,
            body: responseData,
          },
        },
        true,
        output
      );

      return {
        success: true,
        output,
        variables: {
          [responseVariable]: responseData, // Store body data directly
          http_status: response.status,
        },
      };
    } catch (fetchError) {
      clearTimeout(timeoutId);

      // Check if it was a timeout
      if (fetchError.name === "AbortError") {
        const error = "HTTP request timeout";
        addNodeExecutionEvent(
          callControlId,
          "http_request_action",
          node.id,
          node.data?.label || "HTTP Request",
          {
            request: {
              url: processedUrl,
              method,
              body: processedBody
                ? typeof processedBody === "string"
                  ? processedBody
                  : JSON.stringify(processedBody)
                : undefined,
            },
            error,
          },
          false,
          1
        );
        return {
          success: false,
          output: 1,
          error,
          variables: {
            [responseVariable]: null,
            http_status: 0,
          },
        };
      }

      const error = fetchError.message || "HTTP request failed";
      addNodeExecutionEvent(
        callControlId,
        "http_request_action",
        node.id,
        node.data?.label || "HTTP Request",
        {
          request: {
            url: processedUrl,
            method,
            body: processedBody
              ? typeof processedBody === "string"
                ? processedBody
                : JSON.stringify(processedBody)
              : undefined,
          },
          error,
        },
        false,
        1,
        executionState?.flowId || null
      );
      return {
        success: false,
        output: 1,
        error,
        variables: {
          [responseVariable]: null,
          http_status: 0,
        },
      };
    }
  } catch (error) {
    const errorMsg = error.message || "HTTP request execution failed";
    addNodeExecutionEvent(
      callControlId,
      "http_request_action",
      node.id,
      node.data?.label || "HTTP Request",
      { error: errorMsg },
      false,
      1
    );
    return {
      success: false,
      output: 1,
      error: errorMsg,
    };
  }
}

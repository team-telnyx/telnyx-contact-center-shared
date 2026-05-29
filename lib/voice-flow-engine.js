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
import {
  DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE,
  getValueByPath,
  resolveVariablePath,
  setValueByPath,
  validateVariableName,
  replaceTemplateVariables,
} from "@/lib/variable-utils.js";
import { resolveSecretReferences } from "@/lib/secrets.js";
import {
  getEntityBasePath,
  getFieldsForAction,
} from "@/lib/data-sources-schema.js";

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

function isConfiguredFormValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function resolveFormDataPath(path, variables) {
  const trimmedPath = String(path || "").trim();
  if (!trimmedPath) return undefined;
  if (trimmedPath.startsWith("global.")) return getValueByPath(variables.global || {}, trimmedPath.substring(7));
  if (trimmedPath.startsWith("payload.")) return getValueByPath(variables.payload || {}, trimmedPath.substring(8));
  if (trimmedPath.startsWith("query.")) return getValueByPath(variables.query || variables.payload?.query || {}, trimmedPath.substring(6));
  if (trimmedPath.startsWith("response.")) return getValueByPath(variables.response || {}, trimmedPath.substring(9));
  if (trimmedPath.startsWith("client_state.")) return getValueByPath(variables.client_state || {}, trimmedPath.substring(13));
  if (trimmedPath.includes(".")) return getValueByPath(variables, trimmedPath);
  return variables[trimmedPath];
}

function resolveFormDataVariable(value, variables) {
  if (typeof value !== "string") return value;
  const singleMatch = value.match(/^\s*\{\{([^}]+)\}\}\s*$/);
  if (singleMatch) return resolveFormDataPath(singleMatch[1], variables);
  const replaced = replaceVariables({ value }, variables).value;
  return typeof replaced === "string" && replaced.includes("{{") ? undefined : replaced;
}

function resolveFormDataPrefill(formDataConfig = {}, variables = {}, clientState = {}) {
  if (!formDataConfig || typeof formDataConfig !== "object" || Array.isArray(formDataConfig)) return {};
  const scopedVariables = { ...variables, client_state: clientState || {} };
  const resolved = {};
  for (const [variableName, entry] of Object.entries(formDataConfig)) {
    if (!variableName) continue;
    const normalizedEntry = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry
      : { source: "static", value: entry };
    const source = normalizedEntry.source || normalizedEntry.type || "static";
    if (source === "none") continue;
    const rawValue = normalizedEntry.value ?? normalizedEntry.variable ?? normalizedEntry.expression;
    if (!isConfiguredFormValue(rawValue)) continue;
    const value = source === "variable"
      ? resolveFormDataVariable(rawValue, scopedVariables)
      : rawValue;
    if (isConfiguredFormValue(value)) resolved[variableName] = value;
  }
  return resolved;
}

function resolveWorkflowDataPrefill(workflowDataConfig = {}, variables = {}, clientState = {}) {
  return resolveFormDataPrefill(workflowDataConfig, variables, clientState);
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
  executionState,
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

    // For enqueue nodes with use_queue_options, clear queue_name before variable replacement
    // to avoid warnings about unresolved variables (queue_name will come from client_state)
    if (
      nodeType === "enqueue" &&
      configWithDefaults.use_queue_options === true &&
      configWithDefaults.queue_name
    ) {
      // Store original value temporarily, then clear it
      const originalQueueName = configWithDefaults.queue_name;
      delete configWithDefaults.queue_name;
    }

    // Merge global variables with execution variables
    const mergedVariables = mergeVariables(
      executionState.globalVariables || {},
      executionState.variables || {},
    );

    // Replace variables in config
    const processedConfig = replaceVariables(
      configWithDefaults,
      mergedVariables,
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
      return await executeFlowEndNode(node, callControlId, executionState);
    }
    if (nodeType === "form_submit_status") {
      return executeFormSubmitStatusNode(node, mergedVariables, callControlId);
    }
    if (nodeType === "form_submit") {
      const candidate =
        configWithDefaults.payloadVariable ||
        configWithDefaults.payloadVariableName ||
        DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE;
      const payloadVariable = validateVariableName(String(candidate || "").trim())
        .valid
        ? String(candidate).trim()
        : DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE;
      const formPayload =
        event?.data?.payload?.form_payload ||
        event?.data?.payload ||
        {};
      return {
        success: true,
        output: 0,
        variables: { [payloadVariable]: formPayload },
      };
    }
    if (nodeType === "http_request_action") {
      return await executeHttpRequestNode(node, mergedVariables, callControlId);
    }
    if (nodeType === "data_action") {
      return await executeDataActionNode(
        node,
        mergedVariables,
        callControlId,
        executionState,
      );
    }

    // Special handling for set_queue_options node: merge queue options into client_state
    if (nodeType === "set_queue_options") {
      // Get existing client_state from execution state or webhook
      let existingClientState = {};

      // First, try to get from webhook payload if available (call's current client_state)
      if (event?.data?.payload?.client_state) {
        try {
          const decoded = Buffer.from(
            event.data.payload.client_state,
            "base64",
          ).toString();
          existingClientState = JSON.parse(decoded);
        } catch {
          // Ignore decode errors
        }
      }

      // Also check if client_state is already in config (from SetQueueOptionsNodeEditor)
      // This should be decoded and merged, but individual config fields take precedence
      if (processedConfig.client_state) {
        try {
          const decoded = Buffer.from(
            processedConfig.client_state,
            "base64",
          ).toString();
          const configClientState = JSON.parse(decoded);
          // Merge config client_state into existing, but individual fields will override
          existingClientState = {
            ...existingClientState,
            ...configClientState,
          };
        } catch {
          // Ignore decode errors
        }
      }

      // Build new client_state with queue options
      // Individual config fields (call_priority, queue_name, skills) will override what's in existingClientState
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

      // Process call_priority (can be variable or static)
      // Check both call_priority (from SetQueueOptionsNodeEditor) and priority (legacy support)
      // Priority from config takes precedence over what's in existingClientState
      const priorityConfig =
        processedConfig.call_priority !== undefined
          ? processedConfig.call_priority
          : processedConfig.priority;

      if (priorityConfig !== undefined) {
        let priorityValue = priorityConfig;
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
        // Validate priority is 1-5 (call priority scale) and ensure it's a number
        if (
          typeof priorityValue === "number" &&
          !isNaN(priorityValue) &&
          priorityValue >= 1 &&
          priorityValue <= 5
        ) {
          newClientState.call_priority = priorityValue;
          console.log(
            `[FlowEngine] Set Queue Options - Setting call_priority to ${priorityValue} in client_state`,
          );
        } else {
          console.warn(
            `[FlowEngine] Set Queue Options - Invalid call_priority value: ${priorityValue} (type: ${typeof priorityValue})`,
          );
        }
      } else {
        console.warn(
          `[FlowEngine] Set Queue Options - call_priority not found in processedConfig. Available keys: ${Object.keys(processedConfig).join(", ")}`,
        );
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
        } else if (
          typeof skillsValue === "object" &&
          !Array.isArray(skillsValue)
        ) {
          // Already in object format
          newClientState.required_skills = skillsValue;
        }
      }

      // Encode and update client_state
      const clientStateBase64 = Buffer.from(
        JSON.stringify(newClientState),
      ).toString("base64");

      const clientStateUpdateResult = await callTelnyxAction(
        executionState?.flowId || null,
        "client_state_update",
        callControlId,
        { client_state: clientStateBase64 },
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
          error:
            clientStateUpdateResult.error || "Failed to update client state",
          variables: mergedVariables,
        };
      }
    }

    // Special handling for agent_assist node - stores config in client_state for later use
    if (nodeType === "agent_assist") {
      const assistType = processedConfig.assist_type || "kb_articles";
      
      // Build config with only relevant parameters based on assist_type
      const agentAssistConfig = {
        enabled: processedConfig.enabled !== false,
        assist_type: assistType,
      };

      if (assistType === "kb_articles") {
        // KB Articles options only
        agentAssistConfig.kb_category = processedConfig.kb_category || null;
        agentAssistConfig.kb_auto_suggest = processedConfig.kb_auto_suggest !== false;
        agentAssistConfig.kb_max_suggestions = processedConfig.kb_max_suggestions || 3;
      } else if (assistType === "workflows") {
        // Workflow options only
        agentAssistConfig.workflow_id = processedConfig.workflow_id || null;
        agentAssistConfig.auto_start = processedConfig.auto_start !== false;
        agentAssistConfig.show_suggestions = processedConfig.show_suggestions !== false;
        agentAssistConfig.auto_detect_completion = processedConfig.auto_detect_completion !== false;
        agentAssistConfig.enable_intent_recognition = processedConfig.enable_intent_recognition === true;
        agentAssistConfig.enable_sentiment_analysis = processedConfig.enable_sentiment_analysis === true;
        agentAssistConfig.enable_translation = processedConfig.enable_translation === true;
        agentAssistConfig.auto_send_response = processedConfig.auto_send_response === true;
        if (configWithDefaults.workflow_data && typeof configWithDefaults.workflow_data === "object") {
          agentAssistConfig.workflow_data = configWithDefaults.workflow_data;
        }
      } else if (assistType === "forms" || assistType === "form") {
        // Forms options only. Keep both singular and array fields for backward compatibility.
        const formIds = Array.isArray(processedConfig.form_ids)
          ? processedConfig.form_ids.filter(Boolean)
          : processedConfig.form_id
            ? [processedConfig.form_id]
            : [];
        agentAssistConfig.form_id = processedConfig.form_id || formIds[0] || null;
        agentAssistConfig.form_ids = formIds;
        agentAssistConfig.auto_open_forms = processedConfig.auto_open_forms !== false;
        if (configWithDefaults.form_data && typeof configWithDefaults.form_data === "object") {
          agentAssistConfig.form_data = configWithDefaults.form_data;
        }
      } else if (assistType === "web_pages" || assistType === "web_page") {
        // Web Pages options only. Canonical config is singular web_page_id.
        // Backward compatibility: if an older flow has web_page_ids, use the first valid ID.
        const legacyWebPageIds = Array.isArray(processedConfig.web_page_ids)
          ? processedConfig.web_page_ids.filter(Boolean)
          : [];
        agentAssistConfig.web_page_id = processedConfig.web_page_id || legacyWebPageIds[0] || null;
      }

      // Get existing client_state
      let existingClientState = {};
      if (event?.data?.payload?.client_state) {
        try {
          const decoded = Buffer.from(
            event.data.payload.client_state,
            "base64",
          ).toString();
          existingClientState = JSON.parse(decoded);
        } catch {
          // Ignore decode errors
        }
      }

      const resolvedFormData = (assistType === "forms" || assistType === "form")
        ? resolveFormDataPrefill(configWithDefaults.form_data || processedConfig.form_data || {}, mergedVariables, existingClientState)
        : {};
      const resolvedWorkflowData = assistType === "workflows"
        ? resolveWorkflowDataPrefill(configWithDefaults.workflow_data || processedConfig.workflow_data || {}, mergedVariables, existingClientState)
        : {};
      if (Object.keys(resolvedWorkflowData).length > 0) {
        agentAssistConfig.workflow_data_resolved = resolvedWorkflowData;
      }

      // Add agent_assist_config to client_state
      // IMPORTANT: Update flowId and currentNodeId from executionState to ensure
      // the flow continues from this node, not the previous one
      const newClientState = {
        ...existingClientState,
        flowId: executionState?.flowId || existingClientState.flowId,
        currentNodeId: executionState?.currentNodeId || existingClientState.currentNodeId,
        agent_assist_config: agentAssistConfig,
      };
      if (Object.keys(resolvedFormData).length > 0) newClientState.form_data = resolvedFormData;
      else delete newClientState.form_data;
      if (Object.keys(resolvedWorkflowData).length > 0) newClientState.workflow_data = resolvedWorkflowData;
      else if (assistType === "workflows") delete newClientState.workflow_data;

      const clientStateBase64 = Buffer.from(
        JSON.stringify(newClientState),
      ).toString("base64");

      // Update client_state on the call
      const clientStateUpdateResult = await callTelnyxAction(
        executionState?.flowId || null,
        "client_state_update",
        callControlId,
        { client_state: clientStateBase64 },
      );

      if (clientStateUpdateResult.success) {
        console.log(
          `[FlowEngine] Agent Assist configured: type=${agentAssistConfig.assist_type}, workflow=${agentAssistConfig.workflow_id || "none"}, forms=${agentAssistConfig.form_ids?.length || 0}, web_page=${agentAssistConfig.web_page_id || "none"}`,
        );
        return {
          success: true,
          output: 0,
          variables: {},
          client_state: clientStateBase64,
        };
      } else {
        console.warn(
          "[FlowEngine] Failed to store agent assist config:",
          clientStateUpdateResult.error,
        );
        // Continue anyway - agent assist config is not critical
        return {
          success: true,
          output: 0,
          variables: {},
        };
      }
    }

    // Special handling for enqueue node
    if (nodeType === "enqueue") {
      // Always remove max_size and max_wait_time_secs - Telnyx doesn't allow modifying these
      // for existing queues. This must be done before the API call to prevent 422 errors.
      delete processedConfig.max_size;
      delete processedConfig.max_wait_time_secs;

      // If use_queue_options is enabled, read queue options from call's client_state
      if (processedConfig.use_queue_options) {
        // Clear queue_name if it's null - we'll read it from client_state instead
        if (processedConfig.queue_name === null) {
          delete processedConfig.queue_name;
        }

        // Get client_state from the call (set by Set Queue Options node) or from node config (fallback)
        let clientStateSource = null;

        // First, try to get from webhook event (call's current client_state)
        // This should contain the updated client_state from Set Queue Options node
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

            // Override queue_name from client_state
            if (clientStateObj.queue_name) {
              processedConfig.queue_name = clientStateObj.queue_name;
            } else {
              throw new Error(
                "queue_name is required but not found in client_state when use_queue_options is enabled",
              );
            }

            // Priority and required_skills should already be in client_state
            // Don't convert required_skills to routing_skills (Telnyx doesn't support routing_skills parameter)
            // Remove routing_skills if it exists (not supported by Telnyx API)
            delete processedConfig.routing_skills;
            delete processedConfig.routing_priority;

            // Remove call_priority from direct body - it should only be in client_state
            delete processedConfig.call_priority;

            // Keep client_state in config - it needs to be sent with the enqueue request
            // so Telnyx has the routing parameters (call_priority, required_skills, queue_name)
            // for priority-based and skills-based routing
            processedConfig.client_state = clientStateSource;
          } catch (err) {
            console.error(
              "[FlowEngine] Failed to process client_state for use_queue_options:",
              err,
            );
            // Re-throw to prevent enqueue without queue_name
            throw err;
          }
        } else {
          throw new Error(
            "No client_state found in event or config when use_queue_options is enabled. Make sure Set Queue Options node runs before Enqueue node.",
          );
        }

        // Validate that queue_name is set before making API call
        if (!processedConfig.queue_name) {
          throw new Error(
            "queue_name is required but not set when use_queue_options is enabled",
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
            { client_state: processedConfig.client_state },
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
      processedConfig,
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
    console.error(
      `[FlowEngine] Error executing node ${nodeType}:`,
      error.message || String(error),
    );
    if (error.stack) {
      console.error("[FlowEngine] Error stack:", error.stack);
    }
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

  const hasExplicitOutput = Number.isInteger(executionState.lastOutput);
  const output = hasExplicitOutput ? executionState.lastOutput : 0;

  const matchingEdges = outgoingEdges.filter((e) => {
    const sourceHandle = e.sourceHandle || "output-0";
    const handleIndex = parseInt(sourceHandle.replace("output-", ""), 10);
    return handleIndex === output;
  });

  if (hasExplicitOutput && matchingEdges.length === 0) {
    return [];
  }

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
        edge.data.variableMappings,
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
        executionState.callControlId,
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
 * For model-based providers (Deepgram/Telnyx/AssemblyAI/Speechmatics/Soniox/xAI):
 * transcription_model and language may also be at top level
 * API expects: transcription: true, transcription_config: { transcription_engine, transcription_engine_config, transcription_tracks }
 * @param {Object} body - The request body to transform
 * @returns {Object} Transformed body with transcription options in correct format
 */
const TRANSCRIPTION_MODEL_DEFAULTS = {
  Deepgram: "deepgram/nova-3",
  Telnyx: "openai/whisper-tiny",
  AssemblyAI: "assemblyai/universal-streaming",
  Speechmatics: "speechmatics/standard",
  Soniox: "soniox/stt-rt-v4",
  xAI: "xai/grok-stt",
};

const TRANSCRIPTION_MODELS_BY_ENGINE = {
  Deepgram: new Set(["deepgram/nova-2", "deepgram/nova-3"]),
  Telnyx: new Set(["openai/whisper-tiny", "openai/whisper-large-v3-turbo"]),
  AssemblyAI: new Set(["assemblyai/universal-streaming"]),
  Speechmatics: new Set(["speechmatics/standard"]),
  Soniox: new Set(["soniox/stt-rt-v4"]),
  xAI: new Set(["xai/grok-stt"]),
};

const TELNYX_TRANSCRIPTION_LANGUAGES = new Set([
  "en",
  "zh",
  "de",
  "es",
  "ru",
  "ko",
  "fr",
  "ja",
  "pt",
  "tr",
  "pl",
  "ca",
  "nl",
  "ar",
  "sv",
  "it",
  "id",
  "hi",
  "fi",
  "vi",
  "he",
  "uk",
  "el",
  "ms",
  "cs",
  "ro",
  "da",
  "hu",
  "ta",
  "no",
  "th",
  "ur",
  "hr",
  "bg",
  "lt",
  "la",
  "mi",
  "ml",
  "cy",
  "sk",
  "te",
  "fa",
  "lv",
  "bn",
  "sr",
  "az",
  "sl",
  "kn",
  "et",
  "mk",
  "br",
  "eu",
  "is",
  "hy",
  "ne",
  "mn",
  "bs",
  "kk",
  "sq",
  "sw",
  "gl",
  "mr",
  "pa",
  "si",
  "km",
  "sn",
  "yo",
  "so",
  "af",
  "oc",
  "ka",
  "be",
  "tg",
  "sd",
  "gu",
  "am",
  "yi",
  "lo",
  "uz",
  "fo",
  "ht",
  "ps",
  "tk",
  "nn",
  "mt",
  "sa",
  "lb",
  "my",
  "bo",
  "tl",
  "mg",
  "as",
  "tt",
  "haw",
  "ln",
  "ha",
  "ba",
  "jw",
  "su",
  "auto_detect",
]);

const AZURE_TRANSCRIPTION_LANGUAGES = new Set([
  "af",
  "am",
  "ar",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fr",
  "ga",
  "gl",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "lo",
  "lt",
  "lv",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "mt",
  "my",
  "nb",
  "ne",
  "nl",
  "pl",
  "ps",
  "pt",
  "ro",
  "ru",
  "si",
  "sk",
  "sl",
  "so",
  "sq",
  "sr",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "wuu",
  "yue",
  "zh",
  "zu",
  "auto",
]);

const TRANSCRIPTION_LANGUAGES_BY_ENGINE_MODEL = {
  "Telnyx:openai/whisper-tiny": TELNYX_TRANSCRIPTION_LANGUAGES,
  "Telnyx:openai/whisper-large-v3-turbo": TELNYX_TRANSCRIPTION_LANGUAGES,
  "Deepgram:deepgram/nova-2": new Set([
    "bg",
    "ca",
    "zh",
    "zh-CN",
    "zh-Hans",
    "zh-TW",
    "zh-Hant",
    "zh-HK",
    "cs",
    "da",
    "da-DK",
    "nl",
    "en",
    "en-US",
    "en-AU",
    "en-GB",
    "en-NZ",
    "en-IN",
    "et",
    "fi",
    "nl-BE",
    "fr",
    "fr-CA",
    "de",
    "de-CH",
    "el",
    "hi",
    "hu",
    "id",
    "it",
    "ja",
    "ko",
    "ko-KR",
    "lv",
    "lt",
    "ms",
    "no",
    "pl",
    "pt",
    "pt-BR",
    "pt-PT",
    "ro",
    "ru",
    "sk",
    "es",
    "es-419",
    "sv",
    "sv-SE",
    "th",
    "th-TH",
    "tr",
    "uk",
    "vi",
    "auto_detect",
  ]),
  "Deepgram:deepgram/nova-3": new Set([
    "en",
    "en-US",
    "en-AU",
    "en-GB",
    "en-IN",
    "en-NZ",
    "de",
    "nl",
    "sv",
    "sv-SE",
    "da",
    "da-DK",
    "es",
    "es-419",
    "fr",
    "fr-CA",
    "pt",
    "pt-BR",
    "pt-PT",
    "auto_detect",
  ]),
  "Speechmatics:speechmatics/standard": new Set([
    "en",
    "ba",
    "eu",
    "gl",
    "ga",
    "mt",
    "mn",
    "sw",
    "ug",
    "cy",
    "ar_en",
    "cmn_en",
    "en_ms",
    "en_ta",
    "tl",
    "es-bilingual-en",
    "cmn_en_ms_ta",
  ]),
  "AssemblyAI:assemblyai/universal-streaming": new Set([]),
  "Soniox:soniox/stt-rt-v4": null,
  "xAI:xai/grok-stt": new Set([
    "ar",
    "cs",
    "da",
    "de",
    "en",
    "es",
    "fa",
    "fil",
    "fr",
    "hi",
    "id",
    "it",
    "ja",
    "ko",
    "mk",
    "ms",
    "nl",
    "pl",
    "pt",
    "ro",
    "ru",
    "sv",
    "th",
    "tr",
    "vi",
  ]),
};

const MODEL_BASED_TRANSCRIPTION_ENGINES = new Set([
  "Deepgram",
  "Telnyx",
  "AssemblyAI",
  "Speechmatics",
  "Soniox",
  "xAI",
]);

function cleanEmptyValues(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entryValue]) => entryValue !== ""),
  );
}

function getValidTranscriptionModel(engine, model) {
  const supportedModels = TRANSCRIPTION_MODELS_BY_ENGINE[engine];
  if (!supportedModels) return model || undefined;
  if (model && supportedModels.has(model)) return model;
  return TRANSCRIPTION_MODEL_DEFAULTS[engine];
}

function getValidTranscriptionLanguage(engine, model, language) {
  if (!language) return undefined;
  if (engine === "Azure") {
    return AZURE_TRANSCRIPTION_LANGUAGES.has(language) ? language : undefined;
  }

  const supportedLanguages =
    TRANSCRIPTION_LANGUAGES_BY_ENGINE_MODEL[`${engine}:${model}`];
  if (supportedLanguages === null) {
    return language === "auto" ? undefined : language;
  }
  if (!supportedLanguages) return language;
  return supportedLanguages.has(language) ? language : undefined;
}

function normalizeTranscriptionStartConfig(body) {
  if (!body?.transcription_engine) return body;

  const engine = body.transcription_engine;
  const nestedConfig = cleanEmptyValues(body.transcription_engine_config);
  const nestedConfigWithoutLanguage = { ...nestedConfig };
  delete nestedConfigWithoutLanguage.language;
  const nextBody = { ...body, transcription_engine: engine };

  if (engine === "Google") {
    const language = body.language || nestedConfig.language || "en";
    const model = body.model || nestedConfig.model || "phone_call";
    const interimResults =
      body.interim_results ?? nestedConfig.interim_results ?? true;
    nextBody.transcription_engine_config = {
      transcription_engine: "Google",
      ...nestedConfigWithoutLanguage,
      language,
      model,
      interim_results: interimResults,
    };
  } else if (engine === "Azure") {
    const language = getValidTranscriptionLanguage(
      engine,
      null,
      body.language || nestedConfig.language,
    );
    nextBody.transcription_engine_config = {
      transcription_engine: "Azure",
      ...nestedConfigWithoutLanguage,
      ...(language ? { language } : {}),
      ...(body.region ? { region: body.region } : {}),
      ...(body.api_key_ref ? { api_key_ref: body.api_key_ref } : {}),
    };
    delete nextBody.transcription_engine_config.model;
    delete nextBody.transcription_engine_config.transcription_model;
  } else if (MODEL_BASED_TRANSCRIPTION_ENGINES.has(engine)) {
    const transcriptionModel =
      getValidTranscriptionModel(
        engine,
        nestedConfig.transcription_model || body.transcription_model,
      );
    const language = getValidTranscriptionLanguage(
      engine,
      transcriptionModel,
      body.language || nestedConfig.language || "en",
    );

    nextBody.transcription_engine_config = {
      transcription_engine: engine,
      ...nestedConfigWithoutLanguage,
      ...(transcriptionModel ? { transcription_model: transcriptionModel } : {}),
      ...(language ? { language } : {}),
      ...(body.interim_results !== undefined
        ? { interim_results: body.interim_results }
        : {}),
    };
    delete nextBody.transcription_engine_config.model;
  } else if (Object.keys(nestedConfig).length > 0) {
    nextBody.transcription_engine_config = nestedConfig;
  }

  delete nextBody.model;
  delete nextBody.region;
  delete nextBody.api_key_ref;
  delete nextBody.transcription_model;
  delete nextBody.language;
  delete nextBody.interim_results;

  return nextBody;
}

export function transformTranscriptionOptions(body) {
  // Check if transcription is enabled (indicated by presence of transcription_engine)
  if (body.transcription_engine) {
    // Set transcription flag to true
    body.transcription = true;

    const startConfig = normalizeTranscriptionStartConfig(body);
    const transcriptionConfig = {
      transcription_engine: startConfig.transcription_engine,
    };

    if (
      startConfig.transcription_engine_config &&
      Object.keys(startConfig.transcription_engine_config).length > 0
    ) {
      transcriptionConfig.transcription_engine_config =
        startConfig.transcription_engine_config;
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
    delete body.interim_results;
    delete body.model;
    delete body.region;
    delete body.api_key_ref;
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
            (h) => h && h.name && h.value,
          );
          if (body.sip_headers.length === 0) {
            delete body.sip_headers;
          }
        }
        // Filter out incomplete custom_headers (must have name or value)
        if (body.custom_headers && Array.isArray(body.custom_headers)) {
          body.custom_headers = body.custom_headers.filter(
            (h) => h && (h.name || h.value),
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
          `/calls/${encodeURIComponent(callControlId)}/actions/answer`,
        );
        method = "POST";
        // Filter out incomplete sip_headers (must have both name and value)
        if (body.sip_headers && Array.isArray(body.sip_headers)) {
          body.sip_headers = body.sip_headers.filter(
            (h) => h && h.name && h.value,
          );
          if (body.sip_headers.length === 0) {
            delete body.sip_headers;
          }
        }
        // Filter out incomplete custom_headers (must have name or value)
        if (body.custom_headers && Array.isArray(body.custom_headers)) {
          body.custom_headers = body.custom_headers.filter(
            (h) => h && (h.name || h.value),
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
          `/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
        );
        method = "POST";
        break;

      case "reject":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/reject`,
        );
        method = "POST";
        break;

      case "noise_suppression_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId,
          )}/actions/suppression_start`,
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
          `/calls/${encodeURIComponent(callControlId)}/actions/suppression_stop`,
        );
        method = "POST";
        break;

      case "switch_supervisor_role":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId,
          )}/actions/switch_supervisor_role`,
        );
        method = "POST";
        break;

      case "transfer":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
        );
        method = "POST";
        break;

      case "bridge":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/bridge`,
        );
        method = "POST";
        break;

      case "enqueue":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/enqueue`,
        );
        method = "POST";
        // Remove unsupported parameters (routing_skills is not supported by Telnyx API)
        // use_queue_options is only a config flag, not an API parameter
        delete body.routing_skills;
        delete body.routing_priority;
        delete body.use_queue_options;
        // Remove max_size and max_wait_time_secs - Telnyx doesn't allow modifying these for existing queues
        delete body.max_size;
        delete body.max_wait_time_secs;

        // Validate queue_name is present
        if (!body.queue_name) {
          throw new Error("queue_name is required for enqueue action");
        }
        break;

      case "leave_queue":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/leave_queue`,
        );
        method = "POST";
        break;

      case "client_state_update":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId,
          )}/actions/client_state_update`,
        );
        method = "PUT";
        break;

      case "refer":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/refer`,
        );
        method = "POST";
        // Filter out incomplete sip_headers (must have both name and value)
        if (body.sip_headers && Array.isArray(body.sip_headers)) {
          body.sip_headers = body.sip_headers.filter(
            (h) => h && h.name && h.value,
          );
          if (body.sip_headers.length === 0) {
            delete body.sip_headers;
          }
        }
        // Filter out incomplete custom_headers (must have name or value)
        if (body.custom_headers && Array.isArray(body.custom_headers)) {
          body.custom_headers = body.custom_headers.filter(
            (h) => h && (h.name || h.value),
          );
          if (body.custom_headers.length === 0) {
            delete body.custom_headers;
          }
        }
        break;

      case "speak":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/speak`,
        );
        method = "POST";
        // Check if using ElevenLabs voice
        const isElevenLabsSpeak = body.voice && String(body.voice).toLowerCase().startsWith("elevenlabs");
        
        // Transform voice_api_key_ref into voice_settings format for ElevenLabs
        if (body.voice_api_key_ref) {
          body.voice_settings = {
            ...body.voice_settings,
            type: "elevenlabs", // Required for ElevenLabs voice_settings
            api_key_ref: body.voice_api_key_ref,
          };
          delete body.voice_api_key_ref;
        } else if (isElevenLabsSpeak && body.voice_settings?.api_key_ref) {
          // Ensure type is set for ElevenLabs
          body.voice_settings = {
            ...body.voice_settings,
            type: "elevenlabs",
          };
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
          `/calls/${encodeURIComponent(callControlId)}/actions/playback_start`,
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
          `/calls/${encodeURIComponent(callControlId)}/actions/gather`,
        );
        method = "POST";
        break;

      case "gather_using_audio":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId,
          )}/actions/gather_using_audio`,
        );
        method = "POST";
        break;

      case "gather_using_speak":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId,
          )}/actions/gather_using_speak`,
        );
        method = "POST";
        // Check if using ElevenLabs voice
        const isElevenLabsGatherSpeak = body.voice && String(body.voice).toLowerCase().startsWith("elevenlabs");
        
        // Transform voice_api_key_ref into voice_settings format for ElevenLabs
        if (body.voice_api_key_ref) {
          body.voice_settings = {
            ...body.voice_settings,
            type: "elevenlabs", // Required for ElevenLabs voice_settings
            api_key_ref: body.voice_api_key_ref,
          };
          delete body.voice_api_key_ref;
        } else if (isElevenLabsGatherSpeak && body.voice_settings?.api_key_ref) {
          // Ensure type is set for ElevenLabs
          body.voice_settings = {
            ...body.voice_settings,
            type: "elevenlabs",
          };
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
            callControlId,
          )}/actions/ai_assistant_start`,
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
              `Available variables in this node: ${availableVars || "none"}`,
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
            callControlId,
          )}/actions/ai_assistant_stop`,
        );
        method = "POST";
        break;

      case "record_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_start`,
        );
        method = "POST";
        break;

      case "record_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_stop`,
        );
        method = "POST";
        break;

      case "record_pause":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_pause`,
        );
        method = "POST";
        break;

      case "record_resume":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/record_resume`,
        );
        method = "POST";
        break;

      case "transcription_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId,
          )}/actions/transcription_start`,
        );
        method = "POST";
        body = normalizeTranscriptionStartConfig(body);
        break;

      case "transcription_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(
            callControlId,
          )}/actions/transcription_stop`,
        );
        method = "POST";
        break;

      case "streaming_start":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`,
        );
        method = "POST";

        // Handle AI streaming provider auto-configuration
        if (
          body.ai_streaming_provider &&
          body.ai_streaming_provider !== "custom"
        ) {
          const aiProvider = body.ai_streaming_provider;

          // Import provider config
          const { getTelnyxStreamingConfig } =
            await import("@/config/ai-streaming-providers");
          const providerConfig = getTelnyxStreamingConfig(aiProvider);

          if (providerConfig) {
            // Build streaming WebSocket base URL.
            // Priority: WS_BASE_URL env var → derive from NEXT_PUBLIC_BASE_URL + actual WS port
            // WS_BASE_URL must be set to the publicly reachable WS URL (e.g. wss://cc.domain.com:3001)
            let streamWsBase = process.env.WS_BASE_URL || process.env.STREAMING_WS_URL;
            if (!streamWsBase) {
              let baseUrl =
                process.env.NEXT_PUBLIC_BASE_URL ||
                process.env.APP_BASE_URL ||
                process.env.VERCEL_URL ||
                "localhost:3000";
              baseUrl = baseUrl.replace(/^https?:\/\//, "");
              const protocol = baseUrl.startsWith("localhost") || baseUrl.startsWith("127.") ? "ws" : "wss";
              // Use actual running WS port (set on server start), fall back to env or main+1
              const wsPort =
                globalThis.__streamingWsPort ||
                parseInt(process.env.STREAMING_WS_PORT || "0", 10) ||
                parseInt(process.env.PORT || "3000", 10) + 1;
              const host = baseUrl.replace(/:\d+$/, ""); // Strip port from base URL hostname
              streamWsBase = `${protocol}://${host}:${wsPort}`;
            }
            streamWsBase = streamWsBase.replace(/\/$/, "");

            const streamingSecret = process.env.STREAMING_SECRET || "";
            const secretParam = streamingSecret
              ? `?secret=${encodeURIComponent(streamingSecret)}`
              : "";

            if (aiProvider === "azure-transcription") {
              // ── Azure Transcription + Translation ──────────────────────────────
              body.stream_url = `${streamWsBase}/streaming/azure${secretParam}`;

              // Apply provider Telnyx config (both_tracks, PCMU)
              Object.assign(body, providerConfig);

              // Inject azure_transcription_config into client_state so webhook-handler
              // can start Azure sessions when call.answered fires
              let existingClientState = {};
              if (body.client_state) {
                try {
                  existingClientState = JSON.parse(
                    Buffer.from(body.client_state, "base64").toString("utf-8")
                  );
                } catch { /* ignore */ }
              } else if (event?.data?.payload?.client_state) {
                try {
                  existingClientState = JSON.parse(
                    Buffer.from(event.data.payload.client_state, "base64").toString("utf-8")
                  );
                } catch { /* ignore */ }
              }

              existingClientState.azure_transcription_config = {
                enabled: true,
                // Region from env — API key intentionally NOT stored in client_state
                // (client_state is sent to Telnyx and can appear in webhook logs)
                // The webhook handler reads the API key directly from process.env
                region: process.env.AZURE_SERVICE_REGION || process.env.AZURE_SPEECH_REGION || "eastus",
                translationEnabled: body.azure_translation_enabled === true,
                sourceLanguage: body.azure_source_language || "en-US",
                targetLanguage: body.azure_target_language || "en",
              };

              body.client_state = Buffer.from(
                JSON.stringify(existingClientState)
              ).toString("base64");
            } else {
              // ── Google Gemini / OpenAI Realtime ────────────────────────────────
              const wsProvider = aiProvider === "google-gemini" ? "google" : "openai";
              body.stream_url = `${streamWsBase}/streaming/${wsProvider}${secretParam}`;

              // Remove optional fields not in provider config to avoid node defaults leaking
              const optionalStreamFields = [
                "stream_bidirectional_target_legs",
                "stream_bidirectional_sampling_rate",
              ];
              for (const field of optionalStreamFields) {
                if (!(field in providerConfig)) delete body[field];
              }

              // Apply provider-specific Telnyx configuration
              Object.assign(body, providerConfig);
            }

            console.log(`[FlowEngine] streaming_start → provider=${aiProvider}, stream_url=${body.stream_url}`);
          }
        }

        // Remove azure-specific fields that are not part of Telnyx API
        delete body.azure_translation_enabled;
        delete body.azure_target_language;

        // Remove ai_streaming_provider from body (not part of Telnyx API)
        delete body.ai_streaming_provider;

        // Extract all ai_* config params and append to stream_url as base64 ai_config query param
        // This is how AI session settings (instructions, voice, VAD etc.) reach the WS handler
        const aiSessionParams = {};
        for (const key of Object.keys(body)) {
          if (key.startsWith("ai_")) {
            aiSessionParams[key] = body[key];
            delete body[key];
          }
        }
        if (Object.keys(aiSessionParams).length > 0 && body.stream_url) {
          const aiConfigB64 = Buffer.from(JSON.stringify(aiSessionParams)).toString("base64");
          const separator = body.stream_url.includes("?") ? "&" : "?";
          body.stream_url = `${body.stream_url}${separator}ai_config=${encodeURIComponent(aiConfigB64)}`;
        }

        // Convert sampling_rate to integer if it's a string
        if (
          body.stream_bidirectional_sampling_rate &&
          typeof body.stream_bidirectional_sampling_rate === "string"
        ) {
          body.stream_bidirectional_sampling_rate = parseInt(
            body.stream_bidirectional_sampling_rate,
            10,
          );
        }
        break;

      case "streaming_stop":
        url = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/streaming_stop`,
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
      console.error(
        `[FlowEngine] Telnyx API error for ${action}:`,
        response.status,
        errorText,
      );
      if (callControlId) {
        addCommandEvent(
          callControlId,
          action,
          body,
          {
            error: true,
            status: response.status,
            body: errorText,
          },
          commandTimestamp,
          flowId,
        );
      }
      return {
        success: false,
        error: `Telnyx API error: ${response.status} - ${errorText}`,
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
        flowId,
      );
    }

    return {
      success: true,
      variables: extractVariablesFromResponse(data),
      responseData: data, // Include full response for output determination
    };
  } catch (error) {
    console.error(
      `[FlowEngine] Error calling Telnyx API for ${action}:`,
      error.message || String(error),
    );
    if (error.stack) {
      console.error("[FlowEngine] Error stack:", error.stack);
    }
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
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (global.${path})`,
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found in global variables`,
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
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (payload.${path})`,
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found in payload variables`,
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
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (response.${path})`,
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found in response variables`,
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
          `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (dot notation)`,
        );
        return stringValue;
      }
      console.warn(
        `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found (dot notation)`,
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
        `[replaceVariablesInJsonBody] Replaced {{${trimmedPath}}} with ${stringValue} (direct)`,
      );
      return stringValue;
    }
    console.warn(
      `[replaceVariablesInJsonBody] Variable {{${trimmedPath}}} not found. Available variables: ${Object.keys(
        variables,
      ).join(", ")}`,
    );
    return match;
  });
}

function replaceVariables(config, variables) {
  const processed = {};

  Object.entries(config).forEach(([key, value]) => {
    if (typeof value === "string") {
      processed[key] = replaceTemplateVariables(value, variables);
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
        typeof item === "object" ? replaceVariables(item, variables) : item,
      );
    } else {
      processed[key] = value;
    }
  });

  return processed;
}

function replaceDataActionFieldValue(value, variables) {
  if (typeof value !== "string") return value;

  const singleVariableMatch = value.match(/^\s*\{\{([^}]+)\}\}\s*$/);
  if (singleVariableMatch) {
    const resolved = resolveVariablePath(variables, singleVariableMatch[1]);
    if (resolved !== undefined) return resolved;
  }

  return replaceVariables({ value }, variables).value;
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
    } else if (sourcePath.startsWith("query.")) {
      const path = sourcePath.substring(6); // Remove "query." prefix
      value = getValueByPath(payload?.query || {}, path);
    } else {
      value = getValueByPath({ payload, query: payload?.query || {} }, sourcePath);
    }

    if (value !== undefined) {
      variables[variableName] = value;
      console.log(
        `[extractVariablesFromWebhook] Extracted ${variableName} = ${JSON.stringify(
          value,
        )} from ${sourcePath}`,
      );
    } else {
      console.warn(
        `[extractVariablesFromWebhook] Failed to extract ${variableName} from ${sourcePath}`,
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
    query: executionVars.query || executionVars.payload?.query || {},
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
    `[shouldContinueImmediately] eventType: ${eventType}, nodeType: ${nodeType}`,
  );
  console.log(
    `[shouldContinueImmediately] currentNode.type: ${currentNode.type}, currentNode.data?.nodeType: ${currentNode.data?.nodeType}`,
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
    "data_action",
    "set_variable",
    "condition",
    "switch",
    "logic_gate",
    "flow_end",
    "form_submit",
    "form_submit_status",
  ];

  // Note: record_start is NOT in this list because it has dual behavior:
  // - Output 0 (Started) should trigger immediately based on API response
  // - Output 1 (Saved) should trigger on call.recording.saved webhook
  // It's handled specially in the webhook handler

  const result = immediateNodes.includes(nodeType);
  console.log(
    `[shouldContinueImmediately] result: ${result}, immediateNodes.includes("${nodeType}"): ${immediateNodes.includes(
      nodeType,
    )}`,
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
        executionState?.flowId || null,
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
      variables,
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
        executionState?.flowId || null,
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
      output,
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
      1,
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
        executionState?.flowId || null,
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
      outputIndex,
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
      executionState?.flowId || null,
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
        executionState?.flowId || null,
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
        executionState?.flowId || null,
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
        executionState?.flowId || null,
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
      0,
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
      executionState?.flowId || null,
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
        executionState?.flowId || null,
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
          1,
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
        variables,
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
          1,
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
          variables,
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
          1,
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
          variables,
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
      output,
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
      1,
    );
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Execute Flow End Node
 * Terminal node. For outbound campaign calls, also hang up the active call so
 * an answered agentless leg cannot remain connected after the flow is done.
 */
async function executeFlowEndNode(node, callControlId, executionState = {}) {
  const variables = executionState?.variables || {};
  const config = node.data?.config || {};
  const shouldHangupOutboundCall =
    config.hangupOnEnd !== false &&
    callControlId &&
    (
      variables.trigger_type === "outbound_campaign" ||
      variables.outbound_campaign_id ||
      variables.payload?.metadata?.outbound_campaign_id ||
      variables.payload?.metadata?.outbound_ledger_id
    );

  let hangupResult = null;
  if (shouldHangupOutboundCall) {
    hangupResult = await callTelnyxAction(
      executionState?.flowId || variables.flow_id || null,
      "hangup",
      callControlId,
      {},
    );
  }

  // Log flow end execution
  addNodeExecutionEvent(
    callControlId,
    "flow_end",
    node.id,
    node.data?.label || "Flow End",
    {
      message: shouldHangupOutboundCall
        ? "Outbound campaign flow completed; hangup requested"
        : "Flow execution completed",
      hangup_requested: Boolean(shouldHangupOutboundCall),
      hangup_success: hangupResult ? Boolean(hangupResult.success) : null,
    },
    !hangupResult || Boolean(hangupResult.success),
    hangupResult && !hangupResult.success ? 1 : 0,
  );

  return {
    success: !hangupResult || Boolean(hangupResult.success),
    output: 0,
    variables: {},
    hangupRequested: Boolean(shouldHangupOutboundCall),
    hangupResult,
  };
}

/**
 * Execute Form Submit Status Node
 * Terminal-ish node for form data action flows. Returns status/message to the caller.
 */
function executeFormSubmitStatusNode(node, variables, callControlId) {
  const config = node.data?.config || {};
  const status = config.status === "error" ? "error" : "success";
  const message = config.message || (status === "success" ? "Data action completed." : "Data action failed.");
  const responseVariable = config.responseVariable || "form_submit_status";
  const payload = { status, success: status === "success", message };

  addNodeExecutionEvent(
    callControlId,
    "form_submit_status",
    node.id,
    node.data?.label || "Form Submit Status",
    payload,
    payload.success,
    payload.success ? 0 : 1,
  );

  return {
    success: payload.success,
    output: payload.success ? 0 : 1,
    variables: { [responseVariable]: payload },
    formSubmitStatus: payload,
    error: payload.success ? undefined : message,
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
        "[executeHttpRequestNode] Error - Missing URL, logging to monitor",
      );
      addNodeExecutionEvent(
        callControlId,
        "http_request_action",
        node.id,
        node.data?.label || "HTTP Request",
        { error },
        false,
        1,
        executionState?.flowId || null,
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
          encodeURIComponent(value),
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
              varPath.substring(7),
            );
          } else if (varPath.startsWith("payload.")) {
            varValue = getValueByPath(
              variables.payload || {},
              varPath.substring(8),
            );
          } else if (varPath.startsWith("response.")) {
            varValue = getValueByPath(
              variables.response || {},
              varPath.substring(9),
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
                `[executeHttpRequestNode] Single variable reference {{${varPath}}} resolved to object, using directly`,
              );
            } else {
              // Variable is a primitive/string - treat body as JSON template
              let processedBodyValue = replaceVariablesInJsonBody(
                body,
                variables,
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
              variables,
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
        output,
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
          1,
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
        executionState?.flowId || null,
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
      1,
    );
    return {
      success: false,
      output: 1,
      error: errorMsg,
    };
  }
}

/**
 * Execute Data Action Node
 * Performs CRUD operations on Contacts, KB Articles, or Tasks
 */
async function executeDataActionNode(
  node,
  variables,
  callControlId,
  executionState,
) {
  try {
    const config = node.data?.config || {};
    const {
      dataSource,
      action,
      fields = {},
      recordId,
      queryParams = {},
      responseVariable = "data_response",
    } = config;

    if (!dataSource) {
      const error = "Data action node missing data source";
      addNodeExecutionEvent(
        callControlId,
        "data_action",
        node.id,
        node.data?.label || "Data Action",
        { error },
        false,
        1,
        executionState?.flowId || null,
      );
      return {
        success: false,
        output: 1,
        error,
      };
    }

    if (!action) {
      const error = "Data action node missing action";
      addNodeExecutionEvent(
        callControlId,
        "data_action",
        node.id,
        node.data?.label || "Data Action",
        { error },
        false,
        1,
        executionState?.flowId || null,
      );
      return {
        success: false,
        output: 1,
        error,
      };
    }

    // Get base API path
    const basePath = getEntityBasePath(dataSource);
    if (!basePath) {
      const error = `Unknown data source: ${dataSource}`;
      addNodeExecutionEvent(
        callControlId,
        "data_action",
        node.id,
        node.data?.label || "Data Action",
        { error },
        false,
        1,
        executionState?.flowId || null,
      );
      return {
        success: false,
        output: 1,
        error,
      };
    }

    // Build API URL
    const baseUrl =
      typeof process !== "undefined" && process.env.NEXT_PUBLIC_BASE_URL
        ? process.env.NEXT_PUBLIC_BASE_URL
        : typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost:3000";

    let url = `${baseUrl}${basePath}`;
    let method = "GET";
    let body = null;

    // Determine HTTP method and URL based on action
    switch (action) {
      case "create":
        method = "POST";
        // Build request body from fields
        const createBody = {};
        Object.entries(fields).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") {
            // Replace variables in field values, preserving object/array values
            // when a field is mapped directly from a single variable.
            const processedValue = replaceDataActionFieldValue(value, variables);
            createBody[key] = processedValue;
          }
        });
        body = JSON.stringify(createBody);
        break;

      case "read":
        method = "GET";
        if (!recordId) {
          const error = "Read action requires record ID";
          addNodeExecutionEvent(
            callControlId,
            "data_action",
            node.id,
            node.data?.label || "Data Action",
            { error },
            false,
            1,
            executionState?.flowId || null,
          );
          return {
            success: false,
            output: 1,
            error,
          };
        }
        const readId = replaceVariables({ recordId }, variables).recordId;
        url = `${url}/${encodeURIComponent(readId)}`;
        break;

      case "update":
        method = "PATCH";
        if (!recordId) {
          const error = "Update action requires record ID";
          addNodeExecutionEvent(
            callControlId,
            "data_action",
            node.id,
            node.data?.label || "Data Action",
            { error },
            false,
            1,
            executionState?.flowId || null,
          );
          return {
            success: false,
            output: 1,
            error,
          };
        }
        const updateId = replaceVariables({ recordId }, variables).recordId;
        url = `${url}/${encodeURIComponent(updateId)}`;
        // Build request body from fields
        const updateBody = {};
        Object.entries(fields).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") {
            // Replace variables in field values, preserving object/array values
            // when a field is mapped directly from a single variable.
            const processedValue = replaceDataActionFieldValue(value, variables);
            updateBody[key] = processedValue;
          }
        });
        body = JSON.stringify(updateBody);
        break;

      case "delete":
        method = "DELETE";
        if (!recordId) {
          const error = "Delete action requires record ID";
          addNodeExecutionEvent(
            callControlId,
            "data_action",
            node.id,
            node.data?.label || "Data Action",
            { error },
            false,
            1,
            executionState?.flowId || null,
          );
          return {
            success: false,
            output: 1,
            error,
          };
        }
        const deleteId = replaceVariables({ recordId }, variables).recordId;
        url = `${url}/${encodeURIComponent(deleteId)}`;
        break;

      case "list":
        method = "GET";
        // Build query string from queryParams
        const processedQueryParams = {};
        Object.entries(queryParams).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") {
            processedQueryParams[key] = replaceVariables(
              { value },
              variables,
            ).value;
          }
        });
        if (Object.keys(processedQueryParams).length > 0) {
          const queryString = new URLSearchParams(
            processedQueryParams,
          ).toString();
          url = `${url}?${queryString}`;
        }
        break;

      default:
        const error = `Unknown action: ${action}`;
        addNodeExecutionEvent(
          callControlId,
          "data_action",
          node.id,
          node.data?.label || "Data Action",
          { error },
          false,
          1,
          executionState?.flowId || null,
        );
        return {
          success: false,
          output: 1,
          error,
        };
    }

    // Make API call
    try {
      const headers = {
        "Content-Type": "application/json",
      };

      const aiApiKey = process.env.TELNYX_AI_API_KEY || "";
      if (aiApiKey) {
        headers[process.env.TELNYX_AI_API_KEY_REF || "telnyx-ai-api-key"] = aiApiKey;
      }

      const fetchOptions = {
        method,
        headers,
      };

      if (body) {
        fetchOptions.body = body;
      }

      // Note: In a real implementation, we'd need to pass session cookies/headers
      // For now, this will work for server-side execution
      const response = await fetch(url, fetchOptions);
      const responseText = await response.text();
      let responseData;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      // Determine output: 0 = success (2xx), 1 = error (4xx/5xx)
      const output = response.ok ? 0 : 1;

      // Log execution
      addNodeExecutionEvent(
        callControlId,
        "data_action",
        node.id,
        node.data?.label || "Data Action",
        {
          dataSource,
          action,
          request: {
            url,
            method,
            body: body
              ? typeof body === "string"
                ? body
                : JSON.stringify(body)
              : undefined,
          },
          response: {
            status: response.status,
            status_text: response.statusText,
            body: responseData,
          },
        },
        response.ok,
        output,
        executionState?.flowId || null,
      );

      return {
        success: response.ok,
        output,
        variables: {
          [responseVariable]: responseData,
          [`${responseVariable}_status`]: response.status,
        },
      };
    } catch (fetchError) {
      const error = fetchError.message || "Data action API request failed";
      addNodeExecutionEvent(
        callControlId,
        "data_action",
        node.id,
        node.data?.label || "Data Action",
        {
          dataSource,
          action,
          request: {
            url,
            method,
          },
          error,
        },
        false,
        1,
        executionState?.flowId || null,
      );
      return {
        success: false,
        output: 1,
        error,
        variables: {
          [responseVariable]: null,
          [`${responseVariable}_status`]: 0,
        },
      };
    }
  } catch (error) {
    const errorMsg = error.message || "Data action execution failed";
    addNodeExecutionEvent(
      callControlId,
      "data_action",
      node.id,
      node.data?.label || "Data Action",
      { error: errorMsg },
      false,
      1,
      executionState?.flowId || null,
    );
    return {
      success: false,
      output: 1,
      error: errorMsg,
    };
  }
}

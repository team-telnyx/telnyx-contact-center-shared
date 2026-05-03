import { getNodeById } from "@/config/voice-flow-nodes.js";
import {
  validateVariableName,
  validateVariableReferences,
  getAllVariableNames,
} from "@/lib/variable-utils.js";
import { validateExpression } from "@/lib/expression-engine.js";

/**
 * Validate a voice flow
 * Returns an object with: { valid: boolean, errors: string[], warnings: string[] }
 * @param {Object} flow - The flow to validate
 * @param {Array} queues - Optional array of queues to validate enqueue nodes against
 */
export function validateFlow(flow, queues = []) {
  const errors = [];
  const warnings = [];

  if (!flow) {
    errors.push("Flow is null or undefined");
    return { valid: false, errors, warnings };
  }

  const { nodes = [], edges = [] } = flow;

  // Check if flow has nodes
  if (nodes.length === 0) {
    errors.push("Flow must have at least one node");
    return { valid: false, errors, warnings };
  }

  // Check for entry nodes (answer, dial, or initiator nodes)
  const hasEntryNode = nodes.some((node) => {
    const nodeType = node.data?.nodeType;
    return (
      nodeType === "answer" ||
      nodeType === "dial" ||
      nodeType === "incoming_call" ||
      nodeType === "http_request" ||
      nodeType === "form_submit"
    );
  });

  if (!hasEntryNode) {
    errors.push(
      "Flow must have at least one entry node (Answer, Dial, Incoming Call, HTTP Request, or Form Submit)",
    );
  }

  // Check for multiple answer nodes (only one allowed)
  const answerNodes = nodes.filter((node) => node.data?.nodeType === "answer");
  if (answerNodes.length > 1) {
    errors.push("Only one Answer node is allowed per flow");
  }

  // Check for multiple initiator nodes (only one initiator total is allowed)
  const initiatorNodes = nodes.filter(
    (node) =>
      node.data?.nodeType === "incoming_call" ||
      node.data?.nodeType === "http_request" ||
      node.data?.nodeType === "form_submit",
  );
  if (initiatorNodes.length > 1) {
    errors.push(
      "Only one initiator node is allowed per flow (Incoming Call, HTTP Request, or Form Submit)",
    );
  }

  const hasFormSubmitInitiator = nodes.some((node) => node.data?.nodeType === "form_submit");
  const hasFormSubmitStatus = nodes.some((node) => node.data?.nodeType === "form_submit_status");
  if (hasFormSubmitInitiator && !hasFormSubmitStatus) {
    errors.push(
      "Form Submit flows must include a Form Submit Status (form_submit_status) node to return success/error feedback to the submitted form",
    );
  }

  // Validate each node
  nodes.forEach((node) => {
    const nodeId = node.id;
    const nodeType = node.data?.nodeType;
    const nodeData = node.data || {};
    const config = nodeData.config || {};

    // Get node definition
    const nodeDef = getNodeById(nodeType);
    if (!nodeDef) {
      errors.push(`Node "${nodeId}" has unknown type "${nodeType}"`);
      return;
    }

    // Check required parameters
    if (nodeDef.config) {
      Object.entries(nodeDef.config).forEach(([paramKey, paramDef]) => {
        // Only flag as error if required AND no value AND no default value
        const hasValue =
          config[paramKey] !== undefined &&
          config[paramKey] !== null &&
          config[paramKey] !== "";
        const hasDefault = paramDef.default !== undefined;

        if (paramDef.required && !hasValue && !hasDefault) {
          errors.push(
            `Node "${nodeData.label || nodeId}" (${
              nodeDef.label
            }) is missing required parameter "${paramDef.label || paramKey}"`,
          );
        }
      });
    }

    // Special validation for set_queue_options nodes
    if (nodeType === "set_queue_options") {
      // Validate queue_name
      const queueNameUseVariable = config.queue_name_use_variable;
      if (queueNameUseVariable) {
        if (
          !config.queue_name_variable ||
          config.queue_name_variable.trim() === ""
        ) {
          errors.push(
            `Node "${nodeData.label || nodeId}" (Set Queue Options) is missing required parameter "Queue Name variable"`,
          );
        }
      } else {
        if (!config.queue_name || config.queue_name.trim() === "") {
          errors.push(
            `Node "${nodeData.label || nodeId}" (Set Queue Options) is missing required parameter "Queue Name"`,
          );
        }
      }

      // Validate call_priority (optional, 1-5 stars)
      const callPriorityUseVariable = config.call_priority_use_variable;
      if (callPriorityUseVariable) {
        // Call priority variable is optional - no validation needed
      } else {
        // Call priority is optional, but if provided must be valid (1-5 stars)
        if (
          config.call_priority !== undefined &&
          config.call_priority !== null &&
          config.call_priority !== ""
        ) {
          if (config.call_priority < 1 || config.call_priority > 5) {
            errors.push(
              `Node "${nodeData.label || nodeId}" (Set Queue Options) has invalid call priority value. Call priority must be between 1 and 5 stars.`,
            );
          }
        }
      }

      // Validate skills (optional, but if provided must be valid)
      const skillsUseVariable = config.skills_use_variable;
      if (!skillsUseVariable) {
        const skills = config.skills || [];
        // Skills are optional, but if provided, they must be valid
        if (skills.length > 0) {
          const invalidSkills = skills.filter(
            (skill) => !skill || !skill.name || skill.proficiency === undefined,
          );
          if (invalidSkills.length > 0) {
            errors.push(
              `Node "${nodeData.label || nodeId}" (Set Queue Options) has invalid skills. All skills must have a name and proficiency level.`,
            );
          }
        }
      }
    }

    // Special validation for enqueue nodes with skill-based queues
    if (nodeType === "enqueue") {
      const queueName = config.queue_name;
      if (queueName && queues.length > 0) {
        const queue = queues.find((q) => q.name === queueName);
        if (queue && queue.routing_strategy === "Skill-based") {
          // Check if skills are defined in routing_skills
          const routingSkills = config.routing_skills || [];
          const hasSkills =
            Array.isArray(routingSkills) &&
            routingSkills.length > 0 &&
            routingSkills.some(
              (skill) => skill && skill.name && skill.proficiency,
            );

          // Also check client_state for required_skills
          let hasSkillsInClientState = false;
          if (!hasSkills && config.client_state) {
            try {
              const decoded = Buffer.from(
                config.client_state,
                "base64",
              ).toString();
              const clientStateObj = JSON.parse(decoded);
              if (
                clientStateObj.required_skills &&
                typeof clientStateObj.required_skills === "object" &&
                Object.keys(clientStateObj.required_skills).length > 0
              ) {
                hasSkillsInClientState = true;
              }
            } catch {
              // Ignore decode errors
            }
          }

          if (!hasSkills && !hasSkillsInClientState) {
            errors.push(
              `Node "${nodeData.label || nodeId}" (Enqueue Call) uses a skill-based queue ("${queue.display_name || queueName}") but no required skills are defined. Please add at least one skill with a proficiency level.`,
            );
          }
        }
      }
    }
  });

  // Check for orphaned nodes (nodes with no incoming edges, except entry nodes)
  const nodesWithIncoming = new Set(edges.map((e) => e.target));
  nodes.forEach((node) => {
    const nodeType = node.data?.nodeType;
    const isEntryNode =
      nodeType === "answer" ||
      nodeType === "dial" ||
      nodeType === "incoming_call" ||
      nodeType === "http_request" ||
      nodeType === "form_submit";

    if (!isEntryNode && !nodesWithIncoming.has(node.id)) {
      warnings.push(
        `Node "${node.data?.label || node.id}" has no incoming connections`,
      );
    }
  });

  // Check for nodes with no outgoing edges (except terminal nodes like hangup)
  const nodesWithOutgoing = new Set(edges.map((e) => e.source));
  nodes.forEach((node) => {
    const nodeType = node.data?.nodeType;
    const nodeDef = getNodeById(nodeType);
    const isTerminalNode = nodeDef?.outputs === 0;

    if (!isTerminalNode && !nodesWithOutgoing.has(node.id)) {
      warnings.push(
        `Node "${node.data?.label || node.id}" has no outgoing connections`,
      );
    }
  });

  // Check for invalid edge connections
  edges.forEach((edge) => {
    const sourceNode = nodes.find((n) => n.id === edge.source);
    const targetNode = nodes.find((n) => n.id === edge.target);

    if (!sourceNode) {
      errors.push(`Edge references non-existent source node "${edge.source}"`);
    }

    if (!targetNode) {
      errors.push(`Edge references non-existent target node "${edge.target}"`);
    }

    // Check if source node has outputs
    if (sourceNode) {
      const sourceType = sourceNode.data?.nodeType;
      const sourceDef = getNodeById(sourceType);
      if (sourceDef && sourceDef.outputs === 0) {
        errors.push(
          `Node "${sourceNode.data?.label || sourceNode.id}" (${
            sourceDef.label
          }) cannot have outgoing connections`,
        );
      }
    }
  });

  // Check for cycles (optional warning)
  const hasCycle = detectCycle(nodes, edges);
  if (hasCycle) {
    warnings.push(
      "Flow contains a cycle - this may cause infinite loops during execution",
    );
  }

  // Validate global variables
  if (flow.globalVariables) {
    const globalVarNames = Object.keys(flow.globalVariables);
    const seenNames = new Set();

    globalVarNames.forEach((varName) => {
      // Check for duplicate names
      if (seenNames.has(varName)) {
        errors.push(`Duplicate global variable name: "${varName}"`);
      }
      seenNames.add(varName);

      // Validate variable name
      const nameValidation = validateVariableName(varName);
      if (!nameValidation.valid) {
        errors.push(`Global variable "${varName}": ${nameValidation.error}`);
      }

      // Check variable definition
      const varDef = flow.globalVariables[varName];
      if (typeof varDef === "object" && varDef.value === undefined) {
        warnings.push(`Global variable "${varName}" has no value set`);
      }
    });
  }

  // Validate edge variable mappings
  const allVariableNames = getAllVariableNames(flow);
  const edgeVarNames = new Set();

  edges.forEach((edge) => {
    if (
      edge.data?.variableMappings &&
      Array.isArray(edge.data.variableMappings)
    ) {
      edge.data.variableMappings.forEach((mapping) => {
        const { variableName, sourcePath } = mapping;

        if (!variableName) {
          errors.push(
            `Edge ${edge.id || "unknown"} has mapping with no variable name`,
          );
          return;
        }

        // Check for duplicate edge variable names
        if (edgeVarNames.has(variableName)) {
          errors.push(`Duplicate edge variable name: "${variableName}"`);
        }
        edgeVarNames.add(variableName);

        // Validate variable name
        const nameValidation = validateVariableName(variableName);
        if (!nameValidation.valid) {
          errors.push(
            `Edge variable "${variableName}": ${nameValidation.error}`,
          );
        }

        // Check if source path is provided
        if (!sourcePath) {
          errors.push(
            `Edge variable "${variableName}" has no source path defined`,
          );
        }
      });
    }
  });

  // Validate variable references in node configs
  nodes.forEach((node) => {
    const nodeType = node.data?.nodeType;
    const config = node.data?.config || {};

    // Get node definition
    const nodeDef = getNodeById(nodeType);

    // Get available variables at this node's point in execution
    const availableVars = [
      ...allVariableNames,
      "payload",
      "global",
      "response",
    ];

    // Check all string config values for variable references
    Object.entries(config).forEach(([key, value]) => {
      if (typeof value === "string" && value.includes("{{")) {
        // Skip validation for enqueue node's queue_name when use_queue_options is enabled
        // The queue_name will be read from client_state (set by Set Queue Options node)
        if (
          nodeType === "enqueue" &&
          key === "queue_name" &&
          config.use_queue_options === true
        ) {
          return; // Skip validation - queue_name comes from client_state
        }

        const refValidation = validateVariableReferences(value, availableVars);
        if (!refValidation.valid) {
          refValidation.errors.forEach((error) => {
            warnings.push(
              `Node "${node.data?.label || node.id}" (${nodeType}): ${error}`,
            );
          });
        }
      }
    });

    // Validate expressions in specific node types
    if (nodeType === "condition") {
      const { leftOperand, rightOperand } = config;
      if (leftOperand) {
        const validation = validateVariableReferences(
          leftOperand,
          availableVars,
        );
        if (!validation.valid) {
          validation.errors.forEach((error) => {
            warnings.push(
              `Condition node "${node.data?.label || node.id}": ${error}`,
            );
          });
        }
      }
      if (rightOperand) {
        const validation = validateVariableReferences(
          rightOperand,
          availableVars,
        );
        if (!validation.valid) {
          validation.errors.forEach((error) => {
            warnings.push(
              `Condition node "${node.data?.label || node.id}": ${error}`,
            );
          });
        }
      }
    }

    if (nodeType === "set_variable") {
      const { variableName, expression } = config;

      if (variableName) {
        const nameValidation = validateVariableName(variableName);
        if (!nameValidation.valid) {
          errors.push(
            `Set Variable node "${node.data?.label || node.id}": ${
              nameValidation.error
            }`,
          );
        }
      }

      if (expression) {
        const exprValidation = validateExpression(expression, availableVars);
        if (!exprValidation.valid) {
          exprValidation.errors.forEach((error) => {
            errors.push(
              `Set Variable node "${node.data?.label || node.id}": ${error}`,
            );
          });
        }
      }
    }

    if (nodeType === "http_request_action") {
      const { url } = config;
      if (url) {
        // Basic URL validation
        const urlPattern = /^https?:\/\//;
        // Check if URL starts with http/https or contains variables
        if (!urlPattern.test(url) && !url.includes("{{")) {
          warnings.push(
            `HTTP Request node "${
              node.data?.label || node.id
            }": URL should start with http:// or https://`,
          );
        }
      }
    }

    // Validate stream URLs for dial, answer, and streaming_start nodes
    if (
      nodeType === "dial" ||
      nodeType === "answer" ||
      nodeType === "streaming_start"
    ) {
      if (!nodeDef) {
        // Skip validation if nodeDef is not found (already handled in earlier validation)
        return;
      }

      const streamUrl = config.stream_url;
      if (streamUrl) {
        // Skip validation if URL contains variables
        if (!streamUrl.includes("{{")) {
          // Validate WebSocket URL format: ws://domain.com/path or wss://domain.com/path
          // Must have a proper domain (with TLD) or IP address
          // Pattern breakdown:
          // - (ws|wss):// - protocol
          // - ([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,} - domain with TLD (at least 2 chars)
          //   OR \d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3} - IPv4 address
          // - (:\d+)? - optional port
          // - (/.*)? - optional path
          const wsUrlPattern =
            /^(ws|wss):\/\/(([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?(\/.*)?$/i;

          if (!wsUrlPattern.test(streamUrl)) {
            errors.push(
              `Node "${node.data?.label || node.id}" (${
                nodeDef.label
              }): Stream URL must be in format ws://domain.com/path or wss://domain.com/path (must include a valid domain or IP address)`,
            );
          }
        }
      } else if (nodeType === "streaming_start") {
        // stream_url is required for streaming_start
        errors.push(
          `Node "${node.data?.label || node.id}" (${
            nodeDef.label
          }): Stream URL is required`,
        );
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Detect cycles in the flow graph using DFS
 */
function detectCycle(nodes, edges) {
  const graph = {};
  nodes.forEach((node) => {
    graph[node.id] = [];
  });

  edges.forEach((edge) => {
    if (graph[edge.source]) {
      graph[edge.source].push(edge.target);
    }
  });

  const visited = new Set();
  const recStack = new Set();

  function dfs(nodeId) {
    if (recStack.has(nodeId)) {
      return true; // Cycle detected
    }

    if (visited.has(nodeId)) {
      return false;
    }

    visited.add(nodeId);
    recStack.add(nodeId);

    const neighbors = graph[nodeId] || [];
    for (const neighbor of neighbors) {
      if (dfs(neighbor)) {
        return true;
      }
    }

    recStack.delete(nodeId);
    return false;
  }

  for (const nodeId of Object.keys(graph)) {
    if (dfs(nodeId)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a single node's configuration
 */
export function validateNode(nodeType, config) {
  const errors = [];
  const nodeDef = getNodeById(nodeType);

  if (!nodeDef) {
    errors.push(`Unknown node type: ${nodeType}`);
    return { valid: false, errors };
  }

  if (nodeDef.config) {
    Object.entries(nodeDef.config).forEach(([paramKey, paramDef]) => {
      // Only flag as error if required AND no value AND no default value
      const hasValue =
        config[paramKey] !== undefined &&
        config[paramKey] !== null &&
        config[paramKey] !== "";
      const hasDefault = paramDef.default !== undefined;

      if (paramDef.required && !hasValue && !hasDefault) {
        errors.push(
          `Missing required parameter: ${paramDef.label || paramKey}`,
        );
      }

      // Type validation
      if (config[paramKey] !== undefined) {
        const value = config[paramKey];

        if (paramDef.type === "number" && typeof value !== "number") {
          errors.push(
            `Parameter "${paramDef.label || paramKey}" must be a number`,
          );
        }

        if (paramDef.type === "boolean" && typeof value !== "boolean") {
          errors.push(
            `Parameter "${paramDef.label || paramKey}" must be a boolean`,
          );
        }

        // Min/max validation for numbers
        if (paramDef.type === "number" && typeof value === "number") {
          if (paramDef.min !== undefined && value < paramDef.min) {
            errors.push(
              `Parameter "${paramDef.label || paramKey}" must be at least ${
                paramDef.min
              }`,
            );
          }
          if (paramDef.max !== undefined && value > paramDef.max) {
            errors.push(
              `Parameter "${paramDef.label || paramKey}" must be at most ${
                paramDef.max
              }`,
            );
          }
        }
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

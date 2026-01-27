"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  IconPlus,
  IconTrash,
  IconStar,
  IconStarFilled,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";

// Helper function to check if Set Queue Options node exists before Enqueue node
function hasSetQueueOptionsNodeBefore(nodeId, nodes, edges) {
  // Build a graph to find all nodes that can reach this node
  const incomingEdges = edges.filter((e) => e.target === nodeId);
  if (incomingEdges.length === 0) {
    return false;
  }

  // Use DFS to check all paths leading to this node
  const visited = new Set();
  const queue = [...incomingEdges.map((e) => e.source)];

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    if (visited.has(currentNodeId)) {
      continue;
    }
    visited.add(currentNodeId);

    const currentNode = nodes.find((n) => n.id === currentNodeId);
    if (currentNode?.data?.nodeType === "set_queue_options") {
      return true;
    }

    // Add all nodes that lead to this node
    const prevEdges = edges.filter((e) => e.target === currentNodeId);
    prevEdges.forEach((e) => {
      if (!visited.has(e.source)) {
        queue.push(e.source);
      }
    });
  }

  return false;
}

// Helper function to get badge color for queue type
function getQueueTypeBadgeColor(routingStrategy) {
  switch (routingStrategy) {
    case "FIFO":
      return "bg-blue-500";
    case "Skill-based":
      return "bg-purple-500";
    case "Priority-based":
      return "bg-orange-500";
    default:
      return "bg-gray-500";
  }
}

// Helper function to get display name for queue type
function getQueueTypeDisplayName(routingStrategy) {
  switch (routingStrategy) {
    case "FIFO":
      return "FIFO";
    case "Skill-based":
      return "SKILLS";
    case "Priority-based":
      return "PRIORITY";
    default:
      return routingStrategy || "FIFO";
  }
}

// Star rating component
function StarRating({ value, onChange, maxStars = 5 }) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: maxStars }, (_, i) => {
        const starValue = i + 1;
        const filled = starValue <= value;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(starValue)}
            className="focus:outline-none"
            aria-label={`Set rating to ${starValue} stars`}
          >
            {filled ? (
              <IconStarFilled className="w-4 h-4 text-yellow-400" />
            ) : (
              <IconStar className="w-4 h-4 text-gray-300" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function EnqueueNodeEditor({
  config = {},
  onChange,
  queues = [],
  nodes = [],
  edges = [],
  currentNodeId = null,
}) {
  // Check if Set Queue Options node exists before this node
  const hasSetQueueOptionsBefore = useMemo(() => {
    if (!currentNodeId) {
      return false;
    }
    return hasSetQueueOptionsNodeBefore(currentNodeId, nodes, edges);
  }, [currentNodeId, nodes, edges]);

  const [useQueueOptions, setUseQueueOptions] = useState(
    config.use_queue_options !== undefined ? config.use_queue_options : false
  );

  const [selectedQueueName, setSelectedQueueName] = useState(
    config.queue_name || ""
  );

  // Initialize skills from config.routing_skills or extract from client_state
  const initialSkills = useMemo(() => {
    if (
      config.routing_skills &&
      Array.isArray(config.routing_skills) &&
      config.routing_skills.length > 0
    ) {
      return config.routing_skills;
    }
    // Try to extract from client_state if routing_skills not in config
    if (config.client_state) {
      try {
        const decoded = atob(config.client_state);
        const clientStateObj = JSON.parse(decoded);
        if (
          clientStateObj.required_skills &&
          typeof clientStateObj.required_skills === "object"
        ) {
          // Convert required_skills object to skills array format
          return Object.entries(clientStateObj.required_skills).map(
            ([name, proficiency]) => ({
              name,
              proficiency:
                typeof proficiency === "number"
                  ? proficiency
                  : parseInt(proficiency, 10) || 1,
            })
          );
        }
      } catch {
        // Ignore decode errors
      }
    }
    return [];
  }, [config.routing_skills, config.client_state]);

  const [skills, setSkills] = useState(initialSkills);
  const [priority, setPriority] = useState(config.routing_priority || 50);
  const [availableSkills, setAvailableSkills] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(false);

  // Find selected queue
  const selectedQueue = useMemo(() => {
    return queues.find((q) => q.name === selectedQueueName);
  }, [queues, selectedQueueName]);

  const queueType = selectedQueue?.routing_strategy || "FIFO";

  // Load available skills
  useEffect(() => {
    async function loadSkills() {
      setLoadingSkills(true);
      try {
        const res = await fetch("/api/admin/skills?active=true&pageSize=1000");
        if (res.ok) {
          const data = await res.json();
          setAvailableSkills(data.items || []);
        }
      } catch (err) {
        console.error("Failed to load skills:", err);
      } finally {
        setLoadingSkills(false);
      }
    }
    loadSkills();
  }, []);

  // Sync skills from config when it changes (e.g., when node is selected)
  useEffect(() => {
    if (config.routing_skills && Array.isArray(config.routing_skills)) {
      setSkills(config.routing_skills);
    } else if (config.client_state) {
      // Try to extract from client_state
      try {
        const decoded = atob(config.client_state);
        const clientStateObj = JSON.parse(decoded);
        if (
          clientStateObj.required_skills &&
          typeof clientStateObj.required_skills === "object"
        ) {
          const extractedSkills = Object.entries(
            clientStateObj.required_skills
          ).map(([name, proficiency]) => ({
            name,
            proficiency:
              typeof proficiency === "number"
                ? proficiency
                : parseInt(proficiency, 10) || 1,
          }));
          if (extractedSkills.length > 0) {
            setSkills(extractedSkills);
          }
        }
      } catch {
        // Ignore decode errors
      }
    }
  }, [config.routing_skills, config.client_state]);

  // Track previous values to avoid unnecessary updates
  const prevValuesRef = useRef({
    selectedQueueName,
    skills: JSON.stringify(skills),
    priority,
    queueType,
    useQueueOptions,
  });

  // Update config when internal state changes
  useEffect(() => {
    // Check if values actually changed
    const prev = prevValuesRef.current;
    const skillsStr = JSON.stringify(skills);
    const hasChanged =
      prev.selectedQueueName !== selectedQueueName ||
      prev.priority !== priority ||
      prev.queueType !== queueType ||
      prev.skills !== skillsStr ||
      prev.useQueueOptions !== useQueueOptions;

    if (!hasChanged) {
      return;
    }

    // Update ref before processing
    prevValuesRef.current = {
      selectedQueueName,
      skills: skillsStr,
      priority,
      queueType,
      useQueueOptions,
    };

    const newConfig = {
      ...config,
      use_queue_options: useQueueOptions,
    };

    // If using queue options from Set Queue Options node, don't set these values
    // They will be read from client_state at execution time
    if (!useQueueOptions) {
      newConfig.queue_name = selectedQueueName;
      newConfig.routing_skills = skills;
      newConfig.routing_priority = priority;
    } else {
      // Clear these values when using queue options
      // Set to null explicitly to prevent default value from being applied
      newConfig.queue_name = null;
      delete newConfig.routing_skills;
      delete newConfig.routing_priority;
    }

    // Build client_state by merging routing parameters (only if not using queue options)
    if (!useQueueOptions) {
      let clientStateObj = {};

      // Parse existing client_state if present
      if (config.client_state) {
        try {
          // Try to decode if it's base64 (browser-compatible)
          const decoded = atob(config.client_state);
          clientStateObj = JSON.parse(decoded);
        } catch {
          // If not base64, try parsing directly
          try {
            clientStateObj = JSON.parse(config.client_state);
          } catch {
            // If parsing fails, start fresh but preserve the original as-is
            // This handles cases where client_state might not be JSON
            if (queueType === "FIFO" || (!skills.length && !priority)) {
              newConfig.client_state = config.client_state;
              onChange?.(newConfig);
              return;
            }
            clientStateObj = {};
          }
        }
      }

      // Add/update routing parameters based on queue type (merge, don't overwrite)
      // Clean up routing params that don't apply to current queue type
      if (queueType !== "Skill-based") {
        delete clientStateObj.required_skills;
      }
      if (queueType !== "Priority-based") {
        delete clientStateObj.priority;
      }

      // Add routing parameters for current queue type
      if (queueType === "Skill-based") {
        if (skills.length > 0) {
          const requiredSkills = {};
          skills.forEach((skill) => {
            if (skill.name && skill.proficiency) {
              requiredSkills[skill.name] = skill.proficiency;
            }
          });
          if (Object.keys(requiredSkills).length > 0) {
            clientStateObj.required_skills = requiredSkills;
          } else {
            // If no valid skills, remove required_skills
            delete clientStateObj.required_skills;
          }
        } else {
          // If skills array is empty, remove required_skills
          delete clientStateObj.required_skills;
        }
      }

      if (queueType === "Priority-based" && priority) {
        clientStateObj.priority = priority;
      }

      // Encode client_state as base64 JSON (preserve all existing fields)
      if (Object.keys(clientStateObj).length > 0) {
        newConfig.client_state = btoa(JSON.stringify(clientStateObj));
      } else if (config.client_state && queueType === "FIFO") {
        // Keep existing client_state for FIFO if no routing params were set
        newConfig.client_state = config.client_state;
      }
    } else {
      // When using queue options, clear client_state from enqueue node config
      // The engine will read from the call's client_state (set by Set Queue Options node)
      delete newConfig.client_state;
    }

    onChange?.(newConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedQueueName, skills, priority, queueType, useQueueOptions]);

  const handleAddSkill = () => {
    setSkills([...skills, { name: "", proficiency: 1 }]);
  };

  const handleRemoveSkill = (index) => {
    setSkills(skills.filter((_, i) => i !== index));
  };

  const handleSkillChange = (index, field, value) => {
    const updated = [...skills];
    updated[index] = { ...updated[index], [field]: value };
    setSkills(updated);
  };

  return (
    <div className="space-y-4">
      {/* Use Queue Options Toggle */}
      {hasSetQueueOptionsBefore && (
        <div className="p-4 border rounded-lg bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label htmlFor="use_queue_options" className="text-sm font-semibold">
                Use Queue Options
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                Use queue options (name, priority, skills) set by Set Queue Options node
              </p>
            </div>
            <Switch
              id="use_queue_options"
              checked={useQueueOptions}
              onCheckedChange={(checked) => {
                setUseQueueOptions(checked);
                onChange?.({
                  ...config,
                  use_queue_options: checked,
                });
              }}
            />
          </div>
        </div>
      )}

      {/* Queue Name Selector */}
      {!useQueueOptions && (
        <>
      <div className="mt-4">
        <Label htmlFor="queue_name">
          Queue Name <span className="text-red-500 mt-0.5">*</span>
        </Label>
        <Select value={selectedQueueName} onValueChange={setSelectedQueueName}>
          <SelectTrigger className="mt-1 w-full">
            <SelectValue placeholder="Select a queue" />
          </SelectTrigger>
          <SelectContent>
            {queues.length > 0 ? (
              queues.map((queue) => (
                <SelectItem key={queue.id} value={queue.name}>
                  <div className="flex items-center gap-2">
                    <span>{queue.display_name || queue.name}</span>
                    <Badge
                      className={cn(
                        "text-xs",
                        getQueueTypeBadgeColor(queue.routing_strategy)
                      )}
                    >
                      {getQueueTypeDisplayName(queue.routing_strategy)}
                    </Badge>
                  </div>
                </SelectItem>
              ))
            ) : (
              <SelectItem value="__no_queues__" disabled>
                No enabled queues available
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Select the queue to enqueue the call to
        </p>
      </div>

      {/* Skills-based Routing Configuration */}
      {queueType === "Skill-based" && (
        <div className="space-y-3 p-4 border rounded-lg bg-muted/50 mt-4">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-semibold">Required Skills</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddSkill}
            >
              <IconPlus className="w-4 h-4 mr-1" />
              Add Skill
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Define skills required for this call with minimum proficiency levels
          </p>

          {skills.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No skills defined. Add skills to enable skills-based routing.
            </p>
          ) : (
            <div className="space-y-3">
              {skills.map((skill, index) => (
                <div key={index} className="flex items-center gap-3">
                  <Select
                    value={skill.name || undefined}
                    onValueChange={(value) =>
                      handleSkillChange(index, "name", value)
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select a skill" />
                    </SelectTrigger>
                    <SelectContent>
                      {loadingSkills ? (
                        <SelectItem value="__loading__" disabled>
                          Loading skills...
                        </SelectItem>
                      ) : availableSkills.length > 0 ? (
                        availableSkills
                          .filter(
                            (s) =>
                              !skill.name || // Allow if no skill selected yet
                              s.name === skill.name || // Include currently selected skill
                              !skills.some(
                                (sk, idx) => sk.name === s.name && idx !== index
                              )
                          )
                          .map((skillOption) => (
                            <SelectItem
                              key={skillOption.id}
                              value={skillOption.name}
                            >
                              {skillOption.name}
                            </SelectItem>
                          ))
                      ) : (
                        <SelectItem value="__no_skills__" disabled>
                          No skills available
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <StarRating
                    value={skill.proficiency || 1}
                    onChange={(value) =>
                      handleSkillChange(index, "proficiency", value)
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveSkill(index)}
                  >
                    <IconTrash className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Priority-based Routing Configuration */}
      {queueType === "Priority-based" && (
        <div className="space-y-3 p-4 border rounded-lg bg-muted/50">
          <Label htmlFor="routing_priority" className="text-sm font-semibold">
            Call Priority
          </Label>
          <div className="flex items-center gap-3">
            <Input
              id="routing_priority"
              type="number"
              min="1"
              max="100"
              value={priority}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                if (!isNaN(value) && value >= 1 && value <= 100) {
                  setPriority(value);
                }
              }}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">
              (1 = lowest, 100 = highest)
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Set the priority level for this call. Higher priority calls will be
            routed to agents first.
          </p>
        </div>
      )}
        </>
      )}

      {/* Other enqueue config fields */}
      <div>
        <Label htmlFor="max_wait_time_secs">Max Wait Time (seconds)</Label>
        <Input
          id="max_wait_time_secs"
          type="number"
          value={config.max_wait_time_secs || ""}
          onChange={(e) =>
            onChange?.({
              ...config,
              max_wait_time_secs: e.target.value
                ? parseInt(e.target.value, 10)
                : undefined,
            })
          }
          placeholder="600"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The number of seconds after which the call will be removed from the
          queue
        </p>
      </div>

      <div>
        <Label htmlFor="max_size">Max Queue Size</Label>
        <Input
          id="max_size"
          type="number"
          value={config.max_size || ""}
          onChange={(e) =>
            onChange?.({
              ...config,
              max_size: e.target.value
                ? parseInt(e.target.value, 10)
                : undefined,
            })
          }
          placeholder="200"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The maximum number of calls allowed in the queue at a given time
        </p>
      </div>

      <div>
        <Label htmlFor="keep_after_hangup">Keep After Hangup</Label>
        <Select
          value={String(config.keep_after_hangup || false)}
          onValueChange={(value) =>
            onChange?.({
              ...config,
              keep_after_hangup: value === "true",
            })
          }
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          If set to true, the call will remain in the queue after hangup
        </p>
      </div>
    </div>
  );
}

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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  IconPlus,
  IconTrash,
  IconStar,
  IconStarFilled,
} from "@tabler/icons-react";
import { VariableInput } from "./VariableInput";
import { cn } from "@/lib/utils";

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
function StarRating({ value, onChange, maxStars = 5, disabled = false }) {
  return (
    <div className={`flex gap-1 ${disabled ? "opacity-60 pointer-events-none" : ""}`}>
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
            disabled={disabled}
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

export default function SetQueueOptionsNodeEditor({
  config = {},
  onChange,
  queues = [],
  availableVariables = [],
  onValidationChange,
}) {
  // Queue Name
  const [queueNameUseVariable, setQueueNameUseVariable] = useState(
    config.queue_name_use_variable !== undefined
      ? config.queue_name_use_variable
      : false
  );
  const [queueName, setQueueName] = useState(config.queue_name || "");
  const [queueNameVariable, setQueueNameVariable] = useState(
    config.queue_name_variable || ""
  );

  // Call Priority (1-5 stars)
  const [callPriorityUseVariable, setCallPriorityUseVariable] = useState(
    config.call_priority_use_variable !== undefined
      ? config.call_priority_use_variable
      : false
  );
  const [callPriority, setCallPriority] = useState(
    config.call_priority !== undefined ? config.call_priority : 3
  );
  const [callPriorityVariable, setCallPriorityVariable] = useState(
    config.call_priority_variable || ""
  );

  // Skills
  const [skillsUseVariable, setSkillsUseVariable] = useState(
    config.skills_use_variable !== undefined
      ? config.skills_use_variable
      : false
  );
  const initialSkills = useMemo(() => {
    if (
      config.skills &&
      Array.isArray(config.skills) &&
      config.skills.length > 0
    ) {
      return config.skills;
    }
    return [];
  }, [config.skills]);
  const [skills, setSkills] = useState(initialSkills);
  const [skillsVariable, setSkillsVariable] = useState(
    config.skills_variable || ""
  );
  const [availableSkills, setAvailableSkills] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(false);

  // Find selected queue to check routing strategy
  const selectedQueue = useMemo(() => {
    const queueNameToFind = queueNameUseVariable ? queueNameVariable : queueName;
    return queues.find((q) => q.name === queueNameToFind);
  }, [queues, queueName, queueNameVariable, queueNameUseVariable]);

  const queueRoutingStrategy = selectedQueue?.routing_strategy || null;

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

  // Sync skills from config when it changes
  useEffect(() => {
    if (config.skills && Array.isArray(config.skills)) {
      setSkills(config.skills);
    }
  }, [config.skills]);

  // Reset call priority to 3 when queue changes to FIFO
  // Clear skills when queue changes to non-Skill-based
  useEffect(() => {
    // Only update if queue routing strategy is FIFO and priority is not 3
    if (queueRoutingStrategy === "FIFO") {
      if (callPriority !== 3) {
        setCallPriority(3);
        setCallPriorityUseVariable(false);
      }
      return; // Exit early to avoid multiple updates
    }
    // Only clear skills if queue is not Skill-based and skills exist
    if (queueRoutingStrategy !== "Skill-based" && skills.length > 0) {
      setSkills([]);
      setSkillsUseVariable(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueRoutingStrategy]); // Only depend on queueRoutingStrategy to avoid loops

  // Track previous values to avoid unnecessary updates
  const prevValuesRef = useRef({
    queueName,
    queueNameVariable,
    queueNameUseVariable,
    callPriority,
    callPriorityVariable,
    callPriorityUseVariable,
    skills: JSON.stringify(skills),
    skillsVariable,
    skillsUseVariable,
  });

  // Update config when internal state changes
  useEffect(() => {
    const prev = prevValuesRef.current;
    const skillsStr = JSON.stringify(skills);
    const hasChanged =
      prev.queueName !== queueName ||
      prev.queueNameVariable !== queueNameVariable ||
      prev.queueNameUseVariable !== queueNameUseVariable ||
      prev.callPriority !== callPriority ||
      prev.callPriorityVariable !== callPriorityVariable ||
      prev.callPriorityUseVariable !== callPriorityUseVariable ||
      prev.skills !== skillsStr ||
      prev.skillsVariable !== skillsVariable ||
      prev.skillsUseVariable !== skillsUseVariable;

    if (!hasChanged) {
      return;
    }

    prevValuesRef.current = {
      queueName,
      queueNameVariable,
      queueNameUseVariable,
      callPriority,
      callPriorityVariable,
      callPriorityUseVariable,
      skills: skillsStr,
      skillsVariable,
      skillsUseVariable,
    };

    // Build new config, explicitly excluding old priority and skills if queue is not Skill-based
    const { skills: _, priority: __, ...configWithoutSkillsAndPriority } = config;
    const newConfig = {
      ...configWithoutSkillsAndPriority,
      queue_name: queueNameUseVariable ? queueNameVariable : queueName,
      queue_name_use_variable: queueNameUseVariable,
      queue_name_variable: queueNameVariable,
      call_priority: callPriorityUseVariable ? callPriorityVariable : callPriority,
      call_priority_use_variable: callPriorityUseVariable,
      call_priority_variable: callPriorityVariable,
      skills_use_variable: skillsUseVariable,
      skills_variable: skillsVariable,
    };
    
    // Only set skills if queue is Skill-based and has skills
    if (queueRoutingStrategy === "Skill-based" && !skillsUseVariable && skills.length > 0) {
      newConfig.skills = skills;
    }
    // Note: skills is already excluded from newConfig above if queue is not Skill-based

    // Build client_state with queue options
    let clientStateObj = {};

    // Parse existing client_state if present
    if (config.client_state) {
      try {
        const decoded = atob(config.client_state);
        clientStateObj = JSON.parse(decoded);
      } catch {
        try {
          clientStateObj = JSON.parse(config.client_state);
        } catch {
          clientStateObj = {};
        }
      }
    }

    // Remove old parameters that should not be in client_state
    delete clientStateObj.priority; // Old parameter, use call_priority instead

    // Add queue options to client_state
    if (!queueNameUseVariable && queueName) {
      clientStateObj.queue_name = queueName;
    }
    if (!callPriorityUseVariable && callPriority !== undefined && callPriority >= 1 && callPriority <= 5) {
      clientStateObj.call_priority = callPriority;
    }
    
    // Only set required_skills if queue routing strategy is Skill-based
    if (queueRoutingStrategy === "Skill-based") {
      if (!skillsUseVariable && skills.length > 0) {
        const requiredSkills = {};
        skills.forEach((skill) => {
          if (skill.name && skill.proficiency) {
            requiredSkills[skill.name] = skill.proficiency;
          }
        });
        if (Object.keys(requiredSkills).length > 0) {
          clientStateObj.required_skills = requiredSkills;
        } else {
          // Remove required_skills if no valid skills
          delete clientStateObj.required_skills;
        }
      } else {
        // Remove required_skills if using variable or no skills
        delete clientStateObj.required_skills;
      }
    } else {
      // Remove required_skills for non-Skill-based queues
      delete clientStateObj.required_skills;
    }

    // Encode client_state as base64 JSON
    if (Object.keys(clientStateObj).length > 0) {
      newConfig.client_state = btoa(JSON.stringify(clientStateObj));
    }

    onChange?.(newConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    queueName,
    queueNameVariable,
    queueNameUseVariable,
    callPriority,
    callPriorityVariable,
    callPriorityUseVariable,
    skills,
    skillsVariable,
    skillsUseVariable,
    queueRoutingStrategy,
  ]);

  // Validation
  const validationErrors = useMemo(() => {
    const errors = [];
    if (queueNameUseVariable) {
      if (!queueNameVariable || queueNameVariable.trim() === "") {
        errors.push("Queue Name variable is required");
      }
    } else {
      if (!queueName || queueName.trim() === "") {
        errors.push("Queue Name is required");
      }
    }
    if (callPriorityUseVariable) {
      // Call priority variable is optional - no validation needed
    } else {
      if (callPriority !== undefined && callPriority !== null && callPriority !== "") {
        if (callPriority < 1 || callPriority > 5) {
          errors.push("Call Priority must be between 1 and 5");
        }
      }
    }
    if (skillsUseVariable) {
      // Skills variable is optional - no validation needed
    } else {
      // Skills are optional, but if provided, they must be valid
      if (skills && skills.length > 0) {
        // Check for duplicate skills FIRST (more specific error)
        const skillNames = skills
          .map((s) => s.name)
          .filter(Boolean);
        const duplicateNames = skillNames.filter(
          (name, index) => skillNames.indexOf(name) !== index
        );
        if (duplicateNames.length > 0) {
          errors.push("Skill name cannot be duplicated. Each skill can only be added once.");
        }
        
        // Check for incomplete skills (only if no duplicates found)
        if (duplicateNames.length === 0) {
          const invalidSkills = skills.filter(
            (skill) => !skill.name || !skill.proficiency
          );
          if (invalidSkills.length > 0) {
            errors.push("All skills must have a name and proficiency level");
          }
        }
      }
    }
    return errors;
  }, [
    queueName,
    queueNameVariable,
    queueNameUseVariable,
    callPriority,
    callPriorityVariable,
    callPriorityUseVariable,
    skills,
    skillsVariable,
    skillsUseVariable,
  ]);

  // Notify parent of validation state
  useEffect(() => {
    if (onValidationChange) {
      onValidationChange({
        isValid: validationErrors.length === 0,
        errors: validationErrors,
      });
    }
  }, [validationErrors, onValidationChange]);

  const handleAddSkill = () => {
    // Prevent adding more skills than available
    if (skills.length >= availableSkills.length) {
      return;
    }
    setSkills([...skills, { name: "", proficiency: 1 }]);
  };

  const handleRemoveSkill = (index) => {
    setSkills(skills.filter((_, i) => i !== index));
  };

  const handleSkillChange = (index, field, value) => {
    // If changing skill name, check for duplicates BEFORE updating
    if (field === "name" && value) {
      const isDuplicate = skills.some(
        (sk, idx) => sk.name === value && idx !== index
      );
      if (isDuplicate) {
        // Prevent duplicate selection - don't update
        return;
      }
    }
    const updated = [...skills];
    updated[index] = { ...updated[index], [field]: value };
    setSkills(updated);
  };

  return (
    <div className="space-y-4">
      {/* Queue Name */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <Label htmlFor="queue_name">
            Queue Name <span className="text-red-500 mt-0.5">*</span>
          </Label>
          <div className="flex items-center gap-2">
            <Label htmlFor="queue_name_use_variable" className="text-xs">
              Use Variable
            </Label>
            <Switch
              id="queue_name_use_variable"
              checked={queueNameUseVariable}
              onCheckedChange={setQueueNameUseVariable}
            />
          </div>
        </div>
        {queueNameUseVariable ? (
          <VariableInput
            value={queueNameVariable}
            onChange={setQueueNameVariable}
            availableVariables={availableVariables}
            placeholder="{{queue_name}}"
            className="mt-1 w-full"
          />
        ) : (
          <Select value={queueName} onValueChange={setQueueName}>
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
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {queueNameUseVariable
            ? "Enter a variable name (e.g., {{queue_name}})"
            : "Select the queue name"}
        </p>
      </div>

      {/* Call Priority (1-5 stars) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label htmlFor="call_priority">
            Call Priority
          </Label>
          <div className="flex items-center gap-2">
            <Label htmlFor="call_priority_use_variable" className="text-xs">
              Use Variable
            </Label>
            <Switch
              id="call_priority_use_variable"
              checked={callPriorityUseVariable}
              onCheckedChange={setCallPriorityUseVariable}
              disabled={queueRoutingStrategy === "FIFO"}
            />
          </div>
        </div>
        {callPriorityUseVariable ? (
          <VariableInput
            value={callPriorityVariable}
            onChange={setCallPriorityVariable}
            availableVariables={availableVariables}
            placeholder="{{call_priority}}"
            className="mt-1 w-full"
            disabled={queueRoutingStrategy === "FIFO"}
          />
        ) : (
          <div className="flex items-center gap-3 mt-1">
            <StarRating
              value={callPriority}
              onChange={setCallPriority}
              maxStars={5}
              disabled={queueRoutingStrategy === "FIFO"}
            />
            <span className="text-sm text-muted-foreground">
              {callPriority === 1 && "Low"}
              {callPriority === 2 && "Below Normal"}
              {callPriority === 3 && "Normal"}
              {callPriority === 4 && "Above Normal"}
              {callPriority === 5 && "High"}
            </span>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {queueRoutingStrategy === "FIFO" ? (
            "Call priority is set to Normal (3 stars) by default for FIFO queues. Priority-based routing is not used in FIFO strategy."
          ) : callPriorityUseVariable ? (
            "Enter a variable name (e.g., {{call_priority}})"
          ) : (
            "Call-level priority (1-5 stars). Higher priority calls are routed first. Works with all routing types including skills-based routing."
          )}
        </p>
      </div>

      {/* Skills - Only show for Skill-based queues */}
      {queueRoutingStrategy === "Skill-based" && (
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-sm font-semibold">
            Required Skills
          </Label>
        </div>
        <div className="space-y-3 p-4 border rounded-lg bg-muted/50">
          {/* First row: Add Skill button and Use Variable toggle */}
          <div className="flex items-center justify-between">
            {!skillsUseVariable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddSkill}
                disabled={
                  loadingSkills ||
                  availableSkills.length === 0 ||
                  skills.length >= availableSkills.length
                }
                title={
                  skills.length >= availableSkills.length
                    ? "All available skills have been added"
                    : "Add a skill"
                }
              >
                <IconPlus className="w-4 h-4 mr-1" />
                Add Skill
              </Button>
            ) : (
              <div></div>
            )}
            <div className="flex items-center gap-2">
              <Label htmlFor="skills_use_variable" className="text-xs">
                Use Variable
              </Label>
              <Switch
                id="skills_use_variable"
                checked={skillsUseVariable}
                onCheckedChange={setSkillsUseVariable}
              />
            </div>
          </div>
          
          <p className="text-xs text-muted-foreground">
            {skillsUseVariable
              ? "Enter a variable name containing skills object (e.g., {{skills}})"
              : "Define skills required for this call with minimum proficiency levels"}
          </p>

        {skillsUseVariable ? (
          <VariableInput
            value={skillsVariable}
            onChange={setSkillsVariable}
            availableVariables={availableVariables}
            placeholder="{{skills}}"
            className="mt-1 w-full"
          />
        ) : skills.length === 0 ? (
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
                        .filter((s) => {
                          // Always show the currently selected skill for this row
                          if (skill.name && s.name === skill.name) {
                            return true;
                          }
                          // For all other skills, exclude those already selected in other rows
                          return !skills.some(
                            (sk, idx) => sk.name === s.name && idx !== index
                          );
                        })
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
      </div>
      )}

      {/* Validation Errors */}
      {validationErrors.length > 0 && (
        <div className="p-3 border border-destructive rounded-lg bg-destructive/10">
          <p className="text-sm font-semibold text-destructive mb-2">
            Validation Errors:
          </p>
          <ul className="text-xs text-destructive space-y-1 list-disc list-inside">
            {validationErrors.map((error, idx) => (
              <li key={idx}>{error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}


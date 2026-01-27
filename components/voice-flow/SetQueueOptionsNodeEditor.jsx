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

  // Priority
  const [priorityUseVariable, setPriorityUseVariable] = useState(
    config.priority_use_variable !== undefined
      ? config.priority_use_variable
      : false
  );
  const [priority, setPriority] = useState(
    config.priority !== undefined ? config.priority : 50
  );
  const [priorityVariable, setPriorityVariable] = useState(
    config.priority_variable || ""
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

  // Track previous values to avoid unnecessary updates
  const prevValuesRef = useRef({
    queueName,
    queueNameVariable,
    queueNameUseVariable,
    priority,
    priorityVariable,
    priorityUseVariable,
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
      prev.priority !== priority ||
      prev.priorityVariable !== priorityVariable ||
      prev.priorityUseVariable !== priorityUseVariable ||
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
      priority,
      priorityVariable,
      priorityUseVariable,
      skills: skillsStr,
      skillsVariable,
      skillsUseVariable,
    };

    const newConfig = {
      ...config,
      queue_name: queueNameUseVariable ? queueNameVariable : queueName,
      queue_name_use_variable: queueNameUseVariable,
      queue_name_variable: queueNameVariable,
      priority: priorityUseVariable ? priorityVariable : priority,
      priority_use_variable: priorityUseVariable,
      priority_variable: priorityVariable,
      skills: skillsUseVariable ? undefined : skills,
      skills_use_variable: skillsUseVariable,
      skills_variable: skillsVariable,
    };

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

    // Add queue options to client_state
    if (!queueNameUseVariable && queueName) {
      clientStateObj.queue_name = queueName;
    }
    if (!priorityUseVariable && priority !== undefined) {
      clientStateObj.priority = priority;
    }
    if (!skillsUseVariable && skills.length > 0) {
      const requiredSkills = {};
      skills.forEach((skill) => {
        if (skill.name && skill.proficiency) {
          requiredSkills[skill.name] = skill.proficiency;
        }
      });
      if (Object.keys(requiredSkills).length > 0) {
        clientStateObj.required_skills = requiredSkills;
      }
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
    priority,
    priorityVariable,
    priorityUseVariable,
    skills,
    skillsVariable,
    skillsUseVariable,
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
    if (priorityUseVariable) {
      if (!priorityVariable || priorityVariable.trim() === "") {
        errors.push("Priority variable is required");
      }
    } else {
      if (priority === undefined || priority === null || priority === "") {
        errors.push("Priority is required");
      } else if (priority < 1 || priority > 100) {
        errors.push("Priority must be between 1 and 100");
      }
    }
    if (skillsUseVariable) {
      // Skills variable is optional - no validation needed
    } else {
      // Skills are optional, but if provided, they must be valid
      if (skills && skills.length > 0) {
        const invalidSkills = skills.filter(
          (skill) => !skill.name || !skill.proficiency
        );
        if (invalidSkills.length > 0) {
          errors.push("All skills must have a name and proficiency level");
        }
      }
    }
    return errors;
  }, [
    queueName,
    queueNameVariable,
    queueNameUseVariable,
    priority,
    priorityVariable,
    priorityUseVariable,
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

      {/* Priority */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label htmlFor="priority">
            Priority <span className="text-red-500 mt-0.5">*</span>
          </Label>
          <div className="flex items-center gap-2">
            <Label htmlFor="priority_use_variable" className="text-xs">
              Use Variable
            </Label>
            <Switch
              id="priority_use_variable"
              checked={priorityUseVariable}
              onCheckedChange={setPriorityUseVariable}
            />
          </div>
        </div>
        {priorityUseVariable ? (
          <VariableInput
            value={priorityVariable}
            onChange={setPriorityVariable}
            availableVariables={availableVariables}
            placeholder="{{priority}}"
            className="mt-1 w-full"
          />
        ) : (
          <div className="flex items-center gap-3 mt-1">
            <Input
              id="priority"
              type="number"
              min="1"
              max="100"
              value={priority}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                if (!isNaN(value) && value >= 1 && value <= 100) {
                  setPriority(value);
                } else if (e.target.value === "") {
                  setPriority("");
                }
              }}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">
              (1 = lowest, 100 = highest)
            </span>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {priorityUseVariable
            ? "Enter a variable name (e.g., {{priority}})"
            : "Set the priority level for this call (1-100)"}
        </p>
      </div>

      {/* Skills */}
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
                        .filter(
                          (s) =>
                            !skill.name ||
                            s.name === skill.name ||
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
      </div>

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


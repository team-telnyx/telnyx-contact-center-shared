"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { VariableInput } from "./VariableInput";
import { IconPlus, IconTrash, IconGripVertical } from "@tabler/icons-react";

/**
 * Switch Node Editor
 * Editor for switch/case routing logic
 */
export default function SwitchNodeEditor({
  config,
  onChange,
  availableVariables = [],
  onOutputsChange,
}) {
  const variable = config.variable || "";
  const cases = config.cases || [];
  const defaultLabel = config.defaultLabel || "Default";

  // Initialize outputs on mount and when config changes
  useEffect(() => {
    if (onOutputsChange) {
      const outputLabels = cases.map((c) => c.label || `Case ${c.value}`);
      outputLabels.push(defaultLabel);
      onOutputsChange(outputLabels);
    }
  }, []); // Only run on mount

  const handleChange = (field, value) => {
    const newConfig = {
      ...config,
      [field]: value,
    };
    onChange(newConfig);

    // Update outputs when cases or defaultLabel changes
    if (field === "cases" || field === "defaultLabel") {
      const updatedCases = field === "cases" ? value : newConfig.cases || [];
      const updatedDefaultLabel =
        field === "defaultLabel" ? value : newConfig.defaultLabel || "Default";
      if (onOutputsChange) {
        const outputLabels = updatedCases.map(
          (c) => c.label || `Case ${c.value}`
        );
        outputLabels.push(updatedDefaultLabel);
        onOutputsChange(outputLabels);
      }
    }
  };

  const handleCaseChange = (index, field, value) => {
    const newCases = [...cases];
    newCases[index] = {
      ...newCases[index],
      [field]: value,
    };
    handleChange("cases", newCases);

    // Update node outputs
    if (onOutputsChange) {
      const outputLabels = newCases.map((c) => c.label || `Case ${c.value}`);
      outputLabels.push(defaultLabel);
      onOutputsChange(outputLabels);
    }
  };

  const addCase = () => {
    const newCases = [
      ...cases,
      { value: "", label: `Case ${cases.length + 1}` },
    ];
    handleChange("cases", newCases);

    // Update node outputs
    if (onOutputsChange) {
      const outputLabels = newCases.map((c) => c.label);
      outputLabels.push(defaultLabel);
      onOutputsChange(outputLabels);
    }
  };

  const removeCase = (index) => {
    const newCases = cases.filter((_, i) => i !== index);
    handleChange("cases", newCases);

    // Update node outputs
    if (onOutputsChange) {
      const outputLabels = newCases.map((c) => c.label);
      outputLabels.push(defaultLabel);
      onOutputsChange(outputLabels);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">Variable to Evaluate</Label>
        <VariableInput
          value={variable}
          onChange={(value) => handleChange("variable", value)}
          availableVariables={availableVariables}
          placeholder="{{variable}}"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Variable whose value determines the route
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-xs">Cases</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addCase}
            className="h-7 text-xs"
          >
            <IconPlus className="h-3 w-3 mr-1" />
            Add Case
          </Button>
        </div>

        <div className="space-y-2">
          {cases.map((caseItem, index) => (
            <div
              key={index}
              className="flex items-start gap-2 p-2 border rounded-md bg-card"
            >
              <IconGripVertical className="h-4 w-4 text-muted-foreground mt-2 flex-shrink-0" />

              <div className="flex-1 space-y-2">
                <div>
                  <Label className="text-xs">Value</Label>
                  <Input
                    value={caseItem.value || ""}
                    onChange={(e) =>
                      handleCaseChange(index, "value", e.target.value)
                    }
                    placeholder="1"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label className="text-xs">Label</Label>
                  <Input
                    value={caseItem.label || ""}
                    onChange={(e) =>
                      handleCaseChange(index, "label", e.target.value)
                    }
                    placeholder="Sales"
                    className="mt-1"
                  />
                </div>
              </div>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => removeCase(index)}
                className="h-8 w-8 p-0 text-destructive"
              >
                <IconTrash className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {cases.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4 border rounded-md bg-muted/30">
            No cases defined. Add a case to get started.
          </p>
        )}
      </div>

      <div>
        <Label className="text-xs">Default Label</Label>
        <Input
          value={defaultLabel}
          onChange={(e) => handleChange("defaultLabel", e.target.value)}
          placeholder="Default"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Label for the default output when no case matches
        </p>
      </div>

      {variable && cases.length > 0 && (
        <div className="p-3 bg-muted rounded-md">
          <p className="text-xs font-medium mb-2">Routing Table:</p>
          <div className="space-y-1 text-xs font-mono">
            {cases.map((c, i) => (
              <div key={i}>
                When <span className="text-blue-600">{variable}</span> ==={" "}
                <span className="text-orange-600">{c.value}</span> →{" "}
                <span className="text-green-600">{c.label}</span>
              </div>
            ))}
            <div>
              Otherwise → <span className="text-green-600">{defaultLabel}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

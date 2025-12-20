"use client";

import {
  useState,
  useEffect,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VariableTextarea } from "./VariableTextarea";
import { Button } from "@/components/ui/button";
import { IconCheck, IconAlertCircle, IconCode } from "@tabler/icons-react";
import { validateExpression } from "@/lib/expression-engine";
import { checkDuplicateVariableName } from "@/lib/variable-utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ExpressionBuilderModal } from "./ExpressionBuilderModal";

/**
 * Set Variable Node Editor
 * Editor for creating and setting variables with expressions
 */
const SetVariableNodeEditor = forwardRef(function SetVariableNodeEditor(
  {
    config,
    onChange,
    availableVariables = [],
    onSave,
    nodes = [],
    edges = [],
    globalVariables = {},
    selectedNodeId = null,
    hideSaveButton = false,
    onValidationChange = null,
  },
  ref
) {
  const [pendingVariableName, setPendingVariableName] = useState("");
  const [pendingExpression, setPendingExpression] = useState("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const variableName = config.variableName || "";
  const expression = config.expression || "";

  // Initialize pending values from config
  useEffect(() => {
    setPendingVariableName(variableName);
    setPendingExpression(expression);
    setHasUnsavedChanges(false);
  }, [variableName, expression]);

  // Validate variable name
  const variableNameValidation = useMemo(() => {
    if (!pendingVariableName) {
      return { valid: false, error: "Variable name is required" };
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pendingVariableName)) {
      return {
        valid: false,
        error:
          "Variable name must start with a letter or underscore and contain only letters, numbers, and underscores",
      };
    }
    return { valid: true, error: null };
  }, [pendingVariableName]);

  // Check for duplicate variable name
  const duplicateCheck = useMemo(() => {
    return checkDuplicateVariableName(
      pendingVariableName,
      { nodes, edges, globalVariables },
      { type: "set_variable", id: selectedNodeId }
    );
  }, [pendingVariableName, nodes, edges, globalVariables, selectedNodeId]);

  // Validate expression
  const expressionValidation = useMemo(() => {
    if (!pendingExpression) {
      return { valid: false, errors: ["Expression is required"] };
    }

    // Check for balanced brackets
    const brackets = { "{": "}", "(": ")", "[": "]" };
    const stack = [];
    for (const char of pendingExpression) {
      if (brackets[char]) {
        stack.push(char);
      } else if (Object.values(brackets).includes(char)) {
        if (stack.length === 0) {
          return {
            valid: false,
            errors: [`Unmatched closing bracket '${char}'`],
          };
        }
        const last = stack.pop();
        if (brackets[last] !== char) {
          return {
            valid: false,
            errors: [`Mismatched brackets: '${last}' and '${char}'`],
          };
        }
      }
    }
    if (stack.length > 0) {
      return {
        valid: false,
        errors: [`Unclosed bracket: '${stack[stack.length - 1]}'`],
      };
    }

    // Use expression engine validation
    const result = validateExpression(pendingExpression, availableVariables);
    return result;
  }, [pendingExpression, availableVariables]);

  // Overall validation
  const isValid =
    variableNameValidation.valid &&
    !duplicateCheck.isDuplicate &&
    expressionValidation.valid &&
    hasUnsavedChanges;

  // Notify parent of validation state changes
  useEffect(() => {
    if (onValidationChange) {
      onValidationChange({
        isValid,
        hasUnsavedChanges,
        expressionValid: expressionValidation.valid,
        hasExpression: !!pendingExpression,
      });
    }
  }, [
    isValid,
    hasUnsavedChanges,
    expressionValidation.valid,
    pendingExpression,
    onValidationChange,
  ]);

  const handlePendingChange = (field, value) => {
    if (field === "variableName") {
      setPendingVariableName(value);
    } else if (field === "expression") {
      setPendingExpression(value);
    }
    setHasUnsavedChanges(true);
  };

  const handleSave = () => {
    if (!isValid) return;

    onChange({
      ...config,
      variableName: pendingVariableName,
      expression: pendingExpression,
    });
    setHasUnsavedChanges(false);

    if (onSave) {
      onSave();
    }
  };

  // Expose save function to parent via ref
  useImperativeHandle(ref, () => ({
    save: handleSave,
  }));

  // Handle apply from modal
  const handleApplyExpression = (newExpression) => {
    setPendingExpression(newExpression);
    setHasUnsavedChanges(true);
  };

  // Syntax highlighting for the preview
  const highlightExpression = (expr) => {
    if (!expr) return null;

    const parts = [];
    let lastIndex = 0;

    // Match variables {{...}}
    const varPattern = /\{\{([^}]+)\}\}/g;
    let match;
    const matches = [];

    while ((match = varPattern.exec(expr)) !== null) {
      matches.push({
        type: "variable",
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        inner: match[1],
      });
    }

    // Match function names (word followed by opening parenthesis)
    const funcPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
    while ((match = funcPattern.exec(expr)) !== null) {
      // Check if this position is not inside a variable
      const insideVariable = matches.some(
        (v) => match.index >= v.start && match.index < v.end
      );
      if (!insideVariable) {
        matches.push({
          type: "function",
          start: match.index,
          end: match.index + match[1].length,
          text: match[1],
        });
      }
    }

    // Match strings (single and double quoted)
    const stringPattern = /(["'])(?:(?=(\\?))\2.)*?\1/g;
    while ((match = stringPattern.exec(expr)) !== null) {
      const insideVariable = matches.some(
        (v) => match.index >= v.start && match.index < v.end
      );
      if (!insideVariable) {
        matches.push({
          type: "string",
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
      }
    }

    // Match numbers
    const numberPattern = /\b\d+(\.\d+)?\b/g;
    while ((match = numberPattern.exec(expr)) !== null) {
      const insideOther = matches.some(
        (v) => match.index >= v.start && match.index < v.end
      );
      if (!insideOther) {
        matches.push({
          type: "number",
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
      }
    }

    // Sort matches by position
    matches.sort((a, b) => a.start - b.start);

    // Build highlighted output
    matches.forEach((m, i) => {
      // Add text before this match
      if (m.start > lastIndex) {
        parts.push(
          <span key={`text-${i}`} className="text-foreground">
            {expr.substring(lastIndex, m.start)}
          </span>
        );
      }

      // Add highlighted match
      let className = "";
      let content = m.text;

      switch (m.type) {
        case "variable":
          className = "text-blue-600 dark:text-blue-400 font-semibold";
          break;
        case "function":
          className = "text-purple-600 dark:text-purple-400 font-semibold";
          break;
        case "string":
          className = "text-green-600 dark:text-green-400";
          break;
        case "number":
          className = "text-orange-600 dark:text-orange-400";
          break;
      }

      parts.push(
        <span key={`match-${i}`} className={className}>
          {content}
        </span>
      );

      lastIndex = m.end;
    });

    // Add remaining text
    if (lastIndex < expr.length) {
      parts.push(
        <span key="text-end" className="text-foreground">
          {expr.substring(lastIndex)}
        </span>
      );
    }

    return parts;
  };

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">Variable Name</Label>
        <Input
          value={pendingVariableName}
          onChange={(e) => handlePendingChange("variableName", e.target.value)}
          placeholder="my_variable"
          className={`mt-1 ${
            !variableNameValidation.valid && pendingVariableName
              ? "border-red-500"
              : duplicateCheck.isDuplicate
              ? "border-yellow-500"
              : ""
          }`}
        />
        {!variableNameValidation.valid && pendingVariableName && (
          <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
            <IconAlertCircle className="h-3 w-3" />
            {variableNameValidation.error}
          </p>
        )}
        {variableNameValidation.valid && duplicateCheck.isDuplicate && (
          <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1 flex items-center gap-1">
            <IconAlertCircle className="h-3 w-3" />
            {duplicateCheck.message}
          </p>
        )}
        {variableNameValidation.valid && !duplicateCheck.isDuplicate && (
          <p className="text-xs text-muted-foreground mt-1">
            Name of the variable to create or update
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs">Expression</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsModalOpen(true)}
            className="h-7 px-2 gap-1"
          >
            <IconCode className="h-4 w-4" />
            <span className="text-xs">Expression Builder</span>
          </Button>
        </div>
        <VariableTextarea
          value={pendingExpression}
          onChange={(value) => handlePendingChange("expression", value)}
          availableVariables={availableVariables}
          placeholder="{{first_name}} + ' ' + {{last_name}}"
          rows={4}
          className={`mt-1 ${
            !expressionValidation.valid && pendingExpression
              ? "border-red-500"
              : ""
          }`}
        />
        {!expressionValidation.valid && pendingExpression && (
          <Alert variant="destructive" className="mt-2">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              <div className="space-y-1">
                {expressionValidation.errors.map((error, i) => (
                  <div key={i} className="text-xs">
                    • {error}
                  </div>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}
        {expressionValidation.valid && (
          <p className="text-xs text-muted-foreground mt-1">
            Expression to evaluate and store in the variable. Use Expression
            Builder for advanced editing.
          </p>
        )}
      </div>

      {/* Enhanced Preview with Syntax Highlighting */}
      {pendingVariableName && pendingExpression && (
        <div
          className={`p-3 rounded-md border ${
            expressionValidation.valid
              ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800"
              : "bg-muted border-muted-foreground/20"
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs font-medium">Preview:</p>
            {expressionValidation.valid && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <IconCheck className="h-3 w-3" />
                Valid
              </span>
            )}
          </div>
          <div className="text-sm font-mono bg-background rounded p-2 border">
            <span className="text-muted-foreground">Set </span>
            <span className="text-blue-600 dark:text-blue-400 font-semibold">
              {pendingVariableName}
            </span>
            <span className="text-muted-foreground"> = </span>
            <span className="break-all">
              {highlightExpression(pendingExpression)}
            </span>
          </div>
        </div>
      )}

      {/* Expression Builder Modal */}
      <ExpressionBuilderModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        initialExpression={pendingExpression}
        availableVariables={availableVariables}
        onApply={handleApplyExpression}
      />

      {/* Save Button - only show if not hidden by parent */}
      {!hideSaveButton && (
        <div className="pt-2 border-t">
          <Button
            onClick={handleSave}
            disabled={!isValid}
            className="w-full"
            variant={isValid ? "default" : "secondary"}
          >
            <IconCheck className="h-4 w-4 mr-2" />
            {hasUnsavedChanges ? "Save Expression" : "Saved"}
          </Button>
          {!expressionValidation.valid && pendingExpression && (
            <p className="text-xs text-red-500 flex items-center gap-1 mt-2">
              <IconAlertCircle className="h-3 w-3" />
              Fix errors to save
            </p>
          )}
        </div>
      )}
    </div>
  );
});

export default SetVariableNodeEditor;

// Export a save button component that can be used in parent's footer
export function SetVariableNodeEditorSaveButton({
  isValid,
  hasUnsavedChanges,
  onSave,
  expressionValid,
  hasExpression,
}) {
  return (
    <div className="space-y-2">
      <Button
        onClick={onSave}
        disabled={!isValid}
        className="w-full"
        variant={isValid ? "default" : "secondary"}
      >
        <IconCheck className="h-4 w-4 mr-2" />
        {hasUnsavedChanges ? "Save Expression" : "Saved"}
      </Button>
      {!expressionValid && hasExpression && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <IconAlertCircle className="h-3 w-3" />
          Fix errors to save
        </p>
      )}
    </div>
  );
}

"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableInput } from "./VariableInput";

/**
 * Condition Node Editor
 * Visual expression builder for condition evaluation
 */
export default function ConditionNodeEditor({
  config,
  onChange,
  availableVariables = [],
}) {
  const handleChange = (field, value) => {
    onChange({
      ...config,
      [field]: value,
    });
  };

  const leftOperand = config.leftOperand || "";
  const operator = config.operator || "===";
  const rightOperand = config.rightOperand || "";
  const dataType = config.dataType || "string";

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">Left Operand</Label>
        <VariableInput
          value={leftOperand}
          onChange={(value) => handleChange("leftOperand", value)}
          availableVariables={availableVariables}
          placeholder="{{variable}} or value"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Left side of the comparison
        </p>
      </div>

      <div>
        <Label className="text-xs">Operator</Label>
        <Select
          value={operator}
          onValueChange={(value) => handleChange("operator", value)}
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="===">Equals (===)</SelectItem>
            <SelectItem value="!==">Not Equals (!==)</SelectItem>
            <SelectItem value=">">Greater Than (&gt;)</SelectItem>
            <SelectItem value="<">Less Than (&lt;)</SelectItem>
            <SelectItem value=">=">Greater or Equal (&gt;=)</SelectItem>
            <SelectItem value="<=">Less or Equal (&lt;=)</SelectItem>
            <SelectItem value="contains">Contains</SelectItem>
            <SelectItem value="startsWith">Starts With</SelectItem>
            <SelectItem value="endsWith">Ends With</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-xs">Right Operand</Label>
        <VariableInput
          value={rightOperand}
          onChange={(value) => handleChange("rightOperand", value)}
          availableVariables={availableVariables}
          placeholder="{{variable}} or value"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Right side of the comparison
        </p>
      </div>

      <div>
        <Label className="text-xs">Data Type</Label>
        <Select
          value={dataType}
          onValueChange={(value) => handleChange("dataType", value)}
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">String</SelectItem>
            <SelectItem value="number">Number</SelectItem>
            <SelectItem value="boolean">Boolean</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Type for comparison
        </p>
      </div>

      <div className="p-3 bg-muted rounded-md">
        <p className="text-xs font-medium mb-1">Preview:</p>
        <p className="text-sm font-mono">
          If <span className="text-blue-600">{leftOperand || "?"}</span>{" "}
          <span className="text-orange-600">{operator}</span>{" "}
          <span className="text-blue-600">{rightOperand || "?"}</span>
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          Then route to <strong>True</strong> output, else route to{" "}
          <strong>False</strong> output
        </p>
      </div>
    </div>
  );
}

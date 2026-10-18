"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


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
  const tUi = useUiText();
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
        <Label className="text-xs">{tUi("Left Operand")}</Label>
        <VariableInput
          value={leftOperand}
          onChange={(value) => handleChange("leftOperand", value)}
          availableVariables={availableVariables}
          placeholder={tUi("{{variable}} or value")}
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">{tUi("Left side of the comparison")}</p>
      </div>

      <div>
        <Label className="text-xs">{tUi("Operator")}</Label>
        <Select
          value={operator}
          onValueChange={(value) => handleChange("operator", value)}
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="===">{tUi("Equals (===)")}</SelectItem>
            <SelectItem value="!==">{tUi("Not Equals (!==)")}</SelectItem>
            <SelectItem value=">">{tUi("Greater Than (>)")}</SelectItem>
            <SelectItem value="<">{tUi("Less Than (<)")}</SelectItem>
            <SelectItem value=">=">{tUi("Greater or Equal (>=)")}</SelectItem>
            <SelectItem value="<=">{tUi("Less or Equal (<=)")}</SelectItem>
            <SelectItem value="contains">{tUi("Contains")}</SelectItem>
            <SelectItem value="startsWith">{tUi("Starts With")}</SelectItem>
            <SelectItem value="endsWith">{tUi("Ends With")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-xs">{tUi("Right Operand")}</Label>
        <VariableInput
          value={rightOperand}
          onChange={(value) => handleChange("rightOperand", value)}
          availableVariables={availableVariables}
          placeholder={tUi("{{variable}} or value")}
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">{tUi("Right side of the comparison")}</p>
      </div>

      <div>
        <Label className="text-xs">{tUi("Data Type")}</Label>
        <Select
          value={dataType}
          onValueChange={(value) => handleChange("dataType", value)}
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">{tUi("String")}</SelectItem>
            <SelectItem value="number">{tUi("Number")}</SelectItem>
            <SelectItem value="boolean">{tUi("Boolean")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">{tUi("Type for comparison")}</p>
      </div>

      <div className="p-3 bg-muted rounded-md">
        <p className="text-xs font-medium mb-1">{tUi("Preview:")}</p>
        <p className="text-sm font-mono">{tUi("If ")}<span className="text-blue-600">{leftOperand || "?"}</span>{" "}
          <span className="text-orange-600">{operator}</span>{" "}
          <span className="text-blue-600">{rightOperand || "?"}</span>
        </p>
        <p className="text-xs text-muted-foreground mt-2">{tUi("Then route to ")}<strong>{tUi("True")}</strong>{tUi(" output, else route to")}{" "}
          <strong>{tUi("False")}</strong>{tUi(" output")}</p>
      </div>
    </div>
  );
}

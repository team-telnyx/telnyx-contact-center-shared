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
import { Button } from "@/components/ui/button";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { VariableInput } from "./VariableInput";

/**
 * Logic Gate Node Editor
 * Editor for combining multiple conditions with AND/OR/NOT
 */
export default function LogicGateNodeEditor({
  config,
  onChange,
  availableVariables = [],
}) {
  const tUi = useUiText();
  const operator = config.operator || "AND";
  const conditions = config.conditions || [];

  const handleChange = (field, value) => {
    onChange({
      ...config,
      [field]: value,
    });
  };

  const handleConditionChange = (index, field, value) => {
    const newConditions = [...conditions];
    newConditions[index] = {
      ...newConditions[index],
      [field]: value,
    };
    handleChange("conditions", newConditions);
  };

  const addCondition = () => {
    const newConditions = [
      ...conditions,
      {
        leftOperand: "",
        operator: "===",
        rightOperand: "",
        dataType: "string",
      },
    ];
    handleChange("conditions", newConditions);
  };

  const removeCondition = (index) => {
    const newConditions = conditions.filter((_, i) => i !== index);
    handleChange("conditions", newConditions);
  };

  return (
    <div className="space-y-4">
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
            <SelectItem value="AND">{tUi("AND (all conditions must be true)")}</SelectItem>
            <SelectItem value="OR">{tUi("OR (at least one must be true)")}</SelectItem>
            <SelectItem value="NOT">{tUi("NOT (invert condition)")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">{tUi("Logical operator to combine conditions")}</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-xs">{tUi("Conditions")}</Label>
          {operator !== "NOT" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addCondition}
              className="h-7 text-xs"
            >
              <IconPlus className="h-3 w-3 mr-1" />{tUi("Add Condition")}</Button>
          )}
        </div>

        {operator === "NOT" && conditions.length === 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addCondition}
            className="w-full"
          >
            <IconPlus className="h-3 w-3 mr-1" />{tUi("Add Condition")}</Button>
        )}

        <div className="space-y-3">
          {conditions.map((condition, index) => (
            <div
              key={index}
              className="p-3 border rounded-md bg-card space-y-2"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">{tUi("Condition ")}{index + 1}
                </span>
                {(operator !== "NOT" || conditions.length > 1) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeCondition(index)}
                    className="h-6 w-6 p-0 text-destructive"
                  >
                    <IconTrash className="h-3 w-3" />
                  </Button>
                )}
              </div>

              <div>
                <Label className="text-xs">{tUi("Left Operand")}</Label>
                <VariableInput
                  value={condition.leftOperand || ""}
                  onChange={(value) =>
                    handleConditionChange(index, "leftOperand", value)
                  }
                  availableVariables={availableVariables}
                  placeholder={tUi("{{variable}} or value")}
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">{tUi("Operator")}</Label>
                <Select
                  value={condition.operator || "==="}
                  onValueChange={(value) =>
                    handleConditionChange(index, "operator", value)
                  }
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
                  value={condition.rightOperand || ""}
                  onChange={(value) =>
                    handleConditionChange(index, "rightOperand", value)
                  }
                  availableVariables={availableVariables}
                  placeholder={tUi("{{variable}} or value")}
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">{tUi("Data Type")}</Label>
                <Select
                  value={condition.dataType || "string"}
                  onValueChange={(value) =>
                    handleConditionChange(index, "dataType", value)
                  }
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
              </div>
            </div>
          ))}
        </div>

        {conditions.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4 border rounded-md bg-muted/30">{tUi("No conditions defined. Add a condition to get started.")}</p>
        )}

        {operator === "NOT" && conditions.length > 1 && (
          <p className="text-xs text-yellow-600 mt-2">{tUi("⚠ NOT operator typically uses only one condition. Additional conditions will be ignored.")}</p>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="p-3 bg-muted rounded-md">
          <p className="text-xs font-medium mb-2">{tUi("Logic Preview:")}</p>
          <div className="text-xs font-mono space-y-1">
            {operator === "NOT" && (
              <div>{tUi("NOT (")}{conditions[0]?.leftOperand} {conditions[0]?.operator}{" "}
                {conditions[0]?.rightOperand})
              </div>
            )}
            {operator === "AND" && (
              <div>
                {conditions.map((c, i) => (
                  <div key={i}>
                    {i > 0 && <span className="text-orange-600">{tUi(" AND ")}</span>}(
                    {c.leftOperand} {c.operator} {c.rightOperand})
                  </div>
                ))}
              </div>
            )}
            {operator === "OR" && (
              <div>
                {conditions.map((c, i) => (
                  <div key={i}>
                    {i > 0 && <span className="text-orange-600">{tUi(" OR ")}</span>}(
                    {c.leftOperand} {c.operator} {c.rightOperand})
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-2">{tUi("Routes to ")}<strong>{tUi("True")}</strong>{tUi(" if condition(s) met, else")}{" "}
            <strong>{tUi("False")}</strong>
          </p>
        </div>
      )}
    </div>
  );
}

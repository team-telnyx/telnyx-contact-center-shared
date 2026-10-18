"use client";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import {
  changeWorkflowBooleanOperator,
  newWorkflowExpression,
} from "@/lib/ai/assistant-workflow-expressions.mjs";

const kinds = [
  ["comparison", "Compare values"],
  ["bool_op", "Combine conditions"],
  ["variable", "Variable"],
  ["string_literal", "Text"],
  ["number_literal", "Number"],
  ["bool_literal", "Yes or no"],
  ["arithmetic", "Calculation"],
];
const comparisons = [
  ["==", "Equals"],
  ["!=", "Does not equal"],
  ["<", "Less than"],
  ["<=", "At most"],
  [">", "Greater than"],
  [">=", "At least"],
  ["contains", "Contains"],
  ["not_contains", "Does not contain"],
];

function Choice({ label, value, options, onChange }) {
  const tUi = useUiText();
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">
        {tUi(label)}
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={tUi(label)} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, title]) => (
            <SelectItem key={key} value={key}>
              {tUi(title)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function WorkflowExpressionEditor({
  value,
  onChange,
  variables = [],
  label = "Condition",
  depth = 0,
}) {
  const tUi = useUiText(),
    listId = useId();
  const expression = value || newWorkflowExpression();
  const update = (patch) => onChange({ ...expression, ...patch });
  const nested = (key, title) => (
    <WorkflowExpressionEditor
      label={title}
      value={expression[key]}
      onChange={(next) => update({ [key]: next })}
      variables={variables}
      depth={depth + 1}
    />
  );
  return (
    <div
      className={`min-w-0 space-y-3 ${depth === 0 ? "" : "rounded-lg border bg-background/50 p-3"}`}
    >
      <Choice
        label={label}
        value={expression.type}
        options={
          depth === 0
            ? kinds.filter(([kind]) =>
                ["comparison", "bool_op", "bool_literal", "variable"].includes(
                  kind,
                ),
              )
            : kinds
        }
        onChange={(type) => onChange(newWorkflowExpression(type))}
      />
      {expression.type === "variable" ? (
        <>
          <Input
            aria-label={tUi("Variable name")}
            list={listId}
            value={expression.name || ""}
            placeholder={tUi("Select or enter a variable")}
            onChange={(e) => update({ name: e.target.value })}
          />
          <datalist id={listId}>
            {variables.map((name) => (
              <option value={name} key={name} />
            ))}
          </datalist>
        </>
      ) : null}
      {expression.type === "string_literal" ||
      expression.type === "number_literal" ? (
        <Input
          aria-label={tUi("Value")}
          type={expression.type === "number_literal" ? "number" : "text"}
          step="any"
          value={expression.value ?? ""}
          onChange={(e) =>
            update({
              value:
                expression.type === "number_literal"
                  ? e.target.value === ""
                    ? undefined
                    : Number(e.target.value)
                  : e.target.value,
            })
          }
        />
      ) : null}
      {expression.type === "bool_literal" ? (
        <label className="flex items-center justify-between gap-3 text-sm">
          {tUi(expression.value ? "Yes" : "No")}
          <Switch
            checked={Boolean(expression.value)}
            onCheckedChange={(next) => update({ value: next })}
          />
        </label>
      ) : null}
      {["comparison", "arithmetic"].includes(expression.type) ? (
        <>
          {nested("left", "First value")}
          <Choice
            label={
              expression.type === "comparison" ? "Comparison" : "Calculation"
            }
            value={expression.op}
            options={
              expression.type === "comparison"
                ? comparisons
                : [
                    ["+", "Add"],
                    ["-", "Subtract"],
                    ["*", "Multiply"],
                    ["/", "Divide"],
                    ["%", "Remainder"],
                  ]
            }
            onChange={(op) => update({ op })}
          />
          {nested("right", "Second value")}
        </>
      ) : null}
      {expression.type === "bool_op" ? (
        <>
          <Choice
            label="Match"
            value={expression.op}
            options={[
              ["and", "All conditions"],
              ["or", "Any condition"],
              ["not", "Condition is not met"],
            ]}
            onChange={(op) =>
              onChange(changeWorkflowBooleanOperator(expression, op))
            }
          />
          {(expression.operands || []).map((operand, index) => (
            <div className="space-y-2" key={index}>
              <WorkflowExpressionEditor
                value={operand}
                onChange={(next) =>
                  update({
                    operands: expression.operands.map((item, i) =>
                      i === index ? next : item,
                    ),
                  })
                }
                label={tUi("Condition {value0}", { value0: index + 1 })}
                variables={variables}
                depth={Math.min(depth + 1, 2)}
              />
              {expression.operands.length > 2 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    update({
                      operands: expression.operands.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  <IconTrash className="size-4" />
                  {tUi("Remove condition")}
                </Button>
              ) : null}
            </div>
          ))}
          {expression.op !== "not" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                update({
                  operands: [...expression.operands, newWorkflowExpression()],
                })
              }
            >
              <IconPlus className="size-4" />
              {tUi("Add condition")}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

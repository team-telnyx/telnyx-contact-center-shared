"use client";

import { useState, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  IconCheck,
  IconAlertCircle,
  IconPlayerPlay,
  IconX,
  IconPlus,
  IconInfoCircle,
  IconCode,
} from "@tabler/icons-react";
import {
  getAvailableFunctions,
  validateExpression,
  evaluateExpression,
} from "@/lib/expression-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";

/**
 * Expression Builder Modal
 * A full-featured modal for building and testing expressions
 */
export function ExpressionBuilderModal({
  open,
  onOpenChange,
  initialExpression = "",
  availableVariables = [],
  testPayloadOptions = [],
  onApply,
}) {
  const [expression, setExpression] = useState(initialExpression);
  const [testData, setTestData] = useState("");
  const [selectedPayloadId, setSelectedPayloadId] = useState("manual-json");
  const [testResult, setTestResult] = useState(null);
  const [accordionValue, setAccordionValue] = useState("string");

  // Reset expression when modal opens with new initial value
  useEffect(() => {
    if (open) {
      setExpression(initialExpression);
      setTestResult(null);
    }
  }, [open, initialExpression]);

  // Get all available functions
  const allFunctions = getAvailableFunctions();

  const groupedTestPayloadOptions = testPayloadOptions.reduce((groups, option) => {
    const group = option.group || "Saved payloads";
    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(option);
    return groups;
  }, {});

  const handleSelectTestPayload = (payloadId) => {
    setSelectedPayloadId(payloadId);
    setTestResult(null);

    if (payloadId === "manual-json") return;

    const option = testPayloadOptions.find((item) => item.id === payloadId);
    if (!option) return;

    setTestData(JSON.stringify(option.payload, null, 2));
  };

  // Function categories
  const categories = [
    { value: "string", label: "String Functions" },
    { value: "numeric", label: "Numeric Functions" },
    { value: "array", label: "Array Functions" },
    { value: "arrayIndexing", label: "Array Indexing" },
    { value: "dateTime", label: "Date/Time Functions" },
    { value: "logic", label: "Logic Functions" },
    { value: "conversion", label: "Type Conversion" },
  ];

  // Extract variable names from test data object
  const extractVariableNames = (obj, prefix = "") => {
    const variables = [];
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        variables.push(fullKey);

        // Recursively extract nested object keys
        if (
          typeof obj[key] === "object" &&
          obj[key] !== null &&
          !Array.isArray(obj[key])
        ) {
          variables.push(...extractVariableNames(obj[key], fullKey));
        }
      }
    }
    return variables;
  };

  // Get variables from test data for validation
  const getTestDataVariables = () => {
    try {
      if (testData.trim()) {
        const parsedTestData = JSON.parse(testData);
        return extractVariableNames(parsedTestData);
      }
    } catch (error) {
      // Ignore JSON parse errors for validation
    }
    return [];
  };

  // Combine available variables with test data variables
  const allAvailableVariables = [
    ...availableVariables,
    ...getTestDataVariables(),
  ];

  // Validate expression
  const validation = validateExpression(expression, allAvailableVariables);

  // Insert function syntax at cursor or end
  const insertFunction = (syntax) => {
    const newExpression = expression ? `${expression} ${syntax}` : syntax;
    setExpression(newExpression);
  };

  // Insert variable reference
  const insertVariable = (varName) => {
    const newExpression = expression
      ? `${expression}{{${varName}}}`
      : `{{${varName}}}`;
    setExpression(newExpression);
  };

  // Test expression with provided data
  const handleTestExpression = () => {
    try {
      let parsedTestData = {};
      if (testData.trim()) {
        parsedTestData = JSON.parse(testData);
      }

      const result = evaluateExpression(expression, parsedTestData);

      setTestResult({
        success: result.success,
        value: result.success ? result.result : null,
        error: result.error,
      });
    } catch (error) {
      setTestResult({
        success: false,
        error: `Invalid test data JSON: ${error.message}`,
      });
    }
  };

  const clearTestResult = () => {
    setTestResult(null);
  };

  // Apply expression (only if valid)
  const handleApply = () => {
    if (validation.valid) {
      onApply(expression);
      onOpenChange(false);
    }
  };

  // Syntax highlighting for preview
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
      });
    }

    // Sort matches by position
    matches.sort((a, b) => a.start - b.start);

    // Build highlighted output
    matches.forEach((m, i) => {
      if (m.start > lastIndex) {
        parts.push(
          <span key={`text-${i}`} className="text-foreground">
            {expr.substring(lastIndex, m.start)}
          </span>
        );
      }

      parts.push(
        <span
          key={`match-${i}`}
          className="text-blue-600 dark:text-blue-400 font-semibold"
        >
          {m.text}
        </span>
      );

      lastIndex = m.end;
    });

    if (lastIndex < expr.length) {
      parts.push(
        <span key="text-end" className="text-foreground">
          {expr.substring(lastIndex)}
        </span>
      );
    }

    return parts.length > 0 ? parts : expr;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!max-w-[1800px] w-[50vw] h-[80vh] max-h-[80vh] flex flex-col sm:!max-w-[1800px] dark:bg-telnyx-background"
        onInteractOutside={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconCode className="h-5 w-5 text-telnyx-green" />
            Expression Builder
          </DialogTitle>
          <DialogDescription>
            Build and test your expression with functions and variables
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          <div className="grid grid-cols-[280px_1fr] gap-6 h-full">
            {/* Left Column - Function Library */}
            <div className="flex flex-col min-h-0">
              <Label className="text-sm font-semibold mb-2">
                Function Library
              </Label>
              <Card className="flex flex-col flex-1 min-h-0 p-4">
                <ScrollArea className="flex-1 pr-3">
                  <Accordion
                    type="single"
                    collapsible
                    value={accordionValue}
                    onValueChange={setAccordionValue}
                    className="w-full"
                  >
                    {categories.map((cat) => (
                      <AccordionItem key={cat.value} value={cat.value}>
                        <AccordionTrigger className="text-sm py-2">
                          {cat.label}
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="space-y-2 py-2 max-h-[400px] overflow-y-auto">
                            {allFunctions[cat.value]?.map((func, index) => (
                              <Card
                                key={index}
                                className="p-3 hover:border-telnyx-green transition-colors cursor-pointer"
                                onClick={() => insertFunction(func.syntax)}
                              >
                                <div className="space-y-1">
                                  <div className="flex items-start gap-2">
                                    <IconPlus className="h-3 w-3 text-telnyx-green flex-shrink-0 mt-0.5" />
                                    <div className="flex-1 min-w-0">
                                      <div className="font-mono text-xs font-semibold break-all">
                                        {func.name}
                                      </div>
                                      <div className="font-mono text-[10px] text-muted-foreground break-all mt-0.5">
                                        {func.syntax}
                                      </div>
                                    </div>
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0 flex-shrink-0"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <IconInfoCircle className="h-3 w-3 text-muted-foreground" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                          side="right"
                                          className="max-w-xs"
                                        >
                                          <div className="space-y-2">
                                            <div>
                                              <p className="font-semibold text-xs">
                                                Example:
                                              </p>
                                              <p className="font-mono text-xs">
                                                {func.example}
                                              </p>
                                            </div>
                                            <div>
                                              <p className="font-semibold text-xs">
                                                Result:
                                              </p>
                                              <p className="font-mono text-xs">
                                                {func.result}
                                              </p>
                                            </div>
                                          </div>
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  </div>
                                  {func.description && (
                                    <p className="text-[10px] text-muted-foreground pl-5">
                                      {func.description}
                                    </p>
                                  )}
                                </div>
                              </Card>
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </ScrollArea>
              </Card>
            </div>

            {/* Right Column - Expression Editor & Testing */}
            <div className="space-y-4 flex flex-col min-h-0 overflow-hidden">
              {/* Expression Textarea */}
              <div className="min-w-0">
                <Label className="text-sm font-semibold mb-2 block">
                  Expression
                </Label>
                <Textarea
                  value={expression}
                  onChange={(e) => setExpression(e.target.value)}
                  placeholder="{{first_name}} + ' ' + {{last_name}}"
                  className={`font-mono text-sm w-full ${
                    !validation.valid && expression ? "border-red-500" : ""
                  }`}
                  rows={4}
                />
              </div>

              {/* Validation Information */}
              {expression && (
                <div>
                  {!validation.valid ? (
                    <Alert variant="destructive">
                      <IconAlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        <div className="space-y-1">
                          {validation.errors.map((error, i) => (
                            <div key={i} className="text-xs">
                              • {error}
                            </div>
                          ))}
                        </div>
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert className="border-green-200 bg-green-50 dark:bg-green-950/20">
                      <IconCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                      <AlertDescription className="text-xs text-green-600 dark:text-green-400">
                        Expression is valid
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}

              {/* Available Variables */}
              {availableVariables.length > 0 && (
                <div className="min-w-0">
                  <Label className="text-sm font-semibold mb-2 block">
                    Available Variables
                  </Label>
                  <div className="overflow-x-auto w-full border rounded-md p-2 bg-muted/30">
                    <div className="flex gap-2">
                      {availableVariables.map((varName) => (
                        <Badge
                          key={varName}
                          variant="secondary"
                          className="cursor-pointer hover:bg-telnyx-green hover:text-white transition-colors text-xs px-3 py-1 whitespace-nowrap flex-shrink-0"
                          onClick={() => insertVariable(varName)}
                        >
                          <IconPlus className="h-3 w-3 mr-1" />
                          {varName}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    Click to insert variable
                  </p>
                </div>
              )}

              {/* Test Expression */}
              <div className="border rounded-md p-4 bg-muted/30 flex-1 flex flex-col min-h-0">
                <div className="mb-3 space-y-2">
                  <Label className="text-sm font-semibold block">
                    Test Data (provide a JSON object)
                  </Label>
                  {testPayloadOptions.length > 0 && (
                    <div className="space-y-1.5">
                      <Select
                        value={selectedPayloadId}
                        onValueChange={handleSelectTestPayload}
                      >
                        <SelectTrigger className="w-full bg-background">
                          <SelectValue placeholder="Choose a saved payload" />
                        </SelectTrigger>
                        <SelectContent className="max-h-80">
                          <SelectItem value="manual-json">Manual JSON / custom test data</SelectItem>
                          {Object.entries(groupedTestPayloadOptions).map(
                            ([group, options]) => (
                              <SelectGroup key={group}>
                                <SelectLabel>{group}</SelectLabel>
                                {options.map((option) => (
                                  <SelectItem key={option.id} value={option.id}>
                                    <div className="flex flex-col items-start gap-0.5">
                                      <span className="text-sm">{option.label}</span>
                                      {option.description && (
                                        <span className="text-[10px] text-muted-foreground">
                                          {option.description}
                                        </span>
                                      )}
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground">
                        Choose a saved webhook/request/response payload from this call flow, or edit the JSON below.
                      </p>
                    </div>
                  )}
                </div>

                <div className="space-y-3 flex-1 flex flex-col min-h-0">
                  <div>
                    <Textarea
                      value={testData}
                      onChange={(e) => {
                        setSelectedPayloadId("manual-json");
                        setTestData(e.target.value);
                      }}
                      placeholder={
                        '{\n  "customer_data_rows": [\n    {"first_name": "John", "last_name": "Doe"}\n  ]\n}'
                      }
                      rows={8}
                      className="font-mono text-xs w-full"
                    />
                  </div>
                  <Button
                    type="button"
                    onClick={handleTestExpression}
                    disabled={!expression}
                    size="sm"
                    className="w-full"
                  >
                    <IconPlayerPlay className="h-3 w-3 mr-1" />
                    Test Expression
                  </Button>

                  {testResult && (
                    <div className="flex items-center gap-2 mb-2">
                      {testResult.success ? (
                        <IconCheck className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                      ) : (
                        <IconAlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                      )}
                      <Label className="text-sm font-semibold">
                        {testResult.success ? "Result:" : "Error:"}
                      </Label>
                    </div>
                  )}

                  {testResult && (
                    <div className="flex-1 min-h-0 overflow-hidden">
                      {testResult.success ? (
                        <div className="h-full overflow-auto">
                          <CodeBlock
                            code={JSON.stringify(testResult.value, null, 2)}
                            language="json"
                          >
                            <CodeBlockCopyButton />
                          </CodeBlock>
                        </div>
                      ) : (
                        <div className="h-full border rounded-md bg-destructive/10 overflow-auto">
                          <div className="text-xs font-mono break-all p-3 text-destructive">
                            {testResult.error}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleApply}
              disabled={!validation.valid || !expression}
            >
              <IconCheck className="h-4 w-4 mr-2" />
              Apply Expression
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

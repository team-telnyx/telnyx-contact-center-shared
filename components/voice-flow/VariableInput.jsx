"use client";

import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Variable-enabled Input component with autocomplete
 * Detects {{ typing and shows variable picker
 */
export function VariableInput({
  value = "",
  onChange,
  availableVariables = [],
  webhookSchema = null,
  placeholder = "",
  className = "",
  ...props
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const inputRef = useRef(null);

  // Handle input change
  const handleInputChange = (e) => {
    const newValue = e.target.value;
    const cursor = e.target.selectionStart;

    onChange(newValue);
    setCursorPosition(cursor);

    // Check if user is typing {{ to trigger autocomplete
    const textBeforeCursor = newValue.substring(0, cursor);
    const lastOpenBraces = textBeforeCursor.lastIndexOf("{{");

    if (lastOpenBraces !== -1) {
      const afterBraces = textBeforeCursor.substring(lastOpenBraces + 2);
      // Check if there's a closing }} after the opening {{
      const hasClosing = newValue.substring(cursor).indexOf("}}") !== -1;

      if (!hasClosing && !afterBraces.includes("\n")) {
        setSearchTerm(afterBraces);
        setShowPicker(true);
      } else {
        setShowPicker(false);
      }
    } else {
      setShowPicker(false);
    }
  };

  // Handle variable selection
  const handleSelectVariable = (varName) => {
    const textBeforeCursor = value.substring(0, cursorPosition);
    const textAfterCursor = value.substring(cursorPosition);
    const lastOpenBraces = textBeforeCursor.lastIndexOf("{{");

    if (lastOpenBraces !== -1) {
      const beforeBraces = value.substring(0, lastOpenBraces);
      const newValue = `${beforeBraces}{{${varName}}}${textAfterCursor}`;

      onChange(newValue);
      setShowPicker(false);

      // Set cursor position after the inserted variable
      setTimeout(() => {
        if (inputRef.current) {
          const newPos = beforeBraces.length + varName.length + 4; // 4 for {{}}
          inputRef.current.setSelectionRange(newPos, newPos);
          inputRef.current.focus();
        }
      }, 0);
    }
  };

  // Get filtered variables based on search term
  const getFilteredVariables = () => {
    const lowerSearch = searchTerm.toLowerCase();

    // Start with available variables
    let vars = availableVariables.map((v) => ({
      value: v,
      label: v,
      description: "",
    }));

    // Add webhook schema paths if available and search starts with "payload."
    if (webhookSchema && lowerSearch.startsWith("payload.")) {
      const searchPath = lowerSearch.substring(8); // Remove "payload."
      const schemaPaths = getSchemaPathsFromSchema(webhookSchema);

      schemaPaths.forEach((path) => {
        if (path.path.toLowerCase().includes(searchPath)) {
          vars.push({
            value: path.path,
            label: path.path,
            description: path.description || path.type,
          });
        }
      });
    }

    // Filter by search term
    if (lowerSearch) {
      vars = vars.filter(
        (v) =>
          v.label.toLowerCase().includes(lowerSearch) ||
          v.description.toLowerCase().includes(lowerSearch)
      );
    }

    return vars;
  };

  const filteredVars = getFilteredVariables();

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value}
        onChange={handleInputChange}
        placeholder={placeholder}
        className={className}
        {...props}
      />

      {showPicker && filteredVars.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-60 overflow-auto">
          <Command>
            <CommandList>
              <CommandGroup heading="Variables">
                {filteredVars.map((v) => (
                  <CommandItem
                    key={v.value}
                    value={v.value}
                    onSelect={() => handleSelectVariable(v.value)}
                    className="cursor-pointer"
                  >
                    <div className="flex flex-col">
                      <span className="font-mono text-sm">{v.label}</span>
                      {v.description && (
                        <span className="text-xs text-muted-foreground">
                          {v.description}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}

/**
 * Extract paths from webhook schema
 */
function getSchemaPathsFromSchema(schema) {
  const paths = [];

  function traverse(obj, currentPath = "") {
    if (!obj || typeof obj !== "object") return;

    Object.keys(obj).forEach((key) => {
      const field = obj[key];
      const path = currentPath ? `${currentPath}.${key}` : key;

      paths.push({
        path,
        type: field.type || "unknown",
        description: field.description || "",
      });

      // Traverse nested objects
      if (field.type === "object" && field.properties) {
        traverse(field.properties, path);
      }
    });
  }

  if (schema && schema.payload) {
    traverse(schema.payload, "payload");
  }

  return paths;
}

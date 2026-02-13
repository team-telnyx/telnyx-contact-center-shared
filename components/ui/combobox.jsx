"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconCheck, IconSelector } from "@tabler/icons-react";

export function Combobox({
  value,
  onChange,
  options = [],
  placeholder = "Select…",
  emptyLabel = "No results",
  triggerClassName = "",
  contentClassName = "",
  renderSelected,
  searchable = true,
  disabled = false,
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) =>
      String(opt.label || opt.value || "")
        .toLowerCase()
        .includes(q)
    );
  }, [options, query]);

  const selected = React.useMemo(
    () => options.find((o) => o.value === value) || null,
    [options, value]
  );

  // Auto-focus and maintain focus on search input when dropdown is open
  React.useEffect(() => {
    if (open && searchable && inputRef.current) {
      // Use setTimeout to ensure the input is rendered before focusing
      const timeoutId = setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [open, searchable, query]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          className={`h-9 justify-between px-3 overflow-hidden ${triggerClassName}`}
          disabled={disabled}
        >
          <span className="truncate flex items-center gap-2 min-w-0 flex-1">
            {renderSelected ? (
              renderSelected(selected)
            ) : (
              <>
                {selected?.Icon ? <selected.Icon className="shrink-0" /> : null}
                <span className="truncate block">
                  {selected ? selected.label || selected.value : placeholder}
                </span>
              </>
            )}
          </span>
          <IconSelector className="size-4 opacity-60 shrink-0 ml-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent 
        className={`p-0 max-h-[min(400px,var(--radix-dropdown-menu-content-available-height))] flex flex-col ${contentClassName || "w-[400px]"}`}
      >
        {searchable ? (
          <div className="px-3 pt-3 pb-2 border-b sticky top-0 bg-popover z-10 shrink-0">
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to filter…"
              autoFocus
            />
          </div>
        ) : null}
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <DropdownMenuItem disabled>{emptyLabel}</DropdownMenuItem>
          ) : (
            filtered.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => {
                  try {
                    onChange?.(opt.value);
                  } finally {
                    setOpen(false);
                    setQuery("");
                  }
                }}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-2 flex-1 min-w-0">
                  {opt.Icon ? <opt.Icon className="shrink-0" /> : null}
                  {opt.flag && <span className="shrink-0">{opt.flag}</span>}
                  <span className="break-words">{opt.label || opt.value}</span>
                </span>
                {value === opt.value ? (
                  <IconCheck className="ml-2 shrink-0 text-telnyx-green" />
                ) : null}
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default Combobox;

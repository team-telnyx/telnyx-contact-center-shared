"use client";

import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

const MODE_LABELS = { all: "All", list: "Selected", own: "Own" };

function ModeSwitch({ anchor, value, onChange, disabled }) {
  const modes = anchor.own ? ["all", "list", "own"] : ["all", "list"];
  return (
    <div className="inline-flex overflow-hidden rounded-md border">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            "border-r px-3 py-1 text-xs font-medium last:border-r-0",
            value === mode ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-muted",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          {MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

function Picker({ anchor, options, selectedIds, onAdd, disabled }) {
  const [open, setOpen] = useState(false);
  const remaining = options.filter((option) => !selectedIds.includes(option.id));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-7 rounded-full border-dashed text-xs" disabled={disabled || !remaining.length}>
          + add {anchor.label.toLowerCase()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${anchor.label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>Nothing to add.</CommandEmpty>
            {remaining.map((option) => (
              <CommandItem
                key={option.id}
                value={option.label}
                onSelect={() => {
                  onAdd(option.id);
                  setOpen(false);
                }}
              >
                {option.label}
                {option.label !== option.id ? <span className="ml-auto text-[11px] text-muted-foreground">{option.id}</span> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function describeMode(anchor, mode, hasOptions) {
  if (mode === "all") return `Every ${anchor.label.toLowerCase().replace(/s$/, "")} in the system, including ones created later.`;
  if (mode === "own") {
    if (anchor.id === "teams") return "Resolved from the assignee's teams at request time (Admin → Configuration → Teams). A team leader without a team contributes nothing to the OR and does not cancel the other anchors.";
    return `Resolved from the assignee's ${anchor.label.toLowerCase()} at request time, so one role serves many people.`;
  }
  if (!hasOptions) return anchor.id === "teams" ? "No teams yet — create them in Admin → Configuration → Teams, or use All or Own." : "No options available yet.";
  return "An explicit selection. Only these objects are visible; an empty selection grants nothing.";
}

/**
 * Scope per anchor: All / Selected / Own. Queues, teams and campaigns combine
 * with OR; channels always narrow with AND.
 */
export function ScopeEditor({ anchors = [], scopes, onChange, options = {}, readOnly = false }) {
  function update(anchorId, patch) {
    onChange({ ...scopes, [anchorId]: { ...(scopes[anchorId] || { mode: "all" }), ...patch } });
  }

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        <b>All</b> covers every object of that kind. <b>Selected</b> is an explicit list. <b>Own</b> resolves from the assignee&apos;s own queue, team or campaign membership at request time. Queues, teams and campaigns combine with OR; channels always narrow with AND.
      </p>
      <div className="divide-y rounded-md border">
        {anchors.map((anchor) => {
          const value = scopes[anchor.id] || { mode: "all" };
          const anchorOptions = options[anchor.id] || [];
          const labelOf = (id) => anchorOptions.find((option) => option.id === id)?.label || id;
          return (
            <div key={anchor.id} className="grid gap-3 px-3 py-3 md:grid-cols-[160px_minmax(0,1fr)]">
              <div>
                <div className="font-medium">{anchor.label}</div>
                <div className="text-[11px] text-muted-foreground">{anchor.source}</div>
              </div>
              <div className="space-y-2">
                <ModeSwitch anchor={anchor} value={value.mode} disabled={readOnly} onChange={(mode) => update(anchor.id, { mode, ids: mode === "list" ? value.ids || [] : undefined })} />
                {value.mode === "list" ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(value.ids || []).map((id) => (
                      <span key={id} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                        {labelOf(id)}
                        {!readOnly ? (
                          <button type="button" aria-label={`Remove ${labelOf(id)}`} className="text-muted-foreground hover:text-foreground" onClick={() => update(anchor.id, { ids: (value.ids || []).filter((x) => x !== id) })}>
                            <IconX className="size-3" />
                          </button>
                        ) : null}
                      </span>
                    ))}
                    {!readOnly ? <Picker anchor={anchor} options={anchorOptions} selectedIds={value.ids || []} disabled={readOnly} onAdd={(id) => update(anchor.id, { ids: [...(value.ids || []), id] })} /> : null}
                  </div>
                ) : null}
                <p className={cn("text-[11px]", value.mode === "list" && !(value.ids || []).length ? "text-destructive" : "text-muted-foreground")}>{describeMode(anchor, value.mode, anchorOptions.length > 0)}</p>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Per-object lists for call flows, assistants, mailboxes and similar resources arrive with the data-scoping phase; those resources are currently granted on all objects.</p>
    </div>
  );
}

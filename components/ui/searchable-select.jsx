"use client";
import { useMemo, useState } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

// Outline trigger plus a filterable command list: the same picker the demo
// portal uses for template languages, reused for messaging profiles and other
// long lists. Options: { value, label, description?, flag?, badge?, disabled? }.
export function SearchableSelect({ value, onChange, options = [], placeholder = "Select…", searchPlaceholder = "Filter…", emptyText = "No results.", heading, disabled = false, className, contentClassName, id, ...rest }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = options.find((option) => option.value === value) || null;
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return options;
    return options.filter((option) => `${option.label} ${option.value} ${option.description || ""}`.toLocaleLowerCase().includes(query));
  }, [options, search]);
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} disabled={disabled} className={cn("h-9 w-full justify-between px-3 font-normal", className)} {...rest}>
          {selected ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {selected.flag && <span className="text-base" aria-hidden="true">{selected.flag}</span>}
              <span className="truncate">{selected.label}</span>
              {selected.description && <span className="truncate text-xs text-muted-foreground">{selected.description}</span>}
            </span>
          ) : <span className="truncate text-muted-foreground">{placeholder}</span>}
          <IconChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("w-[var(--radix-popover-trigger-width)] min-w-72 p-0", contentClassName)}>
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
          <CommandList className="max-h-72">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup heading={heading}>
              {filtered.map((option) => (
                <CommandItem key={option.value} value={option.value} disabled={option.disabled} onSelect={() => { onChange?.(option.value); setOpen(false); setSearch(""); }} className="py-2">
                  <IconCheck className={cn("size-4", option.value === value ? "opacity-100" : "opacity-0")} />
                  {option.flag && <span className="text-base" aria-hidden="true">{option.flag}</span>}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.badge}
                  {option.description && <span className="max-w-[45%] truncate text-xs text-muted-foreground">{option.description}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

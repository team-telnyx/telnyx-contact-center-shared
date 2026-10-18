"use client";
import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useUiText } from "@/components/i18n/use-ui-text";
import { settingLabel } from "@/lib/ai/assistant-setting-presentation.mjs";
import { ASSISTANT_SETTINGS_INDEX } from "@/lib/ai/assistant-settings-index.mjs";
export default function AssistantSettingsSearch({ onSelect }) {
  const tUi = useUiText(),
    [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Search className="size-4" />
        {tUi("Find setting")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tUi("Find a setting")}</DialogTitle>
            <DialogDescription>
              {tUi("Search by setting name or Telnyx API parameter.")}
            </DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput placeholder={tUi("Search settings…")} />
            <CommandList>
              <CommandEmpty>{tUi("No settings found")}</CommandEmpty>
              <CommandGroup>
                {ASSISTANT_SETTINGS_INDEX.map((item) => (
                  <CommandItem
                    key={item.path}
                    value={`${tUi(item.label)} ${item.path}`}
                    onSelect={() => {
                      onSelect(item);
                      setOpen(false);
                    }}
                  >
                    <div className="min-w-0">
                      <div className="text-sm">{tUi(item.label)}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.location.filter(Boolean).map(key => tUi(settingLabel(key))).join(" › ")}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

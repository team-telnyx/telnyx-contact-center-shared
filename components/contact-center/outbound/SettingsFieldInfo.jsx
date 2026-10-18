"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { IconInfoCircle } from "@tabler/icons-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Settings fields keep a single-line label so inputs stay aligned across a row.
// The explanation lives behind this icon instead of wrapping under the field.
export default function SettingsFieldInfo({ hint, label = "" }) {
  const tUi = useUiText();
  if (!hint) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label ? tUi("About {value0}", { value0: label }) : tUi("More information")} className="shrink-0 rounded text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={(event) => event.preventDefault()}>
          <IconInfoCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs leading-snug">{hint}</TooltipContent>
    </Tooltip>
  );
}

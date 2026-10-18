"use client";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const videoToolbarClass = "inline-flex shrink-0 items-center rounded-lg border bg-background text-foreground shadow-xs";
export const videoToolbarButtonClass = "relative h-[var(--video-toolbar-button-size,32px)] w-[var(--video-toolbar-button-size,32px)] shrink-0 rounded-none p-0 first:rounded-s-lg last:rounded-e-lg hover:bg-black/5 dark:hover:bg-white/10";

export function videoToolbarPalette(palette) {
  return palette ? {
    "--background": palette.surface, "--foreground": palette.text, "--border": palette.border, "--input": palette.border,
    "--popover": palette.surface, "--popover-foreground": palette.text,
    "--muted": palette.surface, "--muted-foreground": palette.text, "--accent": palette.surface, "--accent-foreground": palette.text,
    "--primary": palette.primary, "--primary-foreground": palette.onPrimary,
    backgroundColor: palette.surface, color: palette.text, borderColor: palette.border,
  } : undefined;
}

export function VideoToolbarButton({ label, pressed, palette, children, ...props }) {
  return <Tooltip delayDuration={350}><TooltipTrigger asChild>
    <Button type="button" size="icon" variant="ghost" className={videoToolbarButtonClass} aria-label={label} aria-pressed={pressed}
      style={pressed ? { backgroundColor: palette ? `color-mix(in srgb, ${palette.primary} 18%, transparent)` : "var(--accent)", color: palette?.text || "var(--primary)", boxShadow: `inset 0 -2px ${palette?.primary || "var(--primary)"}` } : undefined} {...props}>{children}</Button>
  </TooltipTrigger><TooltipContent className="z-[2147483647] max-w-60" side="bottom">{label}</TooltipContent></Tooltip>;
}

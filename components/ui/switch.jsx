"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export function Switch({ className, style, checkedTrackColor, uncheckedTrackColor, thumbColor, checked, defaultChecked, ...props }) {
  const trackStyle = { ...style };
  const currentChecked = typeof checked === "boolean" ? checked : typeof defaultChecked === "boolean" ? defaultChecked : undefined;
  if (currentChecked === true && checkedTrackColor) trackStyle.backgroundColor = checkedTrackColor;
  if (currentChecked === false && uncheckedTrackColor) trackStyle.backgroundColor = uncheckedTrackColor;
  return (
    <SwitchPrimitives.Root
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className
      )}
      style={trackStyle}
      checked={checked}
      defaultChecked={defaultChecked}
      {...props}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
        )}
        style={thumbColor ? { backgroundColor: thumbColor } : undefined}
      />
    </SwitchPrimitives.Root>
  );
}

export default Switch;

"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

export function Progress({ className, indicatorClassName, value = 0, max = 100, ...props }) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  
  return (
    <ProgressPrimitive.Root
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      value={value}
      max={max}
      {...props}
    >
      <ProgressPrimitive.Indicator 
        className={cn("h-full bg-primary transition-all duration-300 ease-in-out", indicatorClassName)}
        style={{ width: `${percentage}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

export default Progress;

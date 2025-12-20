"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

export function Progress({ className, value = 0, max = 100, ...props }) {
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
      <ProgressPrimitive.Indicator className="h-full w-full flex-1 bg-primary transition-all" />
    </ProgressPrimitive.Root>
  );
}

export default Progress;

"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

function Slider({ className, value, defaultValue, min = 0, max = 100, rangeColor, thumbColor, trackColor, ...props }) {
  const values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [value, defaultValue, min]
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      className={cn("relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20" style={trackColor ? { backgroundColor: trackColor } : undefined}>
        <SliderPrimitive.Range className="absolute h-full bg-primary" style={rangeColor ? { backgroundColor: rangeColor } : undefined} />
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          style={thumbColor ? { backgroundColor: thumbColor, borderColor: thumbColor } : undefined}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
export default Slider;

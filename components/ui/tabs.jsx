"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

// Platform tab style: underline tabs with a Telnyx-green indicator, the same
// as the AI Assistant configuration pages (AssistantSectionTabs). Every tab
// switcher uses these classes; pass className only for spacing or size.
export const tabsListClass =
  "flex w-full shrink-0 items-center gap-6 overflow-x-auto border-b border-border";
export const tabsTriggerClass =
  "-mb-px inline-flex min-h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap border-b-[3px] border-transparent bg-transparent px-0 pb-3 pt-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-telnyx-green data-[state=active]:text-emerald-700 dark:data-[state=active]:text-telnyx-green [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
// Compact size for tabs inside forms and narrow panels.
export const tabsTriggerCompactClass = "min-h-8 pb-2 text-xs";

function Tabs({ className, ...props }) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(tabsListClass, className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(tabsTriggerClass, className)}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };

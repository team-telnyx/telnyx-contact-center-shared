"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip,TooltipContent,TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function InteractionActionGroup({label,children}){
  return <div role="group" aria-label={label} className="pointer-events-auto relative z-10 ml-auto flex shrink-0 divide-x divide-background/20 overflow-hidden rounded-md border border-foreground/20 bg-foreground text-background shadow-sm">{children}</div>;
}

export function InteractionActionButton({label,description,icon:Icon,busy,tone,disabled,...props}){
  return <Tooltip><TooltipTrigger asChild><span className="inline-flex" tabIndex={disabled?0:undefined}>
    <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={label} aria-busy={busy||undefined}
      className={cn("size-8 rounded-none bg-transparent text-background hover:bg-background/15 hover:text-background focus-visible:ring-inset focus-visible:ring-background/70 focus-visible:ring-offset-0",
        tone==="positive"&&"text-emerald-300 hover:text-emerald-200 dark:text-emerald-700 dark:hover:text-emerald-800",
        tone==="negative"&&"text-red-300 hover:text-red-200 dark:text-red-700 dark:hover:text-red-800")} {...props}>
      {busy?<Loader2 className="size-4 animate-spin"/>:<Icon className="size-4"/>}
    </Button>
  </span></TooltipTrigger><TooltipContent side="bottom" sideOffset={6}>{label}{description&&<span className="mt-1 block max-w-56 text-xs opacity-80">{description}</span>}</TooltipContent></Tooltip>;
}

"use client";

import { IconSparkles } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export const supervisorPageShellClass =
  "h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(113,113,122,0.14),transparent_26%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted))/0.55)]";

export const supervisorPurplePageShellClass =
  "h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(168,85,247,0.14),transparent_26%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted))/0.55)]";

export function SupervisorPageShell({ children, className }) {
  return (
    <div className={cn(supervisorPageShellClass, className)}>
      <div className="flex h-full min-h-0 flex-col">{children}</div>
    </div>
  );
}

export function SupervisorPageHeader({ title, badges, actions }) {
  return (
    <header className="shrink-0 border-y bg-background/80 px-5 py-4 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
            <IconSparkles className="h-4 w-4 text-sky-500" />
            Supervisor workspace
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {badges}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function SupervisorPageContent({ children, className }) {
  return (
    <main className={cn("flex-1 min-h-0 overflow-y-auto p-4 lg:p-6", className)}>
      {children}
    </main>
  );
}

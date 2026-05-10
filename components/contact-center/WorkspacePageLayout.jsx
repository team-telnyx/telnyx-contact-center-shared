"use client";

import { IconShieldCheck, IconSparkles } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export const workspacePageShellClass =
  "h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 overflow-hidden bg-[radial-gradient(circle_at_top_left,var(--workspace-shell-glow-primary,rgba(14,165,233,0.14)),transparent_28%),radial-gradient(circle_at_85%_15%,var(--workspace-shell-glow-secondary,rgba(113,113,122,0.14)),transparent_26%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted))/0.55)]";

export const supervisorPageShellClass =
  "h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(113,113,122,0.14),transparent_26%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted))/0.55)]";

export const supervisorPurplePageShellClass =
  "h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(168,85,247,0.14),transparent_26%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted))/0.55)]";

const variants = {
  supervisor: {
    label: "Supervisor workspace",
    Icon: IconSparkles,
    iconClassName: "text-sky-500",
    style: {
      "--workspace-shell-glow-primary": "rgba(14,165,233,0.14)",
      "--workspace-shell-glow-secondary": "rgba(113,113,122,0.14)",
    },
  },
  supervisorPurple: {
    label: "Supervisor workspace",
    Icon: IconSparkles,
    iconClassName: "text-sky-500",
    style: {
      "--workspace-shell-glow-primary": "rgba(14,165,233,0.14)",
      "--workspace-shell-glow-secondary": "rgba(168,85,247,0.14)",
    },
  },
  admin: {
    label: "ADMIN WORKSPACE",
    Icon: IconShieldCheck,
    iconClassName: "text-amber-500",
    style: {
      "--workspace-shell-glow-primary": "rgba(245,158,11,0.14)",
      "--workspace-shell-glow-secondary": "rgba(120,113,108,0.14)",
    },
  },
};

function variantConfig(variant = "supervisor") {
  return variants[variant] || variants.supervisor;
}

export function WorkspacePageShell({ children, className, variant = "supervisor" }) {
  return (
    <div className={cn(workspacePageShellClass, className)} style={variantConfig(variant).style}>
      <div className="flex h-full min-h-0 flex-col">{children}</div>
    </div>
  );
}

export function WorkspacePageHeader({
  title,
  badges,
  actions,
  variant = "supervisor",
  label,
  icon: IconOverride,
  iconClassName,
}) {
  const config = variantConfig(variant);
  const Icon = IconOverride || config.Icon;
  return (
    <header className="shrink-0 border-y bg-background/80 px-5 py-4 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
            <Icon className={cn("h-4 w-4", iconClassName || config.iconClassName)} />
            {label || config.label}
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

export function WorkspacePageContent({ children, className }) {
  return <main className={cn("flex-1 min-h-0 overflow-y-auto p-4 lg:p-6", className)}>{children}</main>;
}

export function AdminPageShell(props) {
  return <WorkspacePageShell {...props} variant="admin" />;
}

export function AdminPageHeader(props) {
  return <WorkspacePageHeader {...props} variant="admin" />;
}

export function AdminPageContent(props) {
  return <WorkspacePageContent {...props} />;
}

"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const SYSTEM_COLORS = {
  owner: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  admin: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  supervisor: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  agent: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

const ORIGIN_COLORS = {
  system: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  preset: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  custom: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
};

const ORIGIN_LABELS = { system: "System", preset: "Shipped", custom: "Custom" };

/** Colour for a role badge: system roles keep their historical colours, shipped and custom roles get their own. */
export function roleBadgeClass(role) {
  const key = String(role?.key || role || "").toLowerCase();
  if (SYSTEM_COLORS[key]) return SYSTEM_COLORS[key];
  const origin = role?.origin || (SYSTEM_COLORS[key] ? "system" : "custom");
  return ORIGIN_COLORS[origin] || ORIGIN_COLORS.custom;
}

export function RoleBadge({ role, label, className }) {
  const text = label || role?.name || String(role?.key || role || "").toUpperCase();
  return (
    <Badge variant="outline" className={cn(roleBadgeClass(role), "justify-center", className)}>
      {text}
    </Badge>
  );
}

export function RoleTypeBadge({ origin, className }) {
  return (
    <Badge variant="outline" className={cn(ORIGIN_COLORS[origin] || ORIGIN_COLORS.custom, className)}>
      {ORIGIN_LABELS[origin] || "Custom"}
    </Badge>
  );
}

export function EditedBadge({ className }) {
  return (
    <Badge variant="outline" className={cn("border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300", className)}>
      edited
    </Badge>
  );
}

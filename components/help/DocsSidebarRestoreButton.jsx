"use client";

import { IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import { useSidebar } from "fumadocs-ui/layouts/the internal documentation";

export function DocsSidebarRestoreButton() {
  const { collapsed, setCollapsed } = useSidebar();

  if (!collapsed) return null;

  return (
    <button
      type="button"
      className="help-sidebar-restore"
      aria-label="Expand navigation"
      title="Expand navigation"
      onClick={() => setCollapsed(false)}
    >
      <IconLayoutSidebarLeftExpand className="size-5" />
    </button>
  );
}

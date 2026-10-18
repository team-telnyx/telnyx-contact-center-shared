"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import { useSidebar } from "fumadocs-ui/layouts/docs/slots/sidebar";

export function DocsSidebarRestoreButton() {
  const tUi = useUiText();
  const { collapsed, setCollapsed } = useSidebar();

  if (!collapsed) return null;

  return (
    <button
      type="button"
      className="help-sidebar-restore"
      aria-label={tUi("Expand navigation")}
      title={tUi("Expand navigation")}
      onClick={() => setCollapsed(false)}
    >
      <IconLayoutSidebarLeftExpand className="size-5" />
    </button>
  );
}

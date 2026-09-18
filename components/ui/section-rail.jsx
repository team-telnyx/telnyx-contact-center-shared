"use client";

import { useEffect, useMemo } from "react";
import { useAuth } from "@/components/auth-provider";

export const SECTION_RAIL_WIDTH = "100px";
export const SECTION_RAIL_PAGE_GRID_CLASS = "grid flex-1 min-h-0 gap-3 p-3";
export const SECTION_RAIL_FILL_GRID_CLASS = "grid h-full min-h-0 w-full gap-3 p-3 overflow-hidden";
export const SECTION_RAIL_GRID_COLUMN = `${SECTION_RAIL_WIDTH}_minmax(0,1fr)`;
export const SECTION_RAIL_GRID_COLUMN_WITH_PANEL = `${SECTION_RAIL_WIDTH}_320px_minmax(0,1fr)_360px`;

function RailItem({ item, activeId, onSelect }) {
  const { id, label, icon: Icon, description, tone } = item;
  const isActive = activeId === id;
  const toneClass = tone === "exit"
    ? "border border-amber-500/40 bg-amber-500/15 text-amber-700 shadow-sm hover:bg-amber-500/25 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
    : isActive
      ? "bg-foreground text-background shadow-sm"
      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground";

  return (
    <button
      key={id}
      type="button"
      onClick={() => onSelect?.(id)}
      title={description || label}
      aria-current={isActive ? "page" : undefined}
      className={`group flex min-h-[68px] w-full flex-col items-center justify-center rounded-[1rem] px-1 py-2 text-center transition-all duration-200 ${toneClass}`}
    >
      {Icon ? (
        <Icon
          className={`h-[22px] w-[22px] transition ${
            tone === "exit"
              ? "text-current"
              : isActive
                ? "text-background"
                : "text-muted-foreground group-hover:text-foreground"
          }`}
        />
      ) : null}
      <span className="mt-1.5 max-w-full text-wrap break-words text-[10px] font-medium leading-tight tracking-tight">{label}</span>
    </button>
  );
}

/**
 * Screen id of a rail item: an explicit `item.screen`, otherwise
 * `<screenGroup>.<item.id>` when the rail declares its catalogue group.
 */
export function railItemScreen(item, screenGroup) {
  if (item?.screen) return item.screen;
  return screenGroup && item?.id ? `${screenGroup}.${item.id}` : null;
}

/**
 * Section rail. With `screenGroup` (or per-item `screen`) the items follow
 * the user's screen grants (RBAC Phase 3): sections a role does not grant are
 * hidden, and when the active section is hidden the first visible one is
 * selected so the page never shows a section the user may not open.
 */
export function SectionRail({ items = [], fixedItems = [], activeId, onSelect, ariaLabel = "Sections", className = "", screenGroup = null }) {
  const { canScreen, loaded } = useAuth();
  const gated = Boolean(screenGroup) || items.some((item) => item?.screen);
  const visibleItems = useMemo(() => {
    if (!gated || !loaded) return items;
    return items.filter((item) => {
      const screen = railItemScreen(item, screenGroup);
      return !screen || canScreen(screen);
    });
  }, [items, gated, loaded, screenGroup, canScreen]);
  const activeHidden = gated && loaded && activeId && !visibleItems.some((item) => item.id === activeId) && items.some((item) => item.id === activeId);
  const firstVisibleId = visibleItems[0]?.id || null;
  useEffect(() => {
    if (activeHidden && firstVisibleId) onSelect?.(firstVisibleId);
  }, [activeHidden, firstVisibleId, onSelect]);
  return (
    <aside
      className={`min-h-0 overflow-hidden rounded-[1.25rem] border bg-card/95 p-2 shadow-sm backdrop-blur ${className}`}
    >
      <nav className="flex h-full min-h-0 flex-col" aria-label={ariaLabel}>
        {fixedItems.length ? (
          <div className="shrink-0 border-b pb-2.5">
            {fixedItems.map((item) => <RailItem key={item.id} item={item} activeId={activeId} onSelect={onSelect} />)}
          </div>
        ) : null}
        <div className={`flex min-h-0 flex-1 flex-col items-center gap-2.5 overflow-y-auto ${fixedItems.length ? "pt-2.5" : ""}`}>
          {visibleItems.map((item) => <RailItem key={item.id} item={item} activeId={activeId} onSelect={onSelect} />)}
        </div>
      </nav>
    </aside>
  );
}

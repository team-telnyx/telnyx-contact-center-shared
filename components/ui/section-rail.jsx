"use client";

export const SECTION_RAIL_WIDTH = "146px";
export const SECTION_RAIL_GRID_COLUMN = `${SECTION_RAIL_WIDTH}_minmax(0,1fr)`;
export const SECTION_RAIL_GRID_COLUMN_WITH_PANEL = `${SECTION_RAIL_WIDTH}_320px_minmax(0,1fr)_360px`;

export function SectionRail({ items = [], activeId, onSelect, ariaLabel = "Sections", className = "" }) {
  return (
    <aside
      className={`min-h-0 overflow-hidden rounded-[1.35rem] border bg-card/95 p-2.5 shadow-sm backdrop-blur ${className}`}
    >
      <nav className="flex h-full min-h-0 flex-col items-center gap-3.5 overflow-y-auto" aria-label={ariaLabel}>
        {items.map(({ id, label, icon: Icon, description }) => {
          const isActive = activeId === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect?.(id)}
              title={description || label}
              aria-current={isActive ? "page" : undefined}
              className={`group flex min-h-[76px] w-full flex-col items-center justify-center rounded-[1.05rem] px-2 py-3 text-center transition-all duration-200 ${
                isActive
                  ? "bg-foreground text-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              }`}
            >
              {Icon ? (
                <Icon
                  className={`h-6 w-6 transition ${
                    isActive ? "text-background" : "text-muted-foreground group-hover:text-foreground"
                  }`}
                />
              ) : null}
              <span className="mt-2 text-[11px] font-medium leading-tight tracking-tight">{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

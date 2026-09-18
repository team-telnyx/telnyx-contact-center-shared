"use client";

import { useMemo, useState } from "react";
import { IconChevronDown, IconChevronRight, IconLock } from "@tabler/icons-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { screenLeavesUnder } from "@/lib/authz/permissions.mjs";
import { cn } from "@/lib/utils";

function collectGroupIds(nodes, out = []) {
  for (const node of nodes) {
    if (node.kids?.length) {
      out.push(node.id);
      collectGroupIds(node.kids, out);
    }
  }
  return out;
}

/**
 * Navigation tree with tri-state checkboxes. `selected` holds leaf screen ids.
 * Leaves outside `actorAccess` are locked (delegation rule).
 */
export function ScreenTree({ tree = [], selected, onChange, readOnly = false, actorAccess = null }) {
  const allGroups = useMemo(() => collectGroupIds(tree), [tree]);
  const [collapsed, setCollapsed] = useState(() => new Set(tree.map((node) => node.id)));

  const canGrant = (leafId) => !actorAccess || actorAccess.wildcard || actorAccess.screens.has(leafId);

  function toggleGroup(node, leaves, nextChecked) {
    const next = new Set(selected);
    for (const leaf of leaves) {
      if (!canGrant(leaf)) continue;
      if (nextChecked) next.add(leaf);
      else next.delete(leaf);
    }
    onChange(next);
  }

  function renderNode(node, level) {
    const leaves = node.kids?.length ? screenLeavesUnder(node.id) : [node.id];
    const on = leaves.filter((leaf) => selected.has(leaf)).length;
    const grantable = leaves.some(canGrant);
    const checked = on === 0 ? false : on === leaves.length ? true : "indeterminate";
    const isGroup = Boolean(node.kids?.length);
    const isCollapsed = collapsed.has(node.id);
    const checkboxId = `screen-${node.id}`;
    return (
      <div key={node.id}>
        <div
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60",
            level === 0 && "mt-2 font-semibold",
            level === 1 && "font-medium",
          )}
          style={{ paddingLeft: `${8 + level * 22}px` }}
        >
          <button
            type="button"
            aria-label={isGroup ? (isCollapsed ? "Expand" : "Collapse") : undefined}
            className={cn("flex size-5 items-center justify-center text-muted-foreground", !isGroup && "invisible")}
            onClick={() => {
              if (!isGroup) return;
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
              });
            }}
          >
            {isCollapsed ? <IconChevronRight className="size-4" /> : <IconChevronDown className="size-4" />}
          </button>
          <Checkbox
            id={checkboxId}
            checked={checked}
            disabled={readOnly || !grantable}
            onCheckedChange={(value) => toggleGroup(node, leaves, value === true)}
            aria-label={`Grant ${node.label}`}
          />
          <label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2">
            <span className="truncate">{node.label}</span>
            {node.path ? <span className="truncate text-[11px] text-muted-foreground">{node.path}</span> : null}
            {!grantable ? (
              <span title="Outside your own access" className="text-muted-foreground">
                <IconLock className="size-3.5" />
              </span>
            ) : null}
          </label>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {isGroup ? `${on}/${leaves.length}` : <code className="font-mono">screen:{node.id}</code>}
          </span>
        </div>
        {isGroup && !isCollapsed ? node.kids.map((kid) => renderNode(kid, level + 1)) : null}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Tick a group to grant every screen below it, now and in future releases. Menu groups appear automatically when anything under them is granted.
        </p>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => setCollapsed(new Set())}>
            Expand all
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setCollapsed(new Set(allGroups))}>
            Collapse
          </Button>
        </div>
      </div>
      <div className="rounded-md border p-1">{tree.map((node) => renderNode(node, 0))}</div>
    </div>
  );
}

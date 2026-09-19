"use client";

import { IconLock } from "@tabler/icons-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CRUD = ["read", "create", "update", "delete"];

const ANCHOR_HINT = {
  queues: "by queues",
  teams: "by teams",
  campaigns: "by campaigns",
  channels: "by channels",
  objects: "per object",
};

/**
 * Operations per managed object: read / create / update / delete plus named
 * operations. `selected` holds operation keys such as `users:create`.
 */
export function OperationsMatrix({ areas = [], selected, onChange, readOnly = false, actorAccess = null }) {
  const canGrant = (key) => !actorAccess || actorAccess.wildcard || actorAccess.operations.has(key);

  function setMany(keys, nextChecked) {
    const next = new Set(selected);
    for (const key of keys) {
      if (!canGrant(key)) continue;
      if (nextChecked) next.add(key);
      else next.delete(key);
    }
    onChange(next);
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 text-left font-semibold">Object</th>
            {CRUD.map((action) => (
              <th key={action} className="w-16 px-2 py-2 text-center font-semibold">
                {action}
              </th>
            ))}
            <th className="px-3 py-2 text-left font-semibold">Named operations</th>
            <th className="w-28 px-3 py-2 text-left font-semibold">Scope</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => {
            const areaKeys = area.items.flatMap((item) => [...item.crud, ...item.named].map((action) => `${item.key}:${action}`)).filter(canGrant);
            const on = areaKeys.filter((key) => selected.has(key)).length;
            return [
              <tr key={`area-${area.area}`} className="border-b bg-muted/30">
                <td colSpan={7} className="px-3 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {area.area} <span className="ml-1 tabular-nums normal-case tracking-normal">{on}/{areaKeys.length}</span>
                    </span>
                    {!readOnly && areaKeys.length ? (
                      <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setMany(areaKeys, on !== areaKeys.length)}>
                        {on === areaKeys.length ? "Clear area" : "Grant all in area"}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>,
              ...area.items.map((item) => (
                <tr key={item.key} className="border-b last:border-b-0">
                  <td className="whitespace-nowrap px-3 py-1.5 align-middle">
                    <div className="flex flex-col">
                      <span>{item.label}</span>
                      <code className="text-[11px] text-muted-foreground">{item.key}</code>
                    </div>
                  </td>
                  {CRUD.map((action) => {
                    const key = `${item.key}:${action}`;
                    if (!item.crud.includes(action)) {
                      return (
                        <td key={action} className="px-2 py-1.5 text-center text-muted-foreground">
                          ·
                        </td>
                      );
                    }
                    const locked = !canGrant(key);
                    return (
                      <td key={action} className="px-2 py-1.5 text-center align-middle">
                        <Checkbox
                          aria-label={key}
                          title={locked ? `${key} · outside your own access` : key}
                          checked={selected.has(key)}
                          disabled={readOnly || locked}
                          onCheckedChange={(value) => setMany([key], value === true)}
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 align-middle">
                    <div className="flex flex-wrap gap-1">
                      {item.named.map((action) => {
                        const key = `${item.key}:${action}`;
                        const locked = !canGrant(key);
                        const checked = selected.has(key);
                        return (
                          <label
                            key={action}
                            title={locked ? `${key} · outside your own access` : key}
                            className={cn(
                              "inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
                              checked && "border-foreground",
                              (readOnly || locked) && "cursor-not-allowed opacity-60",
                            )}
                          >
                            <Checkbox className="size-3.5" checked={checked} disabled={readOnly || locked} onCheckedChange={(value) => setMany([key], value === true)} aria-label={key} />
                            {action}
                            {locked ? <IconLock className="size-3 text-muted-foreground" /> : null}
                          </label>
                        );
                      })}
                      {!item.named.length ? <span className="text-[11px] text-muted-foreground">—</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 align-middle text-[11px] text-muted-foreground">{item.anchor ? ANCHOR_HINT[item.anchor] || item.anchor : "—"}</td>
                </tr>
              )),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { IconAddressBook, IconBook, IconChecklist } from "@tabler/icons-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const tiles = [
  {
    id: "contacts",
    title: "Contacts",
    icon: IconAddressBook,
    description: "Manage contact information",
  },
  {
    id: "kb-articles",
    title: "KB Articles",
    icon: IconBook,
    description: "Knowledge base articles",
  },
  {
    id: "tasks",
    title: "Tasks",
    icon: IconChecklist,
    description: "Task management",
  },
];

export default function DataSourcesTiles() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeView = searchParams.get("view") || "contacts";

  const handleTileClick = (viewId) => {
    router.push(`/admin/data-sources?view=${viewId}`);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      {tiles.map((tile) => {
        const Icon = tile.icon;
        const isActive = activeView === tile.id;

        return (
          <Card
            key={tile.id}
            className={cn(
              "cursor-pointer transition-all hover:shadow-md",
              isActive
                ? "ring-2 ring-telnyx-green bg-telnyx-green/5"
                : "hover:bg-muted/50",
            )}
            onClick={() => handleTileClick(tile.id)}
          >
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    "p-2 rounded-md",
                    isActive
                      ? "bg-telnyx-green text-black"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3
                    className={cn(
                      "font-semibold text-sm mb-1",
                      isActive && "text-telnyx-green",
                    )}
                  >
                    {tile.title}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {tile.description}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

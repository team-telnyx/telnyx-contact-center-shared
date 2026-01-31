"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  IconAddressBook,
  IconBook,
  IconChecklist,
  IconWorld,
  IconDatabase,
} from "@tabler/icons-react";
import { AgentContactsView } from "./AgentContactsView";
import { AgentTasksView } from "./AgentTasksView";
import { AgentKbArticlesView } from "./AgentKbArticlesView";
import { AgentWebPagesView } from "./AgentWebPagesView";

const tiles = [
  {
    id: "contacts",
    title: "Contacts",
    icon: IconAddressBook,
    description: "Search contacts",
  },
  {
    id: "tasks",
    title: "Tasks",
    icon: IconChecklist,
    description: "Manage tasks",
  },
  {
    id: "kb-articles",
    title: "KB Articles",
    icon: IconBook,
    description: "Knowledge base",
  },
  {
    id: "web-pages",
    title: "Web Pages",
    icon: IconWorld,
    description: "External portals",
  },
];

/**
 * AgentDataSources component
 * Shows tiles when view is null, shows specific view when view is set
 */
export function AgentDataSources({
  view,
  selectedInteraction,
  activeView,
  onTileClick,
  onBackToInteraction,
}) {
  // If view is null, show tiles
  if (view === null) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 bg-muted/50 border-b rounded-t-lg">
          <div className="flex items-center gap-2">
            <IconDatabase className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              Data Sources
            </h3>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {tiles.map((tile) => {
            const Icon = tile.icon;
            const isSelected = activeView === tile.id;
            return (
              <Card
                key={tile.id}
                className={cn(
                  "cursor-pointer transition-all hover:shadow-md",
                  isSelected
                    ? "ring-2 ring-primary bg-primary/5 border-primary"
                    : "hover:bg-muted/50",
                )}
                onClick={() => onTileClick?.(tile.id)}
              >
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        "p-2 rounded-md shrink-0",
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : "bg-primary/10 text-primary",
                      )}
                    >
                      <Icon className="size-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3
                        className={cn(
                          "font-semibold text-sm mb-0.5",
                          isSelected && "text-primary",
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
      </div>
    );
  }

  // Show specific view
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {view === "contacts" && (
        <AgentContactsView
          selectedInteraction={selectedInteraction}
          onBackToInteraction={onBackToInteraction}
        />
      )}
      {view === "tasks" && (
        <AgentTasksView
          selectedInteraction={selectedInteraction}
          onBackToInteraction={onBackToInteraction}
        />
      )}
      {view === "kb-articles" && (
        <AgentKbArticlesView
          selectedInteraction={selectedInteraction}
          onBackToInteraction={onBackToInteraction}
        />
      )}
      {view === "web-pages" && (
        <AgentWebPagesView
          selectedInteraction={selectedInteraction}
          onBackToInteraction={onBackToInteraction}
        />
      )}
    </div>
  );
}

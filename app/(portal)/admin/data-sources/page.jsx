"use client";

import { useSearchParams } from "next/navigation";
import DataSourcesTiles from "@/components/data-sources/DataSourcesTiles";
import ContactsView from "@/components/data-sources/ContactsView";
import KbArticlesView from "@/components/data-sources/KbArticlesView";
import TasksView from "@/components/data-sources/TasksView";

export default function DataSourcesPage() {
  const searchParams = useSearchParams();
  const view = searchParams.get("view") || "contacts";

  return (
    <div className="px-4 lg:px-6">
      <DataSourcesTiles />
      {view === "contacts" && <ContactsView />}
      {view === "kb-articles" && <KbArticlesView />}
      {view === "tasks" && <TasksView />}
    </div>
  );
}

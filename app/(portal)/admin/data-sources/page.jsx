import { Suspense } from "react";
import DataSourcesPageClient from "./page-client";

export const dynamic = "force-dynamic";

export default function DataSourcesPage() {
  return (
    <div className="px-4 lg:px-6">
      <Suspense
        fallback={
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-20 bg-muted animate-pulse rounded-lg"
                />
              ))}
            </div>
          </div>
        }
      >
        <DataSourcesPageClient />
      </Suspense>
    </div>
  );
}

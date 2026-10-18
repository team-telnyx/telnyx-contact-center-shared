
import { UiText } from "@/components/i18n/use-ui-text";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { ConfigurationSectionPage } from "@/components/admin/ConfigurationSectionNav";
import DataSourcesPageClient from "./page-client";

export const dynamic = "force-dynamic";

export default function DataSourcesPage() {
  return (
    <AdminPageShell>
      <AdminPageHeader title={<UiText>Data Sources</UiText>} badges={<Badge variant="secondary"><UiText>Knowledge hub</UiText></Badge>} />
      <ConfigurationSectionPage activeId="data-sources">
        <div className="space-y-4">
          <Suspense
            fallback={
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-20 animate-pulse rounded-lg bg-muted"
                    />
                  ))}
                </div>
              </div>
            }
          >
            <DataSourcesPageClient />
          </Suspense>
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}

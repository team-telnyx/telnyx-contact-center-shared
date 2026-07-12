"use client";

import { useRouter } from "next/navigation";
import { IconArrowRight, IconSettings, IconShieldCheck, IconSparkles } from "@tabler/icons-react";
import { SystemSectionPage, visibleSystemItems } from "@/components/admin/SystemSectionNav";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Card, CardContent } from "@/components/ui/card";
import { useExperimentalFeatures } from "@/lib/experimental-features-client";

export default function SystemPage() {
  const router = useRouter();
  const { enabled: experimentalFeaturesEnabled } = useExperimentalFeatures();
  const systemItems = visibleSystemItems(experimentalFeaturesEnabled);

  return (
    <AdminPageShell>
      <AdminPageHeader title="System" icon={IconSettings} />
      <SystemSectionPage>
        <div className="space-y-4 overflow-y-auto pr-1">
          <Card className="overflow-hidden border-amber-500/20 bg-gradient-to-br from-amber-500/10 via-card to-card">
            <CardContent className="p-6">
              <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
                <div className="flex items-start gap-4">
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-300">
                    <IconShieldCheck className="size-6" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">
                      <IconSparkles className="size-4" /> Platform control center
                    </div>
                    <h2 className="text-2xl font-semibold tracking-tight">System administration</h2>
                    <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                      Start with Dashboard for a platform-wide health overview, or choose another
                      section from the rail to manage operational tooling, observability, phone
                      provisioning, and the visual identity of the contact center.
                    </p>
                  </div>
                </div>
                <div className="shrink-0 rounded-xl border bg-background/70 px-4 py-3 text-center shadow-sm">
                  <div className="text-2xl font-semibold">{systemItems.length}</div>
                  <div className="text-xs text-muted-foreground">system modules</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            {systemItems.map(({ id, label, icon: Icon, href, description }) => (
              <button
                key={id}
                type="button"
                onClick={() => router.push(href)}
                className="group flex min-h-36 items-start gap-4 rounded-xl border bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-muted/30 hover:shadow-md"
              >
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition group-hover:bg-foreground group-hover:text-background">
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold">{label}</h3>
                    <IconArrowRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-foreground" />
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">{description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </SystemSectionPage>
    </AdminPageShell>
  );
}

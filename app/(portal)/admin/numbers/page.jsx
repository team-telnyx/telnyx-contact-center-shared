"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { ConfigurationSectionPage } from "@/components/admin/ConfigurationSectionNav";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconPhone, IconSearch } from "@tabler/icons-react";
import NumbersInventoryTab from "@/components/numbers/NumbersInventoryTab";
import NumbersSearchTab from "@/components/numbers/NumbersSearchTab";

export default function NumbersPage() {
  const tUi = useUiText();
  const [activeTab, setActiveTab] = useState("inventory");

  return (
    <AdminPageShell>
      <AdminPageHeader title={tUi("Phone Numbers")} badges={<Badge variant="secondary">{tUi("Number inventory")}</Badge>} />
      <ConfigurationSectionPage activeId="numbers">
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="w-full"
          >
            <TabsList>
              <TabsTrigger value="inventory">
                <IconPhone className="size-4" />{tUi("Inventory")}</TabsTrigger>
              <TabsTrigger value="search">
                <IconSearch className="size-4" />{tUi("Search & Order")}</TabsTrigger>
            </TabsList>

            <TabsContent value="inventory" className="mt-6">
              <NumbersInventoryTab />
            </TabsContent>

            <TabsContent value="search" className="mt-6">
              <NumbersSearchTab />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}

"use client";

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
  const [activeTab, setActiveTab] = useState("inventory");

  return (
    <AdminPageShell>
      <AdminPageHeader title="Phone Numbers" badges={<Badge variant="secondary">Number inventory</Badge>} />
      <ConfigurationSectionPage activeId="numbers">
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger
                value="inventory"
                className="flex items-center gap-2"
              >
                <IconPhone className="size-4" />
                Inventory
              </TabsTrigger>
              <TabsTrigger value="search" className="flex items-center gap-2">
                <IconSearch className="size-4" />
                Search & Order
              </TabsTrigger>
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

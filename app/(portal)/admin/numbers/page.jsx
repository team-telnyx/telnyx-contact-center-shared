"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconPhone, IconSearch } from "@tabler/icons-react";
import NumbersInventoryTab from "@/components/numbers/NumbersInventoryTab";
import NumbersSearchTab from "@/components/numbers/NumbersSearchTab";

export default function NumbersPage() {
  const [activeTab, setActiveTab] = useState("inventory");

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconPhone className="size-6 text-telnyx-green" /> Phone Numbers
            </div>
          </div>

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
  );
}


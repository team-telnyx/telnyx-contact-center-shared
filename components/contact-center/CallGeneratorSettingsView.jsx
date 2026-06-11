"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export default function CallGeneratorSettingsView() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Enable Call Generator</div>
              <div className="text-xs text-muted-foreground">Master on/off switch for the entire module.</div>
            </div>
            <Switch />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Max concurrent calls</Label>
              <Input type="number" defaultValue={10} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Max CPS</Label>
              <Input type="number" defaultValue={5} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Caller number (from)</Label>
              <Input placeholder="+1234567890" className="mt-1" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Panic button timeout (ms)</Label>
              <Input type="number" defaultValue={5000} className="mt-1" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

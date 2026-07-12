"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Combobox from "@/components/ui/combobox";
import { IconRobot } from "@tabler/icons-react";

export default function HandoffToolEditor({ value, onChange }) {
  const ho = value?.handoff || {};
  const list = Array.isArray(ho.ai_assistants) ? ho.ai_assistants : [];
  const [assistantOptions, setAssistantOptions] = useState([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`/api/ai/assistants?all=true`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (mounted && res.ok && data?.ok) {
          const items = Array.isArray(data.items) ? data.items : [];
          const opts = items.map((a) => ({
            value: a.id,
            label: a.name || a.id,
            Icon: IconRobot,
          }));
          setAssistantOptions(opts);
        }
      } catch (_) {}
    })();
    return () => {
      mounted = false;
    };
  }, []);
  function update(partial) {
    onChange?.({
      ...(value || { type: "handoff" }),
      handoff: { ...(value?.handoff || {}), ...partial },
    });
  }
  const selected = list?.[0] || { name: "", id: "" };
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs">Voice Mode</label>
        <div className="mt-1">
          <Tabs
            defaultValue={ho.voice_mode || "unified"}
            onValueChange={(val) => update({ voice_mode: val })}
          >
            <TabsList className="w-full">
              <TabsTrigger value="unified" className="flex-1">
                Unified
              </TabsTrigger>
              <TabsTrigger value="distinct" className="flex-1">
                Distinct
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-xs">Name</div>
        <Input
          placeholder="Name"
          value={selected?.name || ""}
          onChange={(e) =>
            update({ ai_assistants: [{ ...selected, name: e.target.value }] })
          }
        />
        <div className="text-xs mt-3">Assistant</div>
        <Combobox
          value={selected?.id || ""}
          onChange={(val) =>
            update({ ai_assistants: [{ ...selected, id: val }] })
          }
          options={assistantOptions}
          placeholder="Select assistant…"
          triggerClassName="w-full"
          searchable
        />
      </div>
    </div>
  );
}

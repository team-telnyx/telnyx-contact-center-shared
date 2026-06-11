"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ToastNotify";
import {
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconEdit,
} from "@tabler/icons-react";

const API = "/api/admin/call-generator/scenarios";

export default function CallGeneratorScenariosView({ refreshNonce = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error("Failed to load scenarios");
        const data = await res.json();
        if (!cancelled) setItems(data.scenarios || []);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refreshNonce]);

  async function save() {
    const payload = {
      name: name.trim(),
      description: description.trim(),
    };
    if (!payload.name) {
      notify("Name is required", "error");
      return;
    }
    try {
      const url = editing ? `${API}/${editing.id}` : API;
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      notify(editing ? "Scenario updated" : "Scenario created", "success");
      setFormOpen(false);
      setEditing(null);
      setName("");
      setDescription("");
      const data = await res.json();
      setItems((prev) => (editing
        ? prev.map((i) => (i.id === editing.id ? data.scenario : i))
        : [data.scenario, ...prev]));
    } catch (err) {
      notify(err.message || "Save failed", "error");
    }
  }

  async function remove(id) {
    if (!window.confirm("Delete this scenario?")) return;
    try {
      const res = await fetch(`${API}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      notify("Scenario deleted", "success");
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      notify(err.message || "Delete failed", "error");
    }
  }

  async function startRun(id) {
    try {
      const res = await fetch("/api/admin/call-generator/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_id: id }),
      });
      if (!res.ok) throw new Error("Failed to start run");
      notify("Run started", "success");
    } catch (err) {
      notify(err.message || "Run failed", "error");
    }
  }

  function openNew() {
    setEditing(null);
    setName("");
    setDescription("");
    setFormOpen(true);
  }

  function openEdit(item) {
    setEditing(item);
    setName(item.name);
    setDescription(item.description || "");
    setFormOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Scenarios</h4>
        <Button size="sm" onClick={openNew}>
          <IconPlus className="mr-2 h-4 w-4" />
          New scenario
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scenarios yet. Use New scenario to create one.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id} className="rounded-xl">
              <CardContent className="flex items-center justify-between p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    <Badge variant="outline" className={
                      item.status === "active"
                        ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300"
                    }>
                      {item.status || "draft"}
                    </Badge>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{item.description || "No description"}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="icon" variant="ghost" onClick={() => openEdit(item)} title="Edit">
                    <IconEdit className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => startRun(item.id)} title="Start run">
                    <IconPlayerPlay className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => remove(item.id)} title="Delete">
                    <IconTrash className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {formOpen && (
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h4 className="text-sm font-semibold">{editing ? "Edit scenario" : "New scenario"}</h4>
          <div className="mt-4 space-y-3">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scenario name" />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save}>{editing ? "Update" : "Create"}</Button>
              <Button size="sm" variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

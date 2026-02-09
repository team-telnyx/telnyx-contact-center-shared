"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconArrowLeft, IconGitBranch, IconLoader2 } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";

const WORKFLOW_CATEGORIES = [
  "Sales",
  "Support",
  "Onboarding",
  "Fulfillment",
  "Operations",
  "HR",
  "Other",
];

export default function NewWorkflowPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    category: "",
  });

  async function handleSubmit(e) {
    e.preventDefault();

    if (!form.name.trim()) {
      notify({
        title: "Validation Error",
        description: "Workflow name is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          category: form.category || null,
          is_active: false,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Failed to create workflow");
      }

      notify({
        title: "Workflow created",
        description: "Now you can add stages and items to your workflow.",
        variant: "success",
      });

      // Redirect to the editor
      router.push(`/admin/workflows/${data.workflow.id}`);
    } catch (err) {
      notify({
        title: "Create failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-4 lg:px-6">
      <div className="mb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/admin/workflows")}
        >
          <IconArrowLeft className="size-4 mr-1" />
          Back to Workflows
        </Button>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconGitBranch className="size-6 text-telnyx-green" />
            Create New Workflow
          </CardTitle>
          <CardDescription>
            Create a new workflow to manage stages and items for your processes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g., Sales Pipeline, Support Tickets"
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Describe the purpose of this workflow..."
                rows={3}
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select
                value={form.category}
                onValueChange={(value) =>
                  setForm((f) => ({ ...f, category: value }))
                }
                disabled={saving}
              >
                <SelectTrigger id="category">
                  <SelectValue placeholder="Select a category..." />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOW_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push("/admin/workflows")}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <IconLoader2 className="size-4 mr-1 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Workflow"
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

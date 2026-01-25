"use client";

import React, { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { IconEdit, IconPlus } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const STATUS_OPTIONS = [
  { value: "Draft", label: "Draft" },
  { value: "Published", label: "Published" },
  { value: "Archived", label: "Archived" },
];

export default function KbArticleEditSheet({
  open,
  onOpenChange,
  articleId,
  onSave,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [tags, setTags] = useState("");
  const [keywords, setKeywords] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [status, setStatus] = useState("Draft");
  const [language, setLanguage] = useState("en");

  useEffect(() => {
    if (open) {
      if (articleId) {
        loadArticle();
      } else {
        // Reset form for new article
        setTitle("");
        setSlug("");
        setSummary("");
        setContent("");
        setCategory("");
        setSubcategory("");
        setTags("");
        setKeywords("");
        setAuthorName("");
        setStatus("Draft");
        setLanguage("en");
      }
    }
  }, [open, articleId]);

  // Auto-generate slug from title
  useEffect(() => {
    if (!articleId && title) {
      const generatedSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      setSlug(generatedSlug);
    }
  }, [title, articleId]);

  async function loadArticle() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/kb-articles/${encodeURIComponent(articleId)}`,
        {
          cache: "no-store",
        }
      );
      if (!res.ok) {
        throw new Error("Failed to load article");
      }
      const data = await res.json();
      const article = data;
      if (article) {
        setTitle(article.title || "");
        setSlug(article.slug || "");
        setSummary(article.summary || "");
        setContent(article.content || "");
        setCategory(article.category || "");
        setSubcategory(article.subcategory || "");
        setTags(Array.isArray(article.tags) ? article.tags.join(", ") : "");
        setKeywords(
          Array.isArray(article.keywords) ? article.keywords.join(", ") : ""
        );
        setAuthorName(article.author_name || "");
        setStatus(article.status || "Draft");
        setLanguage(article.language || "en");
      }
    } catch (error) {
      console.error("[KbArticleEditSheet] Load error:", error);
      notify({
        title: "Failed to load article",
        description: error.message,
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!title.trim()) {
      notify({
        title: "Validation error",
        description: "Title is required",
        variant: "error",
      });
      return;
    }

    if (!slug.trim()) {
      notify({
        title: "Validation error",
        description: "Slug is required",
        variant: "error",
      });
      return;
    }

    if (!content.trim()) {
      notify({
        title: "Validation error",
        description: "Content is required",
        variant: "error",
      });
      return;
    }

    if (!category.trim()) {
      notify({
        title: "Validation error",
        description: "Category is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      // Parse tags and keywords from comma-separated strings
      const tagsArray = tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const keywordsArray = keywords
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);

      const payload = {
        title: title.trim(),
        slug: slug.trim(),
        summary: summary.trim() || null,
        content: content.trim(),
        category: category.trim(),
        subcategory: subcategory.trim() || null,
        tags: tagsArray.length > 0 ? tagsArray : null,
        keywords: keywordsArray.length > 0 ? keywordsArray : null,
        authorName: authorName.trim() || null,
        status,
        language: language.trim() || "en",
      };

      const url = articleId
        ? `/api/admin/kb-articles/${encodeURIComponent(articleId)}`
        : "/api/admin/kb-articles";
      const method = articleId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save article");
      }

      notify({
        title: "Article saved",
        description: `Article ${articleId ? "updated" : "created"} successfully`,
        variant: "success",
      });

      if (onSave) {
        onSave();
      }
      onOpenChange(false);
    } catch (error) {
      console.error("[KbArticleEditSheet] Save error:", error);
      notify({
        title: "Failed to save article",
        description: error.message,
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            {articleId ? (
              <>
                <IconEdit className="size-5" />
                Edit KB Article
              </>
            ) : (
              <>
                <IconPlus className="size-5" />
                Create KB Article
              </>
            )}
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
              {loading ? (
                <>
                  <div className="space-y-3">
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                    <div className="grid gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-24 w-full" />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="title">Title *</Label>
                    <Input
                      id="title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g., How to reset your password"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="slug">Slug *</Label>
                    <Input
                      id="slug"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      placeholder="e.g., how-to-reset-password"
                    />
                    <p className="text-xs text-muted-foreground">
                      URL-friendly identifier (auto-generated from title)
                    </p>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="summary">Summary</Label>
                    <Textarea
                      id="summary"
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                      placeholder="Brief summary of the article"
                      rows={3}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="content">Content *</Label>
                    <Textarea
                      id="content"
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      placeholder="Full article content (markdown or plain text)"
                      rows={12}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="category">Category *</Label>
                      <Input
                        id="category"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        placeholder="e.g., General, Technical, Billing"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="subcategory">Subcategory</Label>
                      <Input
                        id="subcategory"
                        value={subcategory}
                        onChange={(e) => setSubcategory(e.target.value)}
                        placeholder="Optional subcategory"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="tags">Tags</Label>
                      <Input
                        id="tags"
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                        placeholder="Comma-separated tags"
                      />
                      <p className="text-xs text-muted-foreground">
                        e.g., password, reset, account
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="keywords">Keywords</Label>
                      <Input
                        id="keywords"
                        value={keywords}
                        onChange={(e) => setKeywords(e.target.value)}
                        placeholder="Comma-separated keywords"
                      />
                      <p className="text-xs text-muted-foreground">
                        For search optimization
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="authorName">Author Name</Label>
                      <Input
                        id="authorName"
                        value={authorName}
                        onChange={(e) => setAuthorName(e.target.value)}
                        placeholder="Author name"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="status">Status *</Label>
                      <Select value={status} onValueChange={setStatus}>
                        <SelectTrigger id="status">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="language">Language</Label>
                    <Input
                      id="language"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      placeholder="en"
                    />
                    <p className="text-xs text-muted-foreground">
                      ISO 639-1 language code (e.g., en, es, fr)
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !title.trim() || !slug.trim() || !content.trim() || !category.trim()}
          >
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}


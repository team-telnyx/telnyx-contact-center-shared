"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  IconPlus,
  IconTrash,
  IconPencil,
  IconBook2,
  IconLoader2,
  IconChevronLeft,
  IconChevronRight,
  IconPlayerPlay,
  IconPlayerStop,
  IconUpload,
  IconCheck,
  IconX,
} from "@tabler/icons-react";
import { toast } from "@/lib/toast";
import {
  AdminPageHeader,
  AdminPageShell,
} from "@/components/contact-center/WorkspacePageLayout";
import { AiAssistantsSectionPage } from "@/components/assistants/AiAssistantsSectionNav";

const MAX_ITEMS = 100;

function createEmptyItem() {
  return { type: "alias", text: "", alias: "", phoneme: "", alphabet: "ipa" };
}

export default function PronunciationDictionariesPage() {
  const [dicts, setDicts] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [items, setItems] = useState([createEmptyItem()]);

  // Preview state — voice picker
  const [previewProviders, setPreviewProviders] = useState([]);
  const [previewProvider, setPreviewProvider] = useState("");
  const [previewModel, setPreviewModel] = useState("");
  const [previewVoiceName, setPreviewVoiceName] = useState("");
  const [previewSpeed, setPreviewSpeed] = useState(1.0);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [playingIdx, setPlayingIdx] = useState(null);
  const previewAudioRef = useRef(null);

  // voice.id from /api/tts/voices is already the full voice string (e.g. "Telnyx.Ultra.Amber")
  // — do NOT prepend provider/model again
  const previewVoiceString = previewVoiceName || "";

  // Upload / sheet mode state
  const [sheetMode, setSheetMode] = useState("manual"); // "manual" | "upload"
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadItems, setUploadItems] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Fetch voices when sheet opens
  useEffect(() => {
    if (!sheetOpen) return;
    setLoadingVoices(true);
    fetch("/api/tts/voices")
      .then((r) => r.json())
      .then((data) => {
        const providers = data?.providers || [];
        setPreviewProviders(providers);
        // Set default provider to Telnyx if available
        const telnyx = providers.find((p) => p.id === "Telnyx");
        if (telnyx && !previewProvider) {
          setPreviewProvider("Telnyx");
          const firstModel = telnyx.models?.[0];
          if (firstModel) {
            setPreviewModel(firstModel.id || "");
            const firstVoice = firstModel.voices?.[0];
            if (firstVoice) setPreviewVoiceName(firstVoice.id || "");
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingVoices(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);

  const fetchDicts = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/ai/pronunciation-dictionaries?page=${p}&page_size=20`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load dictionaries");
      const records = data.data || [];
      setDicts(records);
      setTotal(data.meta?.total_results ?? records.length);
      setTotalPages(data.meta?.total_pages ?? 1);
    } catch (err) {
      toast.error(err.message || "Failed to load dictionaries");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDicts(page);
  }, [fetchDicts, page]);

  // Open sheet for create
  function openCreate() {
    setEditingId(null);
    setName("");
    setItems([createEmptyItem()]);
    setSheetMode("manual");
    setUploadFile(null);
    setUploadItems([]);
    setSheetOpen(true);
  }

  // Open sheet for edit — fetch full record
  async function openEdit(id) {
    setEditingId(id);
    setName("");
    setItems([]);
    setSheetMode("manual");
    setUploadFile(null);
    setUploadItems([]);
    setSheetOpen(true);
    try {
      const res = await fetch(`/api/ai/pronunciation-dictionaries/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load dictionary");
      const record = data.data || data;
      setName(record.name || "");
      const loaded = (record.items || []).map((it) => ({
        type: it.type || "alias",
        text: it.text || "",
        alias: it.alias || "",
        phoneme: it.phoneme || "",
        alphabet: it.alphabet || "ipa",
      }));
      setItems(loaded.length > 0 ? loaded : [createEmptyItem()]);
    } catch (err) {
      toast.error(err.message || "Failed to load dictionary");
      setSheetOpen(false);
    }
  }

  function closeSheet() {
    setSheetOpen(false);
    setEditingId(null);
    setSheetMode("manual");
    setUploadFile(null);
    setUploadItems([]);
    setPlayingIdx(null);
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = "";
    }
  }

  // Item helpers
  function addItem() {
    if (items.length >= MAX_ITEMS) return;
    setItems((prev) => [...prev, createEmptyItem()]);
  }

  function removeItem(idx) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateItem(idx, field, value) {
    setItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    );
  }

  // TTS preview per item
  const playItem = async (item, idx) => {
    if (playingIdx === idx) {
      // Stop
      previewAudioRef.current?.pause();
      if (previewAudioRef.current) previewAudioRef.current.src = "";
      setPlayingIdx(null);
      return;
    }
    if (!previewVoiceString) {
      toast.error("Select a preview voice first");
      return;
    }
    const textToSpeak = item.type === "alias" ? item.alias || item.text : item.text;
    if (!textToSpeak?.trim()) {
      toast.error("No text to preview");
      return;
    }
    setPlayingIdx(idx);
    try {
      const res = await fetch("/api/tts/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textToSpeak,
          voice: previewVoiceString,
          voice_speed: previewSpeed,
        }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (previewAudioRef.current) {
        previewAudioRef.current.src = url;
        previewAudioRef.current.onended = () => setPlayingIdx(null);
        previewAudioRef.current.play();
      }
    } catch (err) {
      toast.error("Failed to preview pronunciation");
      setPlayingIdx(null);
    }
  };

  // File upload / parsing
  const handleFileSelect = (file) => {
    if (file.size > 1024 * 1024) {
      toast.error("File too large (max 1 MB)");
      return;
    }
    setUploadFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      const ext = file.name.split(".").pop().toLowerCase();
      let parsed = [];
      if (ext === "txt") {
        // Format: word=alias or word (one per line)
        parsed = content
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [text, alias] = line.split("=").map((s) => s.trim());
            return alias
              ? { type: "alias", text: text.slice(0, 200), alias: alias.slice(0, 500) }
              : { type: "alias", text: text.slice(0, 200), alias: text.slice(0, 500) };
          })
          .filter((item) => item.text);
      } else if (ext === "pls" || ext === "xml") {
        // Parse PLS XML: <lexeme><grapheme>word</grapheme><phoneme alphabet="ipa">phoneme</phoneme></lexeme>
        // or <lexeme><grapheme>word</grapheme><alias>alias</alias></lexeme>
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, "text/xml");
        const lexemes = doc.querySelectorAll("lexeme");
        lexemes.forEach((lex) => {
          const grapheme = lex.querySelector("grapheme")?.textContent?.trim();
          const phonemeEl = lex.querySelector("phoneme");
          const aliasEl = lex.querySelector("alias");
          if (!grapheme) return;
          if (aliasEl) {
            parsed.push({
              type: "alias",
              text: grapheme.slice(0, 200),
              alias: aliasEl.textContent.trim().slice(0, 500),
            });
          } else if (phonemeEl) {
            const alphabet = phonemeEl.getAttribute("alphabet") || "ipa";
            parsed.push({
              type: "phoneme",
              text: grapheme.slice(0, 200),
              phoneme: phonemeEl.textContent.trim().slice(0, 500),
              alphabet,
            });
          }
        });
      }
      parsed = parsed.slice(0, 100); // max 100
      setUploadItems(parsed);
      if (parsed.length > 0) {
        setItems(parsed); // pre-populate items so user can review
        toast.success(`Parsed ${parsed.length} items from file`);
      } else {
        toast.error("No items parsed from file");
      }
    };
    reader.readAsText(file);
  };

  // Build API payload from item state
  function buildItemsPayload() {
    return items.map((it) => {
      if (it.type === "alias") {
        return { type: "alias", text: it.text, alias: it.alias };
      }
      return {
        type: "phoneme",
        text: it.text,
        phoneme: it.phoneme,
        alphabet: it.alphabet,
      };
    });
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error("Dictionary name is required");
      return;
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), items: buildItemsPayload() };
      const url = editingId
        ? `/api/ai/pronunciation-dictionaries/${editingId}`
        : "/api/ai/pronunciation-dictionaries";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.errors?.[0]?.detail || data.error || "Save failed"
        );
      }
      toast.success(
        editingId
          ? "Dictionary updated successfully"
          : "Dictionary created successfully"
      );
      closeSheet();
      fetchDicts(page);
    } catch (err) {
      toast.error(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/ai/pronunciation-dictionaries/${deleteTarget.id}`,
        { method: "DELETE" }
      );
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed");
      }
      toast.success(`"${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      // If we deleted the last item on this page and not page 1, go back
      if (dicts.length === 1 && page > 1) {
        setPage((p) => p - 1);
      } else {
        fetchDicts(page);
      }
    } catch (err) {
      toast.error(err.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  function formatDate(str) {
    if (!str) return "—";
    try {
      return new Date(str).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return str;
    }
  }

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Pronunciation Dictionaries"
        icon={IconBook2}
        badges={<Badge variant="secondary">{total} dictionaries</Badge>}
        actions={(
          <Button onClick={openCreate} className="shrink-0">
            <IconPlus className="size-4" />
            New Dictionary
          </Button>
        )}
      />
      <AiAssistantsSectionPage activeId="pronunciation-dictionaries">
      <div className="space-y-6">

      {/* Table */}
      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
            <IconLoader2 className="size-5 animate-spin" />
            <span>Loading dictionaries…</span>
          </div>
        ) : dicts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
            <IconBook2 className="size-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium text-muted-foreground">
                No pronunciation dictionaries yet
              </p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Create one to control how your AI assistant pronounces words.
              </p>
            </div>
            <Button onClick={openCreate} variant="outline" className="mt-2">
              <IconPlus className="size-4 mr-1.5" />
              New Dictionary
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dicts.map((dict) => (
                <TableRow key={dict.id}>
                  <TableCell className="font-medium">{dict.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {dict.items?.length ?? 0} item
                      {(dict.items?.length ?? 0) !== 1 ? "s" : ""}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {dict.version ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(dict.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center text-telnyx-green"
                        title="Edit dictionary"
                        aria-label={`Edit ${dict.name}`}
                        onClick={() => openEdit(dict.id)}
                      >
                        <IconPencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center text-red-500 hover:text-red-700"
                        title="Delete dictionary"
                        aria-label={`Delete ${dict.name}`}
                        onClick={() => setDeleteTarget(dict)}
                      >
                        <IconTrash className="size-4" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {total} total
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <IconChevronLeft className="size-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
              <IconChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Create / Edit Sheet */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0 bg-background"
        >
          <SheetHeader className="px-6 py-4 border-b border-border">
            <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
              <IconBook2 className="size-5" />
              {editingId ? "Edit Dictionary" : "New Pronunciation Dictionary"}
            </SheetTitle>
            <p className="text-xs text-muted-foreground">
              {editingId
                ? "Update the name and pronunciation items."
                : "Create a new dictionary to control how specific words are pronounced."}
            </p>

            {/* Tab switcher — only for new dictionaries */}
            {!editingId && (
              <div className="flex gap-1 mt-2">
                <Button
                  size="sm"
                  variant={sheetMode === "manual" ? "default" : "outline"}
                  onClick={() => setSheetMode("manual")}
                >
                  Add manually
                </Button>
                <Button
                  size="sm"
                  variant={sheetMode === "upload" ? "default" : "outline"}
                  onClick={() => setSheetMode("upload")}
                >
                  <IconUpload className="size-3.5 mr-1.5" />
                  Upload file
                </Button>
              </div>
            )}
          </SheetHeader>

          {/* Fixed cards + scrollable items */}
          <div className="flex flex-col min-h-0 flex-1">

            {/* Card 1: Dictionary Details — always visible */}
            <Card className="mx-5 mt-4 mb-2 border-muted-foreground/20 shrink-0">
              <CardContent className="p-4 space-y-3">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Dictionary Details
                </div>
                <div className="grid gap-2">
                  <Label className="text-sm">
                    Dictionary Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, 255))}
                    placeholder="e.g., Technical Terms"
                    maxLength={255}
                  />
                  <p className="text-xs text-muted-foreground text-right">
                    {name.length}/255
                  </p>
                </div>

              </CardContent>
            </Card>

            {/* Card 2: Preview Settings — always visible */}
            <Card className="mx-5 mb-2 border-muted-foreground/20 shrink-0">
              <CardContent className="p-4 space-y-3">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Preview Settings
                </div>
                {loadingVoices ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                    <IconLoader2 className="size-3.5 animate-spin" />
                    Loading voices…
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {/* Provider */}
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Provider</Label>
                      <Select
                        value={previewProvider}
                        onValueChange={(val) => {
                          setPreviewProvider(val);
                          setPreviewModel("");
                          setPreviewVoiceName("");
                        }}
                      >
                        <SelectTrigger className="text-sm">
                          <SelectValue placeholder="Select provider…" />
                        </SelectTrigger>
                        <SelectContent>
                          {previewProviders.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* Model — only show if provider has multiple models */}
                    {previewProvider && (() => {
                      const prov = previewProviders.find((p) => p.id === previewProvider);
                      const models = (prov?.models || []).filter((m) => m.id);
                      if (models.length <= 1) return null;
                      return (
                        <div className="grid gap-1.5">
                          <Label className="text-xs">Model</Label>
                          <Select
                            value={previewModel}
                            onValueChange={(val) => {
                              setPreviewModel(val);
                              setPreviewVoiceName("");
                            }}
                          >
                            <SelectTrigger className="text-sm">
                              <SelectValue placeholder="Select model…" />
                            </SelectTrigger>
                            <SelectContent>
                              {models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {m.name || m.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })()}
                    {/* Voice */}
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Voice</Label>
                      <Select
                        value={previewVoiceName}
                        onValueChange={setPreviewVoiceName}
                      >
                        <SelectTrigger className="text-sm">
                          <SelectValue placeholder="Select voice…" />
                        </SelectTrigger>
                        <SelectContent>
                          {(() => {
                            const prov = previewProviders.find((p) => p.id === previewProvider);
                            const models = prov?.models || [];
                            const modelEntry = previewModel
                              ? models.find((m) => m.id === previewModel)
                              : models[0];
                            return (modelEntry?.voices || []).map((v) => (
                              <SelectItem key={v.id} value={v.id}>
                                {v.name || v.id}
                              </SelectItem>
                            ));
                          })()}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* Speed */}
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Speed</Label>
                      <Input
                        type="number"
                        min={0.25}
                        max={2.0}
                        step={0.05}
                        className="text-sm"
                        value={previewSpeed}
                        onChange={(e) => setPreviewSpeed(parseFloat(e.target.value) || 1.0)}
                      />
                    </div>
                  </div>
                )}
                {previewVoiceString && (
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    <span className="text-muted-foreground/60">Voice ID: </span>{previewVoiceString}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Card 3: Items — scrollable */}
            <div className="flex-1 overflow-y-auto min-h-0">
              <Card className="mx-5 mb-4 border-muted-foreground/20">
                <CardContent className="p-4 space-y-3">
                <audio ref={previewAudioRef} className="hidden" />

                {/* Section: Items (manual mode) or Upload (upload mode) */}
                {sheetMode === "upload" ? (
                  <div className="space-y-4">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Upload File
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Supported formats: plain text (.txt) and PLS/XML (.pls, .xml). Maximum file size 1 MB.
                    </p>
                    <div
                      className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                        dragOver
                          ? "border-telnyx-green bg-telnyx-green/5"
                          : "border-border hover:border-muted-foreground/50"
                      }`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const file = e.dataTransfer.files[0];
                        if (file) handleFileSelect(file);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <IconUpload className="size-8 mx-auto mb-2 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">
                        {uploadFile
                          ? uploadFile.name
                          : "Drag and drop a file here, or click to browse"}
                      </p>
                      <p className="text-xs text-muted-foreground/60 mt-1">
                        Supports .txt, .pls, and .xml files up to 1 MB
                      </p>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".txt,.pls,.xml"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files[0];
                          if (file) handleFileSelect(file);
                        }}
                      />
                    </div>
                    {uploadFile && (
                      <div className="flex items-center gap-2 text-sm">
                        <IconCheck className="size-4 text-telnyx-green" />
                        <span>{uploadFile.name}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 ml-auto"
                          onClick={() => {
                            setUploadFile(null);
                            setUploadItems([]);
                          }}
                        >
                          <IconX className="size-3.5" />
                        </Button>
                      </div>
                    )}
                    {uploadItems.length > 0 && (
                      <p className="text-xs text-telnyx-green">
                        ✓ Parsed {uploadItems.length} items from file
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Section: Items */}
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-2">
                      Pronunciation Items
                      <span className="ml-2 normal-case font-normal text-muted-foreground">
                        {items.length}/{MAX_ITEMS}
                      </span>
                    </div>

                    {items.length === 0 && (
                      <p className="text-sm text-muted-foreground py-4 text-center border rounded-lg">
                        No items yet. Click &quot;Add item&quot; to get started.
                      </p>
                    )}

                    <div className="space-y-3">
                      {items.map((item, idx) => (
                        <div
                          key={idx}
                          className="border rounded-lg p-3 space-y-3 bg-muted/20"
                        >
                          <div className="flex items-center gap-2">
                            {/* Play button */}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={`h-8 w-8 shrink-0 ${
                                playingIdx === idx
                                  ? "text-destructive hover:text-destructive"
                                  : "text-telnyx-green hover:text-telnyx-green"
                              }`}
                              onClick={() => playItem(item, idx)}
                            >
                              {playingIdx === idx ? (
                                <IconPlayerStop className="size-3.5" />
                              ) : (
                                <IconPlayerPlay className="size-3.5" />
                              )}
                            </Button>

                            <div className="w-32 shrink-0">
                              <Select
                                value={item.type}
                                onValueChange={(v) => updateItem(idx, "type", v)}
                              >
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="alias">Alias</SelectItem>
                                  <SelectItem value="phoneme">Phoneme</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <Input
                              className="h-8 text-sm flex-1"
                              placeholder="Word to match (max 200)"
                              value={item.text}
                              onChange={(e) =>
                                updateItem(idx, "text", e.target.value.slice(0, 200))
                              }
                              maxLength={200}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => removeItem(idx)}
                            >
                              <IconTrash className="size-3.5" />
                            </Button>
                          </div>
                          {item.type === "alias" ? (
                            <div className="grid gap-1.5">
                              <Label className="text-xs text-muted-foreground">Alias (spoken replacement)</Label>
                              <Input
                                className="h-8 text-sm"
                                placeholder="Replacement text (max 500)"
                                value={item.alias}
                                onChange={(e) =>
                                  updateItem(idx, "alias", e.target.value.slice(0, 500))
                                }
                                maxLength={500}
                              />
                            </div>
                          ) : (
                            <div className="grid gap-1.5">
                              <Label className="text-xs text-muted-foreground">Phoneme notation</Label>
                              <div className="flex gap-2">
                                <Input
                                  className="h-8 text-sm flex-1"
                                  placeholder="Phoneme notation (max 500)"
                                  value={item.phoneme}
                                  onChange={(e) =>
                                    updateItem(idx, "phoneme", e.target.value.slice(0, 500))
                                  }
                                  maxLength={500}
                                />
                                <div className="w-28 shrink-0">
                                  <Select
                                    value={item.alphabet}
                                    onValueChange={(v) => updateItem(idx, "alphabet", v)}
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="ipa">IPA</SelectItem>
                                      <SelectItem value="x-sampa">X-SAMPA</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addItem}
                      disabled={items.length >= MAX_ITEMS}
                      className="w-full"
                    >
                      <IconPlus className="size-3.5 mr-1.5" />
                      Add item
                    </Button>
                  </>
                )}

                </CardContent>
              </Card>
            </div>
          </div>

          {/* Fixed Footer */}
          <SheetFooter className="px-6 py-4 border-t border-border flex flex-row justify-end gap-2">
            <Button variant="outline" onClick={closeSheet} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <IconLoader2 className="size-4 mr-1.5 animate-spin" />}
              {editingId ? "Save Changes" : "Create Dictionary"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete Confirm Dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Dictionary</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong>&quot;{deleteTarget?.name}&quot;</strong>? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && (
                <IconLoader2 className="size-4 mr-1.5 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
      </AiAssistantsSectionPage>
    </AdminPageShell>
  );
}

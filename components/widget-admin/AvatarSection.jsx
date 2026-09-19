"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle, Images, Loader2, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ANAM_AVATAR_PROVIDER,
  AVATAR_EXPAND_FULLSCREEN,
  AVATAR_EXPAND_MODAL,
  AVATAR_MODAL_WIDTH_OPTIONS,
  HEYGEN_AVATAR_PROVIDER,
} from "@/lib/ai/avatar-config.mjs";

export const AVATAR_PROVIDER_OPTIONS = {
  [HEYGEN_AVATAR_PROVIDER]: {
    label: "HeyGen LiveAvatar",
    shortLabel: "HeyGen",
    catalogLabel: "Public HeyGen avatars",
    envName: "LIVEAVATAR_API_KEY",
    description: "HeyGen LiveAvatar in LITE mode with synchronized avatar audio and video.",
  },
  [ANAM_AVATAR_PROVIDER]: {
    label: "Anam",
    shortLabel: "Anam",
    catalogLabel: "Anam avatar library",
    envName: "ANAM_API_KEY",
    description: "Anam audio passthrough with real-time lip sync driven by the Telnyx assistant.",
  },
};

// Value of the "Expanded view" select: fullscreen or modal:<width>.
export const AVATAR_EXPAND_OPTIONS = [
  { value: AVATAR_EXPAND_FULLSCREEN, label: "Full screen" },
  ...AVATAR_MODAL_WIDTH_OPTIONS.map((percent) => ({
    value: `${AVATAR_EXPAND_MODAL}:${percent}`,
    label: `Modal · ${percent}% of the screen width`,
  })),
];

export function expandOptionValue(avatar) {
  return avatar.expandMode === AVATAR_EXPAND_MODAL
    ? `${AVATAR_EXPAND_MODAL}:${avatar.modalWidthPercent}`
    : AVATAR_EXPAND_FULLSCREEN;
}

export function expandOptionToConfig(value) {
  const [mode, width] = String(value).split(":");
  return mode === AVATAR_EXPAND_MODAL
    ? { expandMode: AVATAR_EXPAND_MODAL, modalWidthPercent: Number(width) }
    : { expandMode: AVATAR_EXPAND_FULLSCREEN };
}

function previewUrlFor(avatar, displayFormat) {
  if (!avatar) return "";
  return (
    (displayFormat === "landscape" ? avatar.landscapePreviewUrl : avatar.portraitPreviewUrl) ||
    avatar.previewUrl ||
    ""
  );
}

// Catalog fields copied into the widget draft when an avatar is chosen; the
// runtime never talks to the provider catalog.
export function avatarSelection(avatar, displayFormat) {
  return {
    avatarId: avatar.id,
    name: avatar.name || "",
    previewUrl: previewUrlFor(avatar, displayFormat),
    portraitPreviewUrl: avatar.portraitPreviewUrl || "",
    landscapePreviewUrl: avatar.landscapePreviewUrl || "",
    avatarModel: avatar.avatarModel || "",
  };
}

// Uses the provider catalog (admin route) to let a widget administrator pick
// the avatar shown in the voice panel of this widget revision.
export default function AvatarPicker({ avatar, onChange }) {
  const provider = avatar.provider || HEYGEN_AVATAR_PROVIDER;
  const providerInfo = AVATAR_PROVIDER_OPTIONS[provider] || AVATAR_PROVIDER_OPTIONS[HEYGEN_AVATAR_PROVIDER];
  // The catalog is keyed by provider: a mismatch means it is still loading.
  const [catalog, setCatalog] = useState({ provider: null, featured: [], all: [], configured: true, error: null });
  const loading = catalog.provider !== provider;
  const error = catalog.error;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [identity, setIdentity] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/widgets/avatars/${provider}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `Failed to load ${providerInfo.shortLabel} avatars`);
        const featured = Array.isArray(data.avatars) ? data.avatars.slice(0, 5) : [];
        setCatalog({ provider, featured, all: Array.isArray(data.allAvatars) ? data.allAvatars : featured, configured: Boolean(data.configured), error: null });
      })
      .catch((catalogError) => {
        if (catalogError.name === "AbortError") return;
        setCatalog({ provider, featured: [], all: [], configured: true, error: catalogError.message || `Failed to load ${providerInfo.shortLabel} avatars` });
      });
    return () => controller.abort();
  }, [provider, providerInfo.shortLabel]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const entry of catalog.all) {
      const name = entry.identityName || String(entry.name || "Avatar").split(/\s+/)[0];
      const key = name.toLowerCase();
      const group = map.get(key) || { key, name, avatars: [] };
      group.avatars.push(entry);
      map.set(key, group);
    }
    return Array.from(map.values());
  }, [catalog.all]);
  const selectedGroup = identity ? groups.find((group) => group.key === identity) || null : null;
  const query = search.trim().toLowerCase();
  const visibleGroups = groups.filter((group) => !query || group.name.toLowerCase().includes(query) || group.avatars.some((entry) => entry.name.toLowerCase().includes(query)));
  const visibleLooks = (selectedGroup?.avatars || []).filter((entry) => !query || entry.name.toLowerCase().includes(query));
  const selected = catalog.all.find((entry) => entry.id === avatar.avatarId) || null;
  const customSelection = selected && !catalog.featured.some((entry) => entry.id === selected.id) ? selected : null;

  const choose = (entry) => {
    onChange({ ...avatar, ...avatarSelection(entry, avatar.displayFormat) });
    setPickerOpen(false);
  };

  return (
    <div className="grid gap-3">
      {!catalog.configured && !loading && (
        <Alert className="border-amber-500/40 bg-amber-500/10">
          <AlertTriangle className="size-4 text-amber-600" />
          <AlertDescription className="text-xs">
            {providerInfo.envName} is not configured on the server. Publishing with the avatar enabled will fail until the key is available.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-between">
        <Label>{providerInfo.catalogLabel}</Label>
        {loading && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Loading…</span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {catalog.featured.map((entry) => {
          const isSelected = avatar.avatarId === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              className={`rounded-lg border p-1 text-left transition ${isSelected ? "border-emerald-500 ring-2 ring-emerald-500/20" : "border-border hover:border-emerald-500/50"}`}
              onClick={() => choose(entry)}
              aria-pressed={isSelected}
            >
              {/* Preview URLs are normalized by the catalog route. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={entry.previewUrl} alt={entry.name} className="aspect-[4/3] w-full rounded-md bg-zinc-950 object-cover" />
              <span className="mt-1 block truncate px-0.5 text-[11px] font-medium">{entry.name}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`group rounded-lg border p-1 text-left transition ${customSelection ? "border-emerald-500 ring-2 ring-emerald-500/20" : "border-dashed border-border hover:border-emerald-500/50"}`}
          onClick={() => { setSearch(""); setIdentity(null); setPickerOpen(true); }}
          disabled={loading || !catalog.all.length}
          aria-label={`Browse all ${providerInfo.shortLabel} avatars`}
          aria-pressed={Boolean(customSelection)}
        >
          <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-muted">
            {customSelection ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={customSelection.previewUrl} alt={customSelection.name} className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center bg-gradient-to-br from-emerald-500/15 via-muted to-cyan-500/10">
                <Images className="size-6 text-emerald-600 transition-transform group-hover:scale-105" />
              </div>
            )}
            <span className="absolute inset-x-1 bottom-1 rounded bg-black/60 px-1 py-0.5 text-center text-[10px] font-medium text-white backdrop-blur-sm">Browse all</span>
          </div>
          <span className="mt-1 block truncate px-0.5 text-[11px] font-medium">{customSelection?.name || `${catalog.all.length || ""} looks`.trim()}</span>
        </button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {avatar.avatarId ? `Selected: ${avatar.name || avatar.avatarId}` : "No avatar selected yet."} · {providerInfo.description}
      </p>

      <Dialog open={pickerOpen} onOpenChange={(open) => { setPickerOpen(open); if (!open) { setSearch(""); setIdentity(null); } }}>
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-5xl">
          <DialogHeader>
            <div className="flex items-center gap-3">
              {selectedGroup && (
                <Button type="button" variant="outline" size="icon" className="size-8 shrink-0 rounded-full" onClick={() => { setIdentity(null); setSearch(""); }} aria-label="Back to avatar gallery">
                  <ArrowLeft className="size-4" />
                </Button>
              )}
              <div>
                <DialogTitle>{selectedGroup ? selectedGroup.name : `Choose a ${providerInfo.shortLabel} avatar`}</DialogTitle>
                <DialogDescription className="mt-1">
                  {selectedGroup ? `${selectedGroup.avatars.length} available looks` : "Browse compatible real-time avatars and open a person to see every available look."}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={selectedGroup ? "Search looks…" : "Search avatars…"} className="pl-9" autoFocus />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {!selectedGroup ? (
              visibleGroups.length ? (
                <div className="grid grid-cols-1 gap-4 pb-1 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleGroups.map((group) => {
                    const previews = group.avatars.slice(0, 3);
                    return (
                      <button key={group.key} type="button" className="overflow-hidden rounded-2xl border bg-card text-left transition hover:border-emerald-500/60 hover:shadow-md" onClick={() => { setIdentity(group.key); setSearch(""); }}>
                        <div className="flex aspect-[16/9] gap-0.5 overflow-hidden bg-muted">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={previews[0].previewUrl} alt="" className={`h-full object-cover ${previews.length > 1 ? "w-2/3" : "w-full"}`} />
                          {previews.length > 1 && (
                            <div className="grid h-full w-1/3 grid-rows-2 gap-0.5">
                              {previews.slice(1).map((entry) => (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img key={entry.id} src={entry.previewUrl} alt="" className="size-full object-cover" />
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-3 p-3">
                          <span className="font-semibold">{group.name}</span>
                          <span className="text-xs text-muted-foreground">{group.avatars.length} looks</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">No avatars match “{search}”.</p>
              )
            ) : visibleLooks.length ? (
              <div className="grid grid-cols-2 gap-3 pb-1 sm:grid-cols-3 lg:grid-cols-4">
                {visibleLooks.map((entry) => {
                  const isSelected = avatar.avatarId === entry.id;
                  return (
                    <button key={entry.id} type="button" className={`overflow-hidden rounded-xl border bg-card text-left transition ${isSelected ? "border-emerald-500 ring-2 ring-emerald-500/20" : "hover:border-emerald-500/60"}`} onClick={() => choose(entry)} aria-pressed={isSelected}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={entry.previewUrl} alt={entry.name} className="aspect-[4/3] w-full bg-zinc-950 object-cover" />
                      <div className="flex items-center justify-between gap-2 p-2.5">
                        <span className="truncate text-xs font-medium">{entry.name}</span>
                        {isSelected && <CheckCircle className="size-4 shrink-0 text-emerald-500" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">No looks match “{search}”.</p>
            )}
          </div>
          <DialogFooter className="border-t pt-3 sm:justify-between">
            <span className="text-xs text-muted-foreground">Only avatars available to {providerInfo.shortLabel} on this account are shown.</span>
            <DialogClose asChild><Button type="button" variant="outline">Close</Button></DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

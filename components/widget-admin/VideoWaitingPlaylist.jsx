"use client";

import { useEffect, useRef, useState } from "react";

import { ArrowDown, ArrowUp, Film, Link2, Loader2, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Widget Studio → Video → Waiting playlist. Items come from an HTTPS link or
// from the video media library (uploaded mp4/webm, served with byte ranges by
// /api/video/media/[id]); the order is the playback order.
const MAX_ITEMS = 10;
const formatBytes = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function VideoWaitingPlaylist({ items, onChange }) {
  const [library, setLibrary] = useState(null);
  const [link, setLink] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  // The latest playlist, for an upload that finishes after the user kept editing.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const linkValid = /^https:\/\/\S+$/i.test(link.trim());

  const loadLibrary = async () => {
    try {
      const response = await fetch("/api/admin/widgets/video-media", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load the media library");
      // Keep files uploaded while this request was in flight.
      setLibrary((current) => { const fetched = body.media || []; const known = new Set(fetched.map((media) => media.id)); return [...(current || []).filter((media) => !known.has(media.id)), ...fetched]; });
    } catch (loadError) { setError(loadError.message); setLibrary((current) => current || []); }
  };
  useEffect(() => { void loadLibrary(); }, []);

  const update = (next) => onChange(next.slice(0, MAX_ITEMS));
  const addLink = () => { if (!linkValid || items.length >= MAX_ITEMS) return; update([...items, { source: "url", url: link.trim(), mediaId: "", label: "" }]); setLink(""); };
  // The playlist label is capped by the widget schema (120 characters).
  const addFromLibrary = (media) => { const current = itemsRef.current; if (current.length >= MAX_ITEMS) return; update([...current, { source: "library", url: "", mediaId: media.id, label: String(media.name || "").slice(0, 120) }]); };
  const move = (index, delta) => { const next = [...items]; const [item] = next.splice(index, 1); next.splice(index + delta, 0, item); update(next); };
  const upload = async (file) => {
    if (!file) return;
    setUploading(true); setError("");
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/api/admin/widgets/video-media", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Upload failed");
      setLibrary((current) => [body.media, ...(current || [])]);
      addFromLibrary(body.media);
    } catch (uploadError) { setError(uploadError.message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const remove = async (media) => {
    if (!window.confirm(`Delete "${media.name}" from the media library? Widgets using it will skip the file.`)) return;
    setError("");
    try {
      const response = await fetch(`/api/admin/widgets/video-media/${media.id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Unable to delete the video");
      setLibrary((current) => (current || []).filter((item) => item.id !== media.id));
    } catch (deleteError) { setError(deleteError.message); }
  };
  const libraryName = (id) => library?.find((media) => media.id === id)?.name;

  return (
    <div className="grid min-w-0 gap-4 overflow-hidden">
      <div className="grid min-w-0 gap-1.5">
        <Label>Playlist ({items.length}/{MAX_ITEMS})</Label>
        {items.length === 0 && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No videos yet: the visitor sees the queue message over their own preview while waiting.</p>}
        <ol className="grid min-w-0 gap-1.5" data-testid="video-waiting-playlist">
          {items.map((item, index) => (
            <li key={`${item.source}-${item.mediaId || item.url}-${index}`} className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border px-2 py-1.5 text-xs">
              <span className="w-5 shrink-0 text-center text-muted-foreground">{index + 1}</span>
              {item.source === "library" ? <Film className="size-3.5 shrink-0 text-muted-foreground" /> : <Link2 className="size-3.5 shrink-0 text-muted-foreground" />}
              {(() => { const text = item.source === "library" ? (item.label || libraryName(item.mediaId) || item.mediaId) : item.url; return <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>; })()}
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === 0} aria-label="Move up" onClick={() => move(index, -1)}><ArrowUp className="size-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === items.length - 1} aria-label="Move down" onClick={() => move(index, 1)}><ArrowDown className="size-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" className="size-7 text-destructive" aria-label="Remove from playlist" onClick={() => update(items.filter((_, i) => i !== index))}><Trash2 className="size-3.5" /></Button>
            </li>
          ))}
        </ol>
      </div>
      <div className="grid min-w-0 gap-1.5">
        <Label>Add a link</Label>
        <div className="flex gap-2">
          <Input value={link} placeholder="https://cdn.example.com/promo.mp4" onChange={(event) => setLink(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addLink(); } }} />
          <Button type="button" variant="outline" disabled={!linkValid || items.length >= MAX_ITEMS} onClick={addLink}>Add</Button>
        </div>
      </div>
      <div className="grid min-w-0 gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label>Media library</Label>
          <input ref={fileRef} type="file" accept="video/mp4,video/webm" className="hidden" onChange={(event) => void upload(event.target.files?.[0])} />
          <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}Upload video</Button>
        </div>
        <p className="text-xs text-muted-foreground">mp4 or webm up to 64 MB, stored with the Contact Center and streamed to the widget.</p>
        {library === null ? <p className="text-xs text-muted-foreground">Loading…</p> : library.length === 0 ? <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No uploaded videos yet.</p> : (
          <ul className="grid min-w-0 gap-1.5" data-testid="video-media-library">
            {library.map((media) => (
              <li key={media.id} className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border px-2 py-1.5 text-xs">
                <Film className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={media.name}>{media.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(media.byteSize)}</span>
                <Button type="button" variant="outline" size="sm" className="h-7" disabled={items.length >= MAX_ITEMS} onClick={() => addFromLibrary(media)}>Add</Button>
                <Button type="button" variant="ghost" size="icon" className="size-7 text-destructive" aria-label="Delete from library" onClick={() => void remove(media)}><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

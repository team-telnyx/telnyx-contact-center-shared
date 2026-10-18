"use client";
import { useEffect, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";

export function useAiChatImages() {
  const [images, setImages] = useState([]);
  const urls = useRef(new Set());
  useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL(url); }, []);
  function remove(id) { setImages(current => current.filter(image => { if (id && image.id !== id) return true; URL.revokeObjectURL(image.url); urls.current.delete(image.url); return false; })); }
  function add(files) {
    const entries = Array.from(files);
    if (images.length + entries.length > 3) throw new Error("Attach at most 3 images.");
    if (entries.some(file => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1048576)) throw new Error("Choose PNG, JPEG or WebP images up to 5 MiB each.");
    setImages(current => [...current, ...entries.map(file => { const url = URL.createObjectURL(file); urls.current.add(url); return { file, url, id: crypto.randomUUID() }; })]);
  }
  function clear({ preserveObjectUrls = false } = {}) {
    // Studio messages keep their local images until the widget unmounts.
    if (preserveObjectUrls) setImages([]);
    else remove();
  }
  return { images, add, remove, clear };
}
export function AiChatImageDrafts({ images, remove, busy }) {
  if (!images.length) return null;
  return <div className="mb-2 flex flex-wrap gap-2 pt-1" aria-label="Images to send">
    {images.map(image => <div key={image.id} className="relative rounded-lg border p-1" style={{ borderColor: "#cbd5e1", backgroundColor: "#f8fafc" }}>
      {/* Local object URLs are removed when sent, removed or unmounted. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt={image.file.name} className="h-14 w-16 rounded object-cover" />
      <button type="button" disabled={busy} aria-label={`Remove ${image.file.name}`} title={`Remove ${image.file.name}`} className="absolute -right-1 -top-1 grid size-6 place-items-center rounded-full border-2 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50" style={{ backgroundColor: "#0f172a", color: "#ffffff", borderColor: "#ffffff" }} onClick={() => remove(image.id)}><IconX size={14} stroke={2.5} aria-hidden="true" /></button>
    </div>)}
  </div>;
}

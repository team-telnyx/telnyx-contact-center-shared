"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Skeleton } from "@/components/ui/skeleton";
import { documentPreviewKind, documentPreviewUrl } from "@/lib/documents/preview-types.mjs";
import { documentPreviewCopy } from "@/lib/documents/preview-copy.mjs";
import { wordPreviewFrame } from "@/lib/documents/word-preview-frame.mjs";

function PreviewSkeleton({ copy, table }) {
  return <div role="status" aria-label={copy.loading} className="absolute inset-0 z-10 overflow-hidden bg-white p-6">
    <span className="sr-only">{copy.loading}</span>
    <Skeleton className="mb-6 h-7 w-1/3 bg-slate-200" />
    {Array.from({ length: 8 }, (_, row) => <div key={row} className={table ? "mb-3 grid grid-cols-4 gap-3" : "mb-4"}>
      {Array.from({ length: table ? 4 : 1 }, (_, col) => <Skeleton key={col} className={`h-4 bg-slate-200 ${!table && row % 3 === 2 ? "w-3/4" : "w-full"}`} />)}
    </div>)}
  </div>;
}

function columnLabel(index) {
  let label = "";
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label;
  return label;
}

function TablePreview({ data, copy }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const [page, setPage] = useState(0);
  const sheet = data.sheets[sheetIndex];
  const rows = sheet?.rows || [];
  const pageSize = 100;
  const columns = Math.max(0, ...rows.map(row => row.length));
  return <div className="flex h-full min-h-0 flex-col" dir="ltr">
    {data.sheets.length > 1 && <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-2 text-xs">
      <label className="flex min-w-0 items-center gap-2">{copy.sheet}
        <select className="min-w-0 max-w-64 rounded border border-slate-300 bg-white px-2 py-1" value={sheetIndex} onChange={event => { setSheetIndex(Number(event.target.value)); setPage(0); }}>
          {data.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}
        </select>
      </label>
    </div>}
    {data.truncated && <p role="note" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">{copy.limited}</p>}
    {!rows.length ? <p className="p-8 text-center text-sm text-slate-500">{copy.empty}</p> : <>
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} aria-label={sheet.name}>
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <caption className="sr-only">{sheet.name}</caption>
          <thead className="sticky top-0 z-10 bg-slate-100"><tr>
            <th scope="col" className="sticky left-0 z-20 min-w-12 border-b border-r border-slate-200 bg-slate-100 p-2">#</th>
            {Array.from({ length: columns }, (_, col) => <th scope="col" key={col} className="min-w-32 border-b border-r border-slate-200 p-2 font-medium">{columnLabel(col)}</th>)}
          </tr></thead>
          <tbody>{rows.slice(page * pageSize, (page + 1) * pageSize).map((row, index) => <tr key={index}>
            <th scope="row" className="sticky left-0 border-b border-r border-slate-200 bg-slate-50 p-2 text-right font-normal text-slate-500">{page * pageSize + index + 1}</th>
            {Array.from({ length: columns }, (_, col) => <td key={col} className="min-w-32 max-w-96 whitespace-pre-wrap break-words border-b border-r border-slate-200 px-3 py-2 align-top">{row[col] || ""}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2 text-xs">
        <span>{copy.rows} {page * pageSize + 1}–{Math.min((page + 1) * pageSize, rows.length)} {copy.of} {rows.length}</span>
        {rows.length > pageSize && <div className="flex gap-2">
          <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40" disabled={!page} onClick={() => setPage(page - 1)}>{copy.previous}</button>
          <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40" disabled={(page + 1) * pageSize >= rows.length} onClick={() => setPage(page + 1)}>{copy.next}</button>
        </div>}
      </div>
    </>}
  </div>;
}

function MarkdownLink({ href, children }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-700 underline underline-offset-2">{children}</a> : <span>{children}</span>;
}

function MarkdownPreview({ text }) {
  return <article dir="auto" className="break-words p-6 text-sm leading-7 [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:my-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:my-3 [&_h4]:font-semibold [&_h5]:my-3 [&_h5]:font-semibold [&_h6]:my-3 [&_h6]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:ps-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:ps-6 [&_blockquote]:my-4 [&_blockquote]:border-s-4 [&_blockquote]:border-slate-300 [&_blockquote]:ps-4 [&_blockquote]:text-slate-600 [&_pre]:my-4 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-slate-100 [&_pre]:p-4 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_hr]:my-6">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
      // Attachments have no relative resource base. Only explicit safe external
      // links are clickable; images never fetch automatically when opened.
      urlTransform={url => /^(https?:\/\/|mailto:)/i.test(url) ? url : ""}
      components={{
        a: MarkdownLink,
        img: ({ src, alt }) => <MarkdownLink href={src}>{alt || src}</MarkdownLink>,
        table: ({ children }) => <div className="my-4 overflow-auto"><table className="w-full border-collapse text-start">{children}</table></div>,
        th: ({ children }) => <th className="border border-slate-300 bg-slate-100 px-3 py-2 text-start font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-slate-300 px-3 py-2 align-top">{children}</td>,
      }}>{text}</ReactMarkdown>
  </article>;
}

function LoadedPreview({ url, name, kind, copy }) {
  const [state, setState] = useState(kind === "pdf" ? { pdfUrl: url } : null);
  const [rendered, setRendered] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (kind === "pdf") return;
    const controller = new AbortController();
    let objectUrl;
    const timer = setTimeout(() => controller.abort(new DOMException("Preview timeout", "TimeoutError")), 45000);
    (async () => {
      try {
        const response = await fetch(documentPreviewUrl(url, kind), { signal: controller.signal, credentials: "same-origin" });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error([401, 403, 404].includes(response.status) ? "access_denied" : result.error || "conversion_failed");
        }
        if (response.headers.get("content-type")?.startsWith("application/pdf")) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ pdfUrl: objectUrl });
        } else {
          const data = await response.json();
          if (!controller.signal.aborted) {
            if (!["html", "text", "markdown", "table"].includes(data.kind)) throw new Error("conversion_failed");
            setState({ data });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setState({ error: copy[error.message] || copy.conversion_failed });
        else if (controller.signal.reason?.name === "TimeoutError") setState({ error: copy.preview_timeout });
      } finally { clearTimeout(timer); }
    })();
    return () => { clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, kind, copy, attempt]);
  const loading = !state || ((state.pdfUrl || (state.data?.kind === "html" && !state.data.empty)) && !rendered);
  return <div className="relative h-full min-h-48 w-full overflow-hidden bg-white text-slate-900" aria-busy={Boolean(loading)}>
    {loading && <PreviewSkeleton copy={copy} table={kind === "spreadsheet" || kind === "csv"} />}
    {state?.error && <div role="alert" className="grid h-full content-center justify-items-center gap-4 p-8 text-center text-sm">
      <p>{state.error}</p>
      <button type="button" className="rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50" onClick={() => { setState(kind === "pdf" ? { pdfUrl: url } : null); setRendered(false); setAttempt(attempt + 1); }}>{copy.retry}</button>
    </div>}
    {state?.pdfUrl && <iframe key={attempt} src={state.pdfUrl} title={name} className="h-full w-full border-0 bg-white" onLoad={() => setRendered(true)} onError={() => setState({ error: copy.conversion_failed })} />}
    {state?.data?.kind === "html" && <div className="flex h-full min-h-0 flex-col">
      <p role="note" className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs">{state.data.omitted ? copy.word_omitted : copy.word_simplified}</p>
      {state.data.empty ? <p className="p-8 text-center text-sm text-slate-500">{copy.empty}</p>
        : <iframe key={attempt} title={name} sandbox="" referrerPolicy="no-referrer" srcDoc={wordPreviewFrame(state.data.html)}
          className="min-h-0 w-full flex-1 border-0 bg-white" onLoad={() => setRendered(true)} onError={() => setState({ error: copy.conversion_failed })} />}
    </div>}
    {state?.data?.kind === "table" && <TablePreview data={state.data} copy={copy} />}
    {["text", "markdown"].includes(state?.data?.kind) && <div className="h-full overflow-auto" tabIndex={0} aria-label={name}>
      {state.data.simplified && <p role="note" className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs">{copy.word_text}</p>}
      {state.data.truncated && <p role="note" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">{copy.limited}</p>}
      {state.data.text ? state.data.kind === "markdown" ? <MarkdownPreview text={state.data.text} /> : <pre dir="auto" className="whitespace-pre-wrap break-words p-6 font-mono text-sm leading-6">{state.data.text}</pre> : <p className="p-8 text-center text-sm text-slate-500">{copy.empty}</p>}
    </div>}
  </div>;
}

export default function DocumentPreview({ url, name, mimeType, locale = "en-US" }) {
  const kind = documentPreviewKind(mimeType, name);
  return <LoadedPreview key={`${url}:${kind}`} url={url} name={name} kind={kind} copy={documentPreviewCopy(locale)} />;
}

// Only sanitized server HTML may be passed here. The frame has an opaque origin
// and a network-denying CSP; the stylesheet is owned by CC, never the document.
export function wordPreviewFrame(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;padding:24px;color:#0f172a;background:white;font:14px/1.7 system-ui,sans-serif;overflow-wrap:anywhere}p{margin:0 0 1em}h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.2em 0 .6em}table{border-collapse:collapse;max-width:100%;margin:1em 0}th,td{border:1px solid #cbd5e1;padding:8px 12px;vertical-align:top}th{background:#f1f5f9}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f1f5f9;padding:12px}blockquote{margin-inline:0;border-inline-start:3px solid #cbd5e1;padding-inline-start:16px}a{color:#1d4ed8}li>p{margin:.25em 0}hr{border:0;border-top:1px solid #cbd5e1}
  </style></head><body><article dir="auto">${html}</article></body></html>`;
}

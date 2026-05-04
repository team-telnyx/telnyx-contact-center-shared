const ALLOWED_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "DIV",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "I",
  "LI",
  "OL",
  "P",
  "SPAN",
  "STRONG",
  "U",
  "UL",
]);

const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "UL", "OL", "LI", "BLOCKQUOTE"]);

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function unwrapElement(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function sanitizeElement(element) {
  for (const child of Array.from(element.children)) sanitizeElement(child);

  if (!ALLOWED_TAGS.has(element.tagName)) {
    unwrapElement(element);
    return;
  }

  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value || "";

    if (element.tagName === "A" && name === "href" && /^https?:\/\//i.test(value)) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
      continue;
    }

    if (name === "style" && BLOCK_TAGS.has(element.tagName)) {
      const align = value.match(/text-align\s*:\s*(left|center|right|justify)/i)?.[1]?.toLowerCase();
      if (align) {
        element.setAttribute("style", `text-align: ${align};`);
        continue;
      }
    }

    element.removeAttribute(attr.name);
  }
}

export function sanitizeRichTextHtml(value = "") {
  const source = String(value || "");
  if (!source.trim()) return "";

  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return escapeHtml(source).replace(/\n/g, "<br />");
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${source}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  sanitizeElement(root);
  return root.innerHTML;
}

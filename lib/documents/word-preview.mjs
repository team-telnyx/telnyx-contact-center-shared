import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import sanitizeHtml from "sanitize-html";
import yauzl from "yauzl";
import { imageSize } from "image-size";
import { Parser } from "htmlparser2";
import { CFB } from "xlsx";
import { PREVIEW_LIMITS } from "./parse-preview.mjs";

// Run only in the disposable preview worker. No filenames, URLs or application
// secrets are passed to the parsers; all input is the authorized attachment.
export const WORD_PREVIEW_LIMITS = Object.freeze({
  entries: 2000, entryBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024,
  htmlBytes: 16 * 1024 * 1024, nodes: 20000, depth: 64,
  imageBytes: 5 * 1024 * 1024, totalImageBytes: 10 * 1024 * 1024,
  imagePixels: 16_000_000, totalImagePixels: 32_000_000, images: 100,
});
const invalid = () => Object.assign(new Error("invalid_document"), { code: "invalid_document" });
const complex = () => Object.assign(new Error("preview_too_complex"), { code: "preview_too_complex" });
const OLE_SIGNATURE = "d0cf11e0a1b11ae1";

// Count actual streamed output, not only untrusted sizes in ZIP metadata.
// Nothing is extracted to disk. Reject duplicate/ambiguous paths before the
// second parser opens the same archive, and reject XML entity declarations.
export function validateDocxArchive(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(invalid());
      let settled = false, total = 0, count = 0;
      const paths = new Set();
      const requiredXml = new Map();
      const stop = error => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error?.code === "preview_too_complex" ? error : invalid());
      };
      zip.on("error", stop);
      zip.on("end", () => {
        if (settled) return;
        const main = requiredXml.get("word/document.xml") || "";
        const types = requiredXml.get("[Content_Types].xml") || "";
        if (!paths.has("_rels/.rels") || !/<(?:[\w.-]+:)?document[\s>]/.test(main)
          || !/(schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|purl\.oclc\.org\/ooxml\/wordprocessingml\/main)/.test(main)
          || !types.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")) return stop(invalid());
        settled = true;
        resolve();
      });
      zip.on("entry", entry => {
        void (async () => {
          if (++count > WORD_PREVIEW_LIMITS.entries || entry.uncompressedSize > WORD_PREVIEW_LIMITS.entryBytes) throw complex();
          const path = entry.fileName;
          if (paths.has(path) || /[\\\x00-\x1f:]/.test(path) || path.startsWith("/")
            || path.split("/").some(part => part === ".." || part === ".")
            || (entry.generalPurposeBitFlag & 1) || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw invalid();
          paths.add(path);
          const xml = /\.(xml|rels)$/i.test(path);
          const chunks = [];
          let size = 0;
          if (!path.endsWith("/")) {
            const stream = await new Promise((res, rej) => zip.openReadStream(entry, (err, value) => err ? rej(err) : res(value)));
            for await (const chunk of stream) {
              size += chunk.length;
              total += chunk.length;
              if (size > WORD_PREVIEW_LIMITS.entryBytes || total > WORD_PREVIEW_LIMITS.expandedBytes) throw complex();
              if (xml) chunks.push(chunk);
            }
          }
          if (xml) {
            const text = Buffer.concat(chunks).toString("utf8");
            // Accept UTF-8 OOXML. Reject alternative encodings and DTDs, rather
            // than allowing a declaration to evade inspection via NUL bytes.
            if (text.includes("\0") || /<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) throw invalid();
            if (path === "word/document.xml" || path === "[Content_Types].xml") requiredXml.set(path, text);
          }
          if (!settled) zip.readEntry();
        })().catch(stop);
      });
      zip.readEntry();
    });
  });
}

const TAGS = ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "u", "s", "sub", "sup", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "blockquote", "pre", "code", "a", "img"];
const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote", "pre"]);

export function sanitizeWordHtml(html, images = new Set()) {
  if (Buffer.byteLength(html) > WORD_PREVIEW_LIMITS.htmlBytes) throw complex();
  let nodes = 0, depth = 0;
  return sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: { a: ["href", "id"], ol: ["start"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], img: ["src", "alt"] },
    allowedSchemes: [], allowedSchemesByTag: { img: ["data"] }, allowProtocolRelative: false,
    parseStyleAttributes: false,
    onOpenTag() { if (++nodes > WORD_PREVIEW_LIMITS.nodes || ++depth > WORD_PREVIEW_LIMITS.depth) throw complex(); },
    onCloseTag() { depth--; },
    transformTags: {
      a: (tagName, attributes) => ({ tagName, attribs: {
        ...(/^#[A-Za-z0-9_.:-]{1,200}$/.test(attributes.href || "") ? { href: attributes.href } : {}),
        ...(/^[A-Za-z0-9_.:-]{1,200}$/.test(attributes.id || "") ? { id: attributes.id } : {}),
      } }),
      img: (tagName, attributes) => ({ tagName, attribs: images.has(attributes.src) ? { src: attributes.src, alt: (attributes.alt || "").slice(0,1000) } : {} }),
      "*": (tagName, attributes) => {
        const attribs = { ...attributes };
        for (const key of ["colspan", "rowspan", "start"]) {
          if (key in attribs && (!/^\d{1,4}$/.test(attribs[key]) || Number(attribs[key]) < 1 || Number(attribs[key]) > 1000)) delete attribs[key];
        }
        return { tagName, attribs };
      },
    },
    exclusiveFilter: frame => frame.tag === "img" && !frame.attribs.src,
  });
}

function htmlText(html) {
  let text = "";
  new Parser({
    ontext: value => { text += value; },
    onclosetag: tag => { if (BLOCKS.has(tag) || tag === "br") text += "\n"; else if (tag === "td" || tag === "th") text += "\t"; },
  }, { decodeEntities: true }).end(html);
  return text;
}

export async function parseWordPreview(bytes) {
  if (!bytes.length || bytes.length > PREVIEW_LIMITS.inputBytes) throw invalid();
  if (bytes.subarray(0, 8).toString("hex") === OLE_SIGNATURE) {
    const container = CFB.read(bytes, { type: "buffer" });
    const word = CFB.find(container, "WordDocument")?.content;
    if (CFB.find(container, "EncryptedPackage") || !word || word.length < 32
      || word.readUInt16LE(0) !== 0xa5ec || (word.readUInt16LE(10) & 0x8100)) throw invalid();
    const document = await new WordExtractor().extract(bytes);
    // Main body only: do not expose review comments, deleted text, headers or
    // hidden review metadata through an accidental concatenation of all parts.
    const text = document.getBody({ filterUnicode: false });
    return { kind: "text", format: "doc", simplified: true, text: text.slice(0, PREVIEW_LIMITS.textCharacters), truncated: text.length > PREVIEW_LIMITS.textCharacters };
  }
  if (bytes.subarray(0, 4).toString("hex") !== "504b0304") throw invalid();
  await validateDocxArchive(bytes);
  const images = new Set();
  let imageBytes = 0, pixels = 0, imageCount = 0, omitted = false, imageError;
  const result = await mammoth.convertToHtml({ buffer: bytes }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false,
    styleMap: ["u => u", "comment-reference => !"], idPrefix: "word-preview-",
    convertImage: mammoth.images.imgElement(async image => {
      try {
        const data = await image.readAsBuffer();
        const size = imageSize(data);
        const mime = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[size.type];
        if (!mime) { omitted = true; return {}; }
        imageBytes += data.length;
        pixels += size.width * size.height;
        if (++imageCount > WORD_PREVIEW_LIMITS.images || data.length > WORD_PREVIEW_LIMITS.imageBytes
          || imageBytes > WORD_PREVIEW_LIMITS.totalImageBytes || !size.width || !size.height
          || size.width * size.height > WORD_PREVIEW_LIMITS.imagePixels || pixels > WORD_PREVIEW_LIMITS.totalImagePixels) throw complex();
        const src = `data:${mime};base64,${data.toString("base64")}`;
        images.add(src);
        return { src };
      } catch (error) {
        // Mammoth recovers image errors. Preserve our hard budget failures so
        // they cannot be swallowed into a seemingly successful partial preview.
        if (error.code === "preview_too_complex") imageError = error;
        omitted = true;
        return {};
      }
    }),
  });
  if (imageError) throw imageError;
  const html = sanitizeWordHtml(result.value, images);
  const text = htmlText(html);
  return { kind: "html", format: "docx", version: 1, html, text: text.slice(0, PREVIEW_LIMITS.textCharacters),
    textTruncated: text.length > PREVIEW_LIMITS.textCharacters,
    empty: !text.trim() && !images.size, simplified: true, truncated: false,
    omitted: omitted || result.messages.length > 0 };
}

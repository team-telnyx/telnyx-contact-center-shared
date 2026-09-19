import JSZip from "jszip";

export const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const PNG_PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxkAAAAASUVORK5CYII=", "base64");
export const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

export async function docxFixture({ body = paragraph("Hello &amp; goodbye — Zażółć gęślą jaźń"), relationships = "", files = {}, styles = "", numbering = "", main } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rMain" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", main || `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`);
  if (styles) zip.file("word/styles.xml", styles);
  if (numbering) zip.file("word/numbering.xml", numbering);
  for (const [path, bytes] of Object.entries(files)) zip.file(path, bytes);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export const imageRun = id => `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Sample image" descr="Embedded sample"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
export const imageRelationship = (id, target, external = false) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;

export function richDocxFixture() {
  return docxFixture({
    body: '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Alliance sample document</w:t></w:r></w:p>'
      + '<w:p><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/></w:rPr><w:t>Important details</w:t></w:r></w:p>'
      + paragraph("Order 00123 — Zażółć gęślą jaźń — مرحبا — שלום")
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested item</w:t></w:r></w:p>'
      + `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${paragraph("Merged heading")}</w:tc></w:tr><w:tr><w:tc>${paragraph("Item")}</w:tc><w:tc>${paragraph("42.50")}</w:tc></w:tr></w:tbl>`
      + imageRun("rImage")
      + '<w:p><w:ins><w:r><w:t>Accepted insertion</w:t></w:r></w:ins><w:del><w:r><w:delText>DELETED PRIVATE NOTE</w:delText></w:r></w:del></w:p>',
    relationships: imageRelationship("rImage", "media/image.png"),
    files: { "word/media/image.png": PNG_PIXEL },
    styles: `<w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>`,
    numbering: `<w:numbering xmlns:w="${WORD_NS}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  });
}

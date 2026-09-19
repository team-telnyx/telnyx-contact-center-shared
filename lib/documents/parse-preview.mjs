import * as XLSX from "xlsx";
import Papa from "papaparse";

export const PREVIEW_LIMITS = {
  inputBytes: 20 * 1024 * 1024,
  rows: 1000,
  columns: 100,
  sheets: 20,
  textCharacters: 200000,
  cellCharacters: 4000,
  tableCharacters: 1000000,
};

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // Uploaded text is validated as UTF-8. Reject corrupt data instead of silently
  // showing replacement characters or guessing an ambiguous legacy code page.
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function parseDocumentPreview(bytes, kind) {
  if (!bytes.length || bytes.length > PREVIEW_LIMITS.inputBytes) throw new Error("size");
  let remainingCharacters = PREVIEW_LIMITS.tableCharacters;
  function limitedCell(value, sheet) {
    const text = String(value ?? "");
    const limit = Math.min(PREVIEW_LIMITS.cellCharacters, remainingCharacters);
    if (text.length > limit) sheet.truncated = true;
    remainingCharacters -= Math.min(text.length, limit);
    return text.slice(0, limit);
  }

  if (kind === "text" || kind === "markdown") {
    const text = decodeText(bytes);
    return { kind, text: text.slice(0, PREVIEW_LIMITS.textCharacters), truncated: text.length > PREVIEW_LIMITS.textCharacters };
  }
  if (kind === "csv") {
    const parsed = Papa.parse(decodeText(bytes), { preview: PREVIEW_LIMITS.rows + 1, skipEmptyLines: "greedy", dynamicTyping: false });
    // A one-column CSV may legitimately have no detectable delimiter.
    if (parsed.errors.some(error => error.type === "Quotes")) throw new Error("invalid");
    const sheet = { name: "CSV", rows: [], truncated: Boolean(parsed.meta.truncated) || parsed.data.length > PREVIEW_LIMITS.rows };
    for (const row of parsed.data.slice(0, PREVIEW_LIMITS.rows)) {
      if (remainingCharacters <= 0) { sheet.truncated = true; break; }
      if (row.length > PREVIEW_LIMITS.columns) sheet.truncated = true;
      sheet.rows.push(row.slice(0, PREVIEW_LIMITS.columns).map(value => limitedCell(value, sheet)));
    }
    return { kind: "table", sheets: [sheet], truncated: sheet.truncated };
  }
  if (kind !== "spreadsheet") throw new Error("unsupported");
  // SheetJS also accepts arbitrary text as a workbook. Only admit actual Excel
  // containers here, including encrypted containers (which the parser rejects).
  const signature = Buffer.from(bytes.subarray(0, 8)).toString("hex");
  if (!signature.startsWith("504b0304") && signature !== "d0cf11e0a1b11ae1") throw new Error("invalid");
  const workbook = XLSX.read(bytes, { type: "buffer", sheetRows: PREVIEW_LIMITS.rows + 1, cellHTML: false, cellFormula: true, cellText: true, bookVBA: false, dense: true });
  const names = workbook.SheetNames.filter((_, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden);
  const sheets = [];
  let truncated = names.length > PREVIEW_LIMITS.sheets;
  for (const name of names.slice(0, PREVIEW_LIMITS.sheets)) {
    if (remainingCharacters <= 0) { truncated = true; break; }
    const source = workbook.Sheets[name];
    const sheet = { name, rows: [], truncated: false };
    if (source["!ref"]) {
      const range = XLSX.utils.decode_range(source["!ref"]);
      const fullRange = XLSX.utils.decode_range(source["!fullref"] || source["!ref"]);
      const lastRow = Math.min(range.e.r, PREVIEW_LIMITS.rows - 1);
      const lastColumn = Math.min(range.e.c, PREVIEW_LIMITS.columns - 1);
      sheet.truncated = fullRange.e.r >= PREVIEW_LIMITS.rows || fullRange.e.c >= PREVIEW_LIMITS.columns;
      for (let r = 0; r <= lastRow; r++) {
        if (remainingCharacters <= 0) { sheet.truncated = true; break; }
        const row = [];
        for (let c = 0; c <= lastColumn; c++) {
          const cell = source["!data"]?.[r]?.[c] || source[XLSX.utils.encode_cell({ r, c })];
          const value = cell?.v == null ? (cell?.f ? `=${cell.f}` : "") : XLSX.utils.format_cell(cell);
          row.push(limitedCell(value, sheet));
        }
        sheet.rows.push(row);
      }
    }
    truncated ||= sheet.truncated;
    sheets.push(sheet);
  }
  return { kind: "table", sheets, truncated };
}

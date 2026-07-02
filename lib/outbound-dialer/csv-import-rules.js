export const CSV_FILTER_OPERATORS = [
  { value: "any", label: "No filter", needsValue: false },
  { value: "is", label: "Is", needsValue: true },
  { value: "is_not", label: "Is not", needsValue: true },
  { value: "contains", label: "Contains", needsValue: true },
  { value: "does_not_contain", label: "Does not contain", needsValue: true },
  { value: "starts_with", label: "Starts with", needsValue: true },
  { value: "ends_with", label: "Ends with", needsValue: true },
  { value: "is_empty", label: "Is empty", needsValue: false },
  { value: "is_not_empty", label: "Is not empty", needsValue: false },
];

const VALID_OPERATORS = new Set(CSV_FILTER_OPERATORS.map((operator) => operator.value));
const VALUELESS_OPERATORS = new Set(CSV_FILTER_OPERATORS.filter((operator) => !operator.needsValue).map((operator) => operator.value));

function comparable(value) {
  return String(value ?? "").trim().toLowerCase();
}

function rawValue(value) {
  return String(value ?? "").trim();
}

function filterMatches(record, column, filter) {
  const operator = VALID_OPERATORS.has(filter?.operator) ? filter.operator : "any";
  if (operator === "any") return true;
  const value = comparable(record?.[column]);
  const expected = comparable(filter?.value);
  if (!VALUELESS_OPERATORS.has(operator) && expected === "") return true;
  if (operator === "is") return value === expected;
  if (operator === "is_not") return value !== expected;
  if (operator === "contains") return value.includes(expected);
  if (operator === "does_not_contain") return !value.includes(expected);
  if (operator === "starts_with") return value.startsWith(expected);
  if (operator === "ends_with") return value.endsWith(expected);
  if (operator === "is_empty") return value === "";
  if (operator === "is_not_empty") return value !== "";
  return true;
}

export function normalizeCsvImportRules(headers = [], settings = {}) {
  const headerSet = new Set(headers);
  const noDuplicateColumns = (Array.isArray(settings.no_duplicate_columns) ? settings.no_duplicate_columns : settings.noDuplicateColumns || [])
    .map((column) => String(column || "").trim())
    .filter((column, index, all) => headerSet.has(column) && all.indexOf(column) === index);
  const rawFilters = settings.column_filters || settings.columnFilters || {};
  const columnFilters = Object.fromEntries(Object.entries(rawFilters)
    .map(([column, filter]) => {
      const operator = VALID_OPERATORS.has(filter?.operator) ? filter.operator : "any";
      return [String(column || "").trim(), { operator, value: rawValue(filter?.value) }];
    })
    .filter(([column, filter]) => headerSet.has(column) && filter.operator !== "any"));
  return { no_duplicate_columns: noDuplicateColumns, column_filters: columnFilters };
}

export function applyCsvImportRules(records = [], headers = [], settings = {}) {
  const { no_duplicate_columns: noDuplicateColumns, column_filters: columnFilters } = normalizeCsvImportRules(headers, settings);
  const filteredRecords = (Array.isArray(records) ? records : []).filter((record) => Object.entries(columnFilters).every(([column, filter]) => filterMatches(record, column, filter)));
  if (!noDuplicateColumns.length) return { records: filteredRecords, filteredRows: filteredRecords.length, duplicateRowsRejected: 0, noDuplicateColumns, columnFilters };
  const seen = new Set();
  const deduped = [];
  let duplicateRowsRejected = 0;
  for (const record of filteredRecords) {
    const key = noDuplicateColumns.map((column) => comparable(record?.[column])).join("\u001f");
    if (seen.has(key)) { duplicateRowsRejected += 1; continue; }
    seen.add(key);
    deduped.push(record);
  }
  return { records: deduped, filteredRows: filteredRecords.length, duplicateRowsRejected, noDuplicateColumns, columnFilters };
}

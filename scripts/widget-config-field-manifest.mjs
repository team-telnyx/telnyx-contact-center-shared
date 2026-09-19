// Walk the Genesys Integrations widgetConfigSchema (zod) and emit a leaf-field manifest.
// Usage: node scripts/widget-config-field-manifest.mjs [source-config.js] > widget-field-manifest.tsv
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourcePath = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../../telnyx-genesys-integrations/lib/widgets/config.js", import.meta.url));
const { widgetConfigSchema, DEFAULT_WIDGET_CONFIG } = await import(pathToFileURL(sourcePath).href);

function def(s) {
  return s?._def ?? s?._zod?.def ?? null;
}
function typeName(s) {
  const d = def(s);
  if (!d) return "unknown";
  return d.typeName ?? d.type ?? "unknown";
}
function unwrap(s) {
  // unwrap optional/nullable/default/effects/catch/readonly/branded
  let cur = s;
  const wrappers = [];
  for (let i = 0; i < 10; i++) {
    const d = def(cur);
    if (!d) break;
    const t = typeName(cur);
    if (["ZodOptional", "optional"].includes(t)) { wrappers.push("optional"); cur = d.innerType; continue; }
    if (["ZodNullable", "nullable"].includes(t)) { wrappers.push("nullable"); cur = d.innerType; continue; }
    if (["ZodDefault", "default"].includes(t)) {
      const dv = typeof d.defaultValue === "function" ? d.defaultValue() : d.defaultValue;
      wrappers.push("default=" + JSON.stringify(dv));
      cur = d.innerType; continue;
    }
    if (["ZodCatch", "catch"].includes(t)) { wrappers.push("catch"); cur = d.innerType; continue; }
    if (["ZodReadonly", "readonly"].includes(t)) { cur = d.innerType; continue; }
    if (["ZodBranded", "branded"].includes(t)) { cur = d.type; continue; }
    if (["ZodEffects", "effects", "pipe", "ZodPipeline"].includes(t)) {
      wrappers.push(t === "ZodEffects" ? "effects" : "pipe");
      cur = d.schema ?? d.in ?? d.innerType; continue;
    }
    break;
  }
  return { schema: cur, wrappers };
}
function describe(s) {
  const d = def(s);
  const t = typeName(s);
  const checks = (d?.checks ?? []).map((c) => {
    const k = c.kind ?? c._zod?.def?.check ?? c.def?.check ?? "?";
    const v = c.value ?? c.minimum ?? c.maximum ?? c._zod?.def?.value ?? c._zod?.def?.minimum ?? c._zod?.def?.maximum ?? c.def?.value ?? "";
    return v === "" || v === undefined ? k : `${k}:${v}`;
  });
  if (["ZodEnum", "enum"].includes(t)) {
    const vals = d.values ?? (d.entries ? Object.keys(d.entries) : []);
    return `enum[${vals.join("|")}]`;
  }
  if (["ZodLiteral", "literal"].includes(t)) return `literal(${JSON.stringify(d.value ?? d.values)})`;
  if (["ZodString", "string"].includes(t)) return `string${checks.length ? "{" + checks.join(",") + "}" : ""}`;
  if (["ZodNumber", "number"].includes(t)) return `number${checks.length ? "{" + checks.join(",") + "}" : ""}`;
  if (["ZodBoolean", "boolean"].includes(t)) return "boolean";
  if (["ZodUnion", "union"].includes(t)) return "union[" + (d.options ?? []).map((o) => describe(unwrap(o).schema)).join(" | ") + "]";
  if (["ZodRecord", "record"].includes(t)) return "record<" + describe(unwrap(d.valueType).schema) + ">";
  return t;
}
function getDefault(path) {
  let cur = DEFAULT_WIDGET_CONFIG;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
const rows = [];
function walk(s, path) {
  const { schema, wrappers } = unwrap(s);
  const t = typeName(schema);
  const d = def(schema);
  if (["ZodObject", "object"].includes(t)) {
    const shape = typeof d.shape === "function" ? d.shape() : d.shape;
    for (const [k, v] of Object.entries(shape)) walk(v, [...path, k]);
    return;
  }
  if (["ZodArray", "array"].includes(t)) {
    const inner = unwrap(d.element ?? d.type).schema;
    const it = typeName(inner);
    if (["ZodObject", "object"].includes(it)) {
      rows.push([path.join("."), "array<object>", wrappers.join(","), JSON.stringify(getDefault(path))]);
      const shape = typeof def(inner).shape === "function" ? def(inner).shape() : def(inner).shape;
      for (const [k, v] of Object.entries(shape)) walk(v, [...path, "[]", k]);
    } else {
      rows.push([path.join("."), `array<${describe(inner)}>`, wrappers.join(","), JSON.stringify(getDefault(path))]);
    }
    return;
  }
  if (["ZodRecord", "record"].includes(t)) {
    rows.push([path.join("."), describe(schema), wrappers.join(","), JSON.stringify(getDefault(path))]);
    const inner = unwrap(d.valueType).schema;
    if (["ZodObject", "object"].includes(typeName(inner))) {
      const shape = typeof def(inner).shape === "function" ? def(inner).shape() : def(inner).shape;
      for (const [k, v] of Object.entries(shape)) walk(v, [...path, "{key}", k]);
    }
    return;
  }
  const dflt = path.includes("[]") || path.includes("{key}") ? undefined : getDefault(path);
  rows.push([path.join("."), describe(schema), wrappers.join(","), dflt === undefined ? "" : JSON.stringify(dflt)]);
}
walk(widgetConfigSchema, []);
console.log(["path", "type", "wrappers", "default"].join("\t"));
for (const r of rows) console.log(r.join("\t"));
console.error(`leaf rows: ${rows.length}`);

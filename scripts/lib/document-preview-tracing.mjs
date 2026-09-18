import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";

// Preview workers load their parsers outside Next's module graph. Include the
// actually resolved dependency closure, including nested package versions.
export function documentPreviewTracingIncludes(root = process.cwd()) {
  const seen = new Set();
  function visit(name, from, optional = false) {
    let entry;
    try {
      try { entry = from.resolve(`${name}/package.json`); }
      catch { entry = from.resolve(name); }
    } catch (error) { if (optional && error.code === "MODULE_NOT_FOUND") return; throw error; }
    let directory = dirname(entry), metadata;
    while (true) {
      try {
        const candidate = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (candidate.name === name) { metadata = candidate; break; }
      } catch { /* Continue from an exported subdirectory to the package root. */ }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot trace document parser package: ${name}`);
      directory = parent;
    }
    if (seen.has(directory)) return;
    seen.add(directory);
    const childRequire = createRequire(join(directory, "package.json"));
    for (const dependency of Object.keys(metadata.dependencies || {})) visit(dependency, childRequire, dependency in (metadata.optionalDependencies || {}));
    for (const dependency of Object.keys(metadata.optionalDependencies || {})) visit(dependency, childRequire, true);
  }
  const rootRequire = createRequire(resolve(root, "package.json"));
  for (const name of ["xlsx", "papaparse", "mammoth", "word-extractor", "sanitize-html", "htmlparser2", "yauzl", "image-size"]) visit(name, rootRequire);
  return ["./lib/documents/**/*.mjs", ...[...seen].sort().map(path => `./${relative(root,path).replaceAll("\\", "/")}/**/*`)];
}

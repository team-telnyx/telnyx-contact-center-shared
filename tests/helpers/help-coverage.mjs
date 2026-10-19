import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import GithubSlugger from "github-slugger";
import { getHelpTopic } from "../../lib/help/help-registry.js";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const read = (name) => readFile(path.join(root, name), "utf8");

export async function filesBelow(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(name) : [name];
  }));
  return groups.flat().sort();
}

export function articleUrl(file) {
  return `/help/${file.replace(/^content\/help\//, "").replace(/\.mdx$/, "")}`
    .replace(/\/index$/, "");
}

export function sectionsOf(source) {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<HelpTopicContent helpId="([^"]+)"\s*\/>/g, (element, id) => {
    const topic = getHelpTopic(id);
    return topic ? [topic.summary, ...(topic.paragraphs || []), ...(topic.tips || [])].join("\n") : element;
  });
  // Ignore fenced examples so their headings cannot satisfy coverage.
  const text = body.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const slugger = new GithubSlugger();
  return new Map(headings.map((match, index) => {
    const title = match[2].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, "");
    const end = headings.slice(index + 1).find(next => next[1].length <= match[1].length)?.index ?? text.length;
    return [slugger.slug(title), text.slice(match.index + match[0].length, end).trim()];
  }));
}

export async function helpInventory() {
  const files = (await filesBelow("content/help")).filter(file => file.endsWith(".mdx"));
  const entries = await Promise.all(files.map(async file => {
    const source = await read(file);
    return [articleUrl(file), { file, source, sections: sectionsOf(source) }];
  }));
  const inventory = new Map(entries);
  if (inventory.size !== entries.length) throw new Error("Multiple Help files resolve to the same article URL");
  return inventory;
}

export function documentationErrors(inventory, hrefs) {
  const errors = [];
  for (const href of hrefs) {
    const [url, anchor] = href.split("#");
    const article = inventory.get(url);
    if (!article) errors.push(`Missing article: ${href}`);
    else if (article.source.replace(/^---\n[\s\S]*?\n---\n/, "").trim().length < 80) errors.push(`Empty or placeholder article: ${href}`);
    else if (anchor && !article.sections.has(anchor)) errors.push(`Missing section: ${href}`);
    else if (anchor && article.sections.get(anchor).length < 80) errors.push(`Empty or placeholder section: ${href}`);
  }
  return errors;
}

// Parse the actual JSX source without executing client modules or matching
// arbitrary labels in comments. Inventory growth must require documentation.
export async function literalRows(file, name) {
  const ast = parse(await read(file), { sourceType: "module", plugins: ["jsx"] });
  for (const item of ast.program.body) {
    const statement = item.type === "ExportNamedDeclaration" ? item.declaration : item;
    if (statement?.type !== "VariableDeclaration") continue;
    const declaration = statement.declarations.find(entry => entry.id.name === name);
    if (!declaration) continue;
    if (declaration.init.type !== "ArrayExpression") throw new Error(`${file}: ${name} is no longer an array; update its Help inventory reader`);
    return declaration.init.elements.map(element => {
      if (element.type !== "ObjectExpression") throw new Error(`${file}: unsupported ${name} entry`);
      return Object.fromEntries(element.properties
        .filter(property => property.type === "ObjectProperty" && property.value.type === "StringLiteral")
        .map(property => [property.key.name || property.key.value, property.value.value]));
    });
  }
  throw new Error(`${file}: missing inventory ${name}`);
}

export function tableRows(source) {
  return source.split("\n").filter(line => /^\|/.test(line)).map(line =>
    line.split("|").slice(1, -1).map(cell => cell.trim().replace(/\*\*/g, "")),
  );
}

// Legacy structural UI tests inspect source rather than rendering React. Resolve
// only localization calls to their English expressions; never rewrite business
// logic, CSS, identifiers, or imported modules. Browser tests verify translations.
import fs from 'node:fs';
import { readFile as read } from 'node:fs/promises';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
const traverse = traverseModule.default || traverseModule;
export function englishUiSource(source) {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript']
  });
  const edits = [];
  traverse(ast, {
    CallExpression(p) {
      if (p.node.callee.name !== 'tUi' || p.node.arguments[0]?.type !== 'StringLiteral') return;
      const [message, values] = p.node.arguments;
      let replacement = JSON.stringify(message.value);
      if (values?.type === 'ObjectExpression') {
        const bindings = Object.fromEntries(values.properties.filter(x => x.type === 'ObjectProperty').map(x => [x.key.name || x.key.value, source.slice(x.value.start, x.value.end)]));
        replacement = '`' + message.value.replaceAll('`', '\\`').replace(/\{(value\d+)\}/g, (match, key) => bindings[key] === undefined ? match : '${' + bindings[key] + '}') + '`';
      }
      let target = p.node;
      if (!values && p.parentPath.isJSXExpressionContainer()) {
        if (p.parentPath.parentPath.isJSXAttribute()) {
          target = p.parentPath.node;
        } else {
          target = p.parentPath.node;
          replacement = message.value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        }
      }
      edits.push({
        start: target.start,
        end: target.end,
        replacement
      });
      p.skip();
    }
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  return source;
}
function normalize(file, source) {
  return typeof source === 'string' && /\.[jt]sx$/.test(String(file)) ? englishUiSource(source) : source;
}
export async function readFile(file, ...options) {
  return normalize(file, await read(file, ...options));
}
export function readFileSync(file, ...options) {
  return normalize(file, fs.readFileSync(file, ...options));
}

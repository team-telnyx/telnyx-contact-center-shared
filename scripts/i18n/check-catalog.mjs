import fs from 'node:fs';
import path from 'node:path';
import { parse as parseMessage } from '@formatjs/icu-messageformat-parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { UI_LOCALES, messageId } from '../../lib/i18n/locales.mjs';
import { protectedTokens, isCodeExample } from '../../lib/i18n/catalogue-text.mjs';
const traverse = traverseModule.default || traverseModule;
const source = JSON.parse(fs.readFileSync('messages/source.json', 'utf8'));
const errors = [],
  report = [];
const glossary = JSON.parse(fs.readFileSync('messages/glossary.json', 'utf8'));
const editorial = JSON.parse(fs.readFileSync('messages/editorial-overrides.json', 'utf8')).translations;
const rendered = message => parseMessage(message).map(node => node.type === 0 ? node.value : node.type === 1 ? `{${node.value}}` : '').join('');
function argumentsOf(ast) {
  return ast.flatMap(node => node.type === 1 ? [node.value] : node.options ? Object.values(node.options).flatMap(x => argumentsOf(x.value)) : node.children ? argumentsOf(node.children) : []).sort();
}
const argumentsById = new Map();
for (const [id, {
  source: english, context
}] of Object.entries(source)) {
  if (messageId(english, context) !== id) errors.push(`Unstable ID ${id}`);
  argumentsById.set(id, [...english.matchAll(/\{(value\d+)\}/g)].map(m => m[1]).sort());
}
for (const {
  id: locale
} of UI_LOCALES) {
  const messages = JSON.parse(fs.readFileSync(`messages/${locale}.json`, 'utf8')).ui;
  let missing = 0;
  for (const [id, item] of Object.entries(source)) {
    const value = messages[id];
    if (typeof value !== 'string' || !value && item.source) {
      missing++;
      continue;
    }
    try {
      if (JSON.stringify(argumentsOf(parseMessage(value))) !== JSON.stringify(argumentsById.get(id))) errors.push(`${locale}: placeholders changed for ${id}`);
      const visible = rendered(value);
      if (JSON.stringify(protectedTokens(visible)) !== JSON.stringify(protectedTokens(item.source))) errors.push(`${locale}: technical example changed for ${id}`);
      if (isCodeExample(item.source) && visible !== item.source) errors.push(`${locale}: code example translated for ${id}`);
      if (visible.match(/^\s*/)[0] !== item.source.match(/^\s*/)[0] || visible.match(/\s*$/)[0] !== item.source.match(/\s*$/)[0]) errors.push(`${locale}: whitespace changed for ${id}`);
      if (locale === 'en-US' && rendered(value) !== item.source) errors.push(`${locale}: literal source changed for ${id}`);
    } catch (error) {
      errors.push(`${locale}: invalid ICU ${id}: ${error.message}`);
    }
  }
  if (locale !== 'en-US') for (const entry of glossary.entries) {
    const id = messageId(entry.source, entry.context);
    if (messages[id] && rendered(messages[id]) !== entry.translations[locale]) errors.push(`${locale}: glossary mismatch ${id} (${entry.source})`);
  }
  for (const [id, text] of Object.entries(editorial[locale] || {})) {
    if (!messages[id] || rendered(messages[id]) !== text) errors.push(`${locale}: editorial correction changed ${id}`);
  }
  if (missing) errors.push(`${locale}: ${missing} missing messages`);
  report.push({
    locale,
    messages: Object.keys(messages).length,
    missing
  });
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {
    withFileTypes: true
  })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['components/widget', 'components/i18n'].includes(file)) walk(file);
      continue;
    }
    if (!/\.[jt]sx$/.test(file)) continue;
    const ast = parse(fs.readFileSync(file, 'utf8'), {
      sourceType: 'module',
      plugins: ['jsx', 'typescript']
    });
    traverse(ast, {
      CallExpression(p) {
        if (p.node.callee.name !== 'tUi') return;
        const english = p.node.arguments[0]?.value;
        const context = p.node.arguments[2];
        if (context && context.type !== 'StringLiteral') errors.push(`${file}:${p.node.loc.start.line}: translation context must be a literal`);
        if (typeof english === 'string' && /[a-zA-Z]/.test(english) && !source[messageId(english, context?.value)]) errors.push(`${file}:${p.node.loc.start.line}: missing source ${english}`);
      }
    });
  }
}
walk('app');
walk('components');
console.log(JSON.stringify({
  sourceMessages: Object.keys(source).length,
  locales: report,
  errors: errors.slice(0, 30),
  errorCount: errors.length
}, null, 2));
if (errors.length) process.exitCode = 1;

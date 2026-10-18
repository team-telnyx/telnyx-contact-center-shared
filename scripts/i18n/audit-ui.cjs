// Audit rendering paths, not only catalogue completeness. Run after i18n:collect.
const fs = require('node:fs');
const path = require('node:path');
const traverse = require('@babel/traverse').default;
const { ast, resolve } = require('./source-analysis.cjs');
const displayAttributes = new Set([
  'title', 'label', 'description', 'subtitle', 'subTitle', 'hint', 'helper', 'helperText',
  'detail', 'emptyText', 'emptyMessage', 'emptyLabel', 'emptyTitle', 'emptyDescription',
  'loadingText', 'loadingLabel', 'errorText', 'buttonLabel', 'buttonText', 'placeholder',
  'aria-label', 'ariaLabel', 'alt', 'tooltip', 'caption', 'header', 'footer',
  'searchPlaceholder', 'searchEmptyMessage', 'noResultsText', 'connectionLabel',
]);
const nativeTokens = new Set(['type', 'properties', 'required', 'telnyx-ai-api-key', 'created_by', 'screen:', 'q', 'place_id']);
function isNativeLiteral(value) {
  const s = value.trim();
  return !/[a-zA-Z]/.test(s) || nativeTokens.has(s) ||
    /^(?:https?:\/\/|\/|\.\.\.\/|window\.|data-|\.demo-|page\.|device\.|visitor\.|<\/|message\.)\S*$/.test(s);
}
function scanFiles(files, exceptions = []) {
  const findings = [], review = [], exempt = [];
  let unresolved = 0, expressions = 0;
  const add = (file, p, kind, expression, result) => {
    expressions++;
    const values = result.values.filter(v => !isNativeLiteral(v));
    if (result.unknown) unresolved++;
    if (!values.length) return;
    const item = { file, line: p.node.loc.start.line, kind, expression, values, unknown: result.unknown };
    const exception = exceptions.find(e => e.file === file && e.expression === expression && values.every(v => e.values.includes(v)));
    if (exception) exempt.push({ ...item, reason: exception.reason });
    else (result.unknown ? review : findings).push(item);
  };
  for (const file of files) {
    traverse(ast(file).ast, {
      CallExpression(p) {
        if (p.node.callee.name === 'tUi' && !p.scope.getBinding('tUi')) {
          findings.push({ file, line: p.node.loc.start.line, kind: 'missing-translator',
            expression: p.toString(), values: [], unknown: false });
        }
        const c = p.node.callee;
        const browserDialog = (c.type === 'Identifier' && ['confirm', 'alert', 'prompt'].includes(c.name) && !p.scope.getBinding(c.name)) ||
          (c.type === 'MemberExpression' && c.object.name === 'window' && ['confirm', 'alert', 'prompt'].includes(c.property.name));
        if (browserDialog && p.node.arguments[0]) {
          const argument = p.get('arguments.0');
          add(file, argument, 'browser-dialog', argument.toString(), resolve(argument, [], new Set(), 0, file));
        }
      },
      TemplateLiteral(p) {
        if (!p.findParent(q => q.isCallExpression() && q.node.callee.name === 'notify')) return;
        if (p.findParent(q => q.isCallExpression() && q.node.callee.name === 'tUi')) return;
        const text = p.node.quasis.map((part, index) => part.value.cooked + (index < p.node.expressions.length ? `{value${index}}` : '')).join('');
        if (/[a-zA-Z]/.test(p.node.quasis.map(part => part.value.cooked).join(''))) {
          add(file, p, 'notification', p.toString(), { values: [text], unknown: false });
        }
      },
      JSXText(p) {
        if (p.parentPath.node.openingElement?.name?.name === 'UiText') return;
        const s = p.node.value.replace(/\s+/g, ' ').trim();
        if (s) add(file, p, 'text', s, { values: [s], unknown: false });
      },
      JSXAttribute(p) {
        if (!displayAttributes.has(p.node.name.name)) return;
        const value = p.get('value');
        if (!value.node) return;
        const expression = value.isJSXExpressionContainer() ? value.get('expression') : value;
        add(file, p, 'attribute', expression.toString(), resolve(expression, [], new Set(), 0, file));
      },
      JSXExpressionContainer(p) {
        if (p.parentPath.isJSXAttribute() || p.parentPath.node.openingElement?.name?.name === 'UiText') return;
        const expression = p.get('expression');
        if (['JSXEmptyExpression', 'JSXElement', 'JSXFragment'].includes(expression.type)) return;
        add(file, p, 'expression', expression.toString(), resolve(expression, [], new Set(), 0, file));
      },
    });
  }
  return { files: files.length, expressions, unresolved, findings, review, exempt };
}
function uiFiles() {
  const result = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      // Visitor UI and test conversations have an independent locale/content contract.
      if (['app/api', 'app/test', 'components/widget', 'components/i18n'].includes(file)) continue;
      if (e.isDirectory()) walk(file);
      else if (/\.[jt]sx?$/.test(file)) result.push(file);
    }
  }
  walk('app'); walk('components');
  return result;
}
module.exports = { scanFiles, uiFiles, isNativeLiteral };
if (require.main === module) {
  const exceptions = JSON.parse(fs.readFileSync('scripts/i18n/native-display.json', 'utf8'));
  const result = scanFiles(uiFiles(), exceptions);
  const output = process.env.I18N_AUDIT_OUTPUT;
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ files: result.files, expressions: result.expressions, unresolved: result.unresolved,
    unlocalizedStatic: result.findings.length, mixedProvenanceForReview: result.review.length,
    nativeExceptions: result.exempt.length, findings: result.findings.slice(0, 30) }, null, 2));
  if (result.findings.length) process.exitCode = 1;
}

// Conservative, read-only provenance analysis for application-owned display labels.
// Unknown runtime values are never classified as static UI copy.
const fs = require('fs'),
  path = require('path');
const {
  parse
} = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const cache = new Map();
function ast(file) {
  if (cache.has(file)) return cache.get(file);
  let root;
  const a = parse(fs.readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: ['jsx', 'typescript']
  });
  traverse(a, {
    Program(p) {
      root = p;
      p.stop();
    }
  });
  const result = {
    ast: a,
    root
  };
  cache.set(file, result);
  return result;
}
const unknown = () => ({
    values: [],
    unknown: true
  }),
  known = (values = []) => ({
    values,
    unknown: false
  });
const merge = rs => ({
  values: [...new Set(rs.flatMap(r => r.values))],
  unknown: rs.some(r => r.unknown)
});
function keyOf(p) {
  return p?.node?.name ?? p?.node?.value;
}
function pattern(p, name) {
  if (p.isIdentifier()) return p.node.name === name ? [] : null;
  if (p.isAssignmentPattern()) return pattern(p.get('left'), name);
  if (p.isArrayPattern()) {
    for (const [i, x] of p.get('elements').entries()) {
      if (!x.node) continue;
      const r = pattern(x, name);
      if (r) return [i, ...r];
    }
  }
  if (p.isObjectPattern()) {
    for (const x of p.get('properties')) {
      if (x.isRestElement()) continue;
      const r = pattern(x.get('value'), name);
      if (r) return [keyOf(x.get('key')), ...r];
    }
  }
  return null;
}
function resolve(p, sel = [], seen = new Set(), depth = 0, file) {
  if (!p?.node || depth > 22) return unknown();
  const key = `${file}:${p.node.type}:${p.node.start}:${sel.join('.')}`;
  if (seen.has(key)) return unknown();
  seen = new Set(seen).add(key);
  const next = (p, s = sel, f = file) => resolve(p, s, seen, depth + 1, f);
  if (p.isStringLiteral()) return sel.length ? unknown() : known([p.node.value]);
  if (p.isNumericLiteral() || p.isNullLiteral() || p.isBooleanLiteral()) return known();
  if (p.isTemplateLiteral()) return unknown();
  if (p.isIdentifier()) {
    if (['undefined', 'null', 'false', 'true'].includes(p.node.name)) return known();
    const b = p.scope.getBinding(p.node.name);
    if (!b) return unknown();
    const bp = b.path;
    if (bp.isVariableDeclarator()) {
      if (!b.constant) return unknown();
      const keys = pattern(bp.get('id'), p.node.name);
      return keys ? next(bp.get('init'), [...keys, ...sel]) : unknown();
    }
    if (bp.parentPath?.isFunction() && bp.listKey === 'params') {
      const fn = bp.parentPath,
        parent = fn.parentPath,
        keys = pattern(bp, p.node.name);
      if (keys && bp.key === 0 && parent.isCallExpression() && parent.get('callee').isMemberExpression() && ['map', 'flatMap'].includes(keyOf(parent.get('callee.property')))) return next(parent.get('callee.object'), ['*', ...keys, ...sel]);
      if (keys && fn.isFunctionDeclaration() && fn.node.id && keys.length) {
        const calls = [];
        const ownBinding = fn.scope.parent.getBinding(fn.node.id.name);
        ast(file).root.traverse({
          JSXOpeningElement(call) {
            if (call.node.name.type !== 'JSXIdentifier' || call.node.name.name !== fn.node.id.name || call.scope.getBinding(fn.node.id.name) !== ownBinding) return;
            const at = call.get('attributes').find(a => a.isJSXAttribute() && a.node.name.name === keys[0]);
            if (at?.node.value) {
              let v = at.get('value');
              if (v.isJSXExpressionContainer()) v = v.get('expression');
              calls.push(next(v, [...keys.slice(1), ...sel]));
            } else calls.push(unknown());
          }
        });
        if (calls.length) return merge(calls);
      }
      return unknown();
    }
    if (bp.isImportSpecifier()) {
      const name = keyOf(bp.get('imported')),
        loc = bp.parentPath.node.source.value;
      const base = loc.startsWith('@/') ? path.join(process.cwd(), loc.slice(2)) : loc.startsWith('.') ? path.resolve(path.dirname(file), loc) : null;
      if (!base) return unknown();
      const target = [base, ...['.mjs', '.js', '.jsx', '.ts', '.tsx'].map(e => base + e)].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!target) return unknown();
      const entry = ast(target).root.scope.getBinding(name);
      if (entry?.path.isVariableDeclarator()) return next(entry.path.get('init'), sel, target);
    }
    return unknown();
  }
  if (p.isMemberExpression() || p.isOptionalMemberExpression()) {
    const prop = p.node.computed ? p.get('property').isStringLiteral() || p.get('property').isNumericLiteral() ? p.node.property.value : '*' : keyOf(p.get('property'));
    return next(p.get('object'), [prop, ...sel]);
  }
  if (p.isArrayExpression()) {
    if (!sel.length) return unknown();
    const [key, ...rest] = sel;
    const els = p.get('elements');
    return key === '*' ? merge(els.filter(e => e.node).map(e => e.isSpreadElement() ? next(e.get('argument'), ['*', ...rest]) : next(e, rest))) : Number.isInteger(Number(key)) ? next(els[Number(key)], rest) : unknown();
  }
  if (p.isObjectExpression()) {
    if (!sel.length) return unknown();
    const [key, ...rest] = sel;
    const props = p.get('properties');
    if (key === '*') return merge(props.map(v => v.isObjectProperty() ? next(v.get('value'), rest) : unknown()));
    const prop = props.find(v => v.isObjectProperty() && keyOf(v.get('key')) === key);
    if (prop) return next(prop.get('value'), rest);
    return unknown();
  }
  if (p.isConditionalExpression()) return merge([next(p.get('consequent')), next(p.get('alternate'))]);
  if (p.isLogicalExpression()) return merge([next(p.get('left')), next(p.get('right'))]);
  if (p.isCallExpression() || p.isOptionalCallExpression()) {
    const c = p.get('callee');
    if (c.isMemberExpression() && c.get('object').isIdentifier({
      name: 'Object'
    }) && keyOf(c.get('property')) === 'freeze') return next(p.get('arguments.0'));
    if (c.isIdentifier({
      name: 'useMemo'
    }) || c.isMemberExpression() && keyOf(c.get('property')) === 'useMemo' && c.get('object').isIdentifier({
      name: 'React'
    })) {
      const fn = p.get('arguments.0');
      if (fn?.isFunction()) {
        if (!fn.get('body').isBlockStatement()) return next(fn.get('body'));
        const returns = [];
        fn.get('body').traverse({
          Function(q) {
            q.skip();
          },
          ReturnStatement(q) {
            returns.push(next(q.get('argument')));
          }
        });
        if (returns.length) return merge(returns);
      }
    }
    if (c.isIdentifier() && ['tUi', 'statusLabel', 'operationalStatusLabel', 'interactionStateLabel'].includes(c.node.name)) return known();
    if (c.isIdentifier()) {
      const binding = c.scope.getBinding(c.node.name);
      let fn = binding?.path,
        origin = file;
      if (fn?.isImportSpecifier()) {
        const loc = fn.parentPath.node.source.value,
          name = keyOf(fn.get('imported'));
        const base = loc.startsWith('@/') ? path.join(process.cwd(), loc.slice(2)) : loc.startsWith('.') ? path.resolve(path.dirname(file), loc) : null;
        const target = base && [base, ...['.mjs', '.js', '.jsx'].map(e => base + e)].find(f => fs.existsSync(f) && fs.statSync(f).isFile());
        if (target) {
          fn = ast(target).root.scope.getBinding(name)?.path;
          origin = target;
        }
      }
      if (fn?.isVariableDeclarator()) fn = fn.get('init');
      if (fn?.isFunction()) {
        if (!fn.get('body').isBlockStatement()) return next(fn.get('body'), sel, origin);
        const returns = [];
        fn.get('body').traverse({
          Function(q) {
            q.skip();
          },
          ReturnStatement(q) {
            returns.push(next(q.get('argument'), sel, origin));
          }
        });
        if (returns.length) return merge(returns);
      }
    }
    if (c.isMemberExpression() && ['find', 'findLast'].includes(keyOf(c.get('property')))) return next(c.get('object'), ['*', ...sel]);
    if ((c.isMemberExpression() || c.isOptionalMemberExpression()) && ['filter', 'slice', 'sort', 'toSorted'].includes(keyOf(c.get('property')))) return next(c.get('object'));
    if (c.isMemberExpression() && c.get('object').isIdentifier({
      name: 'Object'
    }) && keyOf(c.get('property')) === 'values' && sel[0] === '*') return next(p.get('arguments.0'), ['*', ...sel.slice(1)]);
  }
  return unknown();
}
module.exports = {
  ast,
  resolve,
  pattern
};

// Execute actual route handlers with dependency boundaries replaced. No HTTP
// listener, NextAuth service, application database or provider network is used.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { guardStubFromDeps } from "./authz-harness.mjs";
import * as campaignConfigurationModule from "../../lib/outbound-dialer/configuration-authorization.mjs";
import * as publicUserModule from "../../lib/users/public-user.mjs";
import * as mobilePagesModule from "../../lib/acd/mobile-monitor-pages.mjs";
import * as providerStatusModule from "../../lib/provider-http-status.mjs";
import * as scopeModule from "../../lib/authz/scope.mjs";

export async function loadRoute(path, dependencies) {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node)) continue;
    const specifier = node.moduleSpecifier.text;
    const parts = [];
    if (node.importClause?.name) parts.push(`default: ${node.importClause.name.text}`);
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) parts.push(`${binding.propertyName?.text || binding.name.text}: ${binding.name.text}`);
    }
    const replacement = bindings && ts.isNamespaceImport(bindings)
      ? `const ${bindings.name.text} = deps[${JSON.stringify(specifier)}] || {};`
      : parts.length ? `const { ${parts.join(", ")} } = deps[${JSON.stringify(specifier)}] || {};` : "";
    edits.push({ start: node.getStart(ast), end: node.end, replacement });
  }
  let code = source;
  for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
  const key = `__route_test_${randomUUID()}`;
  const deps = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } },
    "@/lib/acd/mobile-monitor-pages.mjs": mobilePagesModule,
    "@/lib/provider-http-status.mjs": providerStatusModule,
    "@/lib/users/public-user.mjs": publicUserModule,
    "@/lib/outbound-dialer/configuration-authorization.mjs": campaignConfigurationModule,
    ...dependencies,
  };
  // Routes go through withPermission; unless a test provides its own guard,
  // derive one from the test's auth-server mock so existing tests keep working.
  if (!deps["@/lib/authz/guard"]) deps["@/lib/authz/guard"] = guardStubFromDeps(deps);
  // Scope helpers are pure (predicates and SQL builders); routes get the real module.
  if (!deps["@/lib/authz/scope.mjs"]) deps["@/lib/authz/scope.mjs"] = scopeModule;
  globalThis[key] = deps;
  const prefix = `const deps = globalThis[${JSON.stringify(key)}];
    const process = { env: deps.env || {} };
    const fetch = deps.fetch || (() => { throw new Error('Unexpected provider I/O'); });\n`;
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(prefix + code).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { messageId } from '../../lib/i18n/locales.mjs';
import { SYSTEM_ROLES, PRESET_ROLES } from '../../lib/authz/permissions.mjs';
import { documentPreviewCopy } from '../../lib/documents/preview-copy.mjs';
import { DEFAULT_AGENT_STATUSES } from '../../lib/i18n/status-labels.mjs';
import { OPERATIONAL_STATUS_LABELS } from '../../lib/i18n/interaction-labels.mjs';
import { EPOS_DEVICE_CATALOG } from '../../lib/headsets/headset-device-catalog.js';
import { HELP_TOPICS } from '../../lib/help/help-registry.js';
import { toIcuMessage } from '../../lib/i18n/catalogue-text.mjs';
const require = createRequire(import.meta.url),
  {
    parse
  } = require('@babel/parser'),
  traverse = require('@babel/traverse').default;
const { resolve: resolveText } = require('./source-analysis.cjs');
const catalogue = JSON.parse(fs.readFileSync('messages/source.json', 'utf8'));
const files = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, {
    withFileTypes: true
  })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);else if (/\.(jsx?|tsx?|mjs)$/.test(file)) files.push(file);
  }
}
walk('app');
walk('components');
walk('config');
walk('lib/i18n');
files.push('lib/telephony/handoff-phase.mjs', 'lib/telephony/handoff-scene.mjs', 'lib/telephony/handoff-caller.mjs', 'lib/messaging/template-languages.mjs', 'lib/contact-center/customer-identity.js', 'lib/outbound-dialer/attempt-display.mjs', 'lib/ai/assistant-tool-validation.js', 'lib/ai/assistant-conversation-workflow.mjs', 'lib/ai/assistant-transcription.mjs', 'lib/authz/permissions.mjs', 'lib/acd/channel-registry.mjs', 'lib/telephony/phone-indicator.mjs', 'lib/telephony/call-recovery.mjs', 'lib/ai/widget-ui-state.mjs', 'lib/logger/topic-catalog.mjs', 'lib/sms/segments.mjs', 'lib/variable-utils.js', 'lib/agent-assist/sentiment-display.js', 'lib/agent-assist/slot-display.mjs', 'lib/email/message-status.mjs', 'lib/sms/message-status.mjs', 'lib/whatsapp/message-status.mjs');
const copyKeys = new Set(['title', 'label', 'detail', 'description', 'subtitle', 'helper', 'helperText', 'placeholder', 'hint', 'emptyText', 'emptyLabel', 'emptyMessage', 'ariaLabel', 'loadingText', 'error', 'message']);
function add(source, file, context = '') {
  if (typeof source !== 'string' || !/[a-zA-Z]/.test(source) || /^(?:https?:\/\/|\/api\/)\S*$/.test(source)) return;
  const id = messageId(source, context);
  if (catalogue[id] && (catalogue[id].source !== source || (catalogue[id].context || '') !== context)) throw Error(`Hash collision: ${id}`);
  catalogue[id] ||= {
    source,
    ...(context ? { context } : {}),
    files: []
  };
  if (!catalogue[id].files.includes(file)) catalogue[id].files.push(file);
}
for (const file of files) {
  if (file.startsWith('app/api/') || file.startsWith('components/widget/') || file.startsWith('components/i18n/')) continue;
  let ast;
  try {
    ast = parse(fs.readFileSync(file, 'utf8'), {
      sourceType: 'module',
      plugins: ['jsx', 'typescript']
    });
  } catch (error) {
    throw Error(`${file}: ${error.message}`);
  }
  traverse(ast, {
    CallExpression(p) {
      if (p.node.callee.name === 'tUi') {
        const context = p.node.arguments[2];
        if (context && context.type !== 'StringLiteral') throw Error(`${file}: translation context must be a literal`);
        add(p.node.arguments[0]?.value, file, context?.value);
        // Arrays, local column definitions and imported label registries also
        // contain UI copy. Follow only statically known values, never live data.
        for (const value of resolveText(p.get('arguments.0'), [], new Set(), 0, file).values) add(value, file, context?.value);
      }
    },
    ObjectProperty(p) {
      const key = p.node.key.name || p.node.key.value;
      if (copyKeys.has(key) && p.node.value.type === 'StringLiteral') add(p.node.value.value, file);
    },
    JSXAttribute(p) {
      if (copyKeys.has(p.node.name.name)) add(p.node.value?.value, file);
      // Column arrays can pass through several local components. Collect at
      // their declaration as well as at the final translated rendering site.
      if (p.node.name.name === 'headers' && p.get('value').isJSXExpressionContainer()) {
        for (const text of resolveText(p.get('value.expression'), ['*'], new Set(), 0, file).values) add(text, file);
      }
    },
    JSXElement(p) {
      if (p.node.openingElement.name.name !== 'UiText') return;
      const context = p.node.openingElement.attributes.find(a => a.name?.name === 'context')?.value?.value;
      for (const child of p.get('children')) {
        if (child.isJSXText()) add(child.node.value.trim(), file, context);
        if (child.isJSXExpressionContainer()) for (const value of resolveText(child.get('expression'), [], new Set(), 0, file).values) add(value, file, context);
      }
    },
    AssignmentPattern(p) {
      if (copyKeys.has(p.node.left.name)) add(p.node.right.value, file);
    }
  });
}
for (const source of ['Agent', 'Supervisor', 'Admin', 'Connect', 'Assist', 'Resolve', 'Observe', 'Coach', 'Improve', 'Configure', 'Control', 'Scale', 'read', 'create', 'update', 'delete', 'Break', 'Wrapup', 'Agent Not Answering', 'View queues', 'View agents', 'Closed today', 'SLA today', 'Live interactions', 'Global capacity', 'Completed today', 'Average handling', 'Available', 'Busy', 'Away', 'Offline', 'Unknown', 'Agent Desktop', 'Agent Workspace', 'Supervisor Workspace', 'Admin Workspace', 'Failed to save profile', 'Unsupported interface language']) add(source, 'components/i18n/use-ui-text.jsx');
for (const entry of EPOS_DEVICE_CATALOG) for (const source of [entry.status, ...entry.capabilities]) add(source, 'lib/headsets/headset-device-catalog.js');
for (const role of [...SYSTEM_ROLES, ...PRESET_ROLES]) for (const text of [role.name, role.description]) add(text, 'lib/authz/permissions.mjs');
for (const text of Object.values(documentPreviewCopy('en-US'))) add(text, 'lib/documents/preview-copy.mjs');
for (const status of DEFAULT_AGENT_STATUSES) {
  add(status.name, 'lib/i18n/status-labels.mjs');
  add(status.description, 'lib/i18n/status-labels.mjs');
}
for (const label of Object.values(OPERATIONAL_STATUS_LABELS)) add(label, 'lib/i18n/interaction-labels.mjs');
for (const topic of Object.values(HELP_TOPICS)) {
  for (const text of [topic.title, topic.summary, ...(topic.paragraphs || []), ...(topic.tips || [])]) add(text, 'lib/help/help-registry.js');
}
fs.writeFileSync('messages/source.json', JSON.stringify(catalogue, null, 2) + '\n');
fs.writeFileSync('messages/en-US.json', JSON.stringify({
  ui: Object.fromEntries(Object.entries(catalogue).map(([id, {
    source
  }]) => [id, toIcuMessage(source)]))
}, null, 2) + '\n');
console.log(`${Object.keys(catalogue).length} source messages`);

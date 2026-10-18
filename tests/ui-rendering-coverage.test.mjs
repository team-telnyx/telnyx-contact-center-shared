import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { translatedMessageText } from '../lib/i18n/catalogue-text.mjs';
import { phoneIndicator } from '../lib/telephony/phone-indicator.mjs';
import { smsSegments, describeSmsSegments } from '../lib/sms/segments.mjs';
import { formatSlotDisplay } from '../lib/agent-assist/slot-display.mjs';
import { getIntentLabel } from '../lib/agent-assist/sentiment-display.js';
const require = createRequire(import.meta.url);
const { scanFiles } = require('../scripts/i18n/audit-ui.cjs');
function fixture(t, code, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'view.jsx');
  fs.writeFileSync(file, code);
  for (const [name, contents] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), contents);
  return file;
}
test('render audit finds array/tuple labels, table headers and imported helper labels', t => {
  const file = fixture(t, `import {items, helper} from './labels.mjs';
    const headers=['Channel','Queue'];
    function Report({headers}) { return <thead>{headers.map(h=><th>{h}</th>)}</thead> }
    export function View(){return <><Report headers={headers}/>{[['one','1 day']].map(([id,label])=><button value={id}>{label}</button>)}
      {items.map(item=><span>{item.label}</span>)}<span>{helper('active')}</span></>}`, {
    'labels.mjs': `export const items=[{id:'pending',label:'Pending'}]; export function helper(state){return state==='active'?'Active':'Inactive'}`,
  });
  const values = new Set(scanFiles([file]).findings.flatMap(x => x.values));
  for (const text of ['Channel','Queue','1 day','Pending','Active','Inactive']) assert(values.has(text), text);
  assert(!values.has('pending'));
});
test('translated rendering passes; configured labels and their values stay unresolved', t => {
  const file = fixture(t, `const headers=['Channel','Queue'];
    function View({customer, tUi}) { const mixed = customer.name || 'Unknown customer'; return <>
      {headers.map(h=><th>{tUi(h)}</th>)}<span>{customer.name}</span><span>{mixed}</span>
      <option value="queued">{tUi('Queued')}</option><code>call.initiated</code></> }`);
  const result = scanFiles([file]);
  assert.equal(result.findings.filter(x => x.expression !== 'call.initiated').length, 0);
  assert(result.review.some(x => x.values.includes('Unknown customer')));
  assert(!result.findings.some(x => x.expression === 'customer.name'));
});
test('logical fallbacks sharing an AST start are not lost to cycle detection', t => {
  const file = fixture(t, `const labels={a:'Available',b:'Unavailable'};
    function View({status}){return <span>{labels[status] || 'Unknown'}</span>}`);
  assert.deepEqual(scanFiles([file]).findings[0].values.sort(), ['Available','Unavailable','Unknown'].sort());
});
test('technical exceptions only accept their reviewed values, not future English labels', t => {
  const file = fixture(t, `const methods=['GET','POST','Delete all'];function View(){return methods.map(m=><span>{m}</span>)}`);
  const result = scanFiles([file], [{file,expression:'m',values:['GET','POST'],reason:'HTTP methods'}]);
  assert.equal(result.findings.length, 1);
});
test('translation response envelopes cannot bypass string validation', () => {
  assert.equal(translatedMessageText('Save'), 'Save');
  assert.equal(translatedMessageText({text:'Zapisz',context:'action'}), 'Zapisz');
  for (const value of [null, false, 3, [], {text:3}, {value:'Save'}]) assert.equal(translatedMessageText(value), undefined);
});
test('shared display helpers translate copy and preserve raw customer values', () => {
  const translate = (source, values) => `localized:${source.replace(/\{(value\d+)\}/g, (_, key) => values[key])}`;
  const stats = smsSegments('hello');
  assert.equal(describeSmsSegments(stats), 'GSM-7 · 1 part · 155 remaining');
  assert.equal(describeSmsSegments(stats, translate), 'localized:GSM-7 · parts: 1 · remaining: 155');
  assert.equal(stats.encoding, 'GSM-7');
  assert.equal(formatSlotDisplay(true, 'boolean', translate), 'localized:Yes');
  assert.equal(formatSlotDisplay('Yes', 'text', translate), 'Yes');
  assert.equal(getIntentLabel('', translate), 'localized:General Inquiry');
  assert.equal(getIntentLabel('General Inquiry', translate), 'General Inquiry');
  const indicator = phoneIndicator({status:'connecting'}, translate);
  assert.equal(indicator.label, 'localized:Connecting');
  assert.equal(indicator.tone, 'warning');
  assert.equal(indicator.color, 'orange');
});

test('role localization leaves renamed and custom roles untouched', async () => {
  const {roleDisplayText} = await import('../lib/i18n/role-labels.mjs');
  const t = text => `localized:${text}`;
  assert.equal(roleDisplayText(t, {key:'supervisor',name:'Supervisor',origin:'system'}), 'localized:Supervisor');
  assert.equal(roleDisplayText(t, {key:'campaign-manager',name:'Campaign Manager',origin:'preset'}), 'localized:Campaign Manager');
  assert.equal(roleDisplayText(t, {key:'campaign-manager',name:'Save',origin:'preset'}), 'Save');
  assert.equal(roleDisplayText(t, {key:'my-role',name:'Supervisor',origin:'custom'}), 'Supervisor');
});

test('document preview uses profile copy while preserving its standalone widget language', async () => {
  const { documentPreviewCopy } = await import('../lib/documents/preview-copy.mjs');
  assert.equal(documentPreviewCopy('pl-PL').retry, 'Spróbuj ponownie');
  const english = documentPreviewCopy('en-US');
  const translated = documentPreviewCopy('it-IT', value => `localized:${value}`);
  assert.deepEqual(Object.keys(translated), Object.keys(english));
  for (const [key, text] of Object.entries(english)) assert.equal(translated[key], `localized:${text}`);
});

test('provider statuses and outbound helper copy translate without changing addresses or response text', async () => {
  const { operationalStatusLabel } = await import('../lib/i18n/interaction-labels.mjs');
  const { attemptDisplay } = await import('../lib/outbound-dialer/attempt-display.mjs');
  const { supervisionCustomerIdentity } = await import('../lib/contact-center/customer-identity.js');
  const t = text => `localized:${text}`;
  assert.equal(operationalStatusLabel(t, 'CONNECTED'), 'localized:Connected');
  assert.equal(operationalStatusLabel(t, 'Vendor_Custom_State'), 'Vendor_Custom_State');
  const attempt = attemptDisplay({message_state:'delivered',sender_address:'Save',to_address:'Available',rendered_text:'Save',failure_reason:'provider_detail'}, t);
  assert.equal(attempt.label, 'localized:Delivered');
  assert.equal(attempt.from, 'Save'); assert.equal(attempt.to, 'Available'); assert.equal(attempt.text, 'Save');
  assert.equal(attemptDisplay({}, t).from, 'localized:Selected when dialing starts');
  assert.equal(supervisionCustomerIdentity({}, t).label, 'localized:Caller');
  assert.equal(supervisionCustomerIdentity({customerName:'Caller',customerNumber:'Available'}, t).label, 'Caller');
  assert.equal(supervisionCustomerIdentity({customerNumber:'Available'}, t).detail, 'Available');
});

test('notification templates need translation before inserting customer data', t => {
  const file = fixture(t, 'function View({name,tUi}){notify({description:`Saved ${name}`});notify({description:tUi("Saved {value0}",{value0:name})});return null;}');
  const result = scanFiles([file]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, 'notification');
  assert.deepEqual(result.findings[0].values, ['Saved {value0}']);
});

test('translator scope and browser confirmation copy are audited', t => {
  const file = fixture(t, `function View(){return <span>{tUi('Save')}</span>}
    function Actions({tUi}){window.confirm('Delete this item?');window.confirm(tUi('Delete this item?'));return null;}`);
  const result = scanFiles([file]);
  assert.deepEqual(result.findings.map(item => item.kind).sort(), ['browser-dialog', 'missing-translator']);
});

test('preview-device localization preserves device models and canonical orientation', async () => {
  const { previewDeviceLabel } = await import('../lib/i18n/preview-labels.mjs');
  const t = (source, values, context) => `${context}:${source}`;
  const desktop = {id:'desktop-responsive',name:'Desktop',orientations:['landscape']};
  assert.equal(previewDeviceLabel(t, desktop), 'preview device:Desktop');
  assert.deepEqual(desktop.orientations, ['landscape']);
  assert.equal(previewDeviceLabel(t, {id:'iphone-16-pro',name:'iPhone 16 Pro'}), 'iPhone 16 Pro');
  assert.equal(previewDeviceLabel(t, {id:'desktop-responsive',name:'Custom device'}), 'Custom device');
});

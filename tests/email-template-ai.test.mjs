import assert from 'node:assert/strict';
import test from 'node:test';
import { emailTemplateModels, generateEmailTemplate, parseEmailTemplateResult } from '../lib/email/template-ai.mjs';

const template = {
  name: 'welcome', subject: 'Welcome, {{ first_name }}',
  html_body: '<p>Hello {{ first_name }}</p>', text_body: 'Hello {{ first_name }}',
};
const input = { prompt: 'Create a welcome email', model: 'Qwen/test', format: 'html' };
const completion = (content = JSON.stringify(template), finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }] });

test('model catalog retains text models, provider metadata and legacy models without a task', async () => {
  const result = await emailTemplateModels(async path => {
    assert.equal(path, '/ai/models');
    return { data: [{ id: 'qwen/model', task: 'text-generation', context_length: 32000 }, { id: 'openai/chat', task: 'chat' }, { id: 'legacy/model' }, { id: 'embed/model', task: 'embedding' }, { name: 'no-id' }] };
  });
  assert.deepEqual(result.models.map(m => m.id), ['qwen/model', 'openai/chat', 'legacy/model']);
  assert.equal(result.models[0].raw.context_length, 32000);
});

test('generation uses selected model, JSON mode and draft context without mutating the draft', async () => {
  const draft = { ...template };
  const result = await generateEmailTemplate({ ...input, template: draft }, { request: async (path, options) => {
    assert.equal(path, '/ai/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.model, input.model);
    assert.equal(options.body.stream, false);
    assert.equal(options.body.enable_thinking, false);
    assert.deepEqual(options.body.response_format, { type: 'json_object' });
    assert.deepEqual(JSON.parse(options.body.messages[1].content), { requirements: input.prompt, current_template: draft });
    return completion();
  } });
  assert.deepEqual(draft, template);
  assert.deepEqual(result, { ok: true, model: input.model, format: 'html', result: template });
});

test('invalid input is rejected before any provider call', async () => {
  for (const invalid of [{ ...input, prompt: '' }, { ...input, prompt: 'x'.repeat(4001) }, { ...input, model: '' }, { ...input, format: 'markdown' }, { ...input, action: 'send' }, { ...input, template: { ...template, html_body: 'x'.repeat(30001) } }]) {
    await assert.rejects(generateEmailTemplate(invalid, { request: () => assert.fail('Provider must not be called') }), e => e.status === 400);
  }
});

test('parser accepts fenced JSON with thinking removed and preserves Liquid variables', () => {
  assert.deepEqual(parseEmailTemplateResult(`<think>ignore {this}</think>\n\`\`\`json\n${JSON.stringify(template)}\n\`\`\``, 'html'), template);
});

test('plain generation discards HTML and derives a plain body when necessary', async () => {
  const result = await generateEmailTemplate({ ...input, format: 'plain' }, { request: async () => completion(JSON.stringify({ ...template, text_body: '' })) });
  assert.equal(result.format, 'plain');
  assert.equal(result.result.html_body, '');
  assert.equal(result.result.text_body, 'Hello {{ first_name }}');
});

test('HTML fallback escapes text instead of treating it as markup', () => {
  const result = parseEmailTemplateResult(JSON.stringify({ subject: 'Hello', text_body: 'A < B & C\nNext' }), 'html');
  assert.equal(result.html_body, 'A &lt; B &amp; C<br>Next');
});

test('invalid output retries once without JSON mode', async () => {
  const calls = [];
  const result = await generateEmailTemplate(input, { request: async (_, options) => {
    calls.push(options.body);
    return calls.length === 1 ? completion('') : completion();
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  assert.equal(calls[1].response_format, undefined);
  assert.deepEqual(result.result, template);
});

test('structured content and nested provider choices are supported', async () => {
  const result = await generateEmailTemplate(input, { request: async () => ({ data: completion([{ type: 'text', text: JSON.stringify(template) }]) }) });
  assert.deepEqual(result.result, template);
});

test('malformed, empty, oversized and header-injection output is rejected', () => {
  for (const invalid of ['not json', '[]', JSON.stringify({ ...template, subject: '' }), JSON.stringify({ ...template, subject: 'Hello\r\nBcc: other@example.com' }), JSON.stringify({ ...template, name: 'x'.repeat(121) }), JSON.stringify({ ...template, text_body: 'x'.repeat(30001) }), JSON.stringify({ ...template, html_body: 123 })]) {
    assert.throws(() => parseEmailTemplateResult(invalid, 'html'), e => e.status === 502);
  }
});

test('reasoning-only and truncated output never become a proposal and retry at most once', async () => {
  for (const response of [{ choices: [{ message: { reasoning_content: JSON.stringify(template), content: '' } }] }, completion(JSON.stringify(template), 'length')]) {
    let calls = 0;
    await assert.rejects(generateEmailTemplate(input, { request: async () => { calls++; return response; } }), e => e.status === 502);
    assert.equal(calls, 2);
  }
});

test('provider failure is propagated without a duplicate request', async () => {
  let calls = 0;
  const error = Object.assign(new Error('Rate limited'), { status: 429 });
  await assert.rejects(generateEmailTemplate(input, { request: async () => { calls++; throw error; } }), e => e === error);
  assert.equal(calls, 1);
});

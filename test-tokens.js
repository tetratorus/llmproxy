'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const code = source.slice(source.indexOf('function extractTokens('), source.indexOf('// Headers that must not be forwarded'));
const { extractTokens, parseSSE } = vm.runInNewContext(code + '\n({ extractTokens, parseSSE })');
const response = { object: 'response', model: 'fixture', usage: { input_tokens: 20, output_tokens: 6, input_tokens_details: { cached_tokens: 4 } } };
const expected = { input_tokens: 20, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 4 };

for (const provider of ['codex', 'openai']) {
  test(`${provider} non-streaming Responses usage`, () => {
    assert.deepEqual({ ...extractTokens(provider, response) }, expected);
  });
  for (const type of ['response.completed', 'response.incomplete']) {
    test(`${provider} streaming ${type} usage`, () => {
      const events = ['event: response.created', 'data: ' + JSON.stringify({ type: 'response.created', response: { model: 'fixture' } }), '',
        'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }), '',
        'data: ' + JSON.stringify({ type, response }), '', 'data: [DONE]'].join('\n');
      const result = parseSSE(provider, events);
      assert.equal(result.model, 'fixture');
      assert.deepEqual({ ...result.usage }, expected);
    });
  }
}

test('OpenAI Chat Completions streaming usage is unchanged', () => {
  const result = parseSSE('openai', 'data: ' + JSON.stringify({ model: 'fixture', usage: { prompt_tokens: 20, completion_tokens: 6,
    prompt_tokens_details: { cached_tokens: 4 } } }));
  assert.deepEqual({ ...result.usage }, expected);
});

test('Anthropic streaming usage retains cache accounting', () => {
  const result = parseSSE('anthropic', [
    'data: ' + JSON.stringify({ type: 'message_start', message: { model: 'fixture', usage: { input_tokens: 20, cache_read_input_tokens: 4 } } }),
    'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 6 } }),
  ].join('\n'));
  assert.deepEqual({ ...result.usage }, expected);
});

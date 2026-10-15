import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../lib/llm.js';

test('sends the key, model and prompt, and reads usage', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"vote":"Dana Reyes"}' }],
      usage: { input_tokens: 321, output_tokens: 45 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const res = await complete({ system: 'sys', prompt: 'vote now', maxTokens: 150, fallback: () => '', apiKey: 'test-key', fetchImpl });

  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'test-key');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.body.model, 'claude-haiku-5-5');
  assert.equal(seen.body.max_tokens, 150);
  assert.equal(seen.body.system, 'sys');
  assert.deepEqual(seen.body.messages, [{ role: 'user', content: 'vote now' }]);
  assert.equal(res.text, '{"vote":"Dana Reyes"}');
  assert.equal(res.inputTokens, 321);
  assert.equal(res.outputTokens, 45);
});

test('turns API errors into a 502', async () => {
  const fetchImpl = async () => new Response('overloaded', { status: 529 });
  await assert.rejects(
    complete({ system: 's', prompt: 'p', maxTokens: 10, fallback: () => '', apiKey: 'k', fetchImpl }),
    (err) => err.status === 502 && /529/.test(err.message),
  );
});

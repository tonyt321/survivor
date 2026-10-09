import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { demoLlm } from '../lib/llm.js';

let server;
let base;

before(async () => {
  // dataFile null keeps state in memory; demoLlm means no real API calls.
  server = await createServer({ dataFile: null, llm: demoLlm });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

test('status reports demo mode without an API key', async () => {
  const { status, data } = await call('GET', '/api/status');
  assert.equal(status, 200);
  assert.equal(data.mode, 'demo');
  assert.equal(data.model, 'claude-haiku-5-5');
});

test('the castaway library lists defaults and accepts custom castaways', async () => {
  const added = await call('POST', '/api/characters', {
    name: 'Test Castaway',
    bio: 'A custom test character.',
    personality: 'Very test-like.',
    stats: { physical: 5, mental: 5, social: 5, strategy: 5 },
  });
  assert.equal(added.status, 201);

  const { data } = await call('GET', '/api/characters');
  assert.equal(data.characters.filter((c) => !c.custom).length, 10);
  assert.ok(data.characters.some((c) => c.name === 'Test Castaway' && c.custom));

  const bad = await call('POST', '/api/characters', { name: 'Broken', bio: 'x', personality: 'y', stats: {} });
  assert.equal(bad.status, 400);
});

test('a full game plays through the API and default castaways cannot be deleted', async () => {
  const started = await call('POST', '/api/games', {
    characterIds: ['dana-reyes', 'marcus-oyelaran', 'priya-natarajan', 'toby-finch'],
    tokensPerIntermission: 400,
  });
  assert.equal(started.status, 201);
  assert.equal(started.data.game.players.length, 4);

  let last;
  for (let i = 0; i < 10; i++) {
    const res = await call('POST', '/api/game/episode', { talk: true });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    last = res.data;
    if (last.game.phase === 'over') break;
  }
  assert.equal(last.game.phase, 'over');
  assert.ok(last.game.winner);

  const after = await call('POST', '/api/game/episode', { talk: true });
  assert.equal(after.status, 409);

  const del = await call('DELETE', '/api/characters/dana-reyes');
  assert.equal(del.status, 404);

  const reset = await call('POST', '/api/game/reset');
  assert.equal(reset.status, 204);
});

test('invalid game requests get clear errors', async () => {
  const tooFew = await call('POST', '/api/games', { characterIds: ['dana-reyes'] });
  assert.equal(tooFew.status, 400);

  const unknown = await call('POST', '/api/games', {
    characterIds: ['dana-reyes', 'nobody', 'marcus-oyelaran', 'toby-finch'],
  });
  assert.equal(unknown.status, 400);

  const tokens = await call('POST', '/api/games', {
    characterIds: ['dana-reyes', 'marcus-oyelaran', 'toby-finch', 'leo-varga'],
    tokensPerIntermission: 10,
  });
  assert.equal(tokens.status, 400);
});

test('the page and its scripts are served, and paths cannot escape public/', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Island Castaways/);

  const js = await fetch(base + '/app.js');
  assert.match(js.headers.get('content-type'), /javascript/);

  const escape = await fetch(base + '/..%2Fserver.js');
  assert.equal(escape.status, 404);
});

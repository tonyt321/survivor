import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, loadOrCreateToken } from '../server.js';

const TOKEN = 'test-token-0123456789abcdef';
const turns = [];
const fakeLlm = {
  async complete(turn) {
    turns.push(turn);
    return { text: '{"vote":"Dana Reyes"}', inputTokens: 100, outputTokens: 12 };
  },
};

const servers = [];
async function start(options) {
  const server = createServer({ accessToken: TOKEN, llm: fakeLlm, live: true, dailyLimit: 3, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let base;
before(async () => { base = await start(); });
after(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));

const authed = { 'x-access-token': TOKEN };
const agent = (url, body, headers = authed) => fetch(`${url}/api/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const turn = { system: 'You are Dana.', prompt: 'Vote.', maxTokens: 150 };

test('the page is locked without the token', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /This game is private/);

  const wrong = await fetch(`${base}/?t=nope`, { redirect: 'manual' });
  assert.equal(wrong.status, 401);

  const api = await fetch(`${base}/api/status`);
  assert.equal(api.status, 401);
});

test('the link token becomes a cookie and is removed from the address', async () => {
  const res = await fetch(`${base}/?t=${TOKEN}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /ic_token=.*HttpOnly/);

  const page = await fetch(`${base}/`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Island Castaways<\/title>/);

  const engine = await fetch(`${base}/engine.js`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(engine.status, 200);
  assert.match(engine.headers.get('content-type'), /javascript/);
});

test('status reports live mode and the daily limit', async () => {
  const res = await fetch(`${base}/api/status`, { headers: authed });
  const data = await res.json();
  assert.equal(data.mode, 'live');
  assert.equal(data.dailyLimit, 3);
});

test('agent turns go to Claude and stop at the daily limit', async () => {
  const url = await start();
  for (let i = 1; i <= 3; i++) {
    const res = await agent(url, turn);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.text, '{"vote":"Dana Reyes"}');
    assert.equal(data.callsToday, i);
  }
  const blocked = await agent(url, turn);
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /limit of 3/);
  assert.deepEqual(
    { system: turns.at(-1).system, prompt: turns.at(-1).prompt, maxTokens: turns.at(-1).maxTokens },
    turn,
  );
});

test('agent turns are refused without the token or with bad input', async () => {
  assert.equal((await agent(base, turn, {})).status, 401);
  assert.equal((await agent(base, { ...turn, prompt: '' })).status, 400);
  assert.equal((await agent(base, { ...turn, maxTokens: 5000 })).status, 400);
  assert.equal((await agent(base, { ...turn, prompt: 'x'.repeat(9000) })).status, 400);
});

test('without an API key only scripted play is offered', async () => {
  const url = await start({ live: false });
  const status = await (await fetch(`${url}/api/status`, { headers: authed })).json();
  assert.equal(status.mode, 'demo');
  assert.equal((await agent(url, turn)).status, 503);
});

test('paths cannot escape the public folder', async () => {
  const res = await fetch(`${base}/..%2Fserver.js`, { headers: authed });
  assert.equal(res.status, 404);
});

test('a short token is rejected and a new token is saved and reused', async () => {
  assert.throws(() => createServer({ accessToken: 'short' }), /at least 16/);

  const dir = await mkdtemp(path.join(tmpdir(), 'ic-token-'));
  const file = path.join(dir, 'access-token');
  try {
    const first = await loadOrCreateToken(file);
    assert.ok(first.length >= 40);
    assert.equal(await loadOrCreateToken(file), first);
    assert.equal((await readFile(file, 'utf8')).trim(), first);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

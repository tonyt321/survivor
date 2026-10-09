import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAST, validateCharacter } from '../lib/characters.js';
import { createGame, runEpisode, parseJson, createRng } from '../lib/engine.js';
import { complete, demoLlm } from '../lib/llm.js';

const cast = (n = DEFAULT_CAST.length) => DEFAULT_CAST.slice(0, n);

function playToEnd(game, llm = demoLlm) {
  return (async () => {
    while (game.phase === 'playing') await runEpisode(game, { llm });
    return game;
  })();
}

test('a game needs between 4 and 20 castaways', () => {
  assert.throws(() => createGame({ cast: cast(3) }), /4 to 20/);
  assert.doesNotThrow(() => createGame({ cast: cast(4) }));
});

test('a full demo game ends with one winner and one elimination per episode', async () => {
  const game = createGame({ cast: cast(6), seed: 42 });
  await playToEnd(game);

  assert.equal(game.phase, 'over');
  assert.ok(game.winner);
  assert.equal(game.players.filter((p) => p.alive).length, 1);
  assert.equal(game.episodes.length, 5, 'six castaways need five episodes');
  assert.equal(game.episodes.at(-1).type, 'finale');
});

test('nobody ever votes for themselves or for the immune castaway', async () => {
  const game = createGame({ cast: cast(8), seed: 7 });
  await playToEnd(game);

  for (const ep of game.episodes.filter((e) => e.type === 'tribal')) {
    for (const v of ep.votes) {
      assert.notEqual(v.vote, v.voter);
      assert.notEqual(v.vote, ep.immunityWinner);
    }
  }
});

test('talk budgets are never overspent in an intermission', async () => {
  const game = createGame({ cast: cast(5), seed: 99, tokensPerIntermission: 300 });
  await runEpisode(game, { llm: demoLlm });
  await runEpisode(game, { llm: demoLlm });

  for (const p of game.players) {
    assert.ok(p.budget.used <= p.budget.limit, `${p.name} overspent`);
  }
  assert.ok(game.conversations.length > 0, 'intermission should produce conversations');
});

test('talk can be switched off per episode', async () => {
  const game = createGame({ cast: cast(5), seed: 3 });
  await runEpisode(game, { llm: demoLlm });
  await runEpisode(game, { llm: demoLlm, talk: false });
  assert.equal(game.conversations.length, 0);
});

test('unreadable votes fall back to a legal random target', async () => {
  const garbage = { complete: async ({ fallback }) => ({ text: 'I refuse to answer in JSON.', inputTokens: 0, outputTokens: 5, mock: true }) };
  const game = createGame({ cast: cast(4), seed: 11 });
  await runEpisode(game, { llm: garbage, talk: false });

  const ep = game.episodes[0];
  assert.ok(ep.votes.every((v) => v.valid === false));
  assert.ok(ep.votes.every((v) => v.vote !== v.voter));
  assert.equal(game.players.filter((p) => !p.alive).length, 1);
});

test('spend is tracked from every Claude call', async () => {
  const game = createGame({ cast: cast(4), seed: 5 });
  const llm = {
    complete: async ({ fallback }) => ({ text: fallback(), inputTokens: 100, outputTokens: 20, mock: false }),
  };
  await runEpisode(game, { llm, talk: false });
  assert.equal(game.spend.calls, 4, 'one vote per living castaway');
  assert.equal(game.spend.inputTokens, 400);
  assert.equal(game.spend.outputTokens, 80);
});

test('the rng state advances so the next episode differs', async () => {
  const game = createGame({ cast: cast(4), seed: 1234 });
  const before = game.rngState;
  await runEpisode(game, { llm: demoLlm, talk: false });
  assert.notEqual(game.rngState, before);
  assert.notEqual(createRng(before).next(), createRng(game.rngState).next());
});

test('parseJson pulls the first object out of chatty output', () => {
  assert.deepEqual(parseJson('Sure! {"vote":"Dana Reyes"} hope that helps'), { vote: 'Dana Reyes' });
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson('{"broken": '), null);
});

test('live llm path sends the key, model and prompt, and reads usage', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"vote":"Dana Reyes","confessional":"Easy call."}' }],
      usage: { input_tokens: 321, output_tokens: 45 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const res = await complete({
    system: 'sys', prompt: 'vote now', maxTokens: 150, fallback: () => 'never used',
    apiKey: 'test-key', fetchImpl,
  });

  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'test-key');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.body.model, 'claude-haiku-5-5');
  assert.equal(seen.body.max_tokens, 150);
  assert.equal(seen.body.system, 'sys');
  assert.equal(res.text, '{"vote":"Dana Reyes","confessional":"Easy call."}');
  assert.equal(res.inputTokens, 321);
  assert.equal(res.outputTokens, 45);
  assert.equal(res.mock, false);
});

test('live llm path turns API errors into a 502', async () => {
  const fetchImpl = async () => new Response('overloaded', { status: 529 });
  await assert.rejects(
    complete({ system: 's', prompt: 'p', maxTokens: 10, fallback: () => '', apiKey: 'k', fetchImpl }),
    (err) => err.status === 502 && /529/.test(err.message),
  );
});

test('validateCharacter accepts a good castaway and rejects bad input', () => {
  const good = validateCharacter({
    name: 'Ada Lovelace-Test',
    bio: 'Mathematician who wrote the first program.',
    personality: 'Imaginative and precise.',
    stats: { physical: 3, mental: 10, social: 6, strategy: 7 },
  }, DEFAULT_CAST);
  assert.equal(good.id, 'ada-lovelace-test');
  assert.deepEqual(good.stats, { physical: 3, mental: 10, social: 6, strategy: 7 });

  const base = { name: 'New Person', bio: 'Bio.', personality: 'Calm.', stats: { physical: 1, mental: 1, social: 1, strategy: 1 } };
  assert.throws(() => validateCharacter({ ...base, name: '  ' }), /Name is required/);
  assert.throws(() => validateCharacter({ ...base, name: 'Dana Reyes' }, DEFAULT_CAST), /already a castaway/);
  assert.throws(() => validateCharacter({ ...base, stats: { ...base.stats, mental: 11 } }), /Mental must be/);
  assert.throws(() => validateCharacter({ ...base, stats: { ...base.stats, social: 2.5 } }), /Social must be/);
  assert.throws(() => validateCharacter({ ...base, bio: 'x'.repeat(501) }), /500 characters/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/engine.js';

const { DEFAULT_CAST, newGame, runEpisode, parseJson, scripted } = globalThis.IslandEngine;
const cast = (n) => DEFAULT_CAST.slice(0, n);
const demo = { ask: async (turn) => scripted(turn) };

async function playToEnd(game, ctx = demo) {
  while (game.phase === 'playing') await runEpisode(game, ctx);
  return game;
}

test('a game needs between 4 and 20 castaways', () => {
  assert.throws(() => newGame(cast(3), 300), /4 to 20/);
  assert.doesNotThrow(() => newGame(cast(4), 300));
});

test('a full scripted game ends with one winner and one elimination per episode', async () => {
  const game = await playToEnd(newGame(cast(6), 300, 42));
  assert.equal(game.phase, 'over');
  assert.ok(game.winner);
  assert.equal(game.players.filter((p) => p.alive).length, 1);
  assert.equal(game.episodes.length, 5, 'six castaways need five episodes');
  assert.equal(game.episodes.at(-1).type, 'finale');
});

test('nobody votes for themselves or for the immune castaway', async () => {
  const game = await playToEnd(newGame(cast(8), 300, 7));
  for (const ep of game.episodes.filter((e) => e.type === 'tribal')) {
    for (const v of ep.votes) {
      assert.notEqual(v.vote, v.voter);
      assert.notEqual(v.vote, ep.immunity);
    }
  }
});

test('talk budgets are never overspent', async () => {
  const game = newGame(cast(5), 60, 99);
  const wordy = { ask: async () => ({ text: JSON.stringify({ to: 'Dana Reyes', message: 'blah '.repeat(200) }), ai: true, tokens: 50 }) };
  await runEpisode(game, demo);
  await runEpisode(game, wordy);
  for (const p of game.players) assert.ok(p.budget.used <= p.budget.limit, `${p.name} overspent`);
  assert.ok(game.conversations.length > 0);
});

test('talks can be switched off for an episode', async () => {
  const game = newGame(cast(5), 300, 3);
  await runEpisode(game, demo);
  await runEpisode(game, { ...demo, talk: false });
  assert.equal(game.conversations.length, 0);
});

test('unreadable votes fall back to a legal random target', async () => {
  const game = newGame(cast(4), 300, 11);
  await runEpisode(game, { talk: false, ask: async () => ({ text: 'I refuse to answer in JSON.', ai: true, tokens: 5 }) });
  const ep = game.episodes[0];
  assert.ok(ep.votes.every((v) => v.valid === false && v.vote !== v.voter));
  assert.equal(game.players.filter((p) => !p.alive).length, 1);
});

test('every turn is counted, and Claude turns are counted separately', async () => {
  const game = newGame(cast(4), 300, 5);
  const seen = [];
  const ai = { talk: false, ask: async (turn) => { seen.push(turn); return { text: turn.fallback(), ai: true, tokens: 100 }; } };
  await runEpisode(game, ai);
  assert.equal(game.spend.calls, 4, 'one vote per castaway');
  assert.equal(game.spend.aiCalls, 4);
  assert.equal(game.spend.tokens, 400);
  assert.match(seen[0].persona, /You are Dana Reyes/);
  assert.equal(seen[0].maxTokens, 150);
});

test('parseJson pulls the first object out of chatty output', () => {
  assert.deepEqual(parseJson('Sure! {"vote":"Dana Reyes"} hope that helps'), { vote: 'Dana Reyes' });
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson('{"broken": '), null);
});

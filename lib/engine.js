import { randomUUID } from 'node:crypto';
import * as defaultLlm from './llm.js';

export const TALK_ROUNDS = 2;
export const MIN_SPEECH_TOKENS = 20;
export const MAX_SPEECH_TOKENS = 200;
const MIN_CAST = 4;
const MAX_CAST = 20;
const MAX_MEMORY = 8;
const VOTE_CONCURRENCY = 4;

const OPENERS = [
  'Can we talk about who we are actually worried about?',
  'I think we could help each other get further. Are you in?',
  'Be honest with me, what is your read on the group right now?',
];
const REPLIES = [
  "I hear you. Let's keep talking before council.",
  'Maybe. I need to see who is really loyal first.',
  "Works for me, as long as we are not the ones on the chopping block.",
];

// Small seeded PRNG (mulberry32) so a game's state can be saved and replayed.
export function createRng(state) {
  let s = state >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    get state() {
      return s;
    },
  };
}

export function createGame({ cast, tokensPerIntermission = 600, seed = Math.floor(Math.random() * 2 ** 32) }) {
  if (cast.length < MIN_CAST || cast.length > MAX_CAST) {
    throw new Error(`A game needs ${MIN_CAST} to ${MAX_CAST} castaways.`);
  }
  return {
    id: randomUUID(),
    day: 0,
    phase: 'playing',
    winner: null,
    tokensPerIntermission,
    rngState: seed >>> 0,
    players: cast.map((c) => ({
      id: c.id,
      name: c.name,
      bio: c.bio,
      personality: c.personality,
      stats: { ...c.stats },
      alive: true,
      eliminatedDay: null,
      budget: { limit: tokensPerIntermission, used: 0 },
      memory: [],
    })),
    episodes: [],
    conversations: [],
    spend: { calls: 0, inputTokens: 0, outputTokens: 0 },
    createdAt: new Date().toISOString(),
  };
}

// Runs one episode: an intermission of private talks (from day 2 on), then either
// a challenge plus tribal council, or the final jury vote once two remain.
export async function runEpisode(game, { llm = defaultLlm, talk = true } = {}) {
  if (game.phase !== 'playing') throw new Error('This game is already over.');
  const rng = createRng(game.rngState);

  if (talk && game.day > 0) await runIntermission(game, { llm, rng });

  game.day += 1;
  const episode =
    living(game).length === 2
      ? await runFinale(game, { llm, rng })
      : await runTribal(game, { llm, rng });

  game.episodes.push(episode);
  game.rngState = rng.state;
  return episode;
}

async function runIntermission(game, { llm, rng }) {
  for (const p of game.players) p.budget.used = 0;

  for (let round = 0; round < TALK_ROUNDS; round++) {
    for (const speaker of living(game)) {
      const remaining = speaker.budget.limit - speaker.budget.used;
      if (remaining < MIN_SPEECH_TOKENS) continue;

      const others = living(game).filter((p) => p !== speaker);
      const maxTokens = Math.min(remaining, MAX_SPEECH_TOKENS);
      const res = await ask(game, llm, speaker, {
        prompt: talkPrompt(speaker, others, wordCap(maxTokens)),
        maxTokens,
        fallback: () => JSON.stringify({ to: pick(others, rng).name, message: pick(OPENERS, rng) }),
      });
      speaker.budget.used += Math.min(res.outputTokens, remaining);

      const parsed = parseJson(res.text);
      const target = byName(others, parsed?.to) ?? pick(others, rng);
      const message = String(parsed?.message ?? res.text).trim().slice(0, 800);
      const messages = [{ speaker: speaker.name, text: message }];

      const targetRemaining = target.budget.limit - target.budget.used;
      if (targetRemaining >= MIN_SPEECH_TOKENS) {
        const replyMax = Math.min(targetRemaining, MAX_SPEECH_TOKENS);
        const reply = await ask(game, llm, target, {
          prompt: replyPrompt(speaker, message, wordCap(replyMax)),
          maxTokens: replyMax,
          fallback: () => pick(REPLIES, rng),
        });
        target.budget.used += Math.min(reply.outputTokens, targetRemaining);
        messages.push({ speaker: target.name, text: reply.text.trim().slice(0, 800) || '...' });
      }

      game.conversations.push({ day: game.day, with: [speaker.name, target.name], messages });
      remember(speaker, `Day ${game.day}: I spoke privately with ${target.name}.`);
      remember(target, `Day ${game.day}: ${speaker.name} spoke privately with me: "${message.slice(0, 120)}"`);
    }
  }
}

async function runTribal(game, { llm, rng }) {
  const players = living(game);
  const challenge = runChallenge(players, rng);
  const immune = players.find((p) => p.name === challenge.winner);
  const targets = players.filter((p) => p !== immune);

  const votes = await runVote(game, {
    llm,
    rng,
    voters: players,
    targets,
    prompt: (voter, options) => councilPrompt(game, voter, options, immune.name),
  });
  const { winner: out, counts } = tally(votes, targets, rng);

  out.alive = false;
  out.eliminatedDay = game.day;
  for (const p of game.players) remember(p, `Day ${game.day}: ${out.name} was voted out.`);

  return {
    day: game.day,
    type: 'tribal',
    challenge,
    immunityWinner: immune.name,
    votes: publicVotes(votes),
    votesReceived: counts,
    eliminated: out.name,
  };
}

async function runFinale(game, { llm, rng }) {
  const finalists = living(game);
  const jury = game.players.filter((p) => !p.alive);

  const votes = await runVote(game, {
    llm,
    rng,
    voters: jury,
    targets: finalists,
    prompt: (voter, options) => finalePrompt(game, voter, options),
  });
  const { winner, counts } = tally(votes, finalists, rng);
  const runnerUp = finalists.find((p) => p !== winner);

  runnerUp.alive = false;
  runnerUp.eliminatedDay = game.day;
  game.phase = 'over';
  game.winner = winner.name;

  return {
    day: game.day,
    type: 'finale',
    finalists: finalists.map((p) => p.name),
    votes: publicVotes(votes),
    votesReceived: counts,
    winner: winner.name,
    eliminated: runnerUp.name,
  };
}

function runChallenge(players, rng) {
  const scores = players
    .map((p) => ({
      name: p.name,
      score: round1((p.stats.physical + p.stats.mental) / 2 + rng.next() * 6),
    }))
    .sort((a, b) => b.score - a.score);
  return { winner: scores[0].name, scores };
}

// Every voter is asked, in parallel, for one vote plus a confessional. Invalid
// or missing answers fall back to a random legal target so the episode always completes.
async function runVote(game, { llm, rng, voters, targets, prompt }) {
  return mapLimit(voters, VOTE_CONCURRENCY, async (voter) => {
    const options = targets.filter((t) => t !== voter);
    const res = await ask(game, llm, voter, {
      prompt: prompt(voter, options),
      maxTokens: 150,
      fallback: () =>
        JSON.stringify({
          vote: pick(options, rng).name,
          confessional: 'I have to make the move that keeps me safe.',
        }),
    });
    const parsed = parseJson(res.text);
    const chosen = byName(options, parsed?.vote);
    return {
      voter: voter.name,
      chosen: chosen ?? pick(options, rng),
      valid: Boolean(chosen),
      confessional: String(parsed?.confessional ?? (parsed ? '' : res.text)).trim().slice(0, 300),
    };
  });
}

function tally(votes, candidates, rng) {
  const counts = new Map(candidates.map((c) => [c, 0]));
  for (const v of votes) counts.set(v.chosen, counts.get(v.chosen) + 1);
  const top = Math.max(...counts.values());
  const tied = candidates.filter((c) => counts.get(c) === top);
  return {
    winner: pick(tied, rng),
    counts: Object.fromEntries(candidates.map((c) => [c.name, counts.get(c)])),
  };
}

function publicVotes(votes) {
  return votes.map((v) => ({ voter: v.voter, vote: v.chosen.name, valid: v.valid, confessional: v.confessional }));
}

// Calls the Claude API on behalf of one castaway and charges the call to the game's spend.
async function ask(game, llm, player, { prompt, maxTokens, fallback }) {
  const res = await llm.complete({ system: systemPrompt(player), prompt, maxTokens, fallback });
  game.spend.calls += 1;
  game.spend.inputTokens += res.inputTokens;
  game.spend.outputTokens += res.outputTokens;
  return res;
}

function systemPrompt(p) {
  return [
    `You are ${p.name}, a castaway on "Island Castaways," an original reality competition.`,
    'Stay in character at all times. Never mention being an AI or a language model.',
    `Background: ${p.bio}`,
    `Personality: ${p.personality}`,
    `Self-rated stats (1-10): physical ${p.stats.physical}, mental ${p.stats.mental}, social ${p.stats.social}, strategy ${p.stats.strategy}.`,
  ].join('\n');
}

function councilPrompt(game, voter, options, immuneName) {
  return [
    `Tribal Council, day ${game.day}. Immunity winner (cannot be voted out): ${immuneName}.`,
    `Castaways still in the game: ${names(living(game))}.`,
    `Your options (you cannot vote for yourself): ${names(options)}.`,
    `Your memories:\n${memoryList(voter)}`,
    'Vote one castaway out. Respond with JSON only: {"vote": "<exact name from the options>", "confessional": "<one sentence explaining your vote>"}',
  ].join('\n');
}

function finalePrompt(game, voter, options) {
  return [
    `Final Tribal Council, day ${game.day}. The two finalists are ${names(options)}.`,
    'You are on the jury. Vote for the castaway you think deserves to win.',
    `Your memories:\n${memoryList(voter)}`,
    'Respond with JSON only: {"vote": "<exact name from the options>", "confessional": "<one sentence explaining your vote>"}',
  ].join('\n');
}

function talkPrompt(speaker, others, cap) {
  return [
    'Between tribal councils you may speak privately with one fellow castaway.',
    `Other castaways still in the game: ${names(others)}.`,
    `Your memories:\n${memoryList(speaker)}`,
    `Keep your message under ${cap} words.`,
    'Respond with JSON only: {"to": "<exact name from the list>", "message": "<what you say to them>"}',
  ].join('\n');
}

function replyPrompt(speaker, message, cap) {
  return [
    `${speaker.name} just said to you privately: "${message}"`,
    `Reply in character in under ${cap} words. Respond with the reply text only.`,
  ].join('\n');
}

function wordCap(tokens) {
  return Math.max(10, Math.floor(tokens * 0.6));
}

function memoryList(p) {
  return p.memory.length ? p.memory.map((m) => `- ${m}`).join('\n') : '- Nothing yet.';
}

function remember(p, line) {
  p.memory.push(line);
  if (p.memory.length > MAX_MEMORY) p.memory.shift();
}

function living(game) {
  return game.players.filter((p) => p.alive);
}

function names(list) {
  return list.map((p) => p.name).join(', ');
}

function byName(list, name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  return list.find((p) => p.name.toLowerCase() === wanted);
}

function pick(list, rng) {
  return list[Math.floor(rng.next() * list.length)];
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function parseJson(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

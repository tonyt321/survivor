// Game rules for Island Castaways. Loaded by the page as a plain script
// (window.IslandEngine) and by the Node tests (globalThis.IslandEngine).
// Every castaway turn goes through ctx.ask, so the rules never know whether a
// turn was answered by Claude or by a scripted line.
(function (root) {
  'use strict';

  const STATS = ['physical', 'mental', 'social', 'strategy'];
  const DEFAULT_CAST = [
    ['dana-reyes', 'Dana Reyes', 'Emergency room nurse who stays calm when everything is on fire.', 'Warm, observant, quietly competitive. Hates being lied to.', [6, 7, 8, 6]],
    ['marcus-oyelaran', 'Marcus Oyelaran', 'Former college wrestler who now coaches youth teams.', 'Blunt, loyal to a fault, slow to trust.', [9, 4, 6, 4]],
    ['priya-natarajan', 'Priya Natarajan', 'Patent attorney who treats every alliance like a contract.', 'Analytical, precise, always three moves ahead.', [4, 9, 5, 8]],
    ['toby-finch', 'Toby Finch', 'Street magician and cruise-ship entertainer.', 'Charming, playful, too fond of misdirection.', [4, 6, 9, 7]],
    ['rosa-delgado', 'Rosa Delgado', 'Beekeeper and farmer from a small town.', 'Steady and kind, with a dry sense of humor. Keeps her word.', [6, 5, 7, 5]],
    ['kenji-mori', 'Kenji Mori', 'Competitive puzzle gamer.', 'Logical, awkward in groups, focused on the next challenge.', [5, 8, 3, 6]],
    ['hannah-brooks', 'Hannah Brooks', 'Top-selling sales rep who never accepts no.', 'Upbeat, persuasive, quick to make promises.', [5, 5, 9, 5]],
    ['gus-halloran', 'Gus Halloran', 'Retired firefighter with 25 years on the job.', 'Gruff, protects the underdog, distrusts big talkers.', [8, 5, 6, 3]],
    ['amara-osei', 'Amara Osei', 'Podcast host who knows how to get people talking.', 'Curious, articulate, keeps mental notes on everyone.', [4, 6, 8, 7]],
    ['leo-varga', 'Leo Varga', 'Forensic accountant who sees patterns everywhere.', 'Quiet, suspicious, sure someone runs a hidden game.', [3, 7, 2, 9]],
  ].map(([id, name, bio, personality, s]) => ({
    id, name, bio, personality, stats: Object.fromEntries(STATS.map((k, i) => [k, s[i]])),
  }));

  const OPENERS = [
    'Can we talk about who we are actually worried about?',
    'I think we could help each other get further. Are you in?',
    'Be honest with me, what is your read on the group?',
  ];
  const REPLIES = [
    "I hear you. Let's keep talking before council.",
    'Maybe. I need to see who is loyal first.',
    'Works for me, as long as we are not next.',
  ];
  const MIN_SPEECH = 20;
  const MAX_SPEECH = 120;
  const VOTE_TOKENS = 150;
  const MAX_MEMORY = 8;

  // Small seeded PRNG (mulberry32), so a saved game continues the same sequence.
  function createRng(seed) {
    let s = seed >>> 0;
    return {
      next() {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      get state() { return s; },
    };
  }

  const living = (g) => g.players.filter((p) => p.alive);
  const names = (list) => list.map((p) => p.name).join(', ');
  const pick = (list, r) => list[Math.floor(r.next() * list.length)];
  const estimateTokens = (text) => Math.ceil(String(text).length / 4);

  function byName(list, name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    return list.find((p) => p.name.toLowerCase() === wanted);
  }

  function remember(p, line) {
    p.memory.push(line);
    if (p.memory.length > MAX_MEMORY) p.memory.shift();
  }

  function memoryList(p) {
    return p.memory.length ? p.memory.map((m) => `- ${m}`).join('\n') : '- Nothing yet.';
  }

  function parseJson(text) {
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  // Cuts a line to the castaway's remaining budget (about 4 characters per token).
  function clip(text, tokens) {
    const max = tokens * 4;
    return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
  }

  // The ctx.ask answer for scripted (free) play.
  function scripted({ fallback }) {
    const text = fallback();
    return { text, ai: false, tokens: estimateTokens(text) };
  }

  function newGame(cast, budget, seed = Math.floor(Math.random() * 2 ** 32)) {
    if (cast.length < 4 || cast.length > 20) {
      throw new Error(`Pick 4 to 20 castaways. You have ${cast.length} selected.`);
    }
    return {
      day: 0,
      phase: 'playing',
      winner: null,
      rngState: seed >>> 0,
      players: cast.map((c) => ({
        id: c.id, name: c.name, bio: c.bio, personality: c.personality, stats: { ...c.stats },
        alive: true, eliminatedDay: null, budget: { limit: budget, used: 0 }, memory: [],
      })),
      episodes: [],
      conversations: [],
      spend: { calls: 0, aiCalls: 0, tokens: 0 },
    };
  }

  function persona(p) {
    return [
      `You are ${p.name}, a castaway on "Island Castaways," an original reality competition. Stay in character and never mention being an AI.`,
      `Background: ${p.bio}`,
      `Personality: ${p.personality}`,
      `Self-rated stats (1-10): physical ${p.stats.physical}, mental ${p.stats.mental}, social ${p.stats.social}, strategy ${p.stats.strategy}.`,
    ].join('\n');
  }

  // ctx.ask({ persona, prompt, maxTokens, fallback }) resolves { text, ai, tokens }.
  async function ask(g, ctx, player, prompt, maxTokens, fallback) {
    const res = await ctx.ask({ persona: persona(player), prompt, maxTokens, fallback });
    g.spend.calls += 1;
    if (res.ai) g.spend.aiCalls += 1;
    g.spend.tokens += res.tokens;
    return String(res.text ?? '');
  }

  // One episode: private talks (from day 2 on), then a challenge and tribal
  // council, or the jury vote once two castaways remain.
  async function runEpisode(g, ctx) {
    if (g.phase !== 'playing') throw new Error('This game is already over.');
    const r = createRng(g.rngState);
    const run = { ...ctx, progress: ctx.progress || (() => {}) };
    if (run.talk !== false && g.day > 0) await intermission(g, run, r);
    g.day += 1;
    const episode = living(g).length === 2 ? await finale(g, run, r) : await tribal(g, run, r);
    g.episodes.push(episode);
    g.rngState = r.state;
    return episode;
  }

  async function intermission(g, ctx, r) {
    for (const p of g.players) p.budget.used = 0;
    for (const speaker of living(g)) {
      const left = speaker.budget.limit - speaker.budget.used;
      if (left < MIN_SPEECH) continue;
      const others = living(g).filter((p) => p !== speaker);
      const cap = Math.min(left, MAX_SPEECH);

      ctx.progress(`${speaker.name} is looking for someone to talk to...`);
      const raw = await ask(g, ctx, speaker, [
        'Between tribal councils you may speak privately with one fellow castaway.',
        `Other castaways still in the game: ${names(others)}.`,
        `Your memories:\n${memoryList(speaker)}`,
        `Keep your message under ${Math.floor(cap * 0.6)} words.`,
        'Respond with JSON only: {"to": "<exact name from the list>", "message": "<what you say to them>"}',
      ].join('\n'), cap + 30, () => JSON.stringify({ to: pick(others, r).name, message: pick(OPENERS, r) }));

      const parsed = parseJson(raw);
      const target = byName(others, parsed?.to) ?? pick(others, r);
      const message = clip(String(parsed?.message ?? raw).trim(), cap) || '...';
      speaker.budget.used += Math.min(estimateTokens(message), left);
      const messages = [{ speaker: speaker.name, text: message }];

      const targetLeft = target.budget.limit - target.budget.used;
      if (targetLeft >= MIN_SPEECH) {
        const targetCap = Math.min(targetLeft, MAX_SPEECH);
        ctx.progress(`${target.name} is answering ${speaker.name}...`);
        const reply = clip((await ask(g, ctx, target, [
          `${speaker.name} just said to you privately: "${message}"`,
          `Your memories:\n${memoryList(target)}`,
          `Reply in character in under ${Math.floor(targetCap * 0.6)} words. Respond with the reply text only.`,
        ].join('\n'), targetCap, () => pick(REPLIES, r))).trim(), targetCap) || '...';
        target.budget.used += Math.min(estimateTokens(reply), targetLeft);
        messages.push({ speaker: target.name, text: reply });
      }

      g.conversations.push({ day: g.day, with: [speaker.name, target.name], messages });
      remember(speaker, `Day ${g.day}: I spoke privately with ${target.name}.`);
      remember(target, `Day ${g.day}: ${speaker.name} told me privately: "${message.slice(0, 120)}"`);
    }
  }

  // Asks each voter in turn. Unreadable answers become a random legal vote,
  // so an episode always finishes.
  async function vote(g, ctx, r, voters, targets, promptFor) {
    const votes = [];
    for (const voter of voters) {
      const options = targets.filter((t) => t !== voter);
      ctx.progress(`${voter.name} is casting a vote...`);
      const raw = await ask(g, ctx, voter, promptFor(voter, options), VOTE_TOKENS,
        () => JSON.stringify({ vote: pick(options, r).name, confessional: 'I have to make the move that keeps me safe.' }));
      const parsed = parseJson(raw);
      const chosen = byName(options, parsed?.vote);
      votes.push({
        voter: voter.name,
        chosen: chosen ?? pick(options, r),
        valid: Boolean(chosen),
        confessional: String(parsed?.confessional ?? '').trim().slice(0, 300),
      });
    }
    return votes;
  }

  function tally(votes, candidates, r) {
    const counts = new Map(candidates.map((c) => [c, 0]));
    for (const v of votes) counts.set(v.chosen, counts.get(v.chosen) + 1);
    const top = Math.max(...counts.values());
    return {
      picked: pick(candidates.filter((c) => counts.get(c) === top), r),
      counts: Object.fromEntries(candidates.map((c) => [c.name, counts.get(c)])),
    };
  }

  const publicVotes = (votes) => votes.map((v) => ({ voter: v.voter, vote: v.chosen.name, valid: v.valid, confessional: v.confessional }));

  async function tribal(g, ctx, r) {
    const players = living(g);
    const scores = players
      .map((p) => ({ name: p.name, score: Math.round(((p.stats.physical + p.stats.mental) / 2 + r.next() * 6) * 10) / 10 }))
      .sort((a, b) => b.score - a.score);
    const immune = players.find((p) => p.name === scores[0].name);
    const targets = players.filter((p) => p !== immune);

    const votes = await vote(g, ctx, r, players, targets, (voter, options) => [
      `Tribal Council, day ${g.day}. Immunity winner (cannot be voted out): ${immune.name}.`,
      `Castaways still in the game: ${names(players)}.`,
      `Your options (you cannot vote for yourself): ${names(options)}.`,
      `Your memories:\n${memoryList(voter)}`,
      'Vote one castaway out. Respond with JSON only: {"vote": "<exact name from the options>", "confessional": "<one sentence explaining your vote>"}',
    ].join('\n'));
    const { picked: out, counts } = tally(votes, targets, r);

    out.alive = false;
    out.eliminatedDay = g.day;
    for (const p of g.players) remember(p, `Day ${g.day}: ${out.name} was voted out.`);
    return { day: g.day, type: 'tribal', immunity: immune.name, scores, votes: publicVotes(votes), counts, eliminated: out.name };
  }

  async function finale(g, ctx, r) {
    const finalists = living(g);
    const jury = g.players.filter((p) => !p.alive);
    const votes = await vote(g, ctx, r, jury, finalists, (voter, options) => [
      `Final Tribal Council, day ${g.day}. The finalists are ${names(options)}.`,
      'You are on the jury. Vote for the castaway who deserves to win.',
      `Your memories:\n${memoryList(voter)}`,
      'Respond with JSON only: {"vote": "<exact name from the options>", "confessional": "<one sentence explaining your vote>"}',
    ].join('\n'));
    const { picked: winner, counts } = tally(votes, finalists, r);
    const runnerUp = finalists.find((p) => p !== winner);

    runnerUp.alive = false;
    runnerUp.eliminatedDay = g.day;
    g.phase = 'over';
    g.winner = winner.name;
    return { day: g.day, type: 'finale', finalists: finalists.map((p) => p.name), votes: publicVotes(votes), counts, winner: winner.name, eliminated: runnerUp.name };
  }

  root.IslandEngine = { STATS, DEFAULT_CAST, newGame, runEpisode, parseJson, estimateTokens, scripted };
})(typeof window !== 'undefined' ? window : globalThis);

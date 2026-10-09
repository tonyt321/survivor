const state = { characters: [], game: null };
const selected = new Set();
let busy = false;

const $ = (id) => document.getElementById(id);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Builds DOM nodes with textContent, so castaway text is never parsed as HTML.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function setMessage(id, text, isError = false) {
  const node = $(id);
  node.textContent = text;
  node.className = isError ? 'message error' : 'message';
}

function renderStatus(status) {
  const badge = $('mode');
  badge.textContent = status.mode === 'live'
    ? `Live: every castaway is a Claude agent (${status.model})`
    : 'Demo mode: no ANTHROPIC_API_KEY set, so castaways use scripted lines';
  badge.className = `badge ${status.mode}`;
}

function renderCast() {
  $('cast-list').replaceChildren(...state.characters.map((c) =>
    h('div', { class: 'cast-item' },
      h('input', {
        type: 'checkbox',
        checked: selected.has(c.id),
        onchange: (e) => (e.target.checked ? selected.add(c.id) : selected.delete(c.id)),
      }),
      h('span', { class: 'cast-name' }, c.name, c.custom ? h('em', {}, ' (yours)') : null),
      h('span', { class: 'cast-stats' },
        `P${c.stats.physical} M${c.stats.mental} S${c.stats.social} St${c.stats.strategy}`),
      c.custom
        ? h('button', { type: 'button', class: 'link', onclick: () => deleteCharacter(c.id) }, 'Delete')
        : null,
    ),
  ));
}

function renderGame() {
  const game = state.game;
  $('game').hidden = !game;
  if (!game) return;

  const living = game.players.filter((p) => p.alive);
  const over = game.phase === 'over';
  $('game-summary').textContent = over
    ? `Game over. Winner: ${game.winner}`
    : `Day ${game.day} · ${living.length} castaways left`;

  const button = $('next-episode');
  const nextLabel = game.day === 0
    ? 'Run day 1: challenge and tribal council'
    : living.length === 2 ? 'Run the final jury vote' : `Run day ${game.day + 1}`;
  button.textContent = busy ? 'Running... live agents can take a minute' : nextLabel;
  button.disabled = busy || over;
  $('talk-toggle').disabled = busy || over;

  $('spend').textContent =
    `Usage so far: ${game.spend.calls} Claude calls, ${game.spend.inputTokens} input tokens, ${game.spend.outputTokens} output tokens.`;

  $('players').replaceChildren(...game.players.map(renderPlayer));
  $('episodes').replaceChildren(...[...game.episodes].reverse().map(renderEpisode));
  if (!game.episodes.length) $('episodes').append(h('p', { class: 'muted' }, 'No councils yet.'));

  const convos = [...game.conversations].reverse().slice(0, 40);
  $('conversations').replaceChildren(...convos.map(renderConversation));
  if (!convos.length) $('conversations').append(h('p', { class: 'muted' }, 'No private talks yet.'));
}

function renderPlayer(p) {
  const pct = Math.min(100, Math.round((p.budget.used / p.budget.limit) * 100));
  return h('article', { class: p.alive ? 'player' : 'player out' },
    h('header', {},
      h('strong', {}, p.name),
      h('span', { class: 'status' }, p.alive ? 'In the game' : `Out on day ${p.eliminatedDay}`),
    ),
    h('p', { class: 'bio' }, p.bio),
    h('div', { class: 'stats' }, ...Object.entries(p.stats).map(([k, v]) => h('span', {}, `${k} ${v}`))),
    p.alive
      ? h('div', { class: 'budget' },
          h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` })),
          h('small', {}, `Talk budget used: ${p.budget.used} / ${p.budget.limit} tokens`))
      : null,
  );
}

function renderEpisode(ep) {
  const finale = ep.type === 'finale';
  const tally = Object.entries(ep.votesReceived).map(([name, n]) => `${name} ${n}`).join(' · ');
  return h('article', { class: 'card' },
    h('h3', {}, `Day ${ep.day}: ${finale ? 'Final jury vote' : 'Tribal council'}`),
    ep.challenge ? h('p', { class: 'muted' }, `Immunity: ${ep.immunityWinner}`) : null,
    ep.finalists ? h('p', { class: 'muted' }, `Finalists: ${ep.finalists.join(' vs ')}`) : null,
    h('ul', { class: 'votes' }, ...ep.votes.map((v) =>
      h('li', {},
        h('strong', {}, v.voter), ` votes for ${v.vote}${v.valid ? '' : ' (fallback, reply unreadable)'}`,
        v.confessional ? h('q', {}, ` ${v.confessional}`) : null,
      ),
    )),
    h('p', { class: 'tally' }, `Votes: ${tally}`),
    h('p', { class: 'result' }, finale
      ? `Winner: ${ep.winner}. Runner-up: ${ep.eliminated}.`
      : `Voted out: ${ep.eliminated}`),
  );
}

function renderConversation(c) {
  return h('article', { class: 'card convo' },
    h('h4', {}, `Day ${c.day}: ${c.with.join(' and ')}`),
    ...c.messages.map((m) => h('p', {}, h('strong', {}, `${m.speaker}: `), m.text)),
  );
}

async function createCharacter(event) {
  event.preventDefault();
  const body = {
    name: $('char-name').value,
    bio: $('char-bio').value,
    personality: $('char-personality').value,
    stats: {
      physical: Number($('char-physical').value),
      mental: Number($('char-mental').value),
      social: Number($('char-social').value),
      strategy: Number($('char-strategy').value),
    },
  };
  try {
    const { character } = await api('/api/characters', { method: 'POST', body });
    state.characters.push(character);
    selected.add(character.id);
    renderCast();
    event.target.reset();
    setMessage('character-message', `${character.name} joined the cast.`);
  } catch (err) {
    setMessage('character-message', err.message, true);
  }
}

async function deleteCharacter(id) {
  const character = state.characters.find((c) => c.id === id);
  if (!confirm(`Delete ${character.name} from the cast library?`)) return;
  try {
    await api(`/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.characters = state.characters.filter((c) => c.id !== id);
    selected.delete(id);
    renderCast();
  } catch (err) {
    setMessage('page-message', err.message, true);
  }
}

async function startGame() {
  const characterIds = [...selected];
  if (characterIds.length < 4) {
    setMessage('start-message', 'Pick at least 4 castaways.', true);
    return;
  }
  if (state.game?.phase === 'playing' && !confirm('Replace the game in progress?')) return;
  try {
    const { game } = await api('/api/games', {
      method: 'POST',
      body: { characterIds, tokensPerIntermission: Number($('talk-budget').value) },
    });
    state.game = game;
    setMessage('start-message', '');
    setMessage('game-message', 'Game started. Run day 1 when you are ready.');
    renderGame();
    $('game').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    setMessage('start-message', err.message, true);
  }
}

async function runEpisode() {
  busy = true;
  setMessage('game-message', '');
  renderGame();
  try {
    const { game, episode } = await api('/api/game/episode', {
      method: 'POST',
      body: { talk: $('talk-toggle').checked },
    });
    state.game = game;
    const result = episode.type === 'finale'
      ? `Winner: ${episode.winner}.`
      : `Voted out: ${episode.eliminated}.`;
    setMessage('game-message', `Day ${episode.day} done. ${result}`);
  } catch (err) {
    setMessage('game-message', err.message, true);
  } finally {
    busy = false;
    renderGame();
  }
}

async function resetGame() {
  if (!confirm('End this game and delete its history?')) return;
  await api('/api/game/reset', { method: 'POST' });
  state.game = null;
  setMessage('game-message', '');
  renderGame();
}

async function init() {
  const [status, { characters }, { game }] = await Promise.all([
    api('/api/status'),
    api('/api/characters'),
    api('/api/game'),
  ]);
  state.characters = characters;
  for (const c of characters) if (!c.custom) selected.add(c.id);
  state.game = game;

  renderStatus(status);
  renderCast();
  renderGame();

  $('create-form').addEventListener('submit', createCharacter);
  $('start-game').addEventListener('click', startGame);
  $('next-episode').addEventListener('click', runEpisode);
  $('reset-game').addEventListener('click', resetGame);
}

init().catch((err) => setMessage('page-message', `Could not load the app: ${err.message}`, true));

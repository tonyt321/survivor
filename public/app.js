(() => {
  const { STATS, DEFAULT_CAST, newGame, runEpisode, scripted } = window.IslandEngine;

  // ---------- Storage (per browser, best effort) ----------
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

  const state = {
    custom: load('ic.custom', []),
    photos: load('ic.photos', {}),
    game: load('ic.game', null),
    selected: new Set(load('ic.selected', DEFAULT_CAST.map((c) => c.id))),
    mode: 'demo',
    server: null,
    running: null,
    endArmed: false,
  };
  const allCast = () => [...DEFAULT_CAST.map((c) => ({ ...c, custom: false })), ...state.custom.map((c) => ({ ...c, custom: true }))];
  const living = (g) => g.players.filter((p) => p.alive);

  // ---------- Claude turns, paid for by the host's API key ----------
  async function serverAsk({ persona, prompt, maxTokens }, signal) {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: persona, prompt, maxTokens }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `The game server answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    if (state.server) state.server.callsToday = data.callsToday;
    return { text: data.text, ai: true, tokens: data.inputTokens + data.outputTokens };
  }

  // ---------- UI helpers ----------
  const $ = (id) => document.getElementById(id);
  function h(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'value') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }
  const say = (id, text, err = false) => { $(id).textContent = text; $(id).className = err ? 'msg err' : 'msg'; };
  const statLine = (s) => `P${s.physical} M${s.mental} S${s.social} St${s.strategy}`;

  // A castaway's picture: the uploaded photo, or initials on a colored tile.
  function avatar(id, name) {
    const src = state.photos[id];
    if (src) return h('img', { class: 'avatar', src, alt: '' });
    const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const hue = [...id].reduce((a, ch) => a + ch.charCodeAt(0) * 7, 0) % 360;
    return h('span', { class: 'avatar', style: `--h:${hue}`, 'aria-hidden': 'true' }, initials);
  }

  // Crops the picked image to a square and shrinks it so it fits in browser storage.
  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const size = 160;
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture this browser can open. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }

  async function setPhoto(id, file, msgId) {
    if (!file) return;
    try {
      state.photos[id] = await readPhoto(file);
      if (!save('ic.photos', state.photos)) say(msgId, 'The photo shows now, but this browser could not save it for next time.', true);
      renderCast();
      renderGame();
    } catch (err) {
      say(msgId, err.message, true);
    }
  }

  // ---------- Rendering ----------
  function renderMode() {
    const live = state.server?.mode === 'live';
    $('mode-ai').setAttribute('aria-pressed', String(state.mode === 'ai'));
    $('mode-demo').setAttribute('aria-pressed', String(state.mode === 'demo'));
    $('mode-ai').disabled = !live || Boolean(state.running);
    $('mode-demo').disabled = Boolean(state.running);
  }

  function noteMode() {
    renderMode();
    const s = state.server;
    let text;
    if (!s) text = 'Could not reach the game server, so castaways use scripted lines.';
    else if (s.mode !== 'live') text = 'Scripted mode: the host has not set an API key, so castaways use canned lines.';
    else if (state.mode === 'ai') text = `Claude agents: every castaway turn is a Claude call paid for by the host. ${s.callsToday} of ${s.dailyLimit} calls used today.`;
    else text = 'Scripted mode: castaways use canned lines and nothing is spent.';
    say('mode-note', text);
  }

  function renderCast() {
    $('cast').replaceChildren(...allCast().map((c) => h('div', { class: 'pick' },
      h('input', {
        type: 'checkbox', id: `pick-${c.id}`, 'aria-label': `Include ${c.name}`, checked: state.selected.has(c.id),
        onchange: (e) => { e.target.checked ? state.selected.add(c.id) : state.selected.delete(c.id); save('ic.selected', [...state.selected]); },
      }),
      avatar(c.id, c.name),
      h('label', { class: 'who', for: `pick-${c.id}` }, h('strong', {}, c.name), h('small', {}, statLine(c.stats))),
      h('label', { class: 'photo-btn' }, 'Photo',
        h('input', { type: 'file', accept: 'image/*', 'aria-label': `Upload a photo for ${c.name}`, onchange: (e) => setPhoto(c.id, e.target.files[0], 'start-msg') })),
      c.custom ? h('span', { class: 'yours' }, 'Yours') : null,
      c.custom ? h('button', { type: 'button', class: 'link', onclick: () => removeCustom(c.id) }, 'Remove') : null,
    )));
  }

  function renderGame() {
    const g = state.game;
    $('game').hidden = !g;
    renderMode();
    if (!g) return;

    const alive = living(g);
    const over = g.phase === 'over';
    $('summary').textContent = over ? `${g.winner} wins` : g.day === 0 ? `${alive.length} castaways arrive` : `Day ${g.day}: ${alive.length} left`;
    const next = $('next');
    next.textContent = state.running ? 'Running...' : over ? 'Game over' : g.day === 0 ? 'Run day 1' : alive.length === 2 ? 'Run the jury vote' : `Run day ${g.day + 1}`;
    next.disabled = Boolean(state.running) || over;
    $('stop').hidden = !state.running;
    $('talk').disabled = Boolean(state.running);
    $('end').textContent = state.endArmed ? 'Click again to end' : 'End game';
    $('end').disabled = Boolean(state.running);
    $('spend').textContent = `${g.spend.calls} castaway turns · ${g.spend.aiCalls} answered by Claude · about ${g.spend.tokens.toLocaleString()} tokens`;

    $('board').replaceChildren(...g.players.map((p) => {
      const pct = Math.min(100, Math.round((p.budget.used / p.budget.limit) * 100));
      return h('article', { class: p.alive ? 'player' : 'player out' },
        h('div', { class: 'name' },
          h('span', { class: 'portrait' }, avatar(p.id, p.name), h('span', { class: 'torch', 'aria-hidden': 'true' })),
          h('div', {}, h('strong', {}, p.name), h('div', { class: 'status' },
            p.alive ? (over ? 'Winner' : 'Still in') : `Out on day ${p.eliminatedDay}`))),
        h('p', { class: 'bio' }, p.personality),
        h('div', { class: 'chips' }, STATS.map((k) => h('span', {}, `${k} ${p.stats[k]}`))),
        p.alive && !over
          ? h('div', { class: 'budget' }, h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
              h('small', { class: 'num' }, `talk budget ${p.budget.used}/${p.budget.limit}`))
          : null,
      );
    }));

    const episodes = [...g.episodes].reverse();
    $('councils').replaceChildren(...(episodes.length ? episodes.map((ep) => h('div', { class: 'entry council' },
      h('h3', {}, `Day ${ep.day}: ${ep.type === 'finale' ? 'Final jury vote' : 'Tribal council'}`),
      ep.immunity ? h('p', { class: 'tally' }, `Immunity: ${ep.immunity}`) : h('p', { class: 'tally' }, `Finalists: ${ep.finalists.join(' vs ')}`),
      h('ul', {}, ep.votes.map((v) => h('li', {}, h('strong', {}, v.voter), ` votes ${v.vote}`, v.valid ? '' : ' (reply unreadable, random vote)',
        v.confessional ? [' ', h('q', {}, v.confessional)] : null))),
      h('p', { class: 'tally' }, Object.entries(ep.counts).map(([n, c]) => `${n} ${c}`).join(' · ')),
      h('p', { class: 'result' }, ep.type === 'finale' ? `${ep.winner} wins. Runner-up: ${ep.eliminated}.` : `Voted out: ${ep.eliminated}`),
    )) : [h('p', { class: 'empty' }, 'No councils yet. Run day 1 to hold the first immunity challenge and vote.')]));

    const talks = [...g.conversations].reverse().slice(0, 40);
    $('talks').replaceChildren(...(talks.length ? talks.map((c) => h('div', { class: 'entry' },
      h('h3', {}, `Day ${c.day}: ${c.with.join(' and ')}`),
      c.messages.map((m) => h('p', {}, h('strong', {}, `${m.speaker}: `), m.text)),
    )) : [h('p', { class: 'empty' }, 'Private talks start after day 1. Each castaway spends its own token budget to talk to whoever it chooses.')]));
  }

  // ---------- Actions ----------
  function removeCustom(id) {
    state.custom = state.custom.filter((c) => c.id !== id);
    state.selected.delete(id);
    delete state.photos[id];
    save('ic.custom', state.custom);
    save('ic.photos', state.photos);
    renderCast();
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('f-name').value.trim();
    const bio = $('f-bio').value.trim();
    const personality = $('f-personality').value.trim();
    const stats = Object.fromEntries(STATS.map((k) => [k, Number($(`f-${k}`).value)]));
    if (!name || !bio || !personality) return say('form-msg', 'Fill in a name, background and personality.', true);
    if (allCast().some((c) => c.name.toLowerCase() === name.toLowerCase())) return say('form-msg', `There is already a castaway named ${name}.`, true);
    const bad = STATS.find((k) => !Number.isInteger(stats[k]) || stats[k] < 1 || stats[k] > 10);
    if (bad) return say('form-msg', `${bad[0].toUpperCase() + bad.slice(1)} must be a whole number from 1 to 10.`, true);

    const id = `custom-${Date.now().toString(36)}`;
    const file = $('f-photo').files[0];
    if (file) {
      try {
        state.photos[id] = await readPhoto(file);
        save('ic.photos', state.photos);
      } catch (err) {
        return say('form-msg', err.message, true);
      }
    }
    state.custom.push({ id, name, bio, personality, stats });
    state.selected.add(id);
    save('ic.custom', state.custom);
    save('ic.selected', [...state.selected]);
    e.target.reset();
    renderCast();
    say('form-msg', `${name} joined the cast and is selected for the next game.`);
  });

  $('start').addEventListener('click', () => {
    const cast = allCast().filter((c) => state.selected.has(c.id));
    const budget = Number($('budget').value);
    if (!Number.isInteger(budget) || budget < 50 || budget > 2000) return say('start-msg', 'Set a talk budget from 50 to 2000 tokens.', true);
    try {
      state.game = newGame(cast, budget);
    } catch (err) {
      return say('start-msg', err.message, true);
    }
    state.endArmed = false;
    save('ic.game', state.game);
    say('start-msg', `New game started with ${cast.length} castaways.`);
    say('game-msg', 'Run day 1 for the first immunity challenge and tribal council.');
    renderGame();
    $('game').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('next').addEventListener('click', async () => {
    if (!state.game || state.running) return;
    const ctl = new AbortController();
    state.running = ctl;
    state.endArmed = false;
    // Run on a copy so a failed or stopped episode leaves the saved game as it was.
    const draft = structuredClone(state.game);
    renderGame();
    const live = state.mode === 'ai';
    const ctx = {
      talk: $('talk').checked,
      ask: (turn) => (live ? serverAsk(turn, ctl.signal) : Promise.resolve(scripted(turn))),
      progress: (text) => { $('game-msg').textContent = text; $('game-msg').className = 'msg progress'; },
    };
    try {
      const ep = await runEpisode(draft, ctx);
      state.game = draft;
      save('ic.game', draft);
      say('game-msg', ep.type === 'finale' ? `The jury has voted. ${ep.winner} wins.` : `Day ${ep.day} is over. ${ep.eliminated} was voted out.`);
    } catch (err) {
      say('game-msg', episodeError(err), err?.name !== 'AbortError');
    } finally {
      state.running = null;
      renderGame();
      if (live) noteMode();
    }
  });

  function episodeError(err) {
    if (err?.name === 'AbortError') return 'Stopped. Nothing from that episode was kept.';
    if (err?.status === 401) return 'This link is not valid any more. Ask the host for the current link.';
    if (err?.status === 429) return `${err.message} Nothing from that episode was kept. Switch to scripted mode to keep playing for free.`;
    if (err?.status === 503) return 'The host has not set an API key. Switch to scripted mode to keep playing.';
    return `The episode failed and nothing was kept: ${err?.message || 'unknown error'} Run it again.`;
  }

  $('stop').addEventListener('click', () => state.running?.abort());
  $('end').addEventListener('click', () => {
    if (!state.endArmed) { state.endArmed = true; renderGame(); return; }
    state.game = null;
    state.endArmed = false;
    save('ic.game', null);
    renderGame();
  });
  $('mode-ai').addEventListener('click', () => { if (state.server?.mode === 'live') { state.mode = 'ai'; noteMode(); } });
  $('mode-demo').addEventListener('click', () => { state.mode = 'demo'; noteMode(); });

  renderCast();
  renderGame();
  fetch('/api/status')
    .then((res) => (res.ok ? res.json() : null))
    .then((status) => {
      state.server = status;
      if (status?.mode === 'live') state.mode = 'ai';
    })
    .catch(() => {})
    .finally(() => { noteMode(); renderGame(); });
})();

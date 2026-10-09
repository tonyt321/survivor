import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCharacters, validateCharacter } from './lib/characters.js';
import { createGame, runEpisode } from './lib/engine.js';
import { hasApiKey, modelName } from './lib/llm.js';
import { createStore } from './lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Body must be valid JSON.');
  }
}

function sendJson(res, status, data) {
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Not found.');
  let data;
  try {
    data = await readFile(file);
  } catch {
    throw httpError(404, 'Not found.');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(data);
}

// llm defaults to the real Claude client; tests pass a scripted one.
export async function createServer({ dataFile = path.join(here, 'data', 'store.json'), llm } = {}) {
  const store = createStore(dataFile);
  const state = await store.load();
  let busy = false;

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/status') {
      return sendJson(res, 200, {
        mode: hasApiKey() ? 'live' : 'demo',
        model: modelName(),
        hasGame: Boolean(state.game),
      });
    }

    if (route === 'GET /api/characters') {
      return sendJson(res, 200, { characters: allCharacters(state.characters) });
    }

    if (route === 'POST /api/characters') {
      const character = validateCharacter(await readBody(req), allCharacters(state.characters));
      state.characters.push(character);
      await store.save(state);
      return sendJson(res, 201, { character: { ...character, custom: true } });
    }

    const deleteMatch = url.pathname.match(/^\/api\/characters\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1]);
      const index = state.characters.findIndex((c) => c.id === id);
      if (index === -1) throw httpError(404, 'Only custom castaways can be deleted.');
      state.characters.splice(index, 1);
      await store.save(state);
      return sendJson(res, 204);
    }

    if (route === 'GET /api/game') {
      return sendJson(res, 200, { game: state.game });
    }

    if (route === 'POST /api/games') {
      const body = await readBody(req);
      const all = allCharacters(state.characters);
      const ids = Array.isArray(body.characterIds) ? body.characterIds : [];
      const cast = ids.map((id) => all.find((c) => c.id === id));
      if (cast.some((c) => !c)) throw httpError(400, 'One of the selected castaways does not exist.');

      const tokens = Number(body.tokensPerIntermission ?? 600);
      if (!Number.isInteger(tokens) || tokens < 50 || tokens > 5000) {
        throw httpError(400, 'Talk budget must be a whole number from 50 to 5000 tokens.');
      }

      try {
        state.game = createGame({ cast, tokensPerIntermission: tokens });
      } catch (err) {
        throw httpError(400, err.message);
      }
      await store.save(state);
      return sendJson(res, 201, { game: state.game });
    }

    if (route === 'POST /api/game/episode') {
      if (!state.game) throw httpError(404, 'Start a game first.');
      if (state.game.phase !== 'playing') throw httpError(409, 'This game is already over.');
      if (busy) throw httpError(409, 'An episode is already running.');

      const body = await readBody(req);
      // Run on a copy so a failed API call leaves the saved game untouched.
      const draft = structuredClone(state.game);
      busy = true;
      try {
        await runEpisode(draft, { llm, talk: body.talk !== false });
      } catch (err) {
        throw httpError(502, `Episode failed, nothing was saved: ${err.message}`);
      } finally {
        busy = false;
      }
      state.game = draft;
      await store.save(state);
      return sendJson(res, 200, { game: draft, episode: draft.episodes.at(-1) });
    }

    if (route === 'POST /api/game/reset') {
      state.game = null;
      await store.save(state);
      return sendJson(res, 204);
    }

    throw httpError(404, 'Not found.');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET') await serveStatic(res, url.pathname);
      else throw httpError(405, 'Method not allowed.');
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      if (!res.headersSent) {
        sendJson(res, status, { error: err.message });
      }
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7965);
  const host = process.env.HOST || '127.0.0.1';
  const server = await createServer();
  server.listen(port, host, () => {
    const mode = hasApiKey() ? `live Claude agents (${modelName()})` : 'demo mode, no ANTHROPIC_API_KEY set';
    console.log(`Island Castaways on http://${host}:${port}: ${mode}`);
  });
}

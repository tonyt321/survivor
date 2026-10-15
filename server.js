import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultLlm from './lib/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const TOKEN_FILE = path.join(here, 'data', 'access-token');
const COOKIE = 'ic_token';
const MAX_BODY = 64 * 1024;
const MAX_SYSTEM = 3000;
const MAX_PROMPT = 8000;
const MAX_OUTPUT_TOKENS = 300;
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const LOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Island Castaways</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 16px;line-height:1.5">
<h1>This game is private</h1><p>Open the full link the host sent you. It ends in <code>?t=</code> followed by a long code.</p>
</body></html>`;

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

// Loads the saved access token, or makes a new random one the first time.
export async function loadOrCreateToken(file = TOKEN_FILE) {
  try {
    const saved = (await readFile(file, 'utf8')).trim();
    if (saved) return saved;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

// Everything, page included, needs the token: from ?t= on the link (which then
// moves into a cookie) or from the cookie on later requests.
export function createServer({
  accessToken,
  llm = defaultLlm,
  live = defaultLlm.hasApiKey(),
  dailyLimit = Number(process.env.DAILY_CALL_LIMIT || 1500),
} = {}) {
  if (!accessToken || accessToken.length < 16) throw new Error('An access token of at least 16 characters is required.');
  const tokenHash = createHash('sha256').update(accessToken).digest();
  const usage = { day: '', calls: 0 };

  const tokenMatches = (candidate) =>
    typeof candidate === 'string' && candidate.length > 0 &&
    timingSafeEqual(createHash('sha256').update(candidate).digest(), tokenHash);

  function callsToday() {
    const today = new Date().toISOString().slice(0, 10);
    if (usage.day !== today) {
      usage.day = today;
      usage.calls = 0;
    }
    return usage.calls;
  }

  async function agent(req, res) {
    if (!live) throw httpError(503, 'The host has not set an API key, so only scripted play is available.');
    const body = await readBody(req);
    const system = typeof body.system === 'string' ? body.system : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const maxTokens = Number(body.maxTokens);
    if (!prompt) throw httpError(400, 'A prompt is required.');
    if (system.length > MAX_SYSTEM || prompt.length > MAX_PROMPT) throw httpError(400, 'That turn is too long.');
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) {
      throw httpError(400, `maxTokens must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}.`);
    }
    if (callsToday() >= dailyLimit) {
      throw httpError(429, `Today's limit of ${dailyLimit} Claude calls is used up. It resets at midnight UTC.`);
    }

    usage.calls += 1;
    let result;
    try {
      result = await llm.complete({ system, prompt, maxTokens, fallback: () => '' });
    } catch (err) {
      throw httpError(502, err.message);
    }
    return sendJson(res, 200, {
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      callsToday: usage.calls,
    });
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const linkToken = url.searchParams.get('t');
      if (linkToken !== null) {
        if (!tokenMatches(linkToken)) throw httpError(401, 'This link is not valid.');
        // Swap the token in the address bar for a cookie, so it is not left in history.
        url.searchParams.delete('t');
        res.writeHead(302, {
          location: url.pathname + url.search,
          'set-cookie': `${COOKIE}=${encodeURIComponent(linkToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
          'referrer-policy': 'no-referrer',
        });
        return res.end();
      }

      if (!tokenMatches(readCookie(req, COOKIE) ?? req.headers['x-access-token'])) {
        throw httpError(401, 'This game is private. Open the full link the host sent you.');
      }

      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/status') {
        return sendJson(res, 200, {
          mode: live ? 'live' : 'demo',
          model: defaultLlm.modelName(),
          dailyLimit,
          callsToday: callsToday(),
        });
      }
      if (route === 'POST /api/agent') return await agent(req, res);
      if (url.pathname.startsWith('/api/')) throw httpError(404, 'Not found.');
      if (req.method !== 'GET') throw httpError(405, 'Method not allowed.');
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      if (res.headersSent) return;
      if (status === 401 && !url.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(LOCKED_PAGE);
      }
      sendJson(res, status, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7965);
  const host = process.env.HOST || '0.0.0.0';
  const accessToken = process.env.ACCESS_TOKEN || (await loadOrCreateToken());
  const server = createServer({ accessToken });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'YOUR-SERVER-ADDRESS' : host;
    const mode = defaultLlm.hasApiKey()
      ? `Claude agents on (${defaultLlm.modelName()})`
      : 'scripted only, set ANTHROPIC_API_KEY to turn on Claude agents';
    console.log(`Island Castaways is running: ${mode}.`);
    console.log(`Share this link. Anyone who has it can play:\n  http://${shown}:${port}/?t=${accessToken}`);
  });
}

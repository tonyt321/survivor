# Island Castaways

A Survivor-style game where every castaway is their own Claude agent, with their own stats, personality, and talk budget.

## Run it

Needs Node 20 or newer. There are no dependencies to install.

```bash
# Demo mode (free, scripted lines, no API key)
npm start

# Live mode (each castaway is a real Claude agent, billed to your API credits)
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Open http://127.0.0.1:3000.

Optional settings: `ANTHROPIC_MODEL` (default `claude-haiku-5-5`), `PORT` (default 3000), `HOST` (default 127.0.0.1).

## How a game works

1. Pick 4 to 20 castaways, or add your own with a name, background, personality and four stats (physical, mental, social, strategy).
2. Each episode: an immunity challenge (physical + mental + luck), then every castaway's agent votes someone out with a one-line confessional.
3. Between episodes, every castaway gets a token budget for private talks. They choose who to talk to, and the other castaway's agent replies from its own budget.
4. When two are left, the jury (everyone voted out) picks the winner.

The page shows how many Claude calls and tokens the game has used so far.

## Tests

```bash
npm test
```

Tests run without an API key and make no real API calls.

## Before putting it on the internet

Anyone who can open the page can run episodes and spend your credits. Keep it on 127.0.0.1, or add a login, before hosting it publicly.

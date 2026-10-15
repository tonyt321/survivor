# Island Castaways

A Survivor-style game where every castaway is their own Claude agent, with their own stats, personality, photo and talk budget.

## Run it

Needs Node 20 or newer. There is nothing to install.

```bash
ANTHROPIC_API_KEY=sk-ant-your-key npm start
```

It prints a link like this:

```
http://YOUR-SERVER-ADDRESS:7965/?t=Xb3k...long-random-code...
```

Replace `YOUR-SERVER-ADDRESS` with your server's IP or hostname and send the link to your friends. There is no login: anyone who has the full link can play. Anyone without it gets a "This game is private" page.

The first time a player opens the link, the code moves out of the address bar into a cookie, so it isn't left in their browser history.

Without `ANTHROPIC_API_KEY` the game still works, with scripted lines instead of Claude.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Turns on Claude agents, paid from your API credits. |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Which Claude model plays the castaways. |
| `DAILY_CALL_LIMIT` | `1500` | The most Claude calls the server makes per day (UTC), for everyone together. |
| `ACCESS_TOKEN` | random | The code in the link. If you don't set one, a random one is made once and saved in `data/access-token`. |
| `PORT` | `7965` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to listen on. |

**To cut off an old link**, delete `data/access-token` (or change `ACCESS_TOKEN`) and restart. A new link is printed.

## How a game works

1. Pick 4 to 20 castaways, or add your own with a name, background, personality, photo and four stats (physical, mental, social, strategy).
2. Each episode: an immunity challenge (physical + mental + luck), then every castaway's agent votes someone out with a one-line confessional.
3. Between episodes, every castaway gets a token budget for private talks. They choose who to talk to, and the other castaway replies from its own budget.
4. When two are left, the jury (everyone voted out) picks the winner.

Each player's games, custom castaways and photos are saved in their own browser.

## Cost

A game with 10 castaways is roughly 150 Claude calls with private talks on, or about 60 with them off. The daily limit stops spending when it is reached. Your API credits never go negative: when they run out, Claude calls fail until the next month's credits arrive.

## Tests

```bash
npm test
```

Tests make no real API calls.

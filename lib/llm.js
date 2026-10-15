// Thin wrapper around the Anthropic Messages API. Each castaway's turn goes
// through complete(). With no API key it returns scripted lines instead, so the
// whole game can run (and be tested) without spending credits.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 60_000;

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function modelName() {
  return process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
}

export function scripted(fallback) {
  const text = fallback();
  return { text, inputTokens: 0, outputTokens: Math.ceil(text.length / 4), mock: true };
}

export async function complete({
  system,
  prompt,
  maxTokens,
  fallback,
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = fetch,
}) {
  if (!apiKey) return scripted(fallback);

  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: modelName(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    mock: false,
  };
}

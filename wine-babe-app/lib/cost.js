// Per scan cost tracking. Prices are US dollars per million tokens, from
// Anthropic's published pricing (Nov 2026). Web search is $10 per 1,000
// searches; web fetch has no charge beyond the tokens it adds.

const PRICES = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const DEFAULT_PRICE = PRICES["claude-sonnet-5-5"];
const SEARCH_PRICE = 10 / 1000;

function priceFor(model) {
  const key = Object.keys(PRICES).find((k) => String(model || "").startsWith(k));
  return key ? PRICES[key] : DEFAULT_PRICE;
}

function createUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0, fetches: 0, tokenDollars: 0 };
}

// Adds one API response's usage. Safe to call with no accumulator or no usage.
function addUsage(acc, msg) {
  const u = msg && msg.usage;
  if (!acc || !u) return;
  const p = priceFor(msg.model);
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  acc.calls += 1;
  acc.inputTokens += inp;
  acc.outputTokens += out;
  acc.cacheReadTokens += cr;
  acc.cacheWriteTokens += cw;
  acc.searches += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  acc.fetches += (u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0;
  acc.tokenDollars += (inp * p.in + out * p.out + cr * p.cacheRead + cw * p.cacheWrite) / 1e6;
}

function summarizeUsage(acc) {
  const searchDollars = acc.searches * SEARCH_PRICE;
  const round = (n) => Math.round(n * 10000) / 10000;
  return {
    calls: acc.calls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    searches: acc.searches,
    fetches: acc.fetches,
    tokenDollars: round(acc.tokenDollars),
    searchDollars: round(searchDollars),
    dollars: round(acc.tokenDollars + searchDollars),
  };
}

module.exports = { createUsage, addUsage, summarizeUsage, priceFor };

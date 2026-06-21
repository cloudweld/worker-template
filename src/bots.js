/**
 * Default bot UA registry. Mirrors packages/sdk/src/bots.js. The live registry
 * is fetched at runtime from /api/public/bots and cached in KV (when the
 * OOKY_BOT_CACHE binding is configured) or in memory otherwise.
 */

export const DEFAULT_BOTS = [
  { name: "GPTBot", pattern: "GPTBot", category: "ai" },
  { name: "ChatGPT-User", pattern: "ChatGPT-User", category: "ai" },
  { name: "OAI-SearchBot", pattern: "OAI-SearchBot", category: "ai" },
  { name: "Anthropic", pattern: "anthropic-ai", category: "ai" },
  { name: "ClaudeBot", pattern: "ClaudeBot", category: "ai" },
  { name: "Claude-Web", pattern: "Claude-Web", category: "ai" },
  { name: "Google-Extended", pattern: "Google-Extended", category: "ai" },
  { name: "GoogleOther", pattern: "GoogleOther", category: "ai" },
  { name: "Googlebot-Extended", pattern: "Googlebot-Extended", category: "ai" },
  { name: "Googlebot", pattern: "Googlebot", category: "search" },
  { name: "Applebot-Extended", pattern: "Applebot-Extended", category: "ai" },
  { name: "Applebot", pattern: "Applebot", category: "search" },
  { name: "Meta-ExternalAgent", pattern: "meta-externalagent", category: "ai" },
  { name: "Meta-ExternalFetcher", pattern: "Meta-ExternalFetcher", category: "ai" },
  { name: "FacebookBot", pattern: "FacebookBot", category: "social" },
  { name: "facebookexternalhit", pattern: "facebookexternalhit", category: "social" },
  { name: "Bingbot", pattern: "bingbot", category: "search" },
  { name: "Perplexity", pattern: "PerplexityBot", category: "ai" },
  { name: "YouBot", pattern: "YouBot", category: "ai" },
  { name: "CCBot", pattern: "CCBot", category: "ai" },
  { name: "Cohere", pattern: "cohere-ai", category: "ai" },
  { name: "Diffbot", pattern: "Diffbot", category: "ai" },
  { name: "Bytespider", pattern: "Bytespider", category: "ai" },
  { name: "Amazonbot", pattern: "Amazonbot", category: "search" },
  { name: "AI2Bot", pattern: "AI2Bot", category: "ai" },
  { name: "ImagesiftBot", pattern: "ImagesiftBot", category: "ai" },
  { name: "Timesbot", pattern: "Timesbot", category: "ai" },
  { name: "iaskspider", pattern: "iaskspider", category: "ai" },
  { name: "Twitterbot", pattern: "Twitterbot", category: "social" },
  { name: "Slurp", pattern: "Slurp", category: "search" },
  { name: "DuckDuckBot", pattern: "DuckDuckBot", category: "search" },
  { name: "ia_archiver", pattern: "ia_archiver", category: "other" },
];

const KV_KEY = "ooky:bot_registry";
const KV_TTL_S = 3600;

let memoryRegistry = DEFAULT_BOTS;
let memoryExpiresAt = 0;
const MEMORY_TTL_MS = 5 * 60 * 1000;

/**
 * Get the registry. Checks memory first, then KV (if bound), then falls back
 * to refreshing from /api/public/bots and caching the result.
 */
export async function getRegistry(env, ctx) {
  if (Date.now() < memoryExpiresAt) return memoryRegistry;

  if (env.OOKY_BOT_CACHE) {
    const cached = await env.OOKY_BOT_CACHE.get(KV_KEY, "json");
    if (Array.isArray(cached) && cached.length > 0) {
      memoryRegistry = cached;
      memoryExpiresAt = Date.now() + MEMORY_TTL_MS;
      return cached;
    }
  }

  // Refresh asynchronously so we don't block the current request. Return the
  // current (possibly stale) memory registry — the next request will use the
  // refreshed list.
  ctx.waitUntil(refreshRegistry(env));
  return memoryRegistry;
}

async function refreshRegistry(env) {
  try {
    const res = await fetch(`${env.OOKY_API_BASE}/public/bots`, {
      headers: { Accept: "application/json" },
      // A hung Ooky API must never stall the registry refresh (it runs on the
      // ctx.waitUntil() budget). Timeout instead of waiting indefinitely.
      signal: timeoutSignal(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data?.bots) || data.bots.length === 0) return;
    memoryRegistry = data.bots;
    memoryExpiresAt = Date.now() + MEMORY_TTL_MS;
    if (env.OOKY_BOT_CACHE) {
      await env.OOKY_BOT_CACHE.put(KV_KEY, JSON.stringify(data.bots), {
        expirationTtl: KV_TTL_S,
      });
    }
  } catch {
    // Network error — keep stale list.
  }
}

/**
 * Match a UA against the registry. Returns the bot row or null.
 * Defensive: a malformed registry row (missing/non-string pattern, returned
 * by a future backend change or a corrupted payload) is skipped rather than
 * throwing on the request hot path.
 */
export function detectBot(userAgent, registry) {
  if (!userAgent || typeof userAgent !== "string") return null;
  if (!Array.isArray(registry)) return null;
  const ua = userAgent.toLowerCase();
  for (const b of registry) {
    if (!b || typeof b.pattern !== "string" || b.pattern.length === 0) continue;
    if (ua.includes(b.pattern.toLowerCase())) return b;
  }
  return null;
}

/**
 * AbortSignal with a deadline, when the runtime supports it (Cloudflare
 * Workers do). Returns undefined otherwise so fetch falls back to no timeout
 * rather than crashing.
 */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

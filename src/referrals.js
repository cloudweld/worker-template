/**
 * AI referrer detection - identifies humans arriving from AI platforms by
 * Referer header or utm_source. Self-contained copy of worker/src/referrals.js
 * (the template must not import from other packages at runtime). When you add a
 * platform to one, add it to the other to keep the tiers in parity.
 */

const AI_REFERRERS = [
  { pattern: "chatgpt.com", source: "chatgpt" },
  { pattern: "chat.openai.com", source: "chatgpt" },
  { pattern: "perplexity.ai", source: "perplexity" },
  { pattern: "gemini.google.com", source: "gemini" },
  { pattern: "bard.google.com", source: "gemini" },
  { pattern: "copilot.microsoft.com", source: "copilot" },
  { pattern: "bing.com/chat", source: "copilot" },
  { pattern: "claude.ai", source: "claude" },
  { pattern: "meta.ai", source: "meta_ai" },
  { pattern: "grok.x.ai", source: "grok" },
  { pattern: "you.com", source: "you" },
  { pattern: "phind.com", source: "phind" },
  { pattern: "deepseek.com", source: "deepseek" },
];

const UTM_SOURCES = [
  { value: "chatgpt", source: "chatgpt" },
  { value: "openai", source: "chatgpt" },
  { value: "perplexity", source: "perplexity" },
  { value: "gemini", source: "gemini" },
  { value: "copilot", source: "copilot" },
  { value: "claude", source: "claude" },
  { value: "meta_ai", source: "meta_ai" },
  { value: "grok", source: "grok" },
  { value: "you", source: "you" },
  { value: "phind", source: "phind" },
  { value: "deepseek", source: "deepseek" },
];

/**
 * Detect if a human request was referred from an AI platform.
 *
 * @param {Request} request - The incoming request
 * @param {URL} url - Parsed URL
 * @returns {{ source: string, referrerUrl: string|null, method: string } | null}
 */
export function detectAIReferral(request, url) {
  // Check Referer header
  const referer = request.headers.get("Referer") || request.headers.get("Referrer") || "";
  if (referer) {
    const refererLower = referer.toLowerCase();
    for (const entry of AI_REFERRERS) {
      if (refererLower.includes(entry.pattern)) {
        return {
          source: entry.source,
          referrerUrl: referer,
          method: "referer_header",
        };
      }
    }
  }

  // Check UTM params
  const utmSource = (url.searchParams.get("utm_source") || "").toLowerCase();
  if (utmSource) {
    for (const entry of UTM_SOURCES) {
      if (utmSource === entry.value) {
        return {
          source: entry.source,
          referrerUrl: null,
          method: "utm_param",
        };
      }
    }
  }

  return null;
}

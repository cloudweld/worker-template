/**
 * Ooky Worker Template - deploy to your own Cloudflare account.
 *
 * For every request to your domain:
 *   - Detects AI bots by User-Agent and fires a non-blocking bot event.
 *   - Detects humans arriving from AI platforms (ChatGPT/Perplexity/…) and
 *     fires an ai_referral event so the dashboard's attribution lands.
 *   - Serves the well-known AI URLs (/llms.txt, /agents.md, the AI manifest,
 *     and the MCP endpoint) from Ooky's public CDN.
 *   - Passes all other traffic through to your origin unchanged.
 *
 * What this tier does NOT do (those are Full-DNS-tier differentiators):
 *   - It does not rewrite your human HTML or inject JSON-LD for bots - bots
 *     hitting normal pages get your origin's response, not a distilled doc.
 *   - It does not do IP-CIDR / reverse-DNS bot verification (UA-only).
 *   See the README "What this tier does and does NOT do" section.
 */

import { detectBot, getRegistry, isDistillableBot } from "./bots.js";
import { detectAIReferral } from "./referrals.js";
import { handleMcpInvocation, filterBrandSection, McpToolError } from "./mcp.js";

const TEMPLATE_VERSION = "0.1.0";

// Placeholder value shipped in wrangler.toml. If it survives to runtime the
// customer never set their real domain, so the manifest endpoints can't work.
const DOMAIN_PLACEHOLDER = "YOUR_DOMAIN";

const PATH_MAP = {
  "/llms.txt": "llms",
  "/llms-full.txt": "llms-full",
  "/.well-known/ai-manifest.json": "manifest",
  "/ai-manifest.json": "manifest",
  "/agents.md": "agents",
  "/.well-known/mcp": "mcp",
  "/mcp": "mcp",
};

const CONTENT_TYPE = {
  llms: "text/plain; charset=utf-8",
  "llms-full": "text/plain; charset=utf-8",
  manifest: "application/json; charset=utf-8",
  agents: "text/markdown; charset=utf-8",
  mcp: "application/json; charset=utf-8",
};

// Module-level last-good manifest cache, keyed by kind. Persists for the life
// of the isolate and is served when the upstream returns a 5xx or times out,
// mirroring the SDK's stale-serve intent so a transient Ooky outage doesn't
// break /llms.txt for AI crawlers.
const lastGoodManifest = new Map(); // kind → { body, contentType }

function matchPath(pathname) {
  return PATH_MAP[pathname] || null;
}

/** Test-only: clear the module-level last-good manifest cache between tests. */
export function __resetManifestCache() {
  lastGoodManifest.clear();
}

/** True when OOKY_DOMAIN is unset, empty, or still the shipped placeholder. */
function isDomainConfigured(env) {
  const d = env.OOKY_DOMAIN;
  return typeof d === "string" && d.length > 0 && d !== DOMAIN_PLACEHOLDER;
}

/**
 * AbortSignal with a deadline, when the runtime supports it (Cloudflare
 * Workers do). Returns undefined otherwise so fetch falls back to no timeout.
 */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

// ─── Per-page cleaned-HTML serving (the takeover) ──────────────────────────
// A detected bot on a content page is served the published, parity-gated
// "cleaned HTML" for that path in place of origin - the same distillation the
// managed edge Worker serves. A customer-deployed Worker has no R2 binding, so
// it reads the artifact from Ooky's bearer-authed per-page API instead (the
// same source the SDK and WordPress plugin use). Humans always pass through.

// Asset / non-document paths never get the takeover. Mirrors @ooky/sdk.
const ASSET_PATH_RE =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf|zip|gz|tgz|rar|json|xml|rss|atom|txt|wasm|csv|webmanifest)$/i;

function isAssetPath(path) {
  if (typeof path !== "string") return false;
  const clean = path.split("?")[0].split("#")[0];
  return ASSET_PATH_RE.test(clean);
}

// Empty/absent Accept counts as "wants HTML" (common for AI crawlers).
function acceptWantsHtml(accept) {
  const a = (typeof accept === "string" ? accept : "").toLowerCase();
  if (a === "") return true;
  return a.includes("text/html") || a.includes("*/*");
}

/**
 * Fetch the published cleaned HTML for a content path from Ooky's bearer-authed
 * per-page API. Returns the HTML string, or null when there's nothing to serve
 * (feature off / nothing published → 204, missing key, or any failure). Never
 * throws - a fetch problem must fall through to the customer's origin.
 */
async function fetchCleanedHtml(path, env) {
  if (!env.OOKY_API_KEY) return null;
  const url = `${env.OOKY_API_BASE}/public/page/cleaned-html?path=${encodeURIComponent(path)}`;
  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${env.OOKY_API_KEY}` },
      signal: timeoutSignal(8000),
    });
    if (upstream.status !== 200) return null; // 204 = feature off / nothing published
    const html = await upstream.text();
    return html && html.length > 0 ? html : null;
  } catch {
    return null; // network/timeout → origin passthrough
  }
}

/**
 * Fetch a manifest kind from Ooky's public CDN.
 * Returns { ok, status, body, contentType } - never throws.
 */
async function fetchManifest(kind, env) {
  const url = `${env.OOKY_API_BASE}/public/manifest/${encodeURIComponent(env.OOKY_DOMAIN)}/${kind}`;
  try {
    const upstream = await fetch(url, {
      // Don't cache error responses at the edge - a pre-publish 404 must not
      // stick for 5 minutes after the customer publishes. Only 2xx is cached.
      cf: { cacheTtlByStatus: { "200-299": 300, "404": 0, "500-599": 0 } },
      signal: timeoutSignal(8000),
    });
    const body = await upstream.text();
    return {
      ok: upstream.ok,
      status: upstream.status,
      body,
      contentType: upstream.headers.get("content-type") || CONTENT_TYPE[kind],
    };
  } catch (err) {
    // Timeout / network error - signalled as a synthetic 5xx so the caller
    // can fall back to the last-good cache.
    return { ok: false, status: 599, body: null, contentType: null, error: err };
  }
}

async function serveManifest(kind, env) {
  const result = await fetchManifest(kind, env);

  if (result.ok) {
    lastGoodManifest.set(kind, { body: result.body, contentType: CONTENT_TYPE[kind] });
    return new Response(result.body, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPE[kind],
        "Cache-Control": "public, max-age=300, s-maxage=600",
        "X-Ooky-Worker": "byo",
      },
    });
  }

  // Upstream failure. On a 5xx/timeout, serve the last-good copy if we have one
  // so AI crawlers keep getting intelligence through a transient Ooky outage.
  if (result.status >= 500) {
    const stale = lastGoodManifest.get(kind);
    if (stale) {
      return new Response(stale.body, {
        status: 200,
        headers: {
          "Content-Type": stale.contentType,
          "Cache-Control": "public, max-age=60",
          "X-Ooky-Worker": "byo",
          "X-Ooky-Stale": "1",
        },
      });
    }
  }

  // No stale copy (or a 4xx like a pre-publish 404) - propagate the status.
  return new Response(`Manifest unavailable (${result.status})`, {
    status: result.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Fetch the JSON manifest for the MCP get_brand_info tool. Throws McpToolError
 * when intelligence isn't available so the tool reports it in-band.
 */
async function getBrandInfo(env, args) {
  const result = await fetchManifest("manifest", env);
  if (!result.ok || result.body == null) {
    // Fall back to last-good on a transient failure.
    const stale = lastGoodManifest.get("manifest");
    if (stale && stale.body) {
      try {
        return filterBrandSection(JSON.parse(stale.body), args?.section);
      } catch {
        /* fall through */
      }
    }
    throw new McpToolError("Brand information not available");
  }
  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new McpToolError("Brand information not available");
  }
  lastGoodManifest.set("manifest", { body: result.body, contentType: CONTENT_TYPE.manifest });
  return filterBrandSection(parsed, args?.section);
}

/**
 * Handle a request to the MCP endpoint (/mcp or /.well-known/mcp).
 *  - OPTIONS → CORS preflight.
 *  - POST    → JSON-RPC / legacy tool invocation.
 *  - GET     → static descriptor from the public CDN (mcp kind).
 */
async function serveMcp(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (request.method === "POST") {
    let body = null;
    try {
      body = await request.json();
    } catch {
      // null → JSON-RPC parse error, surfaced by handleMcpInvocation.
      body = null;
    }
    const { status, headers, body: respBody } = await handleMcpInvocation(body, {
      domain: env.OOKY_DOMAIN,
      version: TEMPLATE_VERSION,
      getBrandInfo: (args) => getBrandInfo(env, args),
    });
    return new Response(respBody === null ? null : JSON.stringify(respBody), { status, headers });
  }

  // GET / other → static descriptor.
  return serveManifest("mcp", env);
}

/** Build the manifest-misconfigured response (loud 500). */
function misconfiguredManifestResponse() {
  return new Response(
    "Ooky Worker is misconfigured: OOKY_DOMAIN is unset or still the " +
      `"${DOMAIN_PLACEHOLDER}" placeholder. Set OOKY_DOMAIN in wrangler.toml [vars] ` +
      "to the domain you registered in the Ooky dashboard, then redeploy. " +
      "AI manifest endpoints will 404/500 until this is fixed.",
    {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Ooky-Worker": "byo-misconfigured",
      },
    }
  );
}

/**
 * Runtime self-diagnostic. A clean `wrangler deploy` with no `routes` block
 * binds the Worker to *.workers.dev only - bound to ZERO of the customer's
 * routes, so it's a silent no-op for real traffic even though the Cloudflare
 * dashboard reports a successful deploy. We can detect that the request host
 * isn't the configured domain and explain it instead of failing silently.
 */
function healthResponse(url, env) {
  const host = url.hostname;
  const onWorkersDev = host.endsWith(".workers.dev");
  const domainConfigured = isDomainConfigured(env);
  const hostMatchesDomain = domainConfigured && host === env.OOKY_DOMAIN;

  const problems = [];
  if (onWorkersDev) {
    problems.push(
      "This Worker is being served on *.workers.dev, NOT your domain. A clean " +
        "`wrangler deploy` with no `routes` block (or the one-click button on " +
        "its own) does NOT bind the Worker to your site - it deploys to " +
        "*.workers.dev bound to zero customer routes, so it never sees real " +
        "traffic. Uncomment the `routes` block in wrangler.toml, set it to your " +
        "domain, and redeploy."
    );
  }
  if (!domainConfigured) {
    problems.push(
      `OOKY_DOMAIN is unset or still the "${DOMAIN_PLACEHOLDER}" placeholder. Set it ` +
        "in wrangler.toml [vars] to your registered Ooky domain and redeploy."
    );
  } else if (!hostMatchesDomain && !onWorkersDev) {
    problems.push(
      `The request host (${host}) does not match OOKY_DOMAIN (${env.OOKY_DOMAIN}). ` +
        "Manifest endpoints serve intelligence for OOKY_DOMAIN; if this Worker " +
        "fronts a different host, set OOKY_DOMAIN to match."
    );
  }
  if (!env.OOKY_API_KEY) {
    problems.push(
      "OOKY_API_KEY secret is not set. Run `wrangler secret put OOKY_API_KEY` " +
        "with your ooky_sk_* token so bot/referral events can be ingested."
    );
  }

  const report = {
    ok: problems.length === 0,
    worker: "ooky-worker-template",
    version: TEMPLATE_VERSION,
    host,
    served_on_workers_dev: onWorkersDev,
    ooky_domain: domainConfigured ? env.OOKY_DOMAIN : null,
    domain_configured: domainConfigured,
    api_key_set: Boolean(env.OOKY_API_KEY),
    bot_cache_kv_bound: Boolean(env.OOKY_BOT_CACHE),
    routes_wired: hostMatchesDomain,
    problems,
    next_steps: problems.length
      ? "Fix the problems above. The most common one is missing `routes` config - " +
        "see the README STEP 1."
      : "Healthy: this Worker is bound to your domain and configured.",
  };

  return new Response(JSON.stringify(report, null, 2), {
    status: report.ok ? 200 : 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Ooky-Worker": "byo",
    },
  });
}

function recordEvent(env, payload) {
  // Events need the ooky_sk_* token. If it isn't set, analytics are simply
  // disabled - manifest serving still works on OOKY_DOMAIN alone. No-op
  // (avoids a pointless `Bearer undefined` POST that would 401).
  if (!env.OOKY_API_KEY) return Promise.resolve();
  // Fire-and-forget. The request handler keeps this alive past the response
  // cycle with ctx.waitUntil().
  return fetch(`${env.OOKY_API_BASE}/ingest/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OOKY_API_KEY}`,
    },
    body: JSON.stringify(payload),
    // A hung Ooky API must not stall the ctx.waitUntil() budget.
    signal: timeoutSignal(5000),
  })
    .then((res) => {
      // A non-2xx is the one signal the customer has that their key was
      // rotated/revoked (401) or the payload drifted (400). A 401 never
      // reaches .catch(), so log it here.
      if (res && !res.ok) {
        console.warn(`[ooky] ingest responded ${res.status}`);
      }
      return res;
    })
    .catch(() => {
      // Best-effort - never throw on the request path.
    });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Self-diagnostic endpoint - always available, even when misconfigured,
    // so a customer can curl it to find out why the integration looks dead.
    if (url.pathname === "/__ooky/health") {
      return healthResponse(url, env);
    }

    // Manifest serving only needs OOKY_DOMAIN; the API key only gates event
    // analytics (recordEvent no-ops without it). So gate the loud-500 on the
    // DOMAIN alone - a domain-configured Worker still serves AI artifacts even
    // if the key is missing, rather than 500ing them.
    if (!isDomainConfigured(env)) {
      // Domain unconfigured. Human traffic must keep working, so pass normal
      // requests through. But the AI manifest paths can NOT work without a real
      // OOKY_DOMAIN - a silent 404 there makes the dashboard look "Connected"
      // while every AI artifact is broken, so be loud on exactly those paths.
      const kind = matchPath(url.pathname);
      if (kind) return misconfiguredManifestResponse();
      return fetch(request);
    }

    const ua = request.headers.get("user-agent") || "";
    const country = request.cf?.country;

    const registry = await getRegistry(env, ctx);
    const bot = detectBot(ua, registry);

    if (bot) {
      // verified=false - UA-only matching cannot prove bot identity. The
      // Ooky-hosted Worker (Full DNS tier) does IP-CIDR + reverse-DNS via
      // CF-Connecting-IP; a customer-deployed Worker doesn't have that
      // verification surface. The backend also enforces this server-side under
      // Bearer auth, but we're honest from the client too.
      ctx.waitUntil(
        recordEvent(env, {
          event_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          bot: { name: bot.name, verified: false, ua_string: ua },
          request: {
            page_path: url.pathname || "/",
            method: request.method || "GET",
          },
          geo: { country },
        })
      );
    } else {
      // Non-bot traffic: detect humans arriving from an AI platform so the
      // dashboard's "arrived from ChatGPT/Perplexity" attribution lands. The
      // backend routes ai_referral events into ai_referral_visits under the
      // same token auth this tier uses.
      const referral = detectAIReferral(request, url);
      if (referral) {
        ctx.waitUntil(
          recordEvent(env, {
            event_id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            event_type: "ai_referral",
            referral: {
              source: referral.source,
              referrer_url: referral.referrerUrl,
              detection_method: referral.method,
            },
            request: { page_path: url.pathname || "/" },
            geo: { country },
          })
        );
      }
    }

    const kind = matchPath(url.pathname);
    if (kind === "mcp") {
      return serveMcp(request, env);
    }
    if (kind) {
      return serveManifest(kind, env);
    }

    // Content page (not a well-known path). A detected AI bot is served the
    // distilled cleaned HTML in place of origin, if one is published; humans
    // always get the real page. Search/social crawlers (category !== "ai")
    // are excluded — the artifact replaces the page, so serving it to
    // Googlebot/Bingbot/link-preview bots would deindex the site; they fall
    // through to origin like a human (still logged above). Eligibility
    // mirrors the SDK + managed Worker: GET document navigations only, never
    // assets or non-HTML clients. The per-page API returns 204 when the
    // feature is off or nothing is published, so fetchCleanedHtml yields null
    // and we fall straight through to origin.
    if (bot && isDistillableBot(bot)) {
      const eligible =
        request.method === "GET" &&
        acceptWantsHtml(request.headers.get("accept")) &&
        !isAssetPath(url.pathname);
      if (eligible) {
        const cleaned = await fetchCleanedHtml(url.pathname || "/", env);
        if (cleaned) {
          return new Response(cleaned, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
              "X-Ooky-CleanedHtml": "1",
            },
          });
        }
      }
    }

    return fetch(request);
  },
};

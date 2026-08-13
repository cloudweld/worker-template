/**
 * Ooky Worker Template - deploy to your own Cloudflare account.
 *
 * For every request to your domain:
 *   - Detects AI bots by User-Agent and fires a non-blocking bot event.
 *   - Detects humans arriving from AI platforms (ChatGPT/Perplexity/…) and
 *     fires an ai_referral event so the dashboard's attribution lands.
 *   - Serves the well-known AI URLs (/llms.txt, /agents.md, the AI manifest,
 *     and the MCP endpoint) from Ooky's token-bound adapter API.
 *   - Serves eligible AI bots the published cleaned-HTML representation when
 *     available; otherwise passes the request through to origin.
 *
 * What this tier does NOT do (those are Full-DNS-tier differentiators):
 *   - It does not rewrite human origin HTML or inject JSON-LD into origin
 *     responses. Eligible AI bots can receive a complete distilled response.
 *   - It does not do IP-CIDR / reverse-DNS bot verification (UA-only).
 *   See the README "What this tier does and does NOT do" section.
 */

import { detectBot, getRegistry, isDistillableBot } from "./bots.js";
import { detectAIReferral } from "./referrals.js";
import { handleMcpInvocation, filterBrandSection, McpToolError } from "./mcp.js";

const TEMPLATE_VERSION = "0.1.1";
const MAX_MCP_BODY_BYTES = 64 * 1024;

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

const HOSTNAME_CLAIM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EDGE_NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]{0,254}$/;

function readArtifactOwnership(headers, expectedNonce) {
  const hostnameClaimId = headers?.get?.("x-ooky-hostname-claim") || "";
  const hostnameClaimGeneration = headers?.get?.("x-ooky-hostname-generation") || "";
  const edgeNamespace = headers?.get?.("x-ooky-edge-namespace") || "";
  const nonce = headers?.get?.("x-ooky-artifact-nonce") || "";
  if (!HOSTNAME_CLAIM_ID_RE.test(hostnameClaimId)) return null;
  if (!/^[1-9]\d{0,9}$/.test(hostnameClaimGeneration)) return null;
  if (!EDGE_NAMESPACE_RE.test(edgeNamespace)) return null;
  if (typeof expectedNonce !== "string" || nonce !== expectedNonce) return null;
  return { hostnameClaimId, hostnameClaimGeneration, edgeNamespace };
}

function artifactNonce() {
  return crypto.randomUUID().replaceAll("-", "");
}

function matchPath(pathname) {
  return PATH_MAP[pathname] || null;
}

/** Backward-compatible test hook; manifest bodies are deliberately not cached. */
export function __resetManifestCache() {
  // Hostname ownership can transfer while this isolate stays warm. Retaining
  // a previous owner's artifact would cross that terminal boundary.
}

/** True when OOKY_DOMAIN is unset, empty, or still the shipped placeholder. */
function isDomainConfigured(env) {
  const d = env.OOKY_DOMAIN;
  return typeof d === "string" && d.length > 0 && d !== DOMAIN_PLACEHOLDER;
}

function normalizeHostname(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
}

function requestMatchesConfiguredHostname(url, env) {
  return normalizeHostname(url?.hostname) === normalizeHostname(env.OOKY_DOMAIN);
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
    const nonce = artifactNonce();
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.OOKY_API_KEY}`,
        "X-Ooky-Artifact-Nonce": nonce,
      },
      cf: { cacheTtl: 0, cacheEverything: false },
      cache: "no-store",
      signal: timeoutSignal(8000),
    });
    if (upstream.status !== 200) return null; // 204 = feature off / nothing published
    if (!readArtifactOwnership(upstream.headers, nonce)) return null;
    const html = await upstream.text();
    return html && html.length > 0 ? html : null;
  } catch {
    return null; // network/timeout → origin passthrough
  }
}

/**
 * Fetch a manifest kind from Ooky's token-bound adapter API.
 * Returns { ok, status, body, contentType } - never throws.
 */
async function fetchManifest(kind, env) {
  const url = `${env.OOKY_API_BASE}/public/manifest/${encodeURIComponent(env.OOKY_DOMAIN)}/${kind}`;
  try {
    if (!env.OOKY_API_KEY) {
      return { ok: false, status: 401, body: null, contentType: null };
    }
    const nonce = artifactNonce();
    const upstream = await fetch(url, {
      // The URL stays stable when hostname ownership transfers. Bypass the
      // Workers cache for every status so a warm customer isolate cannot
      // replay the previous tenant's artifact.
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: {
        Authorization: `Bearer ${env.OOKY_API_KEY}`,
        "X-Ooky-Artifact-Nonce": nonce,
      },
      cache: "no-store",
      signal: timeoutSignal(8000),
    });
    const ownership = upstream.ok ? readArtifactOwnership(upstream.headers, nonce) : null;
    if (upstream.ok && !ownership) {
      return {
        ok: false,
        status: 502,
        body: null,
        contentType: null,
        error: new Error("manifest ownership could not be verified"),
      };
    }
    const body = await upstream.text();
    return {
      ok: upstream.ok,
      status: upstream.status,
      body,
      contentType: upstream.headers.get("content-type") || CONTENT_TYPE[kind],
      hostnameClaimId: ownership?.hostnameClaimId || null,
      hostnameClaimGeneration: ownership?.hostnameClaimGeneration || null,
      edgeNamespace: ownership?.edgeNamespace || null,
    };
  } catch (err) {
    // Timeout / network error - signalled as a synthetic 5xx. Never replay a
    // prior success because the hostname may have changed owners meanwhile.
    return { ok: false, status: 599, body: null, contentType: null, error: err };
  }
}

async function serveManifest(kind, env) {
  const result = await fetchManifest(kind, env);

  if (result.ok) {
    const headers = {
      "Content-Type": CONTENT_TYPE[kind],
      "Cache-Control": "private, no-store, max-age=0, s-maxage=0",
      "X-Ooky-Worker": "byo",
    };
    headers["X-Ooky-Hostname-Claim"] = result.hostnameClaimId;
    headers["X-Ooky-Hostname-Generation"] = result.hostnameClaimGeneration;
    headers["X-Ooky-Edge-Namespace"] = result.edgeNamespace;
    return new Response(result.body, {
      status: 200,
      headers,
    });
  }

  // Propagate failures. Availability fallback is the origin content path;
  // stale brand intelligence is never an ownership-safe fallback.
  return new Response(`Manifest unavailable (${result.status})`, {
    status: result.status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0, s-maxage=0",
    },
  });
}

/**
 * Fetch the JSON manifest for the MCP get_brand_info tool. Throws McpToolError
 * when intelligence isn't available so the tool reports it in-band.
 */
async function getBrandInfo(env, args) {
  const result = await fetchManifest("manifest", env);
  if (!result.ok || result.body == null) {
    throw new McpToolError("Brand information not available");
  }
  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new McpToolError("Brand information not available");
  }
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
    const parsed = await readBoundedJson(request, MAX_MCP_BODY_BYTES);
    if (!parsed.ok && parsed.error === "too_large") {
      return new Response(JSON.stringify({ error: "Request body too large" }), {
        status: 413,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    const { status, headers, body: respBody } = await handleMcpInvocation(parsed.ok ? parsed.value : null, {
      domain: env.OOKY_DOMAIN,
      version: TEMPLATE_VERSION,
      getBrandInfo: (args) => getBrandInfo(env, args),
    });
    return new Response(respBody === null ? null : JSON.stringify(respBody), { status, headers });
  }

  // GET / other → static descriptor.
  return serveManifest("mcp", env);
}

async function readBoundedJson(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, error: "too_large" };
  const reader = request.body?.getReader?.();
  if (!reader) return { ok: false, error: "invalid_json" };
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large").catch(() => {});
        return { ok: false, error: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
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

    // One Worker script is authorized for one canonical Ooky hostname. If a
    // legacy Cloudflare account reused a script name across routes, never let
    // the older route fetch, emit, or serve the newer tenant's artifacts.
    // Passthrough preserves the mismatched hostname's origin behavior.
    if (!requestMatchesConfiguredHostname(url, env)) {
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
    // assets or non-HTML clients. The per-page API returns 204 when nothing is
    // published, so fetchCleanedHtml yields null and we fall straight through
    // to origin.
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
              "Cache-Control": "private, no-store, max-age=0, s-maxage=0",
              Vary: "User-Agent",
              "X-Ooky-CleanedHtml": "1",
            },
          });
        }
      }
    }

    return fetch(request);
  },
};

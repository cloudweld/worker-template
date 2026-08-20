/**
 * Tests for the Worker template. Covers the happy path plus the real
 * production failure modes:
 *   - manifest serve + origin passthrough
 *   - bot event firing + geo population
 *   - AI-referral firing (human from ChatGPT/Perplexity)
 *   - ownership-safe no-cache manifest fetches
 *   - CDN 5xx/timeouts → propagate without prior-owner replay
 *   - pre-publish 404 propagates (and isn't cached)
 *   - YOUR_DOMAIN misconfig → loud 500 on manifest paths, passthrough elsewhere
 *   - MCP POST (initialize, tools/list, tools/call, parse error)
 *   - /__ooky/health self-diagnostic
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { __resetManifestCache } from "../src/index.js";
import {
  detectBot,
  DEFAULT_BOTS,
  MAX_BOT_REGISTRY_ENTRIES,
  sanitizeBotRegistry,
} from "../src/bots.js";

Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  value: () => "11111111-1111-4111-8111-111111111111",
});

function makeEnv(overrides = {}) {
  return {
    OOKY_API_KEY: "ooky_sk_TEST",
    OOKY_DOMAIN: "acme.com",
    OOKY_API_BASE: "https://api.example/api",
    ...overrides,
  };
}

function makeCtx() {
  return { waitUntil: vi.fn() };
}

const ARTIFACT_HEADERS = {
  "Content-Type": "text/plain",
  "X-Ooky-Hostname-Claim": "11111111-1111-4111-8111-111111111111",
  "X-Ooky-Hostname-Generation": "1",
  "X-Ooky-Edge-Namespace": "acme-com--fixture-g1",
  "X-Ooky-Artifact-Nonce": "11111111111141118111111111111111",
};

// In the real Workers runtime, request.cf is a runtime-injected property. The
// standard Request constructor doesn't honour a `cf` init option, so attach it
// explicitly for tests that assert geo population.
function withCf(request, cf) {
  Object.defineProperty(request, "cf", { value: cf, configurable: true });
  return request;
}

async function drain(ctx) {
  await Promise.allSettled(ctx.waitUntil.mock.calls.map((c) => c[0]));
}

describe("worker-template manifest serving", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetManifestCache();
  });

  it("serves /llms.txt by fetching the public manifest endpoint", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/manifest/acme.com/llms")) {
        return new Response("# Acme\n> intel", {
          status: 200,
          headers: ARTIFACT_HEADERS,
        });
      }
      throw new Error("Unexpected fetch: " + url);
    });

    const req = new Request("https://acme.com/llms.txt", {
      headers: { "user-agent": "Mozilla" },
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res.headers.get("x-ooky-worker")).toBe("byo");
    expect(await res.text()).toContain("# Acme");
  });

  it("bypasses the edge cache for every ownership-sensitive response", async () => {
    let capturedInit;
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedInit = init;
      return new Response("ok", { status: 200 });
    });
    await worker.fetch(
      new Request("https://acme.com/llms.txt"),
      makeEnv(),
      makeCtx()
    );
    expect(capturedInit.cf).toEqual({ cacheTtl: 0, cacheEverything: false });
    expect(capturedInit.cache).toBe("no-store");
    expect(capturedInit.headers.Authorization).toBe("Bearer ooky_sk_TEST");
    expect(capturedInit.headers["X-Ooky-Artifact-Nonce"]).toBe(
      "11111111111141118111111111111111"
    );
  });

  it("rejects a 200 artifact without a complete ownership proof", async () => {
    globalThis.fetch = vi.fn(async () => new Response("former owner", { status: 200 }));
    const res = await worker.fetch(
      new Request("https://acme.com/llms.txt"),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("former owner");
  });

  it("rejects a valid ownership tuple replayed for a different request nonce", async () => {
    globalThis.fetch = vi.fn(async () => new Response("former owner", {
      status: 200,
      headers: {
        ...ARTIFACT_HEADERS,
        "X-Ooky-Artifact-Nonce": "22222222222242228222222222222222",
      },
    }));
    const res = await worker.fetch(
      new Request("https://acme.com/llms.txt"),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("former owner");
  });

  it("falls through to origin for non-matching paths", async () => {
    const originBody = "<html>origin</html>";
    globalThis.fetch = vi.fn(async () => new Response(originBody, { status: 200 }));

    const req = new Request("https://acme.com/pricing", {
      headers: { "user-agent": "Mozilla" },
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(originBody);
  });

  it("passes a mismatched legacy shared-script hostname straight to origin", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (input) => {
      calls.push(input);
      return new Response("<html>other origin</html>", { status: 200 });
    });

    const res = await worker.fetch(
      new Request("https://other-tenant.example/llms.txt", {
        headers: { "user-agent": "GPTBot" },
      }),
      makeEnv({ OOKY_DOMAIN: "acme.com" }),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>other origin</html>");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(Request);
    expect(new URL(calls[0].url).hostname).toBe("other-tenant.example");
  });

  it("accepts www as the same canonical configured hostname", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/manifest/acme.com/llms")) {
        return new Response("# Acme", { status: 200, headers: ARTIFACT_HEADERS });
      }
      throw new Error("Unexpected fetch: " + url);
    });

    const res = await worker.fetch(
      new Request("https://www.acme.com/llms.txt"),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Acme");
  });

  it("propagates a pre-publish 404 (no stale copy)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const res = await worker.fetch(
      new Request("https://acme.com/llms.txt"),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("worker-template ownership-safe failure behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetManifestCache();
  });

  it("does not replay a prior owner on a CDN 5xx after a success", async () => {
    const env = makeEnv({ OOKY_DOMAIN: "stale-test.com" });
    // First request: upstream 200 — populates the last-good cache.
    globalThis.fetch = vi.fn(async () => new Response("# Fresh intel", {
      status: 200,
      headers: ARTIFACT_HEADERS,
    }));
    const ok = await worker.fetch(
      new Request("https://stale-test.com/llms.txt"),
      env,
      makeCtx()
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("# Fresh intel");

    // Second request: upstream 503. The hostname may have transferred since
    // the success, so the prior body is not an eligible fallback.
    globalThis.fetch = vi.fn(async () => new Response("upstream boom", { status: 503 }));
    const stale = await worker.fetch(
      new Request("https://stale-test.com/llms.txt"),
      env,
      makeCtx()
    );
    expect(stale.status).toBe(503);
    expect(stale.headers.get("cache-control")).toContain("no-store");
    expect(stale.headers.get("x-ooky-stale")).toBeNull();
    expect(await stale.text()).not.toBe("# Fresh intel");
  });

  it("propagates a 5xx when there is no cached copy", async () => {
    const env = makeEnv({ OOKY_DOMAIN: "no-cache.com" });
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 503 }));
    const res = await worker.fetch(
      new Request("https://no-cache.com/llms.txt"),
      env,
      makeCtx()
    );
    expect(res.status).toBe(503);
  });

  it("does not replay last-good on a fetch timeout/abort", async () => {
    const env = makeEnv({ OOKY_DOMAIN: "timeout-test.com" });
    globalThis.fetch = vi.fn(async () => new Response("# cached", {
      status: 200,
      headers: ARTIFACT_HEADERS,
    }));
    await worker.fetch(new Request("https://timeout-test.com/llms.txt"), env, makeCtx());

    globalThis.fetch = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const res = await worker.fetch(
      new Request("https://timeout-test.com/llms.txt"),
      env,
      makeCtx()
    );
    expect(res.status).toBe(599);
    expect(res.headers.get("x-ooky-stale")).toBeNull();
    expect(await res.text()).not.toBe("# cached");
  });
});

describe("worker-template bot + referral events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetManifestCache();
  });

  it("fires a bot event with geo when a known bot UA is detected", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/ingest/events")) return new Response(null, { status: 202 });
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: [] }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });

    const ctx = makeCtx();
    const req = withCf(
      new Request("https://acme.com/", {
        headers: { "user-agent": "Mozilla/5.0 GPTBot/1.0" },
      }),
      { country: "US" }
    );
    await worker.fetch(req, makeEnv(), ctx);
    await drain(ctx);

    const eventCall = calls.find((c) => c.url.includes("/ingest/events"));
    expect(eventCall).toBeTruthy();
    expect(eventCall.init.headers.Authorization).toBe("Bearer ooky_sk_TEST");
    const payload = JSON.parse(eventCall.init.body);
    expect(payload.bot.name).toBe("GPTBot");
    expect(payload.bot.verified).toBe(false);
    expect(payload.geo.country).toBe("US");
  });

  it("fires an ai_referral event for a human arriving from ChatGPT", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/ingest/events")) return new Response(null, { status: 202 });
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: DEFAULT_BOTS }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });

    const ctx = makeCtx();
    const req = withCf(
      new Request("https://acme.com/landing", {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120",
          referer: "https://chatgpt.com/c/private-conversation?prompt=secret#answer",
        },
      }),
      { country: "GB" }
    );
    await worker.fetch(req, makeEnv(), ctx);
    await drain(ctx);

    const eventCall = calls.find((c) => c.url.includes("/ingest/events"));
    expect(eventCall).toBeTruthy();
    const payload = JSON.parse(eventCall.init.body);
    expect(payload.event_type).toBe("ai_referral");
    expect(payload.referral.source).toBe("chatgpt");
    expect(payload.referral.detection_method).toBe("referer_header");
    expect(payload.referral.referrer_url).toBe("https://chatgpt.com");
    expect(payload.request.page_path).toBe("/landing");
    expect(payload.geo.country).toBe("GB");
  });

  it("detects ai_referral from a utm_source param", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/ingest/events")) return new Response(null, { status: 202 });
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: DEFAULT_BOTS }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });
    const ctx = makeCtx();
    const req = new Request("https://acme.com/p?utm_source=perplexity", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    });
    await worker.fetch(req, makeEnv(), ctx);
    await drain(ctx);
    const eventCall = calls.find((c) => c.url.includes("/ingest/events"));
    const payload = JSON.parse(eventCall.init.body);
    expect(payload.event_type).toBe("ai_referral");
    expect(payload.referral.source).toBe("perplexity");
    expect(payload.referral.detection_method).toBe("utm_param");
  });

  it("does not fire any event for plain human traffic", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: DEFAULT_BOTS }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });
    const ctx = makeCtx();
    const req = new Request("https://acme.com/", {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120" },
    });
    await worker.fetch(req, makeEnv(), ctx);
    await drain(ctx);
    expect(calls.find((u) => u.includes("/ingest/events"))).toBeFalsy();
  });
});

describe("worker-template misconfiguration handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetManifestCache();
  });

  it("returns a loud 500 on manifest paths when OOKY_DOMAIN is the placeholder", async () => {
    globalThis.fetch = vi.fn(async () => new Response("origin", { status: 200 }));
    const res = await worker.fetch(
      new Request("https://acme.com/llms.txt"),
      makeEnv({ OOKY_DOMAIN: "YOUR_DOMAIN" }),
      makeCtx()
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("x-ooky-worker")).toBe("byo-misconfigured");
    expect(await res.text()).toMatch(/misconfigured/i);
  });

  it("still passes human traffic through to origin when misconfigured", async () => {
    const originBody = "<html>origin still works</html>";
    globalThis.fetch = vi.fn(async () => new Response(originBody, { status: 200 }));
    const res = await worker.fetch(
      new Request("https://acme.com/some-page"),
      makeEnv({ OOKY_DOMAIN: "YOUR_DOMAIN" }),
      makeCtx()
    );
    expect(await res.text()).toBe(originBody);
  });

  it("fails closed when OOKY_API_KEY is missing", async () => {
    // Manifest delivery is bound to the current domain-scoped credential so a
    // former owner cannot fetch a successor's artifact after a transfer.
    const urls = [];
    globalThis.fetch = vi.fn(async (req) => {
      urls.push(typeof req === "string" ? req : req.url);
      return new Response("# llms\nAcme brand summary", {
        status: 200,
        headers: ARTIFACT_HEADERS,
      });
    });
    const res = await worker.fetch(
      // A bot UA so the event path runs — and proves recordEvent no-ops w/o key.
      new Request("https://acme.com/llms.txt", {
        headers: { "user-agent": "GPTBot/1.0" },
      }),
      makeEnv({ OOKY_API_KEY: undefined }),
      makeCtx()
    );
    expect(res.status).toBe(401);
    expect(urls.some((u) => u.includes("/public/manifest/"))).toBe(false);
    expect(urls.some((u) => u.includes("/ingest/events"))).toBe(false);
  });
});

describe("worker-template /__ooky/health diagnostic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetManifestCache();
  });

  it("reports healthy when host matches OOKY_DOMAIN and key is set", async () => {
    globalThis.fetch = vi.fn(async () => new Response("origin", { status: 200 }));
    const res = await worker.fetch(
      new Request("https://acme.com/__ooky/health"),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.routes_wired).toBe(true);
    expect(body.problems).toEqual([]);
  });

  it("flags the *.workers.dev deploy trap", async () => {
    globalThis.fetch = vi.fn(async () => new Response("origin", { status: 200 }));
    const res = await worker.fetch(
      new Request("https://ooky-worker.someacct.workers.dev/__ooky/health"),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.served_on_workers_dev).toBe(true);
    expect(body.problems.join(" ")).toMatch(/workers\.dev/);
    expect(body.problems.join(" ")).toMatch(/routes/);
  });

  it("flags the YOUR_DOMAIN placeholder and missing key", async () => {
    globalThis.fetch = vi.fn(async () => new Response("origin", { status: 200 }));
    const res = await worker.fetch(
      new Request("https://acme.com/__ooky/health"),
      makeEnv({ OOKY_DOMAIN: "YOUR_DOMAIN", OOKY_API_KEY: undefined }),
      makeCtx()
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.domain_configured).toBe(false);
    expect(body.api_key_set).toBe(false);
    expect(body.problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("worker-template MCP POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetManifestCache();
  });

  function mcpPost(message, env = makeEnv()) {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/manifest/acme.com/manifest")) {
        return new Response(
          JSON.stringify({ brand: { name: "Acme", website: "https://acme.com" } }),
          { status: 200, headers: { ...ARTIFACT_HEADERS, "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: DEFAULT_BOTS }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });
    const req = new Request("https://acme.com/mcp", {
      method: "POST",
      headers: { "user-agent": "MCP-Client", "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    return worker.fetch(req, env, makeCtx());
  }

  it("answers initialize with serverInfo.name ooky-<domain>", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("ooky-acme-com");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists tools including get_brand_info", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = await res.json();
    expect(body.result.tools.map((t) => t.name)).toContain("get_brand_info");
  });

  it("calls get_brand_info and returns manifest content", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_brand_info", arguments: {} },
    });
    const body = await res.json();
    expect(body.result.isError).toBe(false);
    const text = JSON.parse(body.result.content[0].text);
    expect(text.brand.name).toBe("Acme");
  });

  it("returns get_brand_info section filter (contact)", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_brand_info", arguments: { section: "contact" } },
    });
    const body = await res.json();
    const text = JSON.parse(body.result.content[0].text);
    expect(text.brand.name).toBe("Acme");
    expect(text.brand.website).toBe("https://acme.com");
  });

  it("returns a JSON-RPC parse error for an invalid body", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: DEFAULT_BOTS }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });
    const req = new Request("https://acme.com/mcp", {
      method: "POST",
      headers: { "user-agent": "MCP-Client", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it("rejects actual bodies over 64KB even without Content-Length", async () => {
    globalThis.fetch = vi.fn(async () => new Response("origin", { status: 200 }));
    const req = new Request("https://acme.com/mcp", {
      method: "POST",
      headers: { "user-agent": "MCP-Client", "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(64 * 1024 + 1) }),
    });
    req.headers.delete("content-length");
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).toBe(413);
  });

  it("handles OPTIONS preflight with CORS", async () => {
    const req = new Request("https://acme.com/mcp", {
      method: "OPTIONS",
      headers: { "user-agent": "MCP-Client" },
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
  });

  it("serves the static descriptor on a GET to /mcp", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/manifest/acme.com/mcp")) {
        return new Response(JSON.stringify({ mcp: "descriptor" }), {
          status: 200,
          headers: { ...ARTIFACT_HEADERS, "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: DEFAULT_BOTS }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });
    const req = new Request("https://acme.com/mcp", {
      headers: { "user-agent": "Mozilla" },
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect((await res.json()).mcp).toBe("descriptor");
  });
});

describe("registry refresh resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetManifestCache();
  });

  it("does not throw when /public/bots returns a 5xx", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/public/bots")) {
        return new Response("boom", { status: 503 });
      }
      return new Response("origin", { status: 200 });
    });
    const ctx = makeCtx();
    const req = new Request("https://acme.com/", { headers: { "user-agent": "Mozilla" } });
    const res = await worker.fetch(req, makeEnv(), ctx);
    await drain(ctx);
    expect(res.status).toBe(200);
  });

  it("does not throw when /public/bots returns a non-array payload", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/public/bots")) {
        return new Response(JSON.stringify({ bots: "not-an-array" }), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    });
    const ctx = makeCtx();
    const req = new Request("https://acme.com/", { headers: { "user-agent": "GPTBot" } });
    const res = await worker.fetch(req, makeEnv(), ctx);
    await drain(ctx);
    // Still serves; falls back to the in-memory default registry.
    expect(res.status).toBe(200);
  });
});

describe("detectBot helper", () => {
  it("matches the major bots in the default registry", () => {
    expect(detectBot("Mozilla/5.0 GPTBot/1.0", DEFAULT_BOTS)?.name).toBe("GPTBot");
    expect(detectBot("CLAUDEBOT/2.0", DEFAULT_BOTS)?.name).toBe("ClaudeBot");
    expect(detectBot("Mozilla/5.0 (Macintosh) Chrome", DEFAULT_BOTS)).toBeNull();
  });

  it("is defensive against malformed registry rows", () => {
    const bad = [{ name: "x" }, null, { pattern: 123 }, { pattern: "GPTBot" }];
    expect(() => detectBot("GPTBot/1.0", bad)).not.toThrow();
    expect(detectBot("GPTBot/1.0", bad)?.pattern).toBe("GPTBot");
    expect(detectBot("anything", "not-an-array")).toBeNull();
  });

  it("sanitizes and caps a live registry before the request hot path", () => {
    const oversized = [null, { pattern: "" }, { pattern: 123 }];
    for (let i = 0; i < MAX_BOT_REGISTRY_ENTRIES + 20; i++) {
      oversized.push({ name: `B${i}`, pattern: `bot-entry-${i};` });
    }

    const cleaned = sanitizeBotRegistry(oversized);

    expect(cleaned).toHaveLength(MAX_BOT_REGISTRY_ENTRIES);
    expect(cleaned[0].pattern).toBe("bot-entry-0;");
    expect(
      detectBot(`x bot-entry-${MAX_BOT_REGISTRY_ENTRIES + 10};`, oversized)
    ).toBeNull();
    expect(sanitizeBotRegistry("not-an-array")).toBeNull();
  });
});

describe("worker-template cleaned-HTML serving (the takeover)", () => {
  beforeEach(() => {
    __resetManifestCache();
  });

  const BOT_UA = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";

  it("serves the published cleaned HTML to a bot on a content page", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/public/page/cleaned-html")) {
        expect(init?.headers?.Authorization).toBe("Bearer ooky_sk_TEST");
        expect(init?.cf).toEqual({ cacheTtl: 0, cacheEverything: false });
        expect(init?.cache).toBe("no-store");
        expect(String(url)).toContain("path=%2Fpricing");
        return new Response("<html><body>distilled</body></html>", {
          status: 200,
          headers: { ...ARTIFACT_HEADERS, "content-type": "text/html" },
        });
      }
      return new Response("ORIGIN PAGE", { status: 200 });
    });
    const req = new Request("https://acme.com/pricing", {
      headers: { "user-agent": BOT_UA, accept: "text/html" },
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html><body>distilled</body></html>");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("vary")).toBe("User-Agent");
    expect(res.headers.get("x-ooky-cleanedhtml")).toBe("1");
  });

  it("falls through to origin when the per-page API returns 204 (nothing published)", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/public/page/cleaned-html")) {
        return new Response(null, { status: 204 });
      }
      return new Response("ORIGIN PAGE", { status: 200 });
    });
    const res = await worker.fetch(
      new Request("https://acme.com/pricing", {
        headers: { "user-agent": BOT_UA, accept: "text/html" },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ORIGIN PAGE");
  });

  it("never serves cleaned HTML to humans (no per-page fetch)", async () => {
    const fetchMock = vi.fn(async () => new Response("ORIGIN PAGE", { status: 200 }));
    globalThis.fetch = fetchMock;
    const res = await worker.fetch(
      new Request("https://acme.com/pricing", {
        headers: { "user-agent": "Mozilla/5.0 (Macintosh)", accept: "text/html" },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(await res.text()).toBe("ORIGIN PAGE");
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/public/page/cleaned-html"))
    ).toBe(false);
  });

  it("does not take over asset requests (e.g. .js) even for a bot", async () => {
    const fetchMock = vi.fn(async () => new Response("console.log(1)", { status: 200 }));
    globalThis.fetch = fetchMock;
    const res = await worker.fetch(
      new Request("https://acme.com/app.js", {
        headers: { "user-agent": BOT_UA, accept: "*/*" },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(await res.text()).toBe("console.log(1)");
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/public/page/cleaned-html"))
    ).toBe(false);
  });
});

describe("worker-template search/social bots never get distilled content", () => {
  beforeEach(() => {
    __resetManifestCache();
  });

  const GOOGLEBOT_UA =
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  it("Googlebot gets the ORIGIN page and the per-page cleaned-html API is never called", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/public/page/cleaned-html")) {
        return new Response("<html><body>distilled</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("ORIGIN PAGE", { status: 200 });
    });
    globalThis.fetch = fetchMock;
    const res = await worker.fetch(
      new Request("https://acme.com/pricing", {
        headers: { "user-agent": GOOGLEBOT_UA, accept: "text/html" },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ORIGIN PAGE");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("x-ooky-cleanedhtml")).toBeNull();
    const cleanedCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/public/page/cleaned-html")
    );
    expect(cleanedCalls).toHaveLength(0);
  });

  it("Bingbot gets the ORIGIN page", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/public/page/cleaned-html")) {
        return new Response("<html><body>distilled</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("ORIGIN PAGE", { status: 200 });
    });
    const res = await worker.fetch(
      new Request("https://acme.com/pricing", {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
          accept: "text/html",
        },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ORIGIN PAGE");
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });
});

describe("ORIGIN_SERVICE binding (site is a Worker, no origin server)", () => {
  beforeEach(() => {
    __resetManifestCache();
  });

  function makeOriginService(body = "<html>site worker</html>") {
    const calls = [];
    return {
      calls,
      binding: {
        fetch: vi.fn(async (request) => {
          calls.push(request.url);
          return new Response(body, { status: 200 });
        }),
      },
    };
  }

  it("routes content passthrough to the bound Worker instead of origin", async () => {
    const originFetch = vi.fn(async () => new Response("ORIGIN", { status: 200 }));
    globalThis.fetch = originFetch;
    const { binding, calls } = makeOriginService();

    const req = new Request("https://acme.com/pricing", {
      headers: { "user-agent": "Mozilla" },
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ORIGIN_SERVICE: binding }),
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>site worker</html>");
    expect(calls).toEqual(["https://acme.com/pricing"]);
    // The whole point: no origin fetch is attempted, because there is no origin.
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("uses the binding when OOKY_DOMAIN is still the placeholder", async () => {
    const originFetch = vi.fn(async () => new Response("ORIGIN", { status: 200 }));
    globalThis.fetch = originFetch;
    const { binding } = makeOriginService("<html>unconfigured</html>");

    const res = await worker.fetch(
      new Request("https://acme.com/", { headers: { "user-agent": "Mozilla" } }),
      makeEnv({ OOKY_DOMAIN: "YOUR_DOMAIN", ORIGIN_SERVICE: binding }),
      makeCtx()
    );

    expect(await res.text()).toBe("<html>unconfigured</html>");
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("uses the binding when the request host does not match OOKY_DOMAIN", async () => {
    const originFetch = vi.fn(async () => new Response("ORIGIN", { status: 200 }));
    globalThis.fetch = originFetch;
    const { binding } = makeOriginService("<html>other host</html>");

    const res = await worker.fetch(
      new Request("https://other.example/", {
        headers: { "user-agent": "Mozilla" },
      }),
      makeEnv({ ORIGIN_SERVICE: binding }),
      makeCtx()
    );

    expect(await res.text()).toBe("<html>other host</html>");
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("falls back to a plain origin fetch when the binding is absent", async () => {
    const originFetch = vi.fn(async () => new Response("ORIGIN", { status: 200 }));
    globalThis.fetch = originFetch;

    const res = await worker.fetch(
      new Request("https://acme.com/pricing", {
        headers: { "user-agent": "Mozilla" },
      }),
      makeEnv(),
      makeCtx()
    );

    expect(await res.text()).toBe("ORIGIN");
    expect(originFetch).toHaveBeenCalled();
  });

  it("reports origin_service_bound in the health check", async () => {
    const bound = await worker.fetch(
      new Request("https://acme.com/__ooky/health"),
      makeEnv({ ORIGIN_SERVICE: makeOriginService().binding }),
      makeCtx()
    );
    expect((await bound.json()).origin_service_bound).toBe(true);

    const unbound = await worker.fetch(
      new Request("https://acme.com/__ooky/health"),
      makeEnv(),
      makeCtx()
    );
    expect((await unbound.json()).origin_service_bound).toBe(false);
  });
});

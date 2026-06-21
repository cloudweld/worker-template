# Ooky Worker Template

Deployable Cloudflare Worker for the **BYO Cloudflare** integration tier. Customers deploy this to their own Cloudflare account, paste their Ooky API key, and traffic for their domain is intercepted at the edge — no DNS change to a vendor zone.

This is a **template repo**. The "Deploy to Cloudflare" button in the Ooky dashboard points at `https://github.com/cloudweld/worker-template`, which is this directory pushed to its own repo.

---

## ⚠️ STEP 1 (REQUIRED): wire the routes — do this BEFORE anything else

A Worker only intercepts your site if it's **bound to your domain's routes**. A
plain `wrangler deploy` (or the one-click button) with the `routes` block still
commented out deploys the Worker to a `*.workers.dev` URL bound to **zero of
your routes** — it never sees real traffic. The deploy "succeeds" and the Ooky
dashboard may even flip to "Connected", but every AI manifest endpoint and all
bot analytics are silently dead.

**You must edit `wrangler.toml` first:**

1. Uncomment the `routes` block and set it to your domain:
   ```toml
   routes = [
     { pattern = "your-domain.com/*", zone_name = "your-domain.com" }
   ]
   ```
2. Set `OOKY_DOMAIN` in `[vars]` to your registered Ooky domain (replace the
   `YOUR_DOMAIN` placeholder — the Worker treats the literal placeholder as
   unconfigured and returns a loud error instead of silently failing).

> **The one-click "Deploy to Cloudflare" button is NOT sufficient on its own.**
> It scaffolds the Worker but cannot wire your routes for you. After clicking it
> you still have to do STEP 1 above, or the integration is a no-op.

After deploying, run the self-diagnostic to confirm everything is wired:

```bash
curl -s https://your-domain.com/__ooky/health | jq
```

It reports whether the Worker is bound to your domain, whether `OOKY_DOMAIN` and
`OOKY_API_KEY` are set, and exactly what to fix if not. If you hit it on the
`*.workers.dev` URL, it will tell you the routes aren't wired.

---

## Manual deploy

```bash
git clone https://github.com/cloudweld/worker-template.git
cd worker-template
npm install

# STEP 1 (REQUIRED): set OOKY_DOMAIN and uncomment the `routes` block.
$EDITOR wrangler.toml

# Set the Bearer token (from your Ooky dashboard → Integrations → Worker)
npx wrangler secret put OOKY_API_KEY

# (Optional) Create a KV namespace for cross-request bot-registry caching
npx wrangler kv namespace create OOKY_BOT_CACHE
# Paste the printed `id` into wrangler.toml under [[kv_namespaces]]

npx wrangler deploy
```

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudweld/worker-template)

The button scaffolds the Worker into your account but **does not wire your
routes** — you must still complete STEP 1 (uncomment `routes`, set
`OOKY_DOMAIN`) or the Worker intercepts nothing.

## What the Worker does

For every request to your domain:

1. Loads the bot-UA registry from `/api/public/bots`. By default this is cached
   **in memory per isolate** (each new isolate refetches on its first request).
   If you bind the optional `OOKY_BOT_CACHE` KV namespace, it's also cached in
   KV for an hour so isolates share it.
2. Checks the `User-Agent` against the registry. If it's a known AI bot, fires a
   non-blocking bot event to Ooky's ingest endpoint with your per-domain Bearer
   token (and the request's `cf.country` for geo).
3. For non-bot traffic, detects humans arriving from an AI platform
   (ChatGPT/Perplexity/Claude/…) via the `Referer` header or a `utm_source`
   param, and fires a non-blocking `ai_referral` event so the dashboard's
   attribution lands.
4. If the path matches one of the well-known AI URLs, serves the manifest from
   Ooky's public CDN:
   - `/llms.txt`
   - `/llms-full.txt`
   - `/agents.md`
   - `/.well-known/ai-manifest.json` (and `/ai-manifest.json`)
   - `/.well-known/mcp` and `/mcp` (full MCP JSON-RPC, see below)
5. Otherwise, the request passes through to your origin unchanged.

### MCP support

`/mcp` and `/.well-known/mcp` speak the **MCP JSON-RPC 2.0** protocol that real
clients (Claude, the MCP Inspector, ChatGPT connectors) use:

- `GET` returns the static descriptor from the public CDN.
- `POST` handles `initialize`, `tools/list`, and `tools/call` for the
  `get_brand_info` tool, plus the legacy `{ tool, arguments }` shape. `OPTIONS`
  returns CORS preflight headers. This mirrors `@ooky/sdk`'s MCP behaviour; the
  server identifies itself as `ooky-<your-domain>`.

This tier exposes only `get_brand_info` (product/feed tools require feed data
this tier doesn't have).

## What this tier does — and does NOT do (vs Full-DNS)

The BYO-Worker tier intercepts bots, fires analytics, and serves the well-known
AI artifacts. It is intentionally simpler than the **Full-DNS** tier (where you
point your domain's DNS at Ooky):

| Capability | BYO Worker (this) | Full-DNS |
|---|---|---|
| Bot detection + AI-Sessions analytics | ✅ | ✅ |
| AI-referral attribution (human from ChatGPT/…) | ✅ | ✅ |
| Serve `/llms.txt`, `/llms-full.txt`, `/agents.md`, AI manifest | ✅ | ✅ |
| MCP JSON-RPC endpoint (`get_brand_info`) | ✅ | ✅ (+ product tools) |
| **Distilled / cleaned-HTML served to bots on normal pages** | ❌ | ✅ |
| **JSON-LD injection into bot responses** | ❌ | ✅ |
| **Content negotiation rewrite of your human HTML** | ❌ | ✅ |
| Reverse-DNS / IP-CIDR bot *verification* | ❌ (UA-only) | ✅ |

**Important:** on this tier, a bot hitting a *normal page* (e.g. `/products`)
gets your **origin's HTML unchanged** — the Worker does not rewrite it or inject
distilled content or JSON-LD. Those are Full-DNS differentiators (they require
Ooky to sit inline in front of every request and serve the parity-gated cleaned
HTML/JSON-LD artifacts, which aren't exposed to this tier). If you need bots to
receive distilled HTML on every page, use the Full-DNS integration.

## Resilience

- **Timeouts:** every upstream fetch (manifest serve, event ingest, bot-registry
  refresh) carries an `AbortSignal` deadline so a hung Ooky API never stalls
  your site.
- **Stale-serve:** the last successful manifest per kind is kept in memory and
  served if a later fetch returns a 5xx or times out, so a transient Ooky outage
  doesn't break `/llms.txt` for crawlers. (A genuine pre-publish `404` is *not*
  masked — it propagates so you know to publish.)
- **No error caching:** the edge cache only stores 2xx responses, so a
  pre-publish 404 won't stick for 5 minutes after you publish.

## Configuration

| Variable | Where set | Required | Description |
|---|---|---|---|
| `routes` | `wrangler.toml` | **Yes** | The domain/route the Worker binds to. Without it the Worker intercepts nothing (see STEP 1). |
| `OOKY_DOMAIN` | `wrangler.toml` `[vars]` | **Yes** | The domain you registered in the Ooky dashboard. Must match the verified domain. The literal `YOUR_DOMAIN` placeholder is treated as unconfigured. |
| `OOKY_API_KEY` | `wrangler secret put` | **Yes** | Per-domain Bearer token (`ooky_sk_*`) from the Ooky dashboard. |
| `OOKY_API_BASE` | `wrangler.toml` `[vars]` | No | Defaults to `https://api.ooky.ai/api`. Override only if you self-host Ooky. |
| `OOKY_BOT_CACHE` | KV binding | No | Optional. Caches the bot registry in KV across requests/isolates. Without it, each new isolate refetches on its first request (in-memory only). |

## Verifying the deploy

```bash
# Self-diagnostic — checks routes/domain/key wiring and tells you what's wrong:
curl -s https://your-domain.com/__ooky/health | jq

# Bot path + a manifest path:
curl -s https://your-domain.com/llms.txt | head
curl -I -H "User-Agent: GPTBot/1.0" https://your-domain.com/
```

Within ~30 seconds the integration in your Ooky dashboard should flip to
"Connected" and the AI Sessions tab should show the event.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/llms.txt` returns origin's response | Worker route not bound to your domain. Complete STEP 1 (uncomment `routes`). Run `/__ooky/health` to confirm. |
| `/__ooky/health` reports `served_on_workers_dev: true` | You're hitting the `*.workers.dev` URL — the `routes` block isn't wired. |
| Manifest endpoint returns a loud 500 about `YOUR_DOMAIN` | `OOKY_DOMAIN` is still the placeholder. Set it in `wrangler.toml` and redeploy. |
| Manifest endpoint returns 404 | No published manifest yet. Publish from the Ooky dashboard's Builder. |
| `[ooky] ingest responded 401` in `wrangler tail` | `OOKY_API_KEY` secret missing or wrong. Re-run `wrangler secret put OOKY_API_KEY`. |
| Bot events not appearing | Check `wrangler tail` to confirm the Worker is being invoked and watch for `[ooky] ingest` warnings. |

## Development

```bash
npm install
npm test                       # vitest unit tests
npx wrangler deploy --dry-run  # validate the config without deploying
```

## License

MIT.

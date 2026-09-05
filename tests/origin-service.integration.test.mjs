import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

let runtime;
beforeAll(async () => {
  runtime = new Miniflare({
    workers: [{
      name: 'ooky',
      scriptPath: fileURLToPath(new URL('../src/index.js', import.meta.url)),
      modules: true,
      modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
      compatibilityDate: '2026-04-01',
      bindings: { OOKY_DOMAIN: 'example.com', OOKY_API_KEY: 'ooky_sk_test', OOKY_API_BASE: 'https://api.example/api' },
      serviceBindings: { ORIGIN_SERVICE: 'site' },
      outboundService: () => Response.json([]),
    }, {
      name: 'site', modules: true, compatibilityDate: '2026-04-01',
      script: `export default { async fetch(request) {
        if (new URL(request.url).pathname === '/redirect') return new Response(null, {status:303,headers:{location:'/cart','set-cookie':'cart=1; Secure'}});
        return Response.json({url:request.url,method:request.method,body:await request.text()});
      }};`,
    }],
  });
});
afterAll(async () => { await runtime?.dispose(); });

describe('BYO origin service in the Workers runtime', () => {
  it('delivers the public URL and original POST body to the existing site Worker', async () => {
    const response = await runtime.dispatchFetch('https://example.com/cart?item=1', { method: 'POST', body: 'checkout-body' });
    expect(await response.json()).toEqual({ url: 'https://example.com/cart?item=1', method: 'POST', body: 'checkout-body' });
  });

  it('probes the actual service binding before declaring readiness', async () => {
    const response = await runtime.dispatchFetch('https://example.com/__ooky/health?check_origin=1');
    expect((await response.json()).origin).toEqual({ reachable: true, status: 200, mode: 'service' });
  });

  it('preserves origin redirects and session cookies', async () => {
    const response = await runtime.dispatchFetch('https://example.com/redirect', { method: 'POST', body: 'checkout-body', redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/cart');
    expect(response.headers.get('set-cookie')).toBe('cart=1; Secure');
  });
});

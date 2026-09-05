import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';

const env = { OOKY_DOMAIN: 'example.com', OOKY_API_KEY: 'ooky_sk_test', OOKY_API_BASE: 'https://api.example/api' };
const ctx = { waitUntil() {} };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('origin readiness diagnostic', () => {
  it('probes the native origin with a sanitized request and cancels its body', async () => {
    let request;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', async input => { request = input; return new Response(new ReadableStream({ cancel })); });
    const response = await worker.fetch(new Request('https://example.com/__ooky/health?check_origin=1', { headers: { cookie: 'secret', authorization: 'Bearer secret' } }), env, ctx);
    const report = await response.json();
    expect(report.origin).toEqual({ reachable: true, status: 200, mode: 'fetch' });
    expect(request.url).toBe('https://example.com/');
    expect(request.method).toBe('GET');
    expect(request.redirect).toBe('manual');
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.headers.has('authorization')).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('checks the service binding that actually serves the site', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('must use service'); });
    const binding = { fetch: vi.fn(async () => new Response('site')) };
    const response = await worker.fetch(new Request('https://example.com/__ooky/health?check_origin=1'), { ...env, ORIGIN_SERVICE: binding }, ctx);
    expect((await response.json()).origin).toEqual({ reachable: true, status: 200, mode: 'service' });
    expect(binding.fetch).toHaveBeenCalledOnce();
  });

  it('does not report a configured but broken origin as connected', async () => {
    vi.stubGlobal('fetch', async () => new Response('error', { status: 522 }));
    const response = await worker.fetch(new Request('https://example.com/__ooky/health?check_origin=1'), env, ctx);
    const report = await response.json();
    expect(response.status).toBe(503);
    expect(report.ok).toBe(false);
    expect(report.origin).toMatchObject({ reachable: false, status: 522, mode: 'fetch', error: 'origin_http_error' });
  });

  it('bounds a stuck service binding even when it ignores the abort signal', async () => {
    vi.useFakeTimers();
    const pending = worker.fetch(new Request('https://example.com/__ooky/health?check_origin=1'), { ...env, ORIGIN_SERVICE: { fetch: () => new Promise(() => {}) } }, ctx);
    await vi.advanceTimersByTimeAsync(8001);
    const response = await pending;
    expect((await response.json()).origin).toMatchObject({ reachable: false, status: null, mode: 'service', error: 'origin_timeout' });
  });

  it('refuses a canonical redirect to the same homepage', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 301, headers: { location: 'https://example.com/' } }));
    const response = await worker.fetch(new Request('https://example.com/__ooky/health?check_origin=1'), env, ctx);
    expect((await response.json()).origin).toMatchObject({ reachable: false, error: 'origin_redirect_loop' });
  });

  it('accepts a homepage redirect that establishes browser state', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 302, headers: { location: 'https://example.com/', 'set-cookie': 'boot=1; Secure' } }));
    const response = await worker.fetch(new Request('https://example.com/__ooky/health?check_origin=1'), env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).origin.reachable).toBe(true);
  });

  it('reports configuration without probing unless explicitly requested', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = await worker.fetch(new Request('https://example.com/__ooky/health'), env, ctx);
    expect((await response.json()).origin).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns 502 for a failed origin service without replaying into a nonexistent DNS origin', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const response = await worker.fetch(new Request('https://example.com/cart', { method: 'POST', body: 'checkout' }), { ...env, ORIGIN_SERVICE: { fetch: async () => { throw new Error('private service failure'); } } }, ctx);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private service failure');
    expect(fetch.mock.calls.every(([input]) => !(input instanceof Request))).toBe(true);
  });
});

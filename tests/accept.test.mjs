import { afterEach, expect, it, vi } from 'vitest';
import worker, { __resetManifestCache } from '../src/index.js';
afterEach(() => vi.unstubAllGlobals());
it.each([
  ['text/html;q=0', false], ['text/html;q=0, */*;q=1', false],
  ['application/not-text/html', false], ['text/*;q=0.8', true],
])('BYO uses HTML media-range precedence for %s', async (accept, expected) => {
  __resetManifestCache();
  const fetcher=vi.fn(async input => {
    const url=String(input?.url || input);
    if(url.includes('/public/bots')) return new Response(JSON.stringify({bots:[]}));
    if(url.includes('/api/')) return new Response(null,{status:204});
    return new Response('origin');
  });
  vi.stubGlobal('fetch',fetcher);
  const pending=[];
  await worker.fetch(new Request('https://example.com/product',{headers:{'User-Agent':'GPTBot',Accept:accept}}),
    {OOKY_API_KEY:'ooky_sk_TEST',OOKY_DOMAIN:'example.com',OOKY_API_BASE:'https://api.example/api'},
    {waitUntil:promise=>pending.push(promise)});
  await Promise.allSettled(pending);
  expect(fetcher.mock.calls.some(([input])=>String(input?.url || input).includes('/public/page/cleaned-html'))).toBe(expected);
});

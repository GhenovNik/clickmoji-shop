// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// The service worker runs in the browser, so it is loaded here into a sandbox with fake
// `self`, `caches` and `fetch`. Pages and server-rendered payloads depend on the cookies
// (language, session): the worker must never answer them from its cache.

const ORIGIN = 'https://clickmoji.test';

function loadWorker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const store = new Map<string, string>();
  const network = vi.fn(async (request: { url: string }) => new Response(`network ${request.url}`));
  const cache = {
    match: async (request: { url: string } | string) => {
      const key = typeof request === 'string' ? `${ORIGIN}${request}` : request.url;
      return store.has(key) ? new Response(store.get(key)) : undefined;
    },
    put: async (request: { url: string }, response: Response) => {
      store.set(request.url, await response.text());
    },
    addAll: async () => undefined,
  };

  vm.runInNewContext(readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8'), {
    URL,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners[type] = listener;
      },
    },
    caches: { open: async () => cache, match: cache.match, keys: async () => [] },
    fetch: network,
  });

  async function request(pathname: string, mode = 'cors') {
    let answer: Promise<Response> | undefined;
    listeners.fetch({
      request: { url: `${ORIGIN}${pathname}`, method: 'GET', mode },
      respondWith: (response: Promise<Response>) => {
        answer = response;
      },
    });
    // Not answered by the worker: the browser goes to the network itself.
    return answer
      ? (await answer).text()
      : network({ url: `${ORIGIN}${pathname}` }).then((r) => r.text());
  }

  return { store, network, request };
}

describe('public/sw.js', () => {
  it('never replays a server-rendered payload, so a refresh after a language switch is fresh', async () => {
    const worker = loadWorker();

    await worker.request('/?_rsc=abc');
    await worker.request('/?_rsc=abc');

    expect(worker.store.size).toBe(0);
    expect(worker.network).toHaveBeenCalledTimes(2);
  });

  it('sends page routes and navigations to the network', async () => {
    const worker = loadWorker();

    await worker.request('/categories');
    await worker.request('/lists', 'navigate');

    expect(worker.store.size).toBe(0);
    expect(worker.network).toHaveBeenCalledTimes(2);
  });

  it('caches content-hashed build output and serves it from the cache afterwards', async () => {
    const worker = loadWorker();
    const asset = '/_next/static/chunks/app-123.js';

    expect(await worker.request(asset)).toBe(`network ${ORIGIN}${asset}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await worker.request(asset)).toBe(`network ${ORIGIN}${asset}`);

    expect(worker.store.has(`${ORIGIN}${asset}`)).toBe(true);
    expect(worker.network).toHaveBeenCalledTimes(1);
  });

  it('uses a new cache name, so activation drops the v1 cache that held stale payloads', () => {
    const source = readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
    expect(source).not.toContain("'clickmoji-cache-v1'");
  });
});

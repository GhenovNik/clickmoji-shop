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

// A PWA installed before this change runs the v2 worker. Its cache holds the old manifest (served
// cache-first) and the old offline page; the new worker file must replace both without a manual
// cleanup: install fills the new cache, activation deletes v2, and the new values are what is served.
describe('public/sw.js update from an installed v2 worker', () => {
  const INSTALLED_CACHE = 'clickmoji-cache-v2';
  const OLD_MANIFEST = '{"name":"Clickmoji Shop","short_name":"Shop"}';
  const OLD_OFFLINE = '<title>Offline - Clickmoji Shop</title>';
  const NEW_MANIFEST = '{"name":"ClickMoji","short_name":"ClickMoji"}';
  const NEW_OFFLINE = '<title>Offline - ClickMoji</title>';
  const SERVER: Record<string, string> = {
    '/manifest.json': NEW_MANIFEST,
    '/icon.svg': '<svg></svg>',
    '/offline.html': NEW_OFFLINE,
  };

  function keyOf(request: { url: string } | string) {
    return typeof request === 'string' ? `${ORIGIN}${request}` : request.url;
  }

  // Fake browser: CacheStorage with named caches, a network that can go offline, and the worker's
  // lifecycle events. Each event's waitUntil promises are awaited, as the browser does.
  function startBrowser(installed: Record<string, Record<string, string>>) {
    const named = new Map(
      Object.entries(installed).map(([name, entries]) => [name, new Map(Object.entries(entries))])
    );
    let online = true;
    const network = vi.fn(async (request: { url: string }) => {
      if (!online) throw new TypeError('offline');
      const path = new URL(request.url).pathname;
      return new Response(SERVER[path] ?? `network ${request.url}`, { status: 200 });
    });
    const listeners: Record<string, (event: unknown) => void> = {};
    const storage = {
      open: async (name: string) => {
        if (!named.has(name)) named.set(name, new Map());
        const entries = named.get(name)!;
        return {
          addAll: async (paths: string[]) => {
            for (const path of paths) {
              const response = await network({ url: keyOf(path) });
              if (!response.ok) throw new TypeError(`addAll failed for ${path}`);
              entries.set(keyOf(path), await response.text());
            }
          },
          put: async (request: { url: string }, response: Response) => {
            entries.set(keyOf(request), await response.text());
          },
        };
      },
      keys: async () => [...named.keys()],
      delete: async (name: string) => named.delete(name),
      match: async (request: { url: string } | string) => {
        for (const entries of named.values()) {
          if (entries.has(keyOf(request))) return new Response(entries.get(keyOf(request)));
        }
        return undefined;
      },
    };

    vm.runInNewContext(readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8'), {
      URL,
      self: {
        location: { origin: ORIGIN },
        skipWaiting: async () => undefined,
        clients: { claim: async () => undefined },
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          listeners[type] = listener;
        },
      },
      caches: storage,
      fetch: network,
    });

    async function lifecycle(type: 'install' | 'activate') {
      const pending: Promise<unknown>[] = [];
      listeners[type]({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
      await Promise.all(pending);
    }

    async function get(pathname: string, mode = 'cors') {
      let answer: Promise<Response> | undefined;
      listeners.fetch({
        request: { url: `${ORIGIN}${pathname}`, method: 'GET', mode },
        respondWith: (response: Promise<Response>) => {
          answer = response;
        },
      });
      return answer ? (await answer).text() : undefined;
    }

    return {
      network,
      storage,
      lifecycle,
      get,
      setOnline: (value: boolean) => {
        online = value;
      },
    };
  }

  it('replaces the installed v2 manifest and offline page through install and activation', async () => {
    const browser = startBrowser({
      [INSTALLED_CACHE]: {
        [keyOf('/manifest.json')]: OLD_MANIFEST,
        [keyOf('/offline.html')]: OLD_OFFLINE,
      },
    });

    await browser.lifecycle('install');
    await browser.lifecycle('activate');

    const names = await browser.storage.keys();
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(INSTALLED_CACHE);
    expect(await browser.storage.match('/manifest.json').then((r) => r?.text())).toBe(NEW_MANIFEST);
    expect(await browser.storage.match('/offline.html').then((r) => r?.text())).toBe(NEW_OFFLINE);
  });

  it('serves the new manifest cache-first and the new offline page on a failed navigation', async () => {
    const browser = startBrowser({
      [INSTALLED_CACHE]: {
        [keyOf('/manifest.json')]: OLD_MANIFEST,
        [keyOf('/offline.html')]: OLD_OFFLINE,
      },
    });
    await browser.lifecycle('install');
    await browser.lifecycle('activate');
    const requestsAfterUpdate = browser.network.mock.calls.length;

    expect(await browser.get('/manifest.json')).toBe(NEW_MANIFEST);
    expect(browser.network.mock.calls.length).toBe(requestsAfterUpdate);

    browser.setOnline(false);
    expect(await browser.get('/some-page', 'navigate')).toBe(NEW_OFFLINE);
  });

  it('keeps a cold install working: empty storage fills the new cache and nothing else', async () => {
    const browser = startBrowser({});

    await browser.lifecycle('install');
    await browser.lifecycle('activate');

    expect(await browser.storage.keys()).toEqual([expect.not.stringMatching(/-v2$/)]);
    expect(await browser.storage.match('/manifest.json').then((r) => r?.text())).toBe(NEW_MANIFEST);
    expect(await browser.storage.match('/offline.html').then((r) => r?.text())).toBe(NEW_OFFLINE);
  });
});

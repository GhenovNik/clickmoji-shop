import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { ListData } from './useShoppingListItems';

type Intent = {
  revision: number;
  desired: boolean;
  epoch: number;
  cancelled: boolean;
  state: 'queued' | 'delivering' | 'confirmed' | 'exhausted' | 'permanent';
  ackGeneration: number;
  cycles: number;
  execute: (dispatch: () => Promise<Response>) => Promise<Response>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
type ItemState = {
  baseline: boolean;
  baselineGeneration: number;
  lastAckedRevision: number;
  current: Intent;
  queue: Intent[];
  running: boolean;
  active?: Intent;
  wake?: () => void;
};
type Read = { generation: number; epoch: number; listId: string };

const stores = new WeakMap<QueryClient, PurchaseIntentStore>();
const reads = new WeakMap<object, Read>();

export function purchaseIntentStore(client: QueryClient) {
  let store = stores.get(client);
  if (!store) {
    store = new PurchaseIntentStore(client);
    stores.set(client, store);
  }
  store.activate();
  return store;
}

export class PurchaseIntentStore {
  private epoch = 0;
  private identity: string | null | undefined;
  private generation = 0;
  private revision = 0;
  private lists = new Map<string, Map<string, ItemState>>();
  private online = onlineManager.isOnline();
  private resettingSession = false;
  private providerActive = false;
  private unsubscribeOnline?: () => void;
  private unsubscribeCache?: () => void;

  constructor(private client: QueryClient) {}

  activate() {
    if (this.unsubscribeOnline) return;
    this.online = onlineManager.isOnline();
    this.unsubscribeOnline = onlineManager.subscribe((online) => {
      const edge = !this.online && online;
      this.online = online;
      for (const [listId, items] of this.lists) {
        for (const [itemId, item] of items) {
          const intent = item.current;
          if (edge && intent.state === 'exhausted' && intent.epoch === this.epoch) {
            intent.state = 'queued';
            intent.cycles++;
            item.queue.push(intent);
            this.run(listId, itemId, item);
          }
        }
      }
    });
    this.unsubscribeCache = this.client.getQueryCache().subscribe((event) => {
      if (
        !this.resettingSession &&
        !this.providerActive &&
        event.type === 'removed' &&
        event.query.queryKey[0] === 'list'
      ) {
        const items = this.lists.get(String(event.query.queryKey[1]));
        for (const item of items?.values() ?? []) {
          if (item.active) item.active.cancelled = true;
          for (const intent of item.queue) intent.cancelled = true;
          item.wake?.();
        }
        this.lists.delete(String(event.query.queryKey[1]));
        if (
          !this.client
            .getQueryCache()
            .getAll()
            .some((query) => query.queryKey[0] === 'list')
        ) {
          this.dispose();
        }
      }
    });
  }

  retainProvider() {
    this.providerActive = true;
    this.activate();
  }

  dispose() {
    this.providerActive = false;
    this.unsubscribeOnline?.();
    this.unsubscribeOnline = undefined;
    this.unsubscribeCache?.();
    this.unsubscribeCache = undefined;
    this.epoch++;
    for (const items of this.lists.values()) for (const item of items.values()) item.wake?.();
    this.lists.clear();
  }

  observeSession(status: string, id: string | null) {
    if (status === 'loading') return;
    const identity = status === 'authenticated' ? id : null;
    if (this.identity === undefined) {
      this.identity = identity;
      return;
    }
    if (identity !== this.identity) {
      this.identity = identity;
      this.epoch++;
      for (const items of this.lists.values()) {
        for (const item of items.values()) item.wake?.();
      }
      this.lists.clear();
      this.resettingSession = true;
      try {
        this.client.removeQueries({ queryKey: queryKeys.listPrefix() });
      } finally {
        this.resettingSession = false;
      }
    }
  }

  beginRead(listId: string): Read {
    return { listId, generation: ++this.generation, epoch: this.epoch };
  }

  tagRead(data: ListData, read: Read) {
    if (read.epoch !== this.epoch) throw new Error('Session changed during list read');
    reads.set(data, read);
    return data;
  }

  applyRead(old: ListData | undefined, data: ListData): ListData {
    const read = reads.get(data);
    if (!read) return data;
    if (read.epoch !== this.epoch) return old ?? data;
    const items = this.lists.get(read.listId);
    if (!items) return data;
    return {
      ...data,
      items: data.items.map((row) => {
        const item = items.get(row.id);
        if (!item) return row;
        const intent = item.current;
        const canUpdate = read.generation > item.baselineGeneration;
        if (canUpdate && (intent.state !== 'confirmed' || read.generation > intent.ackGeneration)) {
          item.baseline = row.isPurchased;
          item.baselineGeneration = read.generation;
        }
        if (intent.state === 'confirmed' && read.generation > intent.ackGeneration && canUpdate) {
          item.current.state = 'permanent';
        }
        return intent.state === 'permanent' ? row : { ...row, isPurchased: intent.desired };
      }),
    };
  }

  toggle(listId: string, itemId: string, execute: Intent['execute']): Promise<void> {
    if (this.identity === null) return Promise.resolve();
    const data = this.client.getQueryData<ListData>(queryKeys.list(listId));
    const row = data?.items.find((item) => item.id === itemId);
    if (!row) return Promise.resolve();
    let items = this.lists.get(listId);
    if (!items) this.lists.set(listId, (items = new Map()));
    let item = items.get(itemId);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const intent: Intent = {
      revision: ++this.revision,
      desired: !row.isPurchased,
      epoch: this.epoch,
      cancelled: false,
      state: 'queued',
      ackGeneration: 0,
      cycles: 0,
      execute,
      resolve,
      reject,
    };
    if (!item) {
      item = {
        baseline: row.isPurchased,
        baselineGeneration: this.generation,
        lastAckedRevision: 0,
        current: intent,
        queue: [],
        running: false,
      };
      items.set(itemId, item);
    }
    item.current = intent;
    item.queue.push(intent);
    this.write(listId, itemId, intent.desired);
    item.wake?.();
    this.run(listId, itemId, item);
    return promise;
  }

  private write(listId: string, itemId: string, value: boolean) {
    this.client.setQueryData<ListData>(
      queryKeys.list(listId),
      (old) =>
        old && {
          ...old,
          items: old.items.map((row) => (row.id === itemId ? { ...row, isPurchased: value } : row)),
        }
    );
  }

  private valid(intent: Intent) {
    return !intent.cancelled && intent.epoch === this.epoch;
  }

  private async wait(item: ItemState, ms: number) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        item.wake = undefined;
        resolve();
      }, ms);
      item.wake = () => {
        clearTimeout(timer);
        item.wake = undefined;
        resolve();
      };
    });
  }

  private run(listId: string, itemId: string, item: ItemState) {
    if (item.running) return;
    item.running = true;
    void (async () => {
      while (item.queue.length) {
        const intent = item.queue.shift()!;
        item.active = intent;
        let failure: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!this.valid(intent) || (attempt > 0 && item.current !== intent)) break;
          intent.state = 'delivering';
          try {
            let response: Response;
            try {
              response = await intent.execute(() => {
                if (!this.valid(intent) || (attempt > 0 && item.current !== intent)) {
                  throw new Error('Intent no longer owns dispatch');
                }
                return fetch(`/api/lists/${listId}/items/${itemId}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ isPurchased: intent.desired }),
                });
              });
            } catch (error) {
              throw { retryable: true, cause: error };
            }
            if (response.status < 200 || response.status >= 300)
              throw {
                retryable:
                  response.status === 408 ||
                  response.status === 429 ||
                  (response.status >= 500 && response.status <= 599),
                status: response.status,
              };
            if (this.valid(intent)) {
              if (intent.revision >= item.lastAckedRevision) {
                item.lastAckedRevision = intent.revision;
                item.baseline = intent.desired;
                item.baselineGeneration = ++this.generation;
              }
              if (item.current === intent) {
                intent.state = 'confirmed';
                intent.ackGeneration = this.generation;
              }
              void this.client.invalidateQueries({ queryKey: queryKeys.list(listId) });
            }
            failure = undefined;
            break;
          } catch (error) {
            failure = error;
            if (!this.valid(intent) || item.current !== intent) break;
            if (!(error as { retryable?: boolean }).retryable) {
              intent.state = 'permanent';
              this.write(listId, itemId, item.baseline);
              void this.client.invalidateQueries({ queryKey: queryKeys.list(listId) });
              break;
            }
            if (attempt === 3) {
              intent.state = 'exhausted';
              break;
            }
            await this.wait(item, [1000, 2000, 4000][attempt]);
          }
        }
        if (failure && this.valid(intent) && item.current === intent) {
          if (intent.cycles > 0) console.error('Error toggling purchased item:', failure);
          else intent.reject(failure);
        } else intent.resolve();
      }
      item.active = undefined;
      item.running = false;
    })();
  }
}

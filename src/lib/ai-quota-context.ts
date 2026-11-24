import { AsyncLocalStorage } from 'node:async_hooks';

export type AiQuotaKind = 'text' | 'image';

export type MonthlyReservationHandle = {
  monthStart: Date;
  ceilingMicroUsd: bigint;
};

export type AiQuotaContext = {
  kind: AiQuotaKind;
  ceilingMicroUsd?: bigint;
  monthlyReservation: MonthlyReservationHandle | null;
};

const quotaContextStorage = new AsyncLocalStorage<AiQuotaContext>();

export function runWithAiQuotaContext<T>(
  options: { kind: AiQuotaKind; ceilingMicroUsd?: bigint },
  fn: () => Promise<T>
): { context: AiQuotaContext; promise: Promise<T> } {
  const context: AiQuotaContext = {
    kind: options.kind,
    ceilingMicroUsd: options.ceilingMicroUsd,
    monthlyReservation: null,
  };
  const promise = quotaContextStorage.run(context, fn);
  return { context, promise };
}

export function getActiveAiQuotaContext(): AiQuotaContext | undefined {
  return quotaContextStorage.getStore();
}

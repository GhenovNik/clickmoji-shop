export type CatalogAddAttempt = {
  attemptId: number;
  listId: string;
  query: string;
  productId: string;
  exists: boolean;
  status: 'pending' | 'failed';
};

// Business completion is independent of UI target/version. A late response can
// settle only its own item POST, not a newer attempt (even for the same target).
export function settleCatalogAddAttempt(
  current: CatalogAddAttempt | null,
  attemptId: number,
  outcome: 'succeeded' | 'failed'
): CatalogAddAttempt | null {
  if (current?.attemptId !== attemptId) return current;
  return outcome === 'succeeded' ? null : { ...current, status: 'failed' };
}

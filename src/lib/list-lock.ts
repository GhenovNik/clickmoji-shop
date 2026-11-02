import type { Prisma } from '@prisma/client';

/**
 * Locks the caller's list row (`FOR UPDATE`) inside a transaction and returns it, or null when the
 * list does not exist or belongs to someone else.
 *
 * Every operation that changes the items of a list takes this lock first: adding items, updating
 * or deleting one item, and completing the list (which then also locks the item rows). The order
 * is always the list row, then item rows, so these operations serialize per list and cannot
 * deadlock with each other. Inserts made elsewhere (text import) wait as well, because the foreign
 * key check of an item insert takes KEY SHARE on the list row, which conflicts with FOR UPDATE.
 */
export async function lockOwnedList(
  tx: Prisma.TransactionClient,
  listId: string,
  userId: string
): Promise<{ id: string; name: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT id, name FROM lists WHERE id = ${listId} AND "userId" = ${userId} FOR UPDATE`;
  return rows[0] ?? null;
}

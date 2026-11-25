import { prisma } from '@/lib/prisma';

/**
 * Persists guest activity for a live guest row. Resolves `true` only when exactly the guest row was
 * updated. Resolves `false` when the row is no longer a guest (deleted by cleanup, or converted), so
 * the caller must not serve the request with that session. A database failure rejects: callers
 * must surface it, never treat the activity as recorded.
 */
export async function recordGuestActivity(
  userId: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await prisma.user.updateMany({
    where: { id: userId, isGuest: true },
    data: { guestLastActiveAt: now },
  });
  return result.count === 1;
}

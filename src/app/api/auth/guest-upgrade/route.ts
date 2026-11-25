import { NextResponse } from 'next/server';
import { resolveRegistrationGuest } from '@/lib/guest-promotion';

/**
 * POST /api/auth/guest-upgrade - checks that the caller is a live guest before the register page
 * starts the explicit Google upgrade (AGE-1667). It arms nothing and sets no cookie: the intent is
 * bound to the OAuth state when the upgrade starts (see src/app/api/auth/[...nextauth]/route.ts).
 * A refusal (409) tells the register page to show the expired notice instead of leaving the page.
 */
export async function POST(request: Request) {
  const guest = await resolveRegistrationGuest(request);
  if (guest.kind !== 'guest') {
    return NextResponse.json({ error: 'guestSessionExpired' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

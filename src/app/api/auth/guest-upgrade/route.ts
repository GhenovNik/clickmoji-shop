import { NextResponse } from 'next/server';
import { shouldUseSecureSessionCookies } from '@/lib/guest';
import { mintGuestUpgradeIntent, resolveRegistrationGuest } from '@/lib/guest-promotion';
import {
  GUEST_UPGRADE_INTENT_COOKIE,
  GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS,
} from '@/lib/guest-upgrade-intent';

/**
 * POST /api/auth/guest-upgrade - arms one explicit guest upgrade through Google (AGE-1667).
 * Only a live guest session gets the intent cookie, bound to that guest's User.id for five minutes.
 * Any other caller gets 409 and no cookie. The register page then starts the `google-upgrade`
 * provider, whose callback refuses with `upgrade=expired` if this intent is missing or stale.
 */
export async function POST(request: Request) {
  const guest = await resolveRegistrationGuest(request);
  if (guest.kind !== 'guest') {
    return NextResponse.json({ error: 'guestSessionExpired' }, { status: 409 });
  }

  let value: string;
  try {
    value = await mintGuestUpgradeIntent(guest.userId);
  } catch {
    return NextResponse.json({ error: 'guestUpgradeUnavailable' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(GUEST_UPGRADE_INTENT_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: shouldUseSecureSessionCookies(request),
    maxAge: GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS,
  });
  return response;
}

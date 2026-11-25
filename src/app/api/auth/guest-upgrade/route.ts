import { NextResponse } from 'next/server';
import { shouldUseSecureSessionCookies } from '@/lib/guest';
import { mintGuestUpgradeArm, resolveRegistrationGuest } from '@/lib/guest-promotion';
import { GUEST_UPGRADE_ARM_MAX_AGE_SECONDS } from '@/lib/guest-upgrade-intent';
import { armCookieHeader } from '@/lib/guest-upgrade-oauth';

/**
 * POST /api/auth/guest-upgrade - arms the explicit Google upgrade for the live guest (AGE-1667). It
 * sets a short-lived, signed, httpOnly arm cookie bound to that guest's User.id. The register page
 * then calls signIn('google'), and the NextAuth route takes the explicit path only while the arm is
 * present (see src/app/api/auth/[...nextauth]/route.ts). A refusal (409) means the guest session is
 * no longer live, so the page shows the expired notice and starts nothing.
 */
export async function POST(request: Request) {
  const guest = await resolveRegistrationGuest(request);
  if (guest.kind !== 'guest') {
    return NextResponse.json({ error: 'guestSessionExpired' }, { status: 409 });
  }

  let value: string;
  try {
    value = await mintGuestUpgradeArm(guest.userId);
  } catch {
    return NextResponse.json({ error: 'guestUpgradeUnavailable' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true });
  response.headers.append(
    'Set-Cookie',
    armCookieHeader(
      value,
      GUEST_UPGRADE_ARM_MAX_AGE_SECONDS,
      shouldUseSecureSessionCookies(request)
    )
  );
  return response;
}

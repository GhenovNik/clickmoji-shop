import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth-guards';
import {
  checkRateLimit,
  getRequestLocale,
  getServerTranslator,
  rateLimitResponse,
} from '@/lib/auth-security';
import { getPasswordValidationError } from '@/lib/validation/password';
import { changeAccountPassword } from '@/lib/account';

export async function POST(request: Request) {
  const locale = getRequestLocale(request);
  const t = getServerTranslator(locale);
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const userId = guard.session.user.id;

    const rateLimit = await checkRateLimit({
      key: `account:password:${userId}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.resetAt, locale);
    }

    let body: { currentPassword?: unknown; newPassword?: unknown };
    try {
      body = (await request.json()) as { currentPassword?: unknown; newPassword?: unknown };
    } catch {
      return NextResponse.json({ error: t('api.errors.invalidRequest') }, { status: 400 });
    }

    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';

    const passwordError = getPasswordValidationError(newPassword, locale);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const result = await changeAccountPassword({
      userId,
      currentPassword,
      newPassword,
    });

    switch (result.status) {
      case 'updated':
        return NextResponse.json({ success: true, message: t('api.account.passwordUpdated') });
      case 'not_found':
        return NextResponse.json({ error: t('api.errors.unauthorized') }, { status: 401 });
      case 'no_local_password':
        return NextResponse.json(
          { error: t('api.account.noLocalPassword'), code: 'NO_LOCAL_PASSWORD' },
          { status: 400 }
        );
      case 'current_password_required':
        return NextResponse.json(
          { error: t('api.account.currentPasswordRequired') },
          { status: 400 }
        );
      case 'incorrect_current_password':
        return NextResponse.json(
          { error: t('api.account.incorrectCurrentPassword') },
          { status: 400 }
        );
      case 'concurrent_change':
        return NextResponse.json(
          { error: t('api.account.passwordChangedConcurrently') },
          { status: 409 }
        );
    }
  } catch (error) {
    console.error('Error changing password:', error);
    return NextResponse.json({ error: t('api.account.passwordUpdateFailed') }, { status: 500 });
  }
}

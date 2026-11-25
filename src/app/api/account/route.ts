import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth-guards';
import {
  checkRateLimit,
  getRequestLocale,
  getServerTranslator,
  rateLimitResponse,
} from '@/lib/auth-security';
import { ACCOUNT_DELETE_PHRASES, deleteAccount, getAccountProfile } from '@/lib/account';

export async function GET(request: Request) {
  const locale = getRequestLocale(request);
  const t = getServerTranslator(locale);
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;

    const profile = await getAccountProfile(guard.session.user.id);
    if (!profile) {
      return NextResponse.json({ error: t('api.errors.unauthorized') }, { status: 401 });
    }

    return NextResponse.json(
      { user: profile },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    console.error('Error fetching account:', error);
    return NextResponse.json({ error: t('api.account.fetchFailed') }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const locale = getRequestLocale(request);
  const t = getServerTranslator(locale);
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const userId = guard.session.user.id;

    const rateLimit = await checkRateLimit({
      key: `account:delete:${userId}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.resetAt, locale);
    }

    let body: { password?: unknown; confirmation?: unknown };
    try {
      body = (await request.json()) as { password?: unknown; confirmation?: unknown };
    } catch {
      return NextResponse.json({ error: t('api.errors.invalidRequest') }, { status: 400 });
    }

    const password = typeof body?.password === 'string' ? body.password : undefined;
    const confirmation = typeof body?.confirmation === 'string' ? body.confirmation : undefined;

    const result = await deleteAccount({ userId, password, confirmation });

    switch (result.status) {
      case 'deleted':
        return NextResponse.json({ success: true, message: t('api.account.deleted') });
      case 'not_found':
        return NextResponse.json({ error: t('api.errors.unauthorized') }, { status: 401 });
      case 'password_required':
        return NextResponse.json(
          { error: t('api.account.passwordRequiredToDelete') },
          { status: 400 }
        );
      case 'incorrect_password':
        return NextResponse.json(
          { error: t('api.account.incorrectCurrentPassword') },
          { status: 400 }
        );
      case 'confirmation_required':
        return NextResponse.json(
          {
            error: t('api.account.deleteConfirmationRequired', {
              word: ACCOUNT_DELETE_PHRASES[locale],
            }),
          },
          { status: 400 }
        );
      case 'concurrent_change':
        return NextResponse.json(
          { error: t('api.account.passwordChangedConcurrently') },
          { status: 409 }
        );
      case 'cross_owner_references':
        return NextResponse.json(
          { error: t('api.account.deleteBlockedByForeignReferences') },
          { status: 409 }
        );
    }
  } catch (error) {
    console.error('Error deleting account:', error);
    return NextResponse.json({ error: t('api.account.deleteFailed') }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth-guards';
import {
  checkRateLimit,
  getRequestLocale,
  getServerTranslator,
  rateLimitResponse,
} from '@/lib/auth-security';
import { exportAccountData } from '@/lib/account';

export async function GET(request: Request) {
  const locale = getRequestLocale(request);
  const t = getServerTranslator(locale);
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const userId = guard.session.user.id;

    const rateLimit = await checkRateLimit({
      key: `account:export:${userId}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.resetAt, locale);
    }

    const payload = await exportAccountData(userId);
    if (!payload) {
      return NextResponse.json({ error: t('api.errors.unauthorized') }, { status: 401 });
    }

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="clickmoji-account-export.json"',
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      },
    });
  } catch (error) {
    console.error('Error exporting account data:', error);
    return NextResponse.json({ error: t('api.account.exportFailed') }, { status: 500 });
  }
}

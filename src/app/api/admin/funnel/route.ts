import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { requireAdmin } from '@/lib/auth-guards';
import { getFunnelReport } from '@/lib/funnel-analytics';

export async function GET(request?: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const report = await getFunnelReport();
    return NextResponse.json(report);
  } catch (error) {
    console.error('Error fetching funnel analytics:', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      { error: await apiText(request, 'fetchFunnelFailed') },
      { status: 500 }
    );
  }
}

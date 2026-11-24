import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth-guards';
import { getFunnelReport } from '@/lib/funnel-analytics';
import FunnelDashboard from '@/components/admin/funnel/FunnelDashboard';

export const dynamic = 'force-dynamic';

export default async function AdminFunnelPage() {
  const guard = await requireAdmin();
  if (guard instanceof Response) {
    redirect('/');
    return null;
  }

  const report = await getFunnelReport();
  return <FunnelDashboard report={report} />;
}

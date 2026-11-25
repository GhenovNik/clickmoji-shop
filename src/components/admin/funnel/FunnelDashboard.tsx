'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type { FunnelReport } from '@/lib/funnel-analytics';

type FunnelDashboardProps = {
  report: FunnelReport;
};

function formatRate(rate: number | null, locale: string, emptyLabel: string): string {
  if (rate === null) return emptyLabel;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(rate);
}

export default function FunnelDashboard({ report }: FunnelDashboardProps) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const router = useRouter();

  const numberFormatter = new Intl.NumberFormat(locale);
  const emptyRate = t('funnelPage.emptyRate');
  const updatedTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(report.generatedAt));

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <Link
            href="/admin"
            className="text-blue-600 hover:text-blue-700 text-sm mb-4 inline-block"
          >
            {t('shared.backToAdmin')}
          </Link>

          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">
                {t('funnelPage.title')}
              </h1>
              <p className="text-gray-600 mt-2">{t('funnelPage.subtitle')}</p>
              <p className="text-xs text-gray-500 mt-1">
                {t('funnelPage.updatedAt', { time: updatedTime })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg font-semibold transition-colors whitespace-nowrap self-start"
            >
              {t('funnelPage.refresh')}
            </button>
          </div>

          <div className="mt-4 bg-blue-50 border border-blue-200 text-blue-900 rounded-lg px-4 py-3 text-sm">
            {t('funnelPage.deferredImportNote')}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {report.windows.map((windowSummary) => {
            const visitCount = windowSummary.stages[0]?.count ?? 0;

            return (
              <section
                key={windowSummary.days}
                data-testid={`funnel-window-${windowSummary.days}`}
                className="bg-white rounded-xl shadow-md border border-gray-200 p-6 flex flex-col gap-4"
              >
                <div className="flex items-center justify-between gap-3 border-b border-gray-100 pb-3">
                  <h2 className="text-xl font-bold text-gray-900">
                    {t(`funnelPage.windows.${windowSummary.days}`)}
                  </h2>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-wide text-gray-500">
                      {t('funnelPage.overallConversion')}
                    </div>
                    <div className="text-base font-bold text-indigo-700">
                      {formatRate(windowSummary.overallRate, locale, emptyRate)}
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-gray-500 border-b border-gray-100">
                        <th className="py-2 pr-2 font-medium">{t('funnelPage.columns.stage')}</th>
                        <th className="py-2 px-2 text-right font-medium">
                          {t('funnelPage.columns.users')}
                        </th>
                        <th className="py-2 pl-2 text-right font-medium">
                          {t('funnelPage.columns.stepConversion')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {windowSummary.stages.map((stageSummary, index) => {
                        const barWidthPercent =
                          visitCount > 0 ? Math.round((stageSummary.count / visitCount) * 100) : 0;

                        return (
                          <tr key={stageSummary.stage}>
                            <td className="py-3 pr-2">
                              <div className="font-medium text-gray-900">
                                {index + 1}. {t(`funnelPage.stages.${stageSummary.stage}`)}
                              </div>
                              <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-indigo-500"
                                  style={{ width: `${barWidthPercent}%` }}
                                />
                              </div>
                            </td>
                            <td className="py-3 px-2 text-right font-semibold text-gray-900 align-top whitespace-nowrap">
                              {numberFormatter.format(stageSummary.count)}
                            </td>
                            <td className="py-3 pl-2 text-right text-gray-700 align-top whitespace-nowrap">
                              {index === 0
                                ? t('funnelPage.entry')
                                : formatRate(stageSummary.transitionRate, locale, emptyRate)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between gap-3 text-sm border-t border-gray-100 pt-3">
                  <span className="text-gray-600">{t('funnelPage.guestPromotions')}</span>
                  <span
                    data-testid={`funnel-guest-promotions-${windowSummary.days}`}
                    className="font-semibold text-gray-900"
                  >
                    {numberFormatter.format(windowSummary.guestPromotions)}
                  </span>
                </div>

                {visitCount === 0 && (
                  <p className="text-xs text-gray-500 pt-1">{t('funnelPage.noData')}</p>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

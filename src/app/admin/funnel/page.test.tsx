import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { NextResponse } from 'next/server';
import { renderWithIntl } from '@/test/intl';
import type { FunnelReport } from '@/lib/funnel-analytics';

const doubles = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getFunnelReport: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: doubles.redirect,
  useRouter: () => ({ refresh: doubles.refresh }),
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: doubles.requireAdmin,
}));

vi.mock('@/lib/funnel-analytics', () => ({
  getFunnelReport: doubles.getFunnelReport,
}));

const { default: AdminFunnelPage } = await import('./page');
const { default: FunnelDashboard } = await import('@/components/admin/funnel/FunnelDashboard');

const SAMPLE_REPORT: FunnelReport = {
  generatedAt: '2026-11-24T12:00:00.000Z',
  windows: [
    {
      days: 1,
      windowStart: '2026-11-23T12:00:00.000Z',
      windowEnd: '2026-11-24T12:00:00.000Z',
      overallRate: null,

      guestPromotions: 0,
      stages: [
        { stage: 'visit', count: 0, transitionRate: null },
        { stage: 'auth', count: 0, transitionRate: null },
        { stage: 'listCreate', count: 0, transitionRate: null },
        { stage: 'itemAdd', count: 0, transitionRate: null },
        { stage: 'itemPurchase', count: 0, transitionRate: null },
      ],
    },
    {
      days: 7,
      windowStart: '2026-11-17T12:00:00.000Z',
      windowEnd: '2026-11-24T12:00:00.000Z',
      overallRate: 0.25,

      guestPromotions: 0,
      stages: [
        { stage: 'visit', count: 20, transitionRate: null },
        { stage: 'auth', count: 10, transitionRate: 0.5 },
        { stage: 'listCreate', count: 10, transitionRate: 1 },
        { stage: 'itemAdd', count: 8, transitionRate: 0.8 },
        { stage: 'itemPurchase', count: 5, transitionRate: 0.625 },
      ],
    },
    {
      days: 30,
      windowStart: '2026-10-25T12:00:00.000Z',
      windowEnd: '2026-11-24T12:00:00.000Z',
      overallRate: 0.2,

      guestPromotions: 0,
      stages: [
        { stage: 'visit', count: 100, transitionRate: null },
        { stage: 'auth', count: 50, transitionRate: 0.5 },
        { stage: 'listCreate', count: 40, transitionRate: 0.8 },
        { stage: 'itemAdd', count: 30, transitionRate: 0.75 },
        { stage: 'itemPurchase', count: 20, transitionRate: 0.6667 },
      ],
    },
  ],
};

beforeEach(() => {
  doubles.requireAdmin.mockReset();
  doubles.getFunnelReport.mockReset().mockResolvedValue(SAMPLE_REPORT);
  doubles.redirect.mockClear();
  doubles.refresh.mockClear();
});

describe('AdminFunnelPage authorization', () => {
  it('redirects away and never reads analytics when caller is not ADMIN', async () => {
    doubles.requireAdmin.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    await expect(AdminFunnelPage()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(doubles.redirect).toHaveBeenCalledWith('/');
    expect(doubles.getFunnelReport).not.toHaveBeenCalled();
  });

  it('reads analytics only after ADMIN authorization passes', async () => {
    doubles.requireAdmin.mockResolvedValue({
      session: { user: { id: 'admin-1', role: 'ADMIN' } },
    });

    const element = await AdminFunnelPage();

    expect(doubles.getFunnelReport).toHaveBeenCalledTimes(1);
    expect(element).toBeTruthy();
  });
});

describe('FunnelDashboard', () => {
  it('renders 1/7/30-day rolling counts, transition rates, and empty denominators in English', () => {
    renderWithIntl(<FunnelDashboard report={SAMPLE_REPORT} />, { locale: 'en' });

    expect(screen.getByText('Action funnel')).toBeTruthy();
    expect(screen.getByText('Last 24 hours')).toBeTruthy();
    expect(screen.getByText('Last 7 days')).toBeTruthy();
    expect(screen.getByText('Last 30 days')).toBeTruthy();
    expect(screen.getByText('No funnel events recorded in this period yet.')).toBeTruthy();
    expect(screen.getByText('62.5%')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).not.toMatch(/[А-Яа-яЁё]/);
    expect(document.body.textContent).not.toContain('NaN');
    expect(document.body.textContent).not.toContain('Infinity');
  });

  it('renders Russian copy cleanly', () => {
    renderWithIntl(<FunnelDashboard report={SAMPLE_REPORT} />, { locale: 'ru' });

    expect(screen.getByText('Воронка действий')).toBeTruthy();
    expect(screen.getByText('За 24 часа')).toBeTruthy();
    expect(screen.getByText('За 7 дней')).toBeTruthy();
    expect(screen.getByText('За 30 дней')).toBeTruthy();
    expect(screen.getByText('За этот период событий воронки пока нет.')).toBeTruthy();
  });
});

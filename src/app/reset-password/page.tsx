'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  getPasswordIssue,
  PASSWORD_MESSAGE_VALUES,
  PASSWORD_MIN_LENGTH,
} from '@/lib/validation/password';

function ResetPasswordForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email');
  const token = searchParams.get('token');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!email || !token) {
    return (
      <div className="bg-yellow-50 text-yellow-700 px-4 py-3 rounded-lg text-sm">
        {t('common.resetLinkInvalid')}
        <div className="mt-2">
          <Link href="/forgot-password" className="text-blue-600 hover:text-blue-700 font-medium">
            {t('resetPassword.requestNewLink')}
          </Link>
        </div>
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const password = formData.get('password') as string;
    const confirmPassword = formData.get('confirmPassword') as string;

    if (password !== confirmPassword) {
      setError(t('common.passwordsMismatch'));
      setLoading(false);
      return;
    }

    const passwordIssue = getPasswordIssue(password);
    if (passwordIssue) {
      setError(t(`password.${passwordIssue}`, PASSWORD_MESSAGE_VALUES));
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error === 'expired') {
          setError(t('common.resetLinkExpired'));
        } else if (data.error === 'invalid') {
          setError(t('common.resetLinkInvalid'));
        } else {
          setError(data.error || t('resetPassword.failed'));
        }
        setLoading(false);
        return;
      }

      router.push('/login?reset=success');
    } catch {
      setError(t('resetPassword.failed'));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
          {t('resetPassword.newPasswordLabel')}
        </label>
        <input
          type="password"
          id="password"
          name="password"
          required
          className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
          placeholder={t('common.passwordMinPlaceholder', { min: PASSWORD_MIN_LENGTH })}
        />
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
          {t('common.confirmPasswordLabel')}
        </label>
        <input
          type="password"
          id="confirmPassword"
          name="confirmPassword"
          required
          className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
          placeholder={t('common.confirmPasswordPlaceholder')}
        />
      </div>

      {error && <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 rounded-lg font-semibold transition-colors shadow-lg hover:shadow-xl"
      >
        {loading ? t('resetPassword.submitting') : t('resetPassword.submit')}
      </button>

      <p className="text-center text-gray-600">
        <Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">
          {t('common.backToLogin')}
        </Link>
      </p>
    </form>
  );
}

function LoadingFallback() {
  const t = useTranslations('auth');
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="text-xl text-gray-600">{t('common.loading')}</div>
    </div>
  );
}

export default function ResetPasswordPage() {
  const t = useTranslations('auth');
  return (
    <Suspense fallback={<LoadingFallback />}>
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold text-gray-900">🔐 {t('resetPassword.title')}</h1>
              <p className="text-gray-600 mt-2">{t('resetPassword.subtitle')}</p>
            </div>
            <ResetPasswordForm />
          </div>
        </div>
      </div>
    </Suspense>
  );
}

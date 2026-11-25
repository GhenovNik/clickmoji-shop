'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  getPasswordIssue,
  PASSWORD_MESSAGE_VALUES,
  PASSWORD_MIN_LENGTH,
} from '@/lib/validation/password';
import { useRouter } from 'next/navigation';
import { getProviders, signIn, useSession } from 'next-auth/react';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import LegalLinks from '@/components/LegalLinks';
import {
  GOOGLE_PROVIDER_ID,
  GUEST_UPGRADE_START_FIELD,
  GUEST_UPGRADE_START_VALUE,
} from '@/lib/guest-upgrade-intent';

/** Reasons the Google callback sends back as `/register?upgrade=<reason>` (AGE-1667). */
function upgradeNoticeKeyFor(reason: string | null) {
  switch (reason) {
    case 'email-taken':
      return 'register.upgradeEmailTaken' as const;
    case 'unverified':
      return 'register.upgradeUnverified' as const;
    case 'expired':
      return 'register.upgradeExpired' as const;
    default:
      return null;
  }
}

export default function RegisterPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const { data: session } = useSession();
  const isGuest = Boolean(session?.user?.isGuest);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);

  useEffect(() => {
    setUpgradeReason(new URLSearchParams(window.location.search).get('upgrade'));

    let active = true;
    getProviders()
      .then((providers) => {
        if (active) setGoogleEnabled(Boolean(providers?.[GOOGLE_PROVIDER_ID]));
      })
      .catch(() => {
        if (active) setGoogleEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const upgradeNoticeKey = upgradeNoticeKeyFor(upgradeReason);
  const shownError = error || (upgradeNoticeKey ? t(upgradeNoticeKey) : '');

  async function startGoogleUpgrade() {
    setError('');
    setUpgradeReason(null);
    try {
      // The server arms the upgrade for this live guest (httpOnly cookie). A refusal means the
      // guest session is no longer live, so the register page shows the expired notice. The same
      // Google provider and redirect URI serve the upgrade: the armed cookie is what makes it one.
      const res = await fetch('/api/auth/guest-upgrade', { method: 'POST' });
      if (!res.ok) {
        setUpgradeReason('expired');
        return;
      }
      // The option is sent as a form field of the POST, which is what makes the start explicit.
      void signIn(GOOGLE_PROVIDER_ID, {
        callbackUrl: '/',
        [GUEST_UPGRADE_START_FIELD]: GUEST_UPGRADE_START_VALUE,
      });
    } catch {
      setError(t('register.networkError'));
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setUpgradeReason(null);
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;
    const confirmPassword = formData.get('confirmPassword') as string;
    const name = formData.get('name') as string;

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
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t('register.failed'));
        setLoading(false);
        return;
      }

      if (data.requiresEmailVerification) {
        router.push('/login?registered=verify');
        return;
      }

      try {
        const result = await signIn('credentials', { email, password, redirect: false });
        if (result?.error) {
          router.push('/login?registered=auto');
          return;
        }
        router.push('/');
        router.refresh();
      } catch {
        router.push('/login?registered=auto');
      }
    } catch {
      setError(t('register.networkError'));
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900">🛒 {t('register.title')}</h1>
            <p className="text-gray-600 mt-2">{t('register.subtitle')}</p>
            {isGuest && (
              <p className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-left text-sm text-blue-900">
                {t('register.guestNotice')}
              </p>
            )}
          </div>

          {isGuest && googleEnabled && (
            <button
              type="button"
              onClick={() => void startGoogleUpgrade()}
              className="mb-4 w-full bg-white hover:bg-gray-50 text-gray-900 border border-gray-300 py-3 rounded-lg font-semibold transition-colors"
            >
              {t('register.saveWithGoogle')}
            </button>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                {t('register.nameLabel')}
              </label>
              <input
                type="text"
                id="name"
                name="name"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
                placeholder={t('register.namePlaceholder')}
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                {t('common.emailLabel')}
              </label>
              <input
                type="email"
                id="email"
                name="email"
                required
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
                placeholder="your@email.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                {t('common.passwordLabel')}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  name="password"
                  required
                  className="w-full px-4 py-3 pr-12 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
                  placeholder={t('common.passwordMinPlaceholder', { min: PASSWORD_MIN_LENGTH })}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700 transition-colors"
                  aria-label={showPassword ? t('common.hidePassword') : t('common.showPassword')}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                {t('common.confirmPasswordLabel')}
              </label>
              <div className="relative">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  id="confirmPassword"
                  name="confirmPassword"
                  required
                  className="w-full px-4 py-3 pr-12 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
                  placeholder={t('common.confirmPasswordPlaceholder')}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700 transition-colors"
                  aria-label={
                    showConfirmPassword ? t('common.hidePassword') : t('common.showPassword')
                  }
                >
                  {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {shownError && (
              <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">
                {shownError}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 rounded-lg font-semibold transition-colors shadow-lg hover:shadow-xl"
            >
              {loading
                ? t('register.submitting')
                : isGuest
                  ? t('register.saveAccount')
                  : t('register.submit')}
            </button>
          </form>

          <p className="text-center text-gray-600 mt-6">
            {t('register.haveAccount')}{' '}
            <Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">
              {t('register.login')}
            </Link>
          </p>

          <LegalLinks
            className="mt-4 justify-center"
            linkClassName="text-gray-500 hover:text-gray-800"
          />
        </div>
      </div>
    </div>
  );
}

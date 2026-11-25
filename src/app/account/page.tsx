'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { useFormatter, useTranslations } from 'next-intl';
import { Download, Eye, EyeOff, KeyRound, ShieldAlert, Trash2, UserCheck } from 'lucide-react';
import LegalLinks from '@/components/LegalLinks';
import {
  getPasswordIssue,
  PASSWORD_MESSAGE_VALUES,
  PASSWORD_MIN_LENGTH,
} from '@/lib/validation/password';

type AccountProfile = {
  id: string;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  createdAt: string;
  hasPassword: boolean;
};

export default function AccountPage() {
  const router = useRouter();
  const { status } = useSession();
  const t = useTranslations('account');
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const format = useFormatter();

  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [profileError, setProfileError] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportSuccess, setExportSuccess] = useState('');

  const [deleteInput, setDeleteInput] = useState('');
  const [showDeletePassword, setShowDeletePassword] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [accountDeleted, setAccountDeleted] = useState(false);

  const routerRef = useRef(router);
  routerRef.current = router;
  const tRef = useRef(t);
  tRef.current = t;

  const loadProfile = useCallback(async () => {
    setLoadingProfile(true);
    setProfileError('');
    try {
      const res = await fetch('/api/account', { cache: 'no-store' });
      if (res.status === 401) {
        routerRef.current.push('/login');
        return;
      }
      const data = (await res.json()) as { user?: AccountProfile; error?: string };
      if (!res.ok || !data.user) {
        setProfileError(data.error || tRef.current('page.loadError'));
        return;
      }
      setProfile(data.user);
    } catch {
      setProfileError(tRef.current('page.loadError'));
    } finally {
      setLoadingProfile(false);
    }
  }, []);

  useEffect(() => {
    if (accountDeleted) return;
    if (status === 'unauthenticated') {
      routerRef.current.push('/login');
      return;
    }
    if (status === 'authenticated') {
      void loadProfile();
    }
  }, [status, accountDeleted, loadProfile]);

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (!currentPassword) {
      setPasswordError(t('password.currentRequired'));
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError(tAuth('common.passwordsMismatch'));
      return;
    }

    const issue = getPasswordIssue(newPassword);
    if (issue) {
      setPasswordError(tAuth(`password.${issue}`, PASSWORD_MESSAGE_VALUES));
      return;
    }

    setPasswordLoading(true);
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        setPasswordError(data.error || t('page.loadError'));
        return;
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess(data.message || t('password.success'));
    } catch {
      setPasswordError(t('page.loadError'));
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handleExport() {
    setExportError('');
    setExportSuccess('');
    setExportLoading(true);
    try {
      const res = await fetch('/api/account/export', { cache: 'no-store' });
      if (!res.ok) {
        let message = t('export.failed');
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          // Keep generic localized fallback when error body is not JSON.
        }
        setExportError(message);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'clickmoji-account-export.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportSuccess(t('export.success'));
    } catch {
      setExportError(t('export.failed'));
    } finally {
      setExportLoading(false);
    }
  }

  async function handleDeleteSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;

    setDeleteError('');
    setDeleteLoading(true);
    try {
      const payload = profile.hasPassword
        ? { password: deleteInput }
        : { confirmation: deleteInput };
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string; success?: boolean };
      if (!res.ok) {
        setDeleteError(data.error || t('page.loadError'));
        return;
      }

      setAccountDeleted(true);
      try {
        await signOut({ redirect: false });
      } catch {
        // Proceed to post-delete state even if client signOut call fails.
      }
      router.push('/login?deleted=true');
      router.refresh();
    } catch {
      setDeleteError(t('page.loadError'));
    } finally {
      setDeleteLoading(false);
    }
  }

  if (accountDeleted) {
    return (
      <div className="py-8 sm:py-12">
        <div className="max-w-xl mx-auto bg-card border border-border rounded-3xl shadow-soft p-6 sm:p-8 space-y-5 text-center">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground font-heading">
            {t('delete.deletedTitle')}
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground">{t('delete.deletedBody')}</p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link
              href="/"
              className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
            >
              {t('delete.toHome')}
            </Link>
            <Link
              href="/login"
              className="px-5 py-2.5 rounded-xl border border-border text-foreground font-semibold text-sm hover:bg-muted transition-colors"
            >
              {t('delete.toLogin')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'loading' || (status === 'authenticated' && loadingProfile)) {
    return (
      <div className="py-12 text-center text-muted-foreground text-base">{tCommon('loading')}</div>
    );
  }

  if (profileError || !profile) {
    return (
      <div className="py-8 sm:py-12">
        <div className="max-w-xl mx-auto bg-card border border-border rounded-3xl shadow-soft p-6 sm:p-8 space-y-4 text-center">
          <p className="text-sm sm:text-base text-red-600">{profileError || t('page.loadError')}</p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void loadProfile()}
              className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              {tCommon('edit')}
            </button>
            <Link
              href="/"
              className="px-4 py-2 rounded-xl border border-border text-sm font-semibold text-foreground hover:bg-muted transition-colors"
            >
              {t('page.backHome')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const createdDate = format.dateTime(new Date(profile.createdAt), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  const phraseWord = t('delete.phraseWord');

  return (
    <div className="py-6 sm:py-10">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-primary hover:text-primary/80 font-medium text-sm sm:text-base"
          >
            <span aria-hidden="true">←</span>
            <span>{t('page.backHome')}</span>
          </Link>
        </div>

        <header className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground font-heading">
            👤 {t('page.title')}
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground">{t('page.subtitle')}</p>
        </header>

        {/* Profile */}
        <section className="bg-card border border-border rounded-3xl shadow-soft p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
            <h2 className="text-lg sm:text-xl font-bold text-foreground">{t('profile.title')}</h2>
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-2xl bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">{t('profile.nameLabel')}</dt>
              <dd className="font-medium text-foreground mt-0.5 break-words">
                {profile.name || t('profile.nameNotSet')}
              </dd>
            </div>
            <div className="rounded-2xl bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">{t('profile.emailLabel')}</dt>
              <dd className="font-medium text-foreground mt-0.5 break-all">{profile.email}</dd>
            </div>
            <div className="rounded-2xl bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">{t('profile.signInMethodLabel')}</dt>
              <dd className="font-medium text-foreground mt-0.5">
                {profile.hasPassword
                  ? t('profile.signInMethodPassword')
                  : t('profile.signInMethodGoogle')}
              </dd>
            </div>
            <div className="rounded-2xl bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">{t('profile.createdAtLabel')}</dt>
              <dd className="font-medium text-foreground mt-0.5">{createdDate}</dd>
            </div>
          </dl>
        </section>

        {/* Password Change */}
        <section className="bg-card border border-border rounded-3xl shadow-soft p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
            <h2 className="text-lg sm:text-xl font-bold text-foreground">{t('password.title')}</h2>
          </div>

          {profile.hasPassword ? (
            <>
              <p className="text-sm text-muted-foreground">{t('password.description')}</p>
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="currentPassword"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('password.currentLabel')}
                  </label>
                  <div className="relative">
                    <input
                      id="currentPassword"
                      name="currentPassword"
                      type={showCurrentPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      placeholder={t('password.currentPlaceholder')}
                      className="w-full px-4 py-2.5 pr-11 rounded-xl border border-gray-300 bg-white text-gray-900 focus:ring-2 focus:ring-primary focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword((prev) => !prev)}
                      className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700"
                      aria-label={
                        showCurrentPassword
                          ? tAuth('common.hidePassword')
                          : tAuth('common.showPassword')
                      }
                    >
                      {showCurrentPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="newPassword"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('password.newLabel')}
                  </label>
                  <div className="relative">
                    <input
                      id="newPassword"
                      name="newPassword"
                      type={showNewPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      placeholder={tAuth('common.passwordMinPlaceholder', {
                        min: PASSWORD_MIN_LENGTH,
                      })}
                      className="w-full px-4 py-2.5 pr-11 rounded-xl border border-gray-300 bg-white text-gray-900 focus:ring-2 focus:ring-primary focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((prev) => !prev)}
                      className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700"
                      aria-label={
                        showNewPassword
                          ? tAuth('common.hidePassword')
                          : tAuth('common.showPassword')
                      }
                    >
                      {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="confirmNewPassword"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('password.confirmLabel')}
                  </label>
                  <div className="relative">
                    <input
                      id="confirmNewPassword"
                      name="confirmNewPassword"
                      type={showConfirmPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      placeholder={tAuth('common.confirmPasswordPlaceholder')}
                      className="w-full px-4 py-2.5 pr-11 rounded-xl border border-gray-300 bg-white text-gray-900 focus:ring-2 focus:ring-primary focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((prev) => !prev)}
                      className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700"
                      aria-label={
                        showConfirmPassword
                          ? tAuth('common.hidePassword')
                          : tAuth('common.showPassword')
                      }
                    >
                      {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                {passwordError && (
                  <div className="bg-red-50 text-red-700 px-4 py-3 rounded-xl text-sm">
                    {passwordError}
                  </div>
                )}

                {passwordSuccess && (
                  <div className="bg-green-50 text-green-700 px-4 py-3 rounded-xl text-sm">
                    {passwordSuccess}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={passwordLoading}
                  className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {passwordLoading ? t('password.submitting') : t('password.submit')}
                </button>
              </form>
            </>
          ) : (
            <div className="rounded-2xl bg-blue-50 border border-blue-200 p-4 space-y-1">
              <p className="text-sm font-semibold text-blue-900">
                {t('password.googleNoticeTitle')}
              </p>
              <p className="text-sm text-blue-800">{t('password.googleNoticeBody')}</p>
            </div>
          )}
        </section>

        {/* Data Export */}
        <section className="bg-card border border-border rounded-3xl shadow-soft p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
            <h2 className="text-lg sm:text-xl font-bold text-foreground">{t('export.title')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t('export.description')}</p>

          {exportError && (
            <div className="bg-red-50 text-red-700 px-4 py-3 rounded-xl text-sm">{exportError}</div>
          )}

          {exportSuccess && (
            <div className="bg-green-50 text-green-700 px-4 py-3 rounded-xl text-sm">
              {exportSuccess}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exportLoading}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border border-border bg-background hover:bg-muted text-foreground font-semibold text-sm disabled:opacity-50 transition-colors"
          >
            <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{exportLoading ? t('export.downloading') : t('export.button')}</span>
          </button>
        </section>

        {/* Legal */}
        <section className="bg-card border border-border rounded-3xl shadow-soft p-5 sm:p-6 space-y-3">
          <h2 className="text-lg sm:text-xl font-bold text-foreground">{t('legal.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('legal.description')}</p>
          <LegalLinks />
        </section>

        {/* Delete Account */}
        <section className="bg-card border border-red-200 rounded-3xl shadow-soft p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2 text-red-700">
            <ShieldAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
            <h2 className="text-lg sm:text-xl font-bold">{t('delete.title')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t('delete.description')}</p>

          <form onSubmit={handleDeleteSubmit} className="space-y-4">
            {profile.hasPassword ? (
              <div>
                <p className="text-sm font-medium text-foreground mb-1.5">
                  {t('delete.passwordPrompt')}
                </p>
                <label htmlFor="deletePassword" className="sr-only">
                  {t('delete.passwordLabel')}
                </label>
                <div className="relative">
                  <input
                    id="deletePassword"
                    name="deletePassword"
                    type={showDeletePassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={deleteInput}
                    onChange={(e) => setDeleteInput(e.target.value)}
                    required
                    placeholder={t('delete.passwordPlaceholder')}
                    className="w-full px-4 py-2.5 pr-11 rounded-xl border border-red-200 bg-white text-gray-900 focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDeletePassword((prev) => !prev)}
                    className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700"
                    aria-label={
                      showDeletePassword
                        ? tAuth('common.hidePassword')
                        : tAuth('common.showPassword')
                    }
                  >
                    {showDeletePassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="deleteConfirmation"
                  className="block text-sm font-medium text-foreground mb-1.5"
                >
                  {t('delete.phrasePrompt', { word: phraseWord })}
                </label>
                <input
                  id="deleteConfirmation"
                  name="deleteConfirmation"
                  type="text"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  required
                  placeholder={phraseWord}
                  className="w-full px-4 py-2.5 rounded-xl border border-red-200 bg-white text-gray-900 focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
              </div>
            )}

            {deleteError && (
              <div className="bg-red-50 text-red-700 px-4 py-3 rounded-xl text-sm">
                {deleteError}
              </div>
            )}

            <button
              type="submit"
              disabled={deleteLoading || !deleteInput.trim()}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{deleteLoading ? t('delete.submitting') : t('delete.submit')}</span>
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

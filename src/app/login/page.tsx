'use client';

import { useEffect, useState, Suspense } from 'react';
import { getProviders, signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const registered = searchParams.get('registered');
  const verified = searchParams.get('verified');
  const resetStatus = searchParams.get('reset');

  useEffect(() => {
    if (verified === 'expired') {
      setNeedsVerification(true);
    }
  }, [verified]);

  useEffect(() => {
    let active = true;

    async function loadProviders() {
      try {
        const providers = await getProviders();
        if (!active) return;
        setGoogleEnabled(Boolean(providers?.google));
      } catch {
        if (!active) return;
        setGoogleEnabled(false);
      }
    }

    loadProviders();

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setNeedsVerification(false);
    setResendStatus('idle');
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        if (result.error === 'EmailNotVerified') {
          setError('Email не подтвержден. Проверьте почту для активации аккаунта.');
          setNeedsVerification(true);
        } else {
          setError('Неверный email или пароль');
        }
        setLoading(false);
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('Ошибка входа');
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    if (!googleEnabled) {
      setError('Google-вход временно недоступен');
      return;
    }

    setError('');
    await signIn('google', { callbackUrl: '/' });
  }

  async function handleResend() {
    if (!email) {
      setError('Введите email, чтобы отправить письмо');
      return;
    }

    setResendStatus('sending');

    try {
      const res = await fetch('/api/auth/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        setResendStatus('error');
        setError('Не удалось отправить письмо');
        return;
      }

      setResendStatus('sent');
    } catch {
      setResendStatus('error');
      setError('Не удалось отправить письмо');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900">🛒 Вход</h1>
            <p className="text-gray-600 mt-2">Войдите в Clickmoji Shop</p>
          </div>

          {registered === 'verify' && (
            <div className="bg-green-50 text-green-600 px-4 py-3 rounded-lg text-sm mb-4">
              Регистрация успешна! Проверьте почту и подтвердите email.
            </div>
          )}

          {registered === 'auto' && (
            <div className="bg-green-50 text-green-600 px-4 py-3 rounded-lg text-sm mb-4">
              Регистрация успешна! Можно войти с email и паролем.
            </div>
          )}

          {verified === 'true' && (
            <div className="bg-green-50 text-green-600 px-4 py-3 rounded-lg text-sm mb-4">
              Email подтвержден! Теперь можно войти.
            </div>
          )}

          {verified === 'expired' && (
            <div className="bg-yellow-50 text-yellow-700 px-4 py-3 rounded-lg text-sm mb-4">
              <div>Ссылка подтверждения истекла. Отправьте письмо еще раз.</div>
              <button
                type="button"
                onClick={handleResend}
                disabled={resendStatus === 'sending'}
                className="mt-2 text-blue-600 hover:text-blue-700 font-medium disabled:text-blue-300"
              >
                {resendStatus === 'sent'
                  ? 'Письмо отправлено'
                  : resendStatus === 'sending'
                    ? 'Отправляем...'
                    : 'Отправить письмо еще раз'}
              </button>
            </div>
          )}

          {verified === 'invalid' && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm mb-4">
              Ссылка подтверждения недействительна.
            </div>
          )}

          {verified === 'error' && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm mb-4">
              Не удалось подтвердить email. Попробуйте еще раз.
            </div>
          )}

          {resetStatus === 'success' && (
            <div className="bg-green-50 text-green-600 px-4 py-3 rounded-lg text-sm mb-4">
              Пароль обновлен. Войдите с новым паролем.
            </div>
          )}

          {resetStatus === 'expired' && (
            <div className="bg-yellow-50 text-yellow-700 px-4 py-3 rounded-lg text-sm mb-4">
              Ссылка для сброса истекла. Запросите новую.
            </div>
          )}

          {resetStatus === 'invalid' && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm mb-4">
              Ссылка для сброса недействительна.
            </div>
          )}

          {resetStatus === 'error' && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm mb-4">
              Не удалось сбросить пароль. Попробуйте еще раз.
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                type="email"
                id="email"
                name="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (resendStatus !== 'idle') {
                    setResendStatus('idle');
                  }
                }}
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
                placeholder="your@email.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Пароль
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  name="password"
                  required
                  className="w-full px-4 py-3 pr-12 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
                  placeholder="Ваш пароль"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700 transition-colors"
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">
                <div>{error}</div>
                {needsVerification && (
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resendStatus === 'sending'}
                    className="mt-2 text-blue-600 hover:text-blue-700 font-medium disabled:text-blue-300"
                  >
                    {resendStatus === 'sent'
                      ? 'Письмо отправлено'
                      : resendStatus === 'sending'
                        ? 'Отправляем...'
                        : 'Отправить письмо еще раз'}
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 rounded-lg font-semibold transition-colors shadow-lg hover:shadow-xl"
            >
              {loading ? 'Вход...' : 'Войти'}
            </button>
          </form>

          {googleEnabled && (
            <div className="mt-6">
              <div className="flex items-center gap-3 text-gray-400 text-sm">
                <span className="h-px flex-1 bg-gray-200" />
                <span>или</span>
                <span className="h-px flex-1 bg-gray-200" />
              </div>
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="mt-4 w-full border border-gray-300 text-gray-900 py-3 rounded-lg font-semibold transition-colors hover:bg-gray-50"
              >
                Войти через Google
              </button>
            </div>
          )}

          <p className="text-center text-gray-600 mt-6">
            Нет аккаунта?{' '}
            <Link href="/register" className="text-blue-600 hover:text-blue-700 font-medium">
              Зарегистрироваться
            </Link>
          </p>
          <p className="text-center text-gray-600 mt-2">
            <Link href="/forgot-password" className="text-blue-600 hover:text-blue-700 font-medium">
              Забыли пароль?
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
          <div className="text-xl text-gray-600">Загрузка...</div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

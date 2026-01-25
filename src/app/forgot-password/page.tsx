'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setStatus('sending');

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        setStatus('error');
        setError('Не удалось отправить письмо');
        return;
      }

      setStatus('sent');
    } catch {
      setStatus('error');
      setError('Не удалось отправить письмо');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900">🔐 Сброс пароля</h1>
            <p className="text-gray-600 mt-2">Отправим ссылку для смены пароля</p>
          </div>

          {status === 'sent' ? (
            <div className="bg-green-50 text-green-600 px-4 py-3 rounded-lg text-sm">
              Если адрес существует, письмо уже в пути. Проверьте почту.
            </div>
          ) : (
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
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900"
                  placeholder="your@email.com"
                />
              </div>

              {error && (
                <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>
              )}

              <button
                type="submit"
                disabled={status === 'sending'}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 rounded-lg font-semibold transition-colors shadow-lg hover:shadow-xl"
              >
                {status === 'sending' ? 'Отправляем...' : 'Отправить ссылку'}
              </button>
            </form>
          )}

          <p className="text-center text-gray-600 mt-6">
            <Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">
              Вернуться ко входу
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

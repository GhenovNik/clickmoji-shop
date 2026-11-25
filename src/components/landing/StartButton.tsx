'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ArrowRight } from 'lucide-react';
import { useRequestSessionRefresh } from '@/components/Providers';

interface StartButtonProps {
  label: string;
  errorLabel: string;
}

/**
 * Primary landing CTA: ensures a server-backed guest session exists (or reuses an active
 * authenticated session) and navigates into the catalog so lists, purchasing and history work
 * immediately.
 */
export default function StartButton({ label, errorLabel }: StartButtonProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const requestSessionRefresh = useRequestSessionRefresh();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);

  const handleStart = async () => {
    if (pendingRef.current) return;
    setError('');

    if (session?.user) {
      router.push('/categories');
      return;
    }

    pendingRef.current = true;
    setStarting(true);

    try {
      const response = await fetch('/api/auth/guest', { method: 'POST' });
      const data: { error?: unknown } | null = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof data?.error === 'string' && data.error.trim() ? data.error : errorLabel;
        setError(message);
        return;
      }

      // Header, MobileNav and catalog read the client session: re-read it now, without a reload.
      requestSessionRefresh();
      router.push('/categories');
      router.refresh();
    } catch {
      setError(errorLabel);
    } finally {
      pendingRef.current = false;
      setStarting(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleStart}
        disabled={starting}
        className="inline-flex w-full sm:w-auto items-center justify-center gap-2.5 min-h-12 bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-3.5 rounded-2xl font-bold text-base sm:text-lg shadow-soft hover:shadow-clay active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60 disabled:cursor-wait group cursor-pointer"
      >
        <span>{label}</span>
        <ArrowRight
          className="w-5 h-5 group-hover:translate-x-1 transition-transform"
          aria-hidden="true"
        />
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive font-medium">
          {error}
        </p>
      )}
    </div>
  );
}

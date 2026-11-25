'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { SessionProvider } from 'next-auth/react';
import { QueryProvider } from '@/providers/QueryProvider';

type RequestSessionRefresh = () => void;

const SessionRefreshContext = createContext<RequestSessionRefresh | null>(null);

/**
 * Returns a function that makes every session consumer re-read `/api/auth/session` right away.
 * Needed after an anonymous client gains a session (guest Start): next-auth's `update()` is a
 * no-op while the client session is still null, so the provider is re-mounted to fetch it again.
 */
export function useRequestSessionRefresh(): RequestSessionRefresh {
  const request = useContext(SessionRefreshContext);
  if (!request) {
    throw new Error('useRequestSessionRefresh must be used inside <Providers />');
  }
  return request;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const requestSessionRefresh = useCallback(() => setSessionEpoch((epoch) => epoch + 1), []);
  const contextValue = useMemo(() => requestSessionRefresh, [requestSessionRefresh]);

  return (
    <SessionRefreshContext.Provider value={contextValue}>
      <SessionProvider key={sessionEpoch}>
        <QueryProvider>{children}</QueryProvider>
      </SessionProvider>
    </SessionRefreshContext.Provider>
  );
}

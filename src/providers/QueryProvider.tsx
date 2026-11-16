'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { purchaseIntentStore } from '@/hooks/purchaseIntent';

function SessionObserver({ client }: { client: QueryClient }) {
  const { data, status } = useSession();
  useEffect(() => {
    purchaseIntentStore(client).observeSession(status, data?.user?.id ?? null);
  }, [client, data?.user?.id, status]);
  useEffect(() => () => purchaseIntentStore(client).dispose(), [client]);
  return null;
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // Keep fetched data fresh for five minutes.
            gcTime: 10 * 60 * 1000, // Retain inactive queries for ten minutes.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionObserver client={queryClient} />
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}

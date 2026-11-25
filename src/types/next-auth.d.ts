import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    /** Immutable initial-issuance time (Unix seconds), copied unchanged across refreshes. */
    sessionIssuedAt?: number;
    user: {
      id: string;
      role: string;
      isGuest?: boolean;
    } & DefaultSession['user'];
  }

  interface User {
    role: string;
    isGuest?: boolean;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: string;
    isGuest?: boolean;
    /** Immutable initial-issuance time (Unix seconds). Set once at sign-in or guest creation. */
    sessionIssuedAt?: number;
  }
}

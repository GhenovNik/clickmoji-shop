import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    tokenIssuedAt?: number;
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
  }
}

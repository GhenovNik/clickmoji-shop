import { getServerSession, type NextAuthOptions } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { authConfig } from './auth.config';
import { isEmailVerificationRequired } from './email';
import { normalizeEmail } from './auth-security';
import { readGuestIdFromRequestScope, recordFunnelEvent } from './funnel';
import {
  currentSessionIssuedAtSeconds,
  isGuestEmail,
  isSessionIssuedAtClaim,
  isSessionTokenFreshForUser,
} from './guest';

const providers: NextAuthOptions['providers'] = [
  Credentials({
    name: 'credentials',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) {
        return null;
      }

      const email = normalizeEmail(credentials.email as string);
      const password = credentials.password as string;

      if (isGuestEmail(email)) {
        return null;
      }

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user || user.isGuest || !user.password) {
        return null;
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        return null;
      }

      if (isEmailVerificationRequired() && !user.emailVerified) {
        throw new Error('EmailNotVerified');
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
        isGuest: user.isGuest,
      };
    },
  }),
];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

export const authOptions: NextAuthOptions = {
  ...authConfig,
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'google') {
        if (user?.id) {
          const guestId = await readGuestIdFromRequestScope();
          await recordFunnelEvent({
            type: 'LOGIN',
            userId: user.id,
            guestId,
            correlateGuest: true,
          });
        }
        return true;
      }

      const email = normalizeEmail((user.email || profile?.email || '') as string);
      if (!email || isGuestEmail(email)) {
        return false;
      }

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser?.isGuest) {
        return false;
      }

      let authenticatedUserId: string;
      let authenticatedRole = 'USER';
      let isNewUser = false;

      if (!existingUser) {
        const createdUser = await prisma.user.create({
          data: {
            email,
            name: user.name || null,
            image: user.image || null,
            password: null,
            emailVerified: new Date(),
          },
        });
        authenticatedUserId = createdUser.id;
        authenticatedRole = createdUser.role ?? 'USER';
        isNewUser = true;
      } else {
        await prisma.user.update({
          where: { email },
          data: {
            name: existingUser.name || user.name || null,
            image: user.image || existingUser.image,
            emailVerified: existingUser.emailVerified || new Date(),
            password: existingUser.emailVerified ? undefined : null,
          },
        });
        authenticatedUserId = existingUser.id;
        authenticatedRole = existingUser.role ?? 'USER';
      }

      // NextAuth passes this same object to the jwt callback on sign-in; the token must carry
      // the DB id of the account that was just authorised, not the Google subject.
      user.id = authenticatedUserId;
      (user as typeof user & { role?: string; isGuest?: boolean }).role = authenticatedRole;
      (user as typeof user & { isGuest?: boolean }).isGuest = false;

      const guestId = await readGuestIdFromRequestScope();
      await recordFunnelEvent({
        type: isNewUser ? 'REGISTER' : 'LOGIN',
        userId: authenticatedUserId,
        guestId,
        correlateGuest: true,
      });

      return true;
    },
    async jwt({ token, user, account }) {
      if (user) {
        // Initial issuance: stamp the immutable claim once. Refreshes below copy it unchanged.
        const sessionIssuedAt = currentSessionIssuedAtSeconds();

        if (account?.provider === 'google') {
          // The signIn callback already resolved or created the row and set user.id to its
          // User.id. Identify it by that id; never look the account up by email again here.
          const dbUser = user.id
            ? await prisma.user.findUnique({
                where: { id: user.id },
                select: { id: true, role: true, email: true, isGuest: true },
              })
            : null;
          if (!dbUser || dbUser.isGuest) {
            throw new Error('Invalid OAuth user');
          }
          token.id = dbUser.id;
          token.sub = dbUser.id;
          token.role = dbUser.role;
          token.email = dbUser.email;
          token.isGuest = dbUser.isGuest;
          token.sessionIssuedAt = sessionIssuedAt;
          return token;
        }

        token.id = user.id;
        token.sub = user.id;
        token.role = (user as typeof user & { role?: string }).role ?? 'USER';
        token.email = user.email;
        token.isGuest = Boolean((user as typeof user & { isGuest?: boolean }).isGuest);
        token.sessionIssuedAt = sessionIssuedAt;
        return token;
      }

      // Refresh of an existing session. Identify strictly by the stable User.id (never by email)
      // and require the immutable issuance claim to be present and not older than the row itself.
      // Tokens without the claim (issued before it existed) are rejected: the user signs in again.
      const hasCompleteIdentity =
        typeof token.id === 'string' && token.id.length > 0 && token.sub === token.id;
      if (!hasCompleteIdentity || !isSessionIssuedAtClaim(token.sessionIssuedAt)) {
        throw new Error('Session token incomplete');
      }

      const dbUser = await prisma.user.findUnique({
        where: { id: token.id },
        select: { id: true, role: true, email: true, isGuest: true, createdAt: true },
      });

      if (!dbUser || !isSessionTokenFreshForUser(token.sessionIssuedAt, dbUser.createdAt)) {
        throw new Error('Session user no longer valid');
      }

      // A guest token minted before the row was promoted in place (AGE-1667) keeps the same id and
      // passes the issuance check, so the stored isGuest claim is compared with the row here.
      // Checked before the claim is overwritten below.
      if (token.isGuest === true && !dbUser.isGuest) {
        throw new Error('Guest session superseded by account');
      }

      token.role = dbUser.role;
      token.email = dbUser.email;
      token.isGuest = dbUser.isGuest;

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.isGuest = Boolean(token.isGuest);
      }
      if (isSessionIssuedAtClaim(token.sessionIssuedAt)) {
        session.sessionIssuedAt = token.sessionIssuedAt;
      }
      return session;
    },
  },
  providers,
};

/**
 * Reads the current session. The jwt callback throws for a token whose user row was deleted or
 * recreated, and next-auth does not catch that. Such a token is treated as signed out here, so a
 * stale guest cookie yields an anonymous caller (for example Start can mint a fresh guest) instead
 * of a 500 on every route.
 */
export async function auth() {
  try {
    return await getServerSession(authOptions);
  } catch (error) {
    console.warn('Session token rejected; treating caller as signed out', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

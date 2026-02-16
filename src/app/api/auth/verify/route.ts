import { NextResponse } from 'next/server';
import { consumeEmailVerificationToken } from '@/lib/auth-tokens';
import { normalizeEmail } from '@/lib/auth-security';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const email = normalizeEmail(searchParams.get('email') || '');
  const loginUrl = new URL('/login', request.url);

  if (!token || !email) {
    loginUrl.searchParams.set('verified', 'invalid');
    return NextResponse.redirect(loginUrl);
  }

  try {
    const result = await consumeEmailVerificationToken(email, token);
    loginUrl.searchParams.set('verified', result.success ? 'true' : result.reason);
  } catch (error) {
    console.error('Email verification error:', error);
    loginUrl.searchParams.set('verified', 'error');
  }

  return NextResponse.redirect(loginUrl);
}

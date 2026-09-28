import { NextResponse, type NextRequest } from 'next/server';

/** Give every browser a random guest id (who "you" are for your own comments). */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.cookies.get('share_guest')) {
    res.cookies.set('share_guest', crypto.randomUUID(), {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
      path: '/', maxAge: 365 * 24 * 60 * 60,
    });
  }
  return res;
}

export const config = { matcher: ['/s/:path*', '/v/:path*', '/api/s/:path*'] };

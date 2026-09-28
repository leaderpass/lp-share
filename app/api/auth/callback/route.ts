import { NextResponse } from 'next/server';
import { verifyMagicToken, SESSION_COOKIE, makeSessionValue, sessionCookieOptions, appOrigin } from '@/lib/auth';
import { safeNext } from '@/lib/viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?token=… from the emailed link → verify, start a session, land on home. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const token = sp.get('token') ?? '';
  const next = safeNext(sp.get('next'));
  const origin = appOrigin(req);

  const email = verifyMagicToken(token);
  if (!email) return NextResponse.redirect(`${origin}${next === '/' ? '/signin' : next}?error=expired`);

  const res = NextResponse.redirect(`${origin}${next}`);
  res.cookies.set(SESSION_COOKIE, makeSessionValue(email), sessionCookieOptions());
  return res;
}

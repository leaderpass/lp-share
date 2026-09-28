import { NextResponse } from 'next/server';
import { appOrigin } from '@/lib/auth';
import { STAFF_COOKIE, safeNext, staffCookieOptions } from '@/lib/viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?next= — drop the staff pass. */
export async function GET(req: Request) {
  const res = NextResponse.redirect(`${appOrigin(req)}${safeNext(new URL(req.url).searchParams.get('next'))}`);
  res.cookies.set(STAFF_COOKIE, '', { ...staffCookieOptions(), maxAge: 0 });
  return res;
}

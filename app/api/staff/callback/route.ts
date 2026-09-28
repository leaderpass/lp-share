import { NextResponse } from 'next/server';
import { appOrigin } from '@/lib/auth';
import { useStaffTicket } from '@/lib/share-db';
import { STAFF_COOKIE, safeNext, staffCookieOptions, staffCookieValue, verifyStaffTicket } from '@/lib/viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?ticket=…&next=… — LPOS vouched for a staff member: verify once, set the staff pass. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const origin = appOrigin(req);
  const next = safeNext(sp.get('next'));
  const t = verifyStaffTicket(sp.get('ticket') ?? '');
  if (!t || !useStaffTicket(t.jti)) {
    return NextResponse.redirect(`${origin}${next}${next.includes('?') ? '&' : '?'}staff=expired`);
  }
  const res = NextResponse.redirect(`${origin}${next}`);
  res.cookies.set(STAFF_COOKIE, staffCookieValue({ uid: t.uid, name: t.name, email: t.email }), staffCookieOptions());
  return res;
}

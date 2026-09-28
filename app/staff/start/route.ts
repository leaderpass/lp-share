import { NextResponse } from 'next/server';
import { appOrigin } from '@/lib/auth';
import { safeNext } from '@/lib/viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /staff/start?next=/s/… → bounce to LPOS, which (if you're signed in there)
 * sends you back to /api/staff/callback with a one-time staff ticket. Spec §3.
 */
export async function GET(req: Request) {
  const next = safeNext(new URL(req.url).searchParams.get('next'));
  const lpos = (process.env.LPOS_ORIGIN ?? '').replace(/\/+$/, '');
  if (!lpos) return NextResponse.redirect(`${appOrigin(req)}${next}`);
  return NextResponse.redirect(`${lpos}/share-auth?next=${encodeURIComponent(next)}`);
}

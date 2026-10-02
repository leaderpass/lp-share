import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { firstVisitsSince } from '@/lib/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?since=cursor — first-time opens of shares, for LPOS's bell. */
export async function GET(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0) || 0;
  return NextResponse.json({ ok: true, ...firstVisitsSince(since) });
}

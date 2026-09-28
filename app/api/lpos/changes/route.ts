import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { changesSince } from '@/lib/share-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?since=cursor — comment changes made here that LPOS hasn't acknowledged. */
export async function GET(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0) || 0;
  return NextResponse.json({ ok: true, ...changesSince(since) });
}

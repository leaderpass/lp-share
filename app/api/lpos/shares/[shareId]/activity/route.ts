import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { getShareById } from '@/lib/share-db';
import { shareActivitySummary } from '@/lib/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — one share's activity (opens, viewers, downloads) for LPOS's Analytics panel. */
export async function GET(req: Request, { params }: { params: { shareId: string } }) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const share = getShareById(params.shareId);
  if (!share) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, activity: shareActivitySummary(share) });
}

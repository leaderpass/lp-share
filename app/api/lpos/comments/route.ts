import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { replaceAssetCommentsFromLpos } from '@/lib/share-db';
import type { LposComment } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { asset_id, comments } (or an array of them) — an asset's full comment set from LPOS. */
export async function POST(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  type Body = { asset_id: string; comments: LposComment[] };
  const body = (await req.json().catch(() => null)) as Body | Body[] | null;
  const sets = body ? (Array.isArray(body) ? body : [body]) : [];
  if (!sets.length || sets.some((s) => !s?.asset_id || !Array.isArray(s.comments))) {
    return NextResponse.json({ ok: false, error: 'bad payload' }, { status: 400 });
  }
  for (const s of sets) replaceAssetCommentsFromLpos(s.asset_id, s.comments);
  return NextResponse.json({ ok: true, assets: sets.length });
}

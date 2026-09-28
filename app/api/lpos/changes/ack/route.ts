import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { ackChanges } from '@/lib/share-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { cursor, mapped: [{ share_comment_id, lpos_id }] } — LPOS applied everything up to cursor. */
export async function POST(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const body = (await req.json().catch(() => null)) as { cursor?: number; mapped?: Array<{ share_comment_id: string; lpos_id: string }> } | null;
  if (!body || typeof body.cursor !== 'number') return NextResponse.json({ ok: false, error: 'bad payload' }, { status: 400 });
  ackChanges(body.cursor, (body.mapped ?? []).filter((m) => m?.share_comment_id && m?.lpos_id));
  return NextResponse.json({ ok: true });
}

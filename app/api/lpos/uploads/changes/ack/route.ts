import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { ackUploadChanges } from '@/lib/upload-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { cursor } — LPOS applied every upload change up to cursor. */
export async function POST(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const body = (await req.json().catch(() => null)) as { cursor?: number } | null;
  if (!body || typeof body.cursor !== 'number') return NextResponse.json({ ok: false, error: 'bad payload' }, { status: 400 });
  ackUploadChanges(body.cursor);
  return NextResponse.json({ ok: true });
}

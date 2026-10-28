import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { downloadChangesSince } from '@/lib/upload-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?since=cursor — team-file downloads LPOS hasn't acknowledged (spec §12.6). */
export async function GET(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0) || 0;
  return NextResponse.json({ ok: true, ...downloadChangesSince(since) });
}

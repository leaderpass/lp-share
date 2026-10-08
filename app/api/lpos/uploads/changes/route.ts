import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { uploadChangesSince } from '@/lib/upload-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?since=cursor — finished and removed client uploads LPOS hasn't acknowledged (spec §12.2). */
export async function GET(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0) || 0;
  return NextResponse.json({ ok: true, ...uploadChangesSince(since) });
}

import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { upsertShareFromLpos } from '@/lib/share-db';
import type { SharePayload } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST — LPOS pushes one share or an array (full replace per share, idempotent). */
export async function POST(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const body = (await req.json().catch(() => null)) as SharePayload | SharePayload[] | null;
  const payloads = body ? (Array.isArray(body) ? body : [body]) : [];
  if (!payloads.length || payloads.some((p) => !p?.share?.id || !p.share.token || !Array.isArray(p.items))) {
    return NextResponse.json({ ok: false, error: 'bad payload' }, { status: 400 });
  }
  for (const p of payloads) upsertShareFromLpos({ ...p, emails: p.emails ?? [] });
  return NextResponse.json({ ok: true, shares: payloads.length });
}

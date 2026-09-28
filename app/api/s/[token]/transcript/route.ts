import { NextResponse } from 'next/server';
import { resolveShareRequest } from '@/lib/share-request';
import { shareItems } from '@/lib/share-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?asset= → { cues: [{ fromMs, text }] } while the share's Transcript switch is on. */
export async function GET(req: Request, { params }: { params: { token: string } }) {
  const r = resolveShareRequest(params.token);
  if (r.deny) return r.deny;
  if (!r.share.caps.transcripts) return NextResponse.json({ cues: [] });
  const item = shareItems(r.share.id).find((i) => i.asset_id === new URL(req.url).searchParams.get('asset'));
  if (!item) return NextResponse.json({ error: 'Video not in this share' }, { status: 404 });
  return NextResponse.json({ cues: (item.transcript ?? []).map((c) => ({ fromMs: c.from_ms, text: c.text })) });
}

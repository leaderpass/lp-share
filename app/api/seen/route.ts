import { NextResponse } from 'next/server';
import { getShareByToken, itemByVideoToken } from '@/lib/share-db';
import { currentViewer, shareAccess, videoAccess } from '@/lib/viewer';
import { recordActivity } from '@/lib/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST { s: shareToken } | { v: videoToken }, plus the viewer's typed name.
 * Sent by the page once it has loaded in a browser, so link previews (which
 * fetch the HTML but never run it) don't count as opens.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { s?: string; v?: string; name?: string };
  const viewer = currentViewer();
  if (body.s) {
    const share = getShareByToken(body.s);
    if (share && shareAccess(share, viewer).ok) recordActivity(share, viewer, { kind: 'open', name: body.name });
  } else if (body.v) {
    const hit = itemByVideoToken(body.v);
    if (hit && videoAccess(hit.share, viewer).ok) recordActivity(hit.share, viewer, { kind: 'video_open', assetId: hit.item.asset_id, name: body.name });
  }
  return new NextResponse(null, { status: 204 });
}

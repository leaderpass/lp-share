import { NextResponse } from 'next/server';
import { activeLink, guestId, rateLimited } from '@/lib/upload-request';
import { getLiveTeamFile, getUploadRow, recordTeamFileDownload } from '@/lib/upload-db';
import { presignGet, uploadsConfigured } from '@/lib/s3';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST { name } → { url } — a short-lived download link for one file on the
 * page: a team file (recorded as a download for LPOS, and no longer New for
 * this browser) or a client upload still in storage. Bytes come straight
 * from R2.
 */
export async function POST(req: Request, { params }: { params: { token: string; fileId: string } }) {
  const r = activeLink(params.token);
  if ('res' in r) return r.res;
  if (rateLimited(params.token)) return NextResponse.json({ error: 'Too many requests. Try again in a few minutes.' }, { status: 429 });
  if (!uploadsConfigured()) return NextResponse.json({ error: 'Downloads are unavailable right now.' }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = String(body?.name ?? '').trim().slice(0, 80);

  const team = getLiveTeamFile(r.link.id, params.fileId);
  if (team) {
    if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 });
    recordTeamFileDownload(team, name, guestId());
    return NextResponse.json({ url: presignGet(team.key, team.file_name) });
  }

  const u = getUploadRow(r.link.id, params.fileId);
  if (!u || !u.completed_at || u.removed_at || u.lpos_status === 'gone' || u.file_gone) {
    return NextResponse.json({ error: 'This file is no longer available' }, { status: 410 });
  }
  return NextResponse.json({ url: presignGet(u.key, u.file_name) });
}

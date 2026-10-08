import { NextResponse } from 'next/server';
import { activeLink, guestId } from '@/lib/upload-request';
import { getUploadRow } from '@/lib/upload-db';
import { presignPart } from '@/lib/s3';
import { partCount } from '@/lib/upload-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { parts: [n…] } (≤ 100) → { urls: { n: url } } presigned part PUTs. */
export async function POST(req: Request, { params }: { params: { token: string; uploadId: string } }) {
  const r = activeLink(params.token);
  if ('res' in r) return r.res;
  const u = getUploadRow(r.link.id, params.uploadId);
  if (!u || u.guest_id !== guestId() || u.completed_at || u.removed_at) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { parts?: number[] } | null;
  const total = partCount(u.size, u.part_size);
  const parts = (body?.parts ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= total).slice(0, 100);
  if (!parts.length) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  return NextResponse.json({ urls: Object.fromEntries(parts.map((n) => [n, presignPart(u.key, u.multipart_id, n)])) });
}

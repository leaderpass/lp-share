import { NextResponse } from 'next/server';
import { activeLink, guestId, toPublic } from '@/lib/upload-request';
import { getUploadRow, markUploadComplete } from '@/lib/upload-db';
import { completeMultipart, deleteObject, headObject } from '@/lib/s3';
import { partCount } from '@/lib/upload-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { parts: [{ n, etag }] } — finish the multipart upload and tell LPOS (via the change feed). */
export async function POST(req: Request, { params }: { params: { token: string; uploadId: string } }) {
  const r = activeLink(params.token);
  if ('res' in r) return r.res;
  const guest = guestId();
  const u = getUploadRow(r.link.id, params.uploadId);
  if (!u || u.guest_id !== guest || u.removed_at) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (u.completed_at) return NextResponse.json({ upload: toPublic(u, guest) });

  const body = (await req.json().catch(() => null)) as { parts?: Array<{ n: number; etag: string }> } | null;
  const parts = (body?.parts ?? []).filter((p) => Number.isInteger(p?.n) && typeof p?.etag === 'string' && p.etag);
  if (parts.length !== partCount(u.size, u.part_size)) return NextResponse.json({ error: 'Upload is missing parts' }, { status: 400 });

  try {
    await completeMultipart(u.key, u.multipart_id, parts);
  } catch (err) {
    // A retried complete after one that succeeded: the object is already there.
    if (!(await headObject(u.key).catch(() => null))) {
      console.warn('[uploads] complete failed:', (err as Error).message);
      return NextResponse.json({ error: 'Upload could not be finished' }, { status: 502 });
    }
  }
  const head = await headObject(u.key);
  if (!head || head.size !== u.size) {
    await deleteObject(u.key).catch(() => undefined);
    return NextResponse.json({ error: 'Upload size did not match' }, { status: 400 });
  }
  markUploadComplete(u.id);
  return NextResponse.json({ upload: toPublic(getUploadRow(r.link.id, u.id)!, guest) });
}

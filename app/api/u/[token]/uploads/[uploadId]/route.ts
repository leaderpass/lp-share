import { NextResponse } from 'next/server';
import { activeLink, guestId } from '@/lib/upload-request';
import { deleteUnfinishedUpload, getUploadRow, markUploadRemoved } from '@/lib/upload-db';
import { abortMultipart, deleteObject, listParts } from '@/lib/s3';
import { partCount } from '@/lib/upload-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — resume an unfinished upload from this browser: parts R2 already has. */
export async function GET(_req: Request, { params }: { params: { token: string; uploadId: string } }) {
  const r = activeLink(params.token);
  if ('res' in r) return r.res;
  const u = getUploadRow(r.link.id, params.uploadId);
  if (!u || u.guest_id !== guestId() || u.completed_at || u.removed_at) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const done = await listParts(u.key, u.multipart_id).catch(() => null);
  if (!done) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    uploadId: u.id, size: u.size, partSize: u.part_size, partCount: partCount(u.size, u.part_size),
    done: done.filter((p) => p.size > 0).map((p) => ({ n: p.n, etag: p.etag })),
  });
}

/**
 * DELETE — this browser takes a file back: cancels an unfinished upload, or
 * removes a finished one while it's still waiting for the team (spec §12.2).
 */
export async function DELETE(_req: Request, { params }: { params: { token: string; uploadId: string } }) {
  const r = activeLink(params.token);
  if ('res' in r) return r.res;
  const u = getUploadRow(r.link.id, params.uploadId);
  if (!u || !u.guest_id || u.guest_id !== guestId() || u.removed_at) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!u.completed_at) {
    await abortMultipart(u.key, u.multipart_id).catch(() => undefined);
    deleteUnfinishedUpload(u.id);
    return NextResponse.json({ ok: true });
  }
  if (u.lpos_status === 'added' || u.lpos_status === 'gone') {
    return NextResponse.json({ error: 'This file has already been added to the project' }, { status: 409 });
  }
  markUploadRemoved(u.id);
  await deleteObject(u.key).catch((err) => console.warn('[uploads] delete failed:', (err as Error).message));
  return NextResponse.json({ ok: true });
}

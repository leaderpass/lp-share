import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { activeLink, guestId, rateLimited, toPublic } from '@/lib/upload-request';
import { createUploadRow, listVisibleUploads } from '@/lib/upload-db';
import { createMultipart, uploadsConfigured } from '@/lib/s3';
import { BLOCKED_EXTENSIONS, MAX_FILE_BYTES, extensionOf, mimeFor, partCount, partSizeFor, sanitizeFileName } from '@/lib/upload-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — files sent through this link. */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const r = activeLink(params.token);
  if ('res' in r) return r.res;
  const guest = guestId();
  return NextResponse.json({ uploads: listVisibleUploads(r.link.id).map((u) => toPublic(u, guest)) });
}

/** POST { fileName, size, contentType, uploaderName } — start a multipart upload (spec §12.3). */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const r = activeLink(params.token);
  if ('res' in r) return r.res;
  if (rateLimited(params.token)) return NextResponse.json({ error: 'Too many uploads. Try again in a few minutes.' }, { status: 429 });
  if (!uploadsConfigured()) return NextResponse.json({ error: 'Uploads are unavailable right now.' }, { status: 503 });

  const body = (await req.json().catch(() => null)) as { fileName?: string; size?: number; contentType?: string; uploaderName?: string } | null;
  const fileName = sanitizeFileName(String(body?.fileName ?? ''));
  const size = Number(body?.size);
  const uploaderName = String(body?.uploaderName ?? '').trim().slice(0, 80);
  if (!body?.fileName || !Number.isFinite(size) || size <= 0) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  if (!uploaderName) return NextResponse.json({ error: 'Name required' }, { status: 400 });
  const ext = extensionOf(fileName);
  if (BLOCKED_EXTENSIONS.has(ext)) return NextResponse.json({ error: `${ext} files can't be uploaded` }, { status: 400 });
  if (size > MAX_FILE_BYTES) return NextResponse.json({ error: 'File is too large' }, { status: 400 });

  const id = randomUUID();
  const key = `${r.link.id}/${id}/${fileName}`;
  const mime = mimeFor(fileName, body.contentType);
  const partSize = partSizeFor(size);
  const multipartId = await createMultipart(key, mime);
  createUploadRow({
    id, link_id: r.link.id, key, multipart_id: multipartId, file_name: fileName, size, mime, part_size: partSize,
    uploader_name: uploaderName, guest_id: guestId(), created_at: new Date().toISOString(),
  });
  return NextResponse.json({ uploadId: id, partSize, partCount: partCount(size, partSize) });
}

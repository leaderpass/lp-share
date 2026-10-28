import { NextResponse } from 'next/server';
import { denyUnlessLpos } from '@/lib/lpos-auth';
import { upsertUploadLink, type UploadLinkPayload } from '@/lib/upload-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { link, uploads, team_files? } — full replace of one Client Upload Link (spec §12.1). */
export async function POST(req: Request) {
  const deny = denyUnlessLpos(req);
  if (deny) return deny;
  const body = (await req.json().catch(() => null)) as UploadLinkPayload | null;
  const l = body?.link;
  if (!l || typeof l.id !== 'string' || typeof l.token !== 'string' || !l.token || !Array.isArray(body!.uploads)) {
    return NextResponse.json({ ok: false, error: 'bad payload' }, { status: 400 });
  }
  upsertUploadLink({
    link: {
      id: l.id, token: l.token, active: !!l.active,
      project_name: String(l.project_name ?? ''), client_name: String(l.client_name ?? ''), welcome_name: l.welcome_name ? String(l.welcome_name) : null,
    },
    uploads: body!.uploads.filter((u) => u && typeof u.upload_id === 'string' && ['received', 'added', 'gone'].includes(u.status)),
    team_files: Array.isArray(body!.team_files)
      ? body!.team_files.filter((f) => f && typeof f.file_id === 'string' && typeof f.file_key === 'string' && f.file_key.startsWith(`${l.id}/`)
        && typeof f.file_name === 'string' && Number.isFinite(Number(f.file_size)) && typeof f.expires_at === 'string')
        .map((f) => ({ ...f, file_size: Number(f.file_size), mime_type: String(f.mime_type || 'application/octet-stream'), added_at: String(f.added_at ?? '') }))
      : undefined,
  });
  return NextResponse.json({ ok: true });
}

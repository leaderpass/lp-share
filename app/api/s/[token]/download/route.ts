import { NextResponse } from 'next/server';
import { resolveShareRequest } from '@/lib/share-request';
import { shareItems } from '@/lib/share-db';
import { isR2Configured, presignR2Get, sanitizeFilename } from '@/lib/r2';
import { recordActivity } from '@/lib/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['original', 'web', 'srt', 'vtt', 'txt'] as const;
type Kind = typeof KINDS[number];

/** GET ?asset=&kind= → 302 to a 4-hour presigned R2 URL, saved under the share's title. */
export async function GET(req: Request, { params }: { params: { token: string } }) {
  const r = resolveShareRequest(params.token);
  if (r.deny) return r.deny;
  if (!r.share.caps.download) return NextResponse.json({ error: 'Downloads are off for this share.' }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const kind = (sp.get('kind') ?? 'original') as Kind;
  if (!KINDS.includes(kind)) return NextResponse.json({ error: 'Unknown download type' }, { status: 400 });
  if ((kind === 'srt' || kind === 'vtt' || kind === 'txt') && !r.share.caps.transcripts) {
    return NextResponse.json({ error: 'Transcripts are off for this share.' }, { status: 403 });
  }
  const item = shareItems(r.share.id).find((i) => i.asset_id === sp.get('asset'));
  const d = item?.download;
  if (!item || !d) return NextResponse.json({ error: 'Video not in this share' }, { status: 404 });

  const file = kind === 'original' ? (d.original ? { key: d.original.key, ext: d.original.ext } : null)
    : kind === 'web' ? (d.web ? { key: d.web.key, ext: '.mp4' } : null)
    : (() => { const t = d.transcripts.find((x) => x.kind === kind); return t ? { key: t.key, ext: `.${kind}` } : null; })();
  if (!file) return NextResponse.json({ error: 'This download is still being prepared.' }, { status: 409 });
  if (!isR2Configured()) return NextResponse.json({ error: 'Downloads aren’t available right now.' }, { status: 503 });

  const title = sanitizeFilename(item.title.replace(/\.(mp4|mov|m4v|mxf|mkv|webm|avi)$/i, ''));
  const filename = kind === 'web' ? `${title} (web).mp4` : `${title}${file.ext}`;
  recordActivity(r.share, r.viewer, { kind: 'download', assetId: item.asset_id, fileKind: kind });
  return NextResponse.redirect(presignR2Get(file.key, filename), { status: 302, headers: { 'Cache-Control': 'no-store' } });
}

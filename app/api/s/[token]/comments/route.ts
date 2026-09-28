import { NextResponse } from 'next/server';
import { resolveShareRequest } from '@/lib/share-request';
import { createComment, deleteComment, editComment, getComment, setCommentCompleted, shareItems } from '@/lib/share-db';
import { commentAuthor } from '@/lib/viewer';
import { isOwnComment, viewComments } from '@/lib/view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { token: string } };
const MAX_TEXT = 5000;

function inShare(shareId: string, assetId: string): boolean {
  return shareItems(shareId).some((i) => i.asset_id === assetId);
}

/** GET ?asset= — the share's comments on one video. */
export async function GET(req: Request, { params }: Ctx) {
  const r = resolveShareRequest(params.token);
  if (r.deny) return r.deny;
  if (!r.share.caps.comments) return NextResponse.json({ comments: [] });
  const assetId = new URL(req.url).searchParams.get('asset') ?? '';
  if (!inShare(r.share.id, assetId)) return NextResponse.json({ error: 'Video not in this share' }, { status: 404 });
  return NextResponse.json({ comments: viewComments(r.share, assetId, r.viewer) });
}

/** POST { asset, text, timestamp?, duration?, parentId?, name? } — new comment or reply. */
export async function POST(req: Request, { params }: Ctx) {
  const r = resolveShareRequest(params.token);
  if (r.deny) return r.deny;
  if (!r.share.caps.comments) return NextResponse.json({ error: 'Comments are off for this share.' }, { status: 403 });
  const body = (await req.json().catch(() => null)) as {
    asset?: string; text?: string; timestamp?: number | null; duration?: number | null; parentId?: string | null; name?: string;
  } | null;
  const text = (body?.text ?? '').trim().slice(0, MAX_TEXT);
  if (!body?.asset || !text) return NextResponse.json({ error: 'Write something first.' }, { status: 400 });
  if (!inShare(r.share.id, body.asset)) return NextResponse.json({ error: 'Video not in this share' }, { status: 404 });

  const author = commentAuthor(r.viewer, body.name ?? null);
  if (!author) return NextResponse.json({ error: 'Add your name to comment.', needName: true }, { status: 400 });

  let parentId: string | null = null;
  if (body.parentId) {
    const parent = getComment(body.parentId);
    if (!parent || parent.share_id !== r.share.id || parent.asset_id !== body.asset || parent.deleted_at) {
      return NextResponse.json({ error: 'That comment is gone.' }, { status: 404 });
    }
    if (parent.internal && !r.viewer.staff) return NextResponse.json({ error: 'That comment is gone.' }, { status: 404 });
    parentId = parent.parent_id ?? parent.id;   // threads are one level deep
  }

  const ts = typeof body.timestamp === 'number' && isFinite(body.timestamp) && body.timestamp >= 0 ? body.timestamp : null;
  const dur = ts !== null && typeof body.duration === 'number' && body.duration > 0 ? body.duration : null;
  createComment({
    share_id: r.share.id, asset_id: body.asset, parent_id: parentId, ...author, text,
    timestamp_s: ts, duration_s: dur,
    // Internal shares keep everything internal; a reply inherits its thread.
    internal: r.share.caps.internal || (parentId ? !!getComment(parentId)?.internal : false),
  });
  return NextResponse.json({ comments: viewComments(r.share, body.asset, r.viewer) });
}

/** PATCH { id, text } (author) or { id, completed } (staff). */
export async function PATCH(req: Request, { params }: Ctx) {
  const r = resolveShareRequest(params.token);
  if (r.deny) return r.deny;
  const body = (await req.json().catch(() => null)) as { id?: string; text?: string; completed?: boolean } | null;
  const c = body?.id ? getComment(body.id) : null;
  if (!c || c.share_id !== r.share.id || c.deleted_at || (c.internal && !r.viewer.staff)) {
    return NextResponse.json({ error: 'That comment is gone.' }, { status: 404 });
  }
  if (typeof body!.completed === 'boolean') {
    if (!r.viewer.staff) return NextResponse.json({ error: 'Only LeaderPass staff can do that.' }, { status: 403 });
    setCommentCompleted(c.id, body!.completed);
  } else {
    const text = (body!.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) return NextResponse.json({ error: 'Write something first.' }, { status: 400 });
    if (!isOwnComment(c, r.viewer)) return NextResponse.json({ error: 'You can only edit your own comments.' }, { status: 403 });
    editComment(c.id, text);
  }
  return NextResponse.json({ comments: viewComments(r.share, c.asset_id, r.viewer) });
}

/** DELETE { id } — your own comment, or any comment for staff. */
export async function DELETE(req: Request, { params }: Ctx) {
  const r = resolveShareRequest(params.token);
  if (r.deny) return r.deny;
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  const c = body?.id ? getComment(body.id) : null;
  if (!c || c.share_id !== r.share.id || c.deleted_at || (c.internal && !r.viewer.staff)) {
    return NextResponse.json({ error: 'That comment is gone.' }, { status: 404 });
  }
  if (!r.viewer.staff && !isOwnComment(c, r.viewer)) {
    return NextResponse.json({ error: 'You can only delete your own comments.' }, { status: 403 });
  }
  deleteComment(c.id);
  return NextResponse.json({ comments: viewComments(r.share, c.asset_id, r.viewer) });
}
